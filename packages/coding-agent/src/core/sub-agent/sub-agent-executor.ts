/**
 * OxiPi Advisor System — Executor + Planner advisory pattern
 *
 *   Task → Executor(m2.7) runs with advisor tool
 *                ↓ (when needed)
 *           Planner(glm-5.1) provides guidance
 *                ↓
 *           Executor continues
 */

import { Agent, type AgentTool, type ThinkingLevel } from "@oxipi/agent-core";
import { type Api, type AssistantMessage, type Message, type Model, streamSimple } from "@oxipi/ai";
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { convertToLlm } from "../messages.js";
import type { ModelRegistry } from "../model-registry.js";
import { createCodingTools } from "../tools/index.js";
import { createPlannerToolDefinition } from "../tools/planner-tool.js";
import { SubAgentIpcBus, type SubAgentIpcMessage } from "./subagent-ipc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Block nested sub-agents: sub-agents cannot spawn sub-agents
export const NESTING_GUARD = {
	isNested: () => !!process.env.OXIPI_SUBAGENT_ID,
	check: () => {
		if (NESTING_GUARD.isNested()) {
			throw new Error("Sub-agents cannot spawn sub-agents (nesting detected)");
		}
	},
};

// =============================================================================
// Message-based state (claw-code pattern)
// =============================================================================

export interface MessageState {
	messages: Message[];
}

export class SessionMessages {
	private messages: Message[] = [];

	addUser(content: string) {
		this.messages.push({
			role: "user",
			content: [{ type: "text", text: content }],
			timestamp: Date.now(),
		} as Message);
	}

	addAssistant(text: string) {
		this.messages.push({
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		} as Message);
	}

	addToolResult(toolUseId: string, content: string) {
		this.messages.push({
			role: "toolResult",
			toolCallId: toolUseId,
			toolName: "", // toolName not tracked in this context
			content: [{ type: "text", text: content }],
			isError: false,
			timestamp: Date.now(),
		} as Message);
	}

	getMessages(): Message[] {
		return [...this.messages]; // Return copy to prevent external mutation
	}

	getLastAssistantText(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const msg = this.messages[i];
			if (msg.role === "assistant") {
				const assistant = msg as AssistantMessage;
				for (const block of assistant.content) {
					if (block.type === "text" && block.text.trim()) {
						return block.text;
					}
				}
			}
		}
		return "";
	}

	hasToolCalls(): boolean {
		for (const msg of this.messages) {
			if (msg.role === "assistant") {
				const assistant = msg as AssistantMessage;
				for (const block of assistant.content) {
					if (block.type === "toolCall") return true;
				}
			}
		}
		return false;
	}

	count(): number {
		return this.messages.length;
	}
}

// =============================================================================
// Types
// =============================================================================

// v2.0 Routing Config Types
export interface ModelDefaults {
	executor: string; // "provider/model" format
	planner: string; // "provider/model" format
}

export interface RoutingConfig {
	version: string;
	defaults: ModelDefaults;
	settings: {
		maxIterations: number;
	};
}

export interface SubAgentExecutorResult {
	success: boolean;
	output?: string;
	error?: string;
	iterations: number;
	executorModel: string;
	plannerModel: string;
}

export interface SubAgentTask {
	id: string;
	task: string;
	type: string;
}

export interface SubAgentResult {
	id: string;
	status: "completed" | "failed";
	output?: string;
	error?: string;
	duration: number;
	worktree?: string;
	branch?: string;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	head: string;
}

export interface SpawnOptions {
	model?: string; // executor model override (format: "provider/model" or just "modelId")
	cwd?: string;
	timeout?: number;
	totalTimeoutMs?: number;
	maxTasks?: number;
	failFast?: boolean;
	parallelism?: number;
	command?: string;
	questionPollMs?: number;
	onStdout?: (line: string) => void;
	onStderr?: (line: string) => void;
	onQuestion?: (question: {
		subAgentId: string;
		correlationId: string;
		question: string;
		context?: string;
	}) => Promise<string> | string;
}

export type ProgressCallback = (event: SubAgentEvent) => void;

export type SubAgentEvent =
	| { type: "executor_start"; model: string; iteration: number }
	| { type: "executor_text"; text: string }
	| { type: "executor_tool"; tool: string; args: unknown }
	| { type: "executor_done"; output: string }
	| { type: "error"; error: string }
	| { type: "complete"; result: SubAgentExecutorResult };

// =============================================================================
// Model Router
// =============================================================================

export interface ModelRouterOptions {
	executorModel?: string;
	plannerModel?: string;
}

export class ModelRouter {
	config: RoutingConfig;
	private registry: ModelRegistry;

	constructor(registry: ModelRegistry, configPath?: string, options?: ModelRouterOptions) {
		this.registry = registry;
		this.config = this.loadConfig(configPath || join(__dirname, "routing.json"));
		// Override from settings if provided
		if (options?.executorModel) {
			this.config.defaults.executor = options.executorModel;
		}
		if (options?.plannerModel) {
			this.config.defaults.planner = options.plannerModel;
		}
	}

	private loadConfig(configPath: string): RoutingConfig {
		if (!existsSync(configPath)) return this.defaultConfig();
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
			// Migrate v1.0 config to v2.0
			if (parsed.version === "1.0") {
				return this.migrateToV2(parsed);
			}
			return parsed;
		} catch {
			return this.defaultConfig();
		}
	}

	private migrateToV2(v1Config: {
		tasks: Record<
			string,
			{
				advisor?: { provider: string; model: string };
				worker?: { provider: string; model: string };
				description?: string;
			}
		>;
	}): RoutingConfig {
		const modelList: string[] = [];
		for (const task of Object.values(v1Config.tasks)) {
			if (task.worker) modelList.push(`${task.worker.provider}/${task.worker.model}`);
			if (task.advisor) modelList.push(`${task.advisor.provider}/${task.advisor.model}`);
		}
		return {
			version: "2.0",
			defaults: {
				executor: modelList[0] || "minimax/m2.7",
				planner: modelList[1] || modelList[0] || "zai/glm-5.1",
			},
			settings: { maxIterations: 3 },
		};
	}

	private defaultConfig(): RoutingConfig {
		return {
			version: "2.0",
			defaults: {
				executor: "minimax/m2.7",
				planner: "zai/glm-5.1",
			},
			settings: { maxIterations: 3 },
		};
	}

	getExecutorModel(): Model<Api> | undefined {
		const [provider, modelId] = this.config.defaults.executor.split("/");
		return this.registry.find(provider, modelId);
	}

	getPlannerModel(): Model<Api> | undefined {
		const [provider, modelId] = this.config.defaults.planner.split("/");
		return this.registry.find(provider, modelId);
	}

	save(path?: string): void {
		writeFileSync(path || join(__dirname, "routing.json"), JSON.stringify(this.config, null, 2));
	}
}

// =============================================================================
// SubAgent Executor — SubAgent spawn and execution
// =============================================================================

export interface SubAgentExecutorConfig {
	executorModel: Model<Api>;
	advisorModel: string;
	advisorMaxUses?: number;
	maxIterations?: number;
}

// =============================================================================
// SubAgent Executor — SubAgent spawn and execution
// =============================================================================

/**
 * SubAgentExecutor — Executor with advisor tool for complex decisions.
 *
 * Flow:
 * 1. Executor (m2.7) runs the task end-to-end
 * 2. When it encounters a complex decision, it calls the advisor tool
 * 3. Advisor (glm-5.1) provides guidance
 * 4. Executor continues with the guidance
 *
 * This is the classic Advisor Strategy pattern:
 * - Single executor agent (not two-phase)
 * - Advisor is called dynamically when needed
 * - Executor makes the final decision
 */
export class SubAgentExecutor {
	private executorModel: Model<Api>;
	private plannerModel: Model<Api>;
	private maxIterations: number;

	constructor(registry: ModelRegistry, router: ModelRouter);
	constructor(registry: ModelRegistry, executorModel: Model<Api>, plannerModel: Model<Api>);
	constructor(
		private reg: ModelRegistry,
		routerOrExecutor: ModelRouter | Model<Api>,
		plannerModel?: Model<Api>,
	) {
		if (routerOrExecutor instanceof ModelRouter) {
			// Router-based: resolve models from router defaults
			const router = routerOrExecutor;
			const executorStr = router.config.defaults.executor;
			const plannerStr = router.config.defaults.planner;
			const [p1, m1] = executorStr.split("/");
			const [p2, m2] = plannerStr.split("/");
			this.executorModel = this.reg.find(p1, m1)!;
			this.plannerModel = this.reg.find(p2, m2)!;
			this.maxIterations = router.config.settings?.maxIterations ?? 3;
		} else {
			// Explicit models
			this.executorModel = routerOrExecutor;
			this.plannerModel = plannerModel!;
			this.maxIterations = 3;
		}
	}

	async run(task: string, onProgress?: (event: SubAgentEvent) => void): Promise<SubAgentExecutorResult> {
		NESTING_GUARD.check();

		const plannerTool = createPlannerToolDefinition(this.reg, {
			plannerModel: `${this.plannerModel.provider}/${this.plannerModel.id}`,
		});

		const tools = [...createCodingTools(process.cwd()), plannerTool as unknown as AgentTool];

		const agent = new Agent({
			initialState: {
				systemPrompt: EXECUTOR_PROMPT,
				model: this.executorModel,
				thinkingLevel: this.executorModel.reasoning ? ("medium" as ThinkingLevel) : ("off" as ThinkingLevel),
				tools,
			},
			convertToLlm,
			streamFn: async (m, context, options) => {
				const auth = await this.reg.getApiKeyAndHeaders(m);
				if (!auth.ok) throw new Error(auth.error);
				return streamSimple(m, context, {
					...options,
					apiKey: auth.apiKey,
					headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
				});
			},
			sessionId: `oxipi-advisor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		});

		const unsub = onProgress
			? agent.subscribe((event) => {
					if (
						event.type === "message_update" ||
						event.type === "tool_execution_start" ||
						event.type === "tool_execution_end"
					) {
						onProgress(event as unknown as SubAgentEvent);
					}
				})
			: null;

		// Message-based state (claw-code pattern)
		const session = new SessionMessages();
		session.addUser(
			`## Task\n${task}\n\nExecute this task step by step. Use the advisor tool when you need guidance on complex decisions.`,
		);

		try {
			await agent.prompt(session.getMessages());

			// Collect output from agent state after prompt() returns
			const texts: string[] = [];
			for (const msg of agent.state.messages as Message[]) {
				if (msg.role === "assistant") {
					for (const block of (msg as AssistantMessage).content) {
						if (block.type === "text" && block.text.trim()) texts.push(block.text);
					}
				}
			}
			const output = texts.join("\n\n");

			const hasToolCalls = (agent.state.messages as Message[]).some((msg) => {
				if (msg.role === "assistant") {
					return (msg as AssistantMessage).content.some((b) => b.type === "toolCall");
				}
				return false;
			});

			onProgress?.({ type: "executor_done", output });

			const result: SubAgentExecutorResult = {
				success: looksComplete(output, hasToolCalls),
				output,
				iterations: 1, // Single prompt cycle with message-based state
				executorModel: this.executorModel.id,
				plannerModel: this.plannerModel.id,
			};
			onProgress?.({ type: "complete", result });
			return result;
		} catch (error) {
			const err = `Executor failed: ${error instanceof Error ? error.message : String(error)}`;
			onProgress?.({ type: "error", error: err });
			return {
				success: false,
				error: err,
				iterations: session.count(),
				executorModel: this.executorModel.id,
				plannerModel: this.plannerModel.id,
			};
		} finally {
			unsub?.();
		}
	}

	/**
	 * Get executor and planner model info.
	 */
	getModels(): { executor: string; planner: string } {
		return {
			executor: this.executorModel.id,
			planner: this.plannerModel.id,
		};
	}
}

// =============================================================================
// System Prompt for Executor
// =============================================================================

const EXECUTOR_PROMPT = `You are a skilled software engineer executing coding tasks.

## Your Approach
- Break down the task and execute step by step
- Use available tools (read, bash, edit, write) to complete the task
- Be thorough and complete the task end-to-end
- End with "Task completed" when done`;

// =============================================================================
// WorktreeManager — git worktree lifecycle
// =============================================================================

export class WorktreeManager {
	private repoPath: string;

	constructor(repoPath: string) {
		this.repoPath = repoPath;
	}

	/** Create a new worktree with a dedicated branch */
	async create(branchName: string, baseBranch: string = "main"): Promise<WorktreeInfo> {
		const { execSync } = await import("child_process");
		const worktreesDir = join(this.repoPath, ".worktrees");
		const worktreePath = join(worktreesDir, branchName);

		// Ensure .worktrees directory exists
		execSync(`mkdir -p "${worktreesDir}"`, { cwd: this.repoPath });

		try {
			execSync(`git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`, {
				cwd: this.repoPath,
				stdio: "pipe",
			});
		} catch (e: any) {
			// Worktree might already exist — try to find it
			const output = execSync(`git worktree list --porcelain`, { cwd: this.repoPath, encoding: "utf-8" });
			const lines = output.split("\n");
			let current: WorktreeInfo | null = null;
			for (const line of lines) {
				if (line.startsWith("worktree ")) current = { path: line.slice(8).trim(), branch: "", head: "" };
				else if (line.startsWith("branch refs/heads/") && current) current.branch = line.slice(17).trim();
				else if (line.startsWith("HEAD ") && current) current.head = line.slice(5).trim();
				else if (line === "" && current && current.path === worktreePath) return current;
			}
			throw e;
		}

		return { path: worktreePath, branch: branchName, head: "" };
	}

	/** Remove a worktree */
	async remove(worktreePath: string, force: boolean = false): Promise<void> {
		const { execSync } = await import("child_process");
		execSync(`git worktree remove "${worktreePath}"${force ? " --force" : ""}`, {
			cwd: this.repoPath,
			stdio: "pipe",
		});
	}

	/** List all worktrees */
	async list(): Promise<WorktreeInfo[]> {
		const { execSync } = await import("child_process");
		const output = execSync(`git worktree list --porcelain`, { cwd: this.repoPath, encoding: "utf-8" });
		const worktrees: WorktreeInfo[] = [];
		const lines = output.split("\n");
		let current: WorktreeInfo | null = null;
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				if (current) worktrees.push(current);
				current = { path: line.slice(8).trim(), branch: "", head: "" };
			} else if (line.startsWith("branch refs/heads/") && current) {
				current.branch = line.slice(17).trim();
			} else if (line.startsWith("HEAD ") && current) {
				current.head = line.slice(5).trim();
			} else if (line === "" && current) {
				worktrees.push(current);
				current = null;
			}
		}
		if (current) worktrees.push(current);
		return worktrees;
	}
}

// =============================================================================
// SubAgent Spawner
// =============================================================================

export class SubAgentSpawner {
	private registry: ModelRegistry;
	private router: ModelRouter;
	private worktreeManager: WorktreeManager | null = null;

	constructor(registry: ModelRegistry, router: ModelRouter, repoPath?: string) {
		this.registry = registry;
		this.router = router;
		if (repoPath) this.worktreeManager = new WorktreeManager(repoPath);
	}

	async spawn(
		id: string,
		task: string,
		_taskType: string = "default",
		onProgress?: (output: string) => void,
	): Promise<SubAgentResult> {
		const start = Date.now();
		NESTING_GUARD.check(); // Prevent nested sub-agent spawn

		const agent = new SubAgentExecutor(this.registry, this.router);

		const result = await agent.run(task, (evt) => {
			if (evt.type === "executor_done") onProgress?.(evt.output);
		});

		return {
			id,
			status: result.success ? "completed" : "failed",
			output: result.output,
			error: result.error,
			duration: Date.now() - start,
		};
	}

	async spawnParallel(
		tasks: SubAgentTask[],
		onProgress?: (id: string, output: string) => void,
	): Promise<Map<string, SubAgentResult>> {
		const results = await Promise.all(
			tasks.map((t) => this.spawn(t.id, t.task, t.type, (o) => onProgress?.(t.id, o))),
		);
		const map = new Map<string, SubAgentResult>();
		for (let i = 0; i < results.length; i++) map.set(tasks[i].id, results[i]);
		return map;
	}

	/**
	 * Spawn a sub-agent in a separate git worktree with its own oxipi process.
	 * Full isolation: separate git branch, file system, and process.
	 */
	async spawnInWorktree(
		id: string,
		task: string,
		_taskType: string = "default",
		opts: SpawnOptions = {},
	): Promise<SubAgentResult> {
		const start = Date.now();
		NESTING_GUARD.check(); // Prevent nested sub-agent spawn

		const wm = opts.cwd ? new WorktreeManager(opts.cwd) : this.worktreeManager;
		const model = opts.model || this.router.getExecutorModel()?.id || "default";
		const command = opts.command || "oxipi";
		const pollMs = Math.max(200, opts.questionPollMs ?? 1000);
		const branchName = `oxipi-${id}-${Date.now()}`;
		let worktreePath: string | null = null;

		if (!wm) return { id, status: "failed", error: "No worktree manager", duration: 0 };

		const cleanup = async () => {
			if (worktreePath) {
				try {
					await wm!.remove(worktreePath, true);
				} catch {}
			}
		};

		try {
			const info = await wm.create(branchName, "main");
			worktreePath = info.path;
			const ipcFile = join(worktreePath, ".oxipi", "subagent", `${id}.jsonl`);
			const bus = new SubAgentIpcBus(ipcFile);
			await bus.append({ type: "sub_ready", subAgentId: id, timestamp: Date.now() });

			let offset = 0;
			let stopPolling = false;
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
						// Log error but keep loop alive - IPC communication should not crash the process
						const errorMessage = err instanceof Error ? err.message : String(err);
						console.error(`[SubAgent IPC] Polling error: ${errorMessage}`);
					}
					if (!stopPolling) {
						await new Promise((resolve) => setTimeout(resolve, pollMs));
					}
				}
			})();

			const output = await this.runProcess(command, ["-p", "--no-session", "--model", model, task], {
				cwd: worktreePath,
				timeout: opts.timeout || 300000,
				onStdout: opts.onStdout,
				onStderr: opts.onStderr,
				env: {
					OXIPI_SUBAGENT_IPC_FILE: ipcFile,
					OXIPI_SUBAGENT_ID: id,
				},
			});
			stopPolling = true;
			await questionPollLoop;
			await bus.append({
				type: output.exitCode === 0 ? "sub_done" : "sub_error",
				subAgentId: id,
				timestamp: Date.now(),
				...(output.exitCode === 0
					? { summary: "Sub-agent finished." }
					: { error: output.stderr || "Sub-agent failed." }),
			} as SubAgentIpcMessage);

			return {
				id,
				status: output.exitCode === 0 ? "completed" : "failed",
				output: output.stdout,
				error: output.exitCode !== 0 ? output.stderr : undefined,
				duration: Date.now() - start,
				worktree: worktreePath,
				branch: branchName,
			};
		} catch (e: any) {
			return {
				id,
				status: "failed",
				error: e.message,
				duration: Date.now() - start,
				worktree: worktreePath || undefined,
				branch: branchName,
			};
		} finally {
			await cleanup();
		}
	}

	/** Spawn multiple agents in parallel, each in its own worktree */
	async spawnParallelInWorktrees(
		tasks: SubAgentTask[],
		opts: SpawnOptions = {},
		onProgress?: (id: string, line: string) => void,
	): Promise<Map<string, SubAgentResult>> {
		const maxTasks = Math.max(1, opts.maxTasks ?? tasks.length);
		const selectedTasks = tasks.slice(0, maxTasks);
		if (tasks.length > selectedTasks.length) {
			onProgress?.(
				"system",
				`[safety] task count trimmed ${tasks.length} -> ${selectedTasks.length} (maxTasks=${maxTasks})`,
			);
		}

		const parallelism = Math.max(1, Math.min(opts.parallelism ?? 3, Math.max(1, selectedTasks.length)));
		const deadline = opts.totalTimeoutMs
			? Date.now() + Math.max(1000, opts.totalTimeoutMs)
			: Number.POSITIVE_INFINITY;
		const failFast = opts.failFast ?? false;

		const results: SubAgentResult[] = [];
		let index = 0;
		let failedCount = 0;

		const workers = Array.from({ length: parallelism }, async () => {
			while (true) {
				if (failFast && failedCount > 0) break;
				if (Date.now() >= deadline) break;
				const current = index++;
				if (current >= selectedTasks.length) break;
				const task = selectedTasks[current];

				const remaining = deadline - Date.now();
				if (!Number.isFinite(remaining) || remaining <= 0) {
					results.push({
						id: task.id,
						status: "failed",
						error: "Global timeout reached before execution",
						duration: 0,
					});
					failedCount++;
					continue;
				}

				const perTaskTimeout = Math.min(opts.timeout || 300000, Math.max(1000, remaining));
				const result = await this.spawnInWorktree(task.id, task.task, task.type, {
					...opts,
					timeout: perTaskTimeout,
					onStdout: (line) => {
						onProgress?.(task.id, line);
						opts.onStdout?.(line);
					},
					onStderr: (line) => {
						opts.onStderr?.(line);
					},
				});
				results.push(result);
				if (result.status === "failed") {
					failedCount++;
				}
			}
		});

		await Promise.all(workers);

		if (Date.now() >= deadline) {
			onProgress?.("system", "[safety] global timeout reached during parallel run");
		}

		const map = new Map<string, SubAgentResult>();
		for (const r of results) map.set(r.id, r);
		return map;
	}

	private runProcess(
		cmd: string,
		args: string[],
		opts: {
			cwd?: string;
			timeout?: number;
			onStdout?: (line: string) => void;
			onStderr?: (line: string) => void;
			env?: Record<string, string>;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let killed = false;

			const proc = spawn(cmd, args, {
				cwd: opts.cwd || process.cwd(),
				env: { ...process.env, FORCE_COLOR: "0", ...(opts.env ?? {}) },
				shell: false,
			});

			const timer = setTimeout(() => {
				killed = true;
				proc.kill("SIGTERM");
			}, opts.timeout || 300000);

			proc.stdout?.on("data", (data: Buffer) => {
				const line = data.toString();
				stdout += line;
				opts.onStdout?.(line.trim());
			});
			proc.stderr?.on("data", (data: Buffer) => {
				const line = data.toString();
				stderr += line;
				opts.onStderr?.(line.trim());
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				if (killed) stderr += "\n[timeout]";
				resolve({ stdout, stderr, exitCode: code ?? (killed ? -1 : 0) });
			});
			proc.on("error", (_e) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, exitCode: -1 });
			});
		});
	}

	async mergeResults(results: Map<string, SubAgentResult>): Promise<string> {
		const parts: string[] = [];
		let ok = 0;
		let fail = 0;

		for (const [id, r] of results) {
			if (r.status === "completed" && r.output) {
				ok++;
				parts.push(`## OK: ${id}${r.worktree ? ` [${r.branch}]` : ""}\n${r.output}`);
			} else {
				fail++;
				parts.push(`## FAIL: ${id}${r.worktree ? ` [${r.branch}]` : ""}\n${r.error || "Unknown error"}`);
			}
		}
		return `# Merged Results — ${ok} OK, ${fail} Failed\n\n${parts.join("\n\n---\n\n")}`;
	}
}

// =============================================================================
// WorkTree — parallel branches
// =============================================================================

export class WorkTree {
	private branches: Map<string, SubAgentTask> = new Map();
	private results: Map<string, SubAgentResult> = new Map();
	private spawner: SubAgentSpawner;

	constructor(spawner: SubAgentSpawner) {
		this.spawner = spawner;
	}

	addBranch(id: string, task: string, type: string = "default"): void {
		this.branches.set(id, { id, task, type });
	}

	async execute(onProgress?: (id: string, output: string) => void): Promise<void> {
		this.results = await this.spawner.spawnParallel(Array.from(this.branches.values()), onProgress);
	}

	async executeInWorktrees(opts: SpawnOptions = {}, onProgress?: (id: string, line: string) => void): Promise<void> {
		this.results = await this.spawner.spawnParallelInWorktrees(Array.from(this.branches.values()), opts, onProgress);
	}

	getResult(id: string): SubAgentResult | undefined {
		return this.results.get(id);
	}
	getAllResults(): Map<string, SubAgentResult> {
		return this.results;
	}
	async merge(): Promise<string> {
		return this.spawner.mergeResults(this.results);
	}
}

// =============================================================================
// Factory
// =============================================================================

export function createSubAgentSystem(
	registry: ModelRegistry,
	configPath?: string,
	repoPath?: string,
	options?: ModelRouterOptions,
) {
	const router = new ModelRouter(registry, configPath, options);
	const spawner = new SubAgentSpawner(registry, router, repoPath);
	return {
		router,
		spawner,
		createAgent: (router: ModelRouter) => new SubAgentExecutor(registry, router),
	};
}

// =============================================================================
// Helpers
// =============================================================================

function looksComplete(output: string, hasToolCalls: boolean = false): boolean {
	// If the agent made tool calls but produced no output, it's not complete
	if (hasToolCalls && !output.trim()) {
		return false;
	}

	// Check for explicit completion markers
	const lower = output.toLowerCase();
	const completionMarkers = [
		"task completed",
		"done.",
		"finished",
		"all changes applied",
		"complete.",
		"successfully completed",
		"no further action needed",
	];

	// Check for failure markers
	const failureMarkers = ["failed", "error", "could not complete", "not complete", "unable to"];

	const hasCompletion = completionMarkers.some((m) => lower.includes(m));
	const hasFailure = failureMarkers.some((m) => lower.includes(m));

	// Only return true if we have completion markers and no failure markers
	// AND the output has meaningful length (not just a one-liner)
	if (hasCompletion && !hasFailure && output.length > 50) {
		return true;
	}

	// Also consider short outputs with no tool calls as complete
	// (simple tasks that don't need multiple iterations)
	if (!hasToolCalls && output.length > 0 && output.length < 200 && !hasFailure) {
		return true;
	}

	return false;
}
