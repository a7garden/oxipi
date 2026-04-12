/**
 * WorktreePool — isolated subtask pool using git worktrees and separate processes.
 *
 * Each subtask runs in its own git worktree with a dedicated `oxipi` process.
 * JSONL-based IPC allows the parent to receive questions and send replies.
 * Worker pool pattern with bounded concurrency.
 */

import { spawn } from "child_process";
import { join } from "path";
import { NESTING_GUARD } from "../sub-agent/sub-agent-executor.js";
import type { SubAgentIpcMessage } from "../sub-agent/subagent-ipc.js";
import { SubAgentIpcBus } from "../sub-agent/subagent-ipc.js";
import type { SubtaskPool } from "./task-pool.js";
import type { SpawnOptions, Subtask, SubtaskResult } from "./types.js";
import { WorktreeManager } from "./worktree-manager.js";

/** Default command to invoke the subagent process */
const DEFAULT_COMMAND = "oxipi";

/** Default polling interval for question IPC (ms) */
const DEFAULT_POLL_MS = 1000;

/** Default per-task timeout (ms) */
const DEFAULT_TIMEOUT = 300_000;

export interface WorktreePoolOptions {
	/** Path to the git repository (for worktree creation) */
	repoPath: string;
	/** Maximum concurrent worktrees (default: 3) */
	maxConcurrency?: number;
	/** Model ID to pass to subagent process (default: "default") */
	model?: string;
	/** Command to invoke subagent process (default: "oxipi") */
	command?: string;
}

export class WorktreePool implements SubtaskPool {
	private readonly repoPath: string;
	private readonly maxConcurrency: number;
	private readonly model: string;
	private readonly command: string;

	constructor(repoPath: string, options?: WorktreePoolOptions);
	constructor(repoPath: string, model?: string, maxConcurrency?: number);
	constructor(repoPath: string, modelOrOptions?: string | WorktreePoolOptions, maxConcurrency?: number) {
		this.repoPath = repoPath;

		if (typeof modelOrOptions === "string") {
			this.model = modelOrOptions;
			this.maxConcurrency = maxConcurrency ?? 3;
		} else {
			this.model = modelOrOptions?.model ?? "default";
			this.maxConcurrency = modelOrOptions?.maxConcurrency ?? 3;
		}
		this.command =
			modelOrOptions && typeof modelOrOptions !== "string"
				? (modelOrOptions.command ?? DEFAULT_COMMAND)
				: DEFAULT_COMMAND;
	}

	async spawn(tasks: Subtask[], options: SpawnOptions = {}): Promise<Map<string, SubtaskResult>> {
		const {
			maxConcurrency = this.maxConcurrency,
			failFast = false,
			timeout = DEFAULT_TIMEOUT,
			totalTimeout,
			signal,
			onProgress,
		} = options;

		// Prevent nested sub-agent spawning
		NESTING_GUARD.check();

		const results = new Map<string, SubtaskResult>();

		// Pool-level AbortController for cancellation
		const poolController = new AbortController();
		const poolAbortHandler = () => poolController.abort();

		// Register external abort signal handler
		if (signal) {
			if (signal.aborted) {
				return results;
			}
			signal.addEventListener("abort", poolAbortHandler);
		}

		// Total timeout deadline
		let totalDeadline: number | undefined;
		if (totalTimeout !== undefined) {
			totalDeadline = Date.now() + totalTimeout;
		}

		try {
			// Trim tasks to maxConcurrency if needed
			const selectedTasks = tasks.slice(0, maxConcurrency);
			if (tasks.length > selectedTasks.length) {
				onProgress?.({
					type: "output",
					subtaskId: "system",
					text: `[safety] task count trimmed ${tasks.length} -> ${selectedTasks.length} (maxConcurrency=${maxConcurrency})`,
				});
			}

			// Worker pool with bounded concurrency
			const pendingTasks = [...selectedTasks];
			const activePromises: Promise<void>[] = [];
			let failedCount = 0;

			while (pendingTasks.length > 0 || activePromises.length > 0) {
				// Check total timeout
				if (totalDeadline !== undefined && Date.now() > totalDeadline) {
					poolController.abort();
					break;
				}

				// Check fail-fast
				if (failFast && failedCount > 0) {
					// Cancel remaining pending tasks
					for (const task of pendingTasks) {
						results.set(task.id, {
							id: task.id,
							status: "cancelled",
							failureReason: "cancelled",
							duration: 0,
							cleaned: true,
						});
					}
					pendingTasks.length = 0;
					poolController.abort();
					break;
				}

				// Fill concurrency slots
				while (pendingTasks.length > 0 && activePromises.length < maxConcurrency) {
					const task = pendingTasks.shift()!;

					const promise = this.spawnSingle(task, {
						...options,
						timeout,
						questionPollMs: DEFAULT_POLL_MS,
						// Use pool abort signal instead of external stop
					})
						.then((result) => {
							results.set(result.id, result);
							if (result.status === "failed") {
								failedCount++;
							}
						})
						.catch((error) => {
							const result: SubtaskResult = {
								id: task.id,
								status: "failed",
								error: error instanceof Error ? error.message : String(error),
								duration: 0,
								cleaned: true,
							};
							results.set(result.id, result);
							failedCount++;

							if (failFast) {
								poolController.abort();
							}
						});

					activePromises.push(promise);
				}

				// Wait for at least one task to complete
				if (activePromises.length > 0 && pendingTasks.length > 0) {
					await Promise.race(activePromises);
				}
			}

			// Wait for all remaining tasks
			await Promise.all(activePromises);
		} finally {
			if (signal) {
				signal.removeEventListener("abort", poolAbortHandler);
			}
		}

		return results;
	}

	/**
	 * Spawn a single subtask in a dedicated worktree with IPC.
	 */
	private async spawnSingle(task: Subtask, opts: SpawnOptions & { questionPollMs?: number }): Promise<SubtaskResult> {
		const start = Date.now();
		const pollMs = Math.max(200, opts.questionPollMs ?? DEFAULT_POLL_MS);
		const branchName = `oxipi-${task.id}-${Date.now()}`;
		const command = this.command;
		const model = this.model;
		const timeout = opts.timeout ?? DEFAULT_TIMEOUT;

		let worktreePath: string | null = null;

		const cleanup = async () => {
			if (worktreePath) {
				try {
					const wm = new WorktreeManager(this.repoPath);
					await wm.remove(worktreePath, true);
				} catch {
					// Ignore cleanup errors
				}
			}
		};

		try {
			// Create worktree
			const info = await new WorktreeManager(this.repoPath).create(branchName, "main");
			worktreePath = info.path;

			const ipcFile = join(worktreePath, ".oxipi", "subagent", `${task.id}.jsonl`);
			const bus = new SubAgentIpcBus(ipcFile);

			// Signal that subagent is ready
			await bus.append({ type: "sub_ready", subAgentId: task.id, timestamp: Date.now() });

			// IPC polling state
			let offset = 0;
			let stopPolling = false;

			// Question polling loop
			const questionPollLoop = (async () => {
				while (!stopPolling) {
					try {
						const read = await bus.readSince(offset);
						offset = read.nextOffset;
						for (const msg of read.messages) {
							if (msg.type !== "sub_question") continue;
							const replyText =
								(await opts.onQuestion?.({
									subAgentId: msg.subAgentId,
									correlationId: msg.correlationId,
									question: msg.question,
									context: msg.context,
								})) ?? "Proceed with best judgment and continue.";
							await bus.append({
								type: "parent_reply",
								subAgentId: msg.subAgentId,
								correlationId: msg.correlationId,
								reply: replyText,
								timestamp: Date.now(),
							});
						}
					} catch (err) {
						// Log but keep loop alive — IPC errors should not crash the process
						const errorMessage = err instanceof Error ? err.message : String(err);
						console.error(`[WorktreePool IPC] Polling error: ${errorMessage}`);
					}
					if (!stopPolling) {
						await new Promise((resolve) => setTimeout(resolve, pollMs));
					}
				}
			})();

			// Spawn the oxipi process in the worktree
			const { output } = await this.runProcessWithProcRef(
				command,
				["-p", "--no-session", "--model", model, task.task],
				{
					cwd: worktreePath,
					timeout,
					onStdout: (line) => {
						opts.onProgress?.({ type: "output", subtaskId: task.id, text: line });
					},
					onStderr: (line) => {
						opts.onProgress?.({ type: "output", subtaskId: task.id, text: line });
					},
					env: {
						OXIPI_SUBAGENT_IPC_FILE: ipcFile,
						OXIPI_SUBAGENT_ID: task.id,
					},
				},
			);

			stopPolling = true;
			await questionPollLoop;

			// Write final IPC message
			await bus.append({
				type: output.exitCode === 0 ? "sub_done" : "sub_error",
				subAgentId: task.id,
				timestamp: Date.now(),
				...(output.exitCode === 0
					? { summary: "Subtask finished." }
					: { error: output.stderr || "Subtask failed." }),
			} as SubAgentIpcMessage);

			return {
				id: task.id,
				status: output.exitCode === 0 ? "completed" : "failed",
				output: output.stdout,
				error: output.exitCode !== 0 ? output.stderr : undefined,
				duration: Date.now() - start,
				worktree: worktreePath,
				branch: branchName,
				cleaned: false, // caller is responsible for cleanup on success
			};
		} catch (e: any) {
			await cleanup();
			return {
				id: task.id,
				status: "failed",
				error: e.message,
				duration: Date.now() - start,
				worktree: undefined,
				branch: branchName,
				cleaned: true,
			};
		}
	}

	/**
	 * Clean up a worktree created by this pool.
	 * Called by the caller when a subtask succeeds (cleaned: false) to release resources.
	 */
	async cleanup(worktreePath: string): Promise<void> {
		try {
			const wm = new WorktreeManager(this.repoPath);
			await wm.remove(worktreePath, true);
		} catch {
			// Ignore cleanup errors
		}
	}

	/**
	 * Run a process and return a reference to it for cancellation.
	 */
	private runProcessWithProcRef(
		command: string,
		args: string[],
		options: {
			cwd?: string;
			timeout?: number;
			onStdout?: (line: string) => void;
			onStderr?: (line: string) => void;
			env?: Record<string, string>;
		},
	): Promise<{
		proc: { kill: (sig?: string | number) => boolean };
		output: { exitCode: number; stdout: string; stderr: string };
	}> {
		return new Promise((resolve, reject) => {
			const { cwd, timeout, onStdout, onStderr, env } = options;
			let stdout = "";
			let stderr = "";
			let timedOut = false;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const proc: any = spawn(command, args, {
				cwd,
				env: { ...process.env, ...env },
				stdio: ["ignore", "pipe", "pipe"],
			});

			const timer = timeout
				? setTimeout(() => {
						timedOut = true;
						proc.kill("SIGTERM");
					}, timeout)
				: undefined;

			proc.stdout?.on("data", (data: Buffer) => {
				const line = data.toString("utf-8").trim();
				if (line) {
					onStdout?.(line);
				}
				stdout += data.toString("utf-8");
			});

			proc.stderr?.on("data", (data: Buffer) => {
				const line = data.toString("utf-8").trim();
				if (line) {
					onStderr?.(line);
				}
				stderr += data.toString("utf-8");
			});

			proc.on("error", (err: Error) => {
				clearTimeout(timer);
				reject(err);
			});

			proc.on("close", (code: number | null) => {
				clearTimeout(timer);
				resolve({
					proc,
					output: {
						exitCode: timedOut ? -1 : (code ?? -1),
						stdout,
						stderr,
					},
				});
			});
		});
	}
}
