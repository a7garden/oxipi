/**
 * InProcessPool — fast-path subtask pool running in the same process.
 *
 * Uses worker pool pattern with configurable concurrency.
 * Spawns SubAgentExecutor instances in the same process as the parent.
 * Shares memory with parent and sibling subtasks.
 */

import type { Api, Model } from "@a7garden/ai";
import type { ModelRegistry } from "../model-registry.js";
import type { SubAgentEvent, SubAgentExecutorConfig, SubAgentExecutorResult } from "../sub-agent/sub-agent-executor.js";
import { NESTING_GUARD, SubAgentExecutor } from "../sub-agent/sub-agent-executor.js";
import type { SubtaskPool } from "./task-pool.js";
import type { SpawnOptions, Subtask, SubtaskResult } from "./types.js";

export interface InProcessPoolOptions {
	/** Maximum concurrent subtasks (default: 3) */
	maxConcurrency?: number;
}

export class InProcessPool implements SubtaskPool {
	private readonly registry: ModelRegistry;
	private readonly executorModel: Model<Api>;
	private readonly plannerModel: Model<Api>;
	private readonly maxConcurrency: number;

	constructor(registry: ModelRegistry, executorModel: Model<Api>, plannerModel: Model<Api>);
	constructor(
		registry: ModelRegistry,
		executorModel: Model<Api>,
		plannerModel: Model<Api>,
		options: InProcessPoolOptions,
	);
	constructor(
		registry: ModelRegistry,
		executorModel: Model<Api>,
		plannerModel: Model<Api>,
		options?: InProcessPoolOptions,
	) {
		this.registry = registry;
		this.executorModel = executorModel;
		this.plannerModel = plannerModel;
		this.maxConcurrency = options?.maxConcurrency ?? 3;
	}

	async spawn(tasks: Subtask[], options: SpawnOptions = {}): Promise<Map<string, SubtaskResult>> {
		const {
			maxConcurrency = this.maxConcurrency,
			failFast = false,
			timeout = 300_000,
			totalTimeout,
			signal,
			onProgress,
		} = options;

		// Check nesting guard before spawning any subtasks
		NESTING_GUARD.check();

		const results = new Map<string, SubtaskResult>();
		const errors: Array<{ id: string; error: string }> = [];

		// Controller for aborting all tasks
		const controller = new AbortController();
		const registeredAbortHandler = () => controller.abort();

		// Register external abort signal handler
		if (signal) {
			if (signal.aborted) {
				// Emit cancelled progress events so callers can distinguish between
				// "zero tasks spawned" and "all tasks were cancelled"
				for (const task of tasks) {
					const result: SubtaskResult = {
						id: task.id,
						status: "cancelled",
						failureReason: "cancelled",
						duration: 0,
						cleaned: true,
					};
					results.set(task.id, result);
					onProgress?.({
						type: "completed",
						subtaskId: task.id,
						result,
					});
				}
				return results;
			}
			signal.addEventListener("abort", registeredAbortHandler);
		}

		// Total timeout deadline
		let totalDeadline: number | undefined;
		if (totalTimeout !== undefined) {
			totalDeadline = Date.now() + totalTimeout;
		}

		try {
			// Worker function that processes a single task
			const processTask = async (task: Subtask): Promise<SubtaskResult> => {
				const startTime = Date.now();
				let timedOut = false;

				// Per-task timeout
				const taskDeadline = timeout !== undefined ? startTime + timeout : undefined;

				const taskController = new AbortController();

				// Listen to the pool-level abort signal
				const poolAbortHandler = () => {
					if (!taskController.signal.aborted) {
						taskController.abort();
					}
				};
				controller.signal.addEventListener("abort", poolAbortHandler);

				try {
					onProgress?.({ type: "started", subtaskId: task.id });

					// Create executor for this task
					const executorConfig: SubAgentExecutorConfig = {
						executorModel: this.executorModel,
						plannerModel: `${this.plannerModel.provider}/${this.plannerModel.id}`,
						enableSubagentSpawning: false, // Nesting guard replaces this
					};
					const executor = new SubAgentExecutor(this.registry, executorConfig);

					// Wrap onProgress to map subtask id
					const wrappedProgress = (event: SubAgentEvent) => {
						if (event.type === "executor_text") {
							onProgress?.({ type: "output", subtaskId: task.id, text: event.text });
						} else if (event.type === "executor_done") {
							onProgress?.({ type: "output", subtaskId: task.id, text: event.output });
						}
					};

					// Run with timeout check
					let result: SubAgentExecutorResult;
					try {
						result = await executor.run(task.task, wrappedProgress);
					} catch (error) {
						if (error instanceof Error && error.name === "AbortError") {
							// Check if it was due to timeout
							if (taskDeadline !== undefined && Date.now() > taskDeadline) {
								timedOut = true;
								onProgress?.({ type: "output", subtaskId: task.id, text: "Task timed out" });
							} else {
								onProgress?.({ type: "output", subtaskId: task.id, text: "Task cancelled" });
							}
							throw error;
						}
						throw error;
					}

					const duration = Date.now() - startTime;
					const subtaskResult: SubtaskResult = {
						id: task.id,
						status: result.success ? "completed" : "failed",
						output: result.output,
						error: result.error,
						failureReason: timedOut ? "timeout" : undefined,
						duration,
						cleaned: true, // No cleanup needed for in-process
					};

					onProgress?.({
						type: "completed",
						subtaskId: task.id,
						result: subtaskResult,
					});

					return subtaskResult;
				} finally {
					// Clean up task-level abort handler
					controller.signal.removeEventListener("abort", poolAbortHandler);

					// Check if task itself timed out
					if (taskDeadline !== undefined && Date.now() > taskDeadline && !timedOut) {
						timedOut = true;
					}
				}
			};

			// Worker pool with concurrency control
			const pendingTasks = [...tasks];
			const activePromises: Promise<void>[] = [];

			// Process next batch of tasks while respecting concurrency
			while (pendingTasks.length > 0 || activePromises.length > 0) {
				// Check total timeout
				if (totalDeadline !== undefined && Date.now() > totalDeadline) {
					controller.abort();
					break;
				}

				// Fill up the concurrency slots
				while (pendingTasks.length > 0 && activePromises.length < maxConcurrency) {
					const task = pendingTasks.shift()!;
					const taskStartTime = Date.now();

					const promise = processTask(task)
						.then((result) => {
							results.set(result.id, result);
							if (!result.output && result.error) {
								errors.push({ id: result.id, error: result.error });
							}
						})
						.catch((error) => {
							// Check if it was an abort (cancelled)
							if (error instanceof Error && error.name === "AbortError") {
								const result: SubtaskResult = {
									id: task.id,
									status: "cancelled",
									failureReason: "cancelled",
									duration: Date.now() - taskStartTime,
									cleaned: true,
								};
								results.set(result.id, result);
							} else {
								const result: SubtaskResult = {
									id: task.id,
									status: "failed",
									error: error instanceof Error ? error.message : String(error),
									duration: Date.now() - taskStartTime,
									cleaned: true,
								};
								results.set(result.id, result);
								errors.push({ id: task.id, error: result.error! });
							}

							if (failFast) {
								controller.abort();
							}
						})
						.finally(() => {
							// Remove this promise from activePromises
							const idx = activePromises.indexOf(promise);
							if (idx !== -1) {
								activePromises.splice(idx, 1);
							}
						});

					activePromises.push(promise);
				}

				// Wait for at least one task to complete if we have active tasks
				if (activePromises.length > 0 && pendingTasks.length > 0) {
					await Promise.race(activePromises);
				}
			}

			// Wait for all remaining tasks to complete
			await Promise.all(activePromises);
		} finally {
			// Clean up abort handler
			if (signal) {
				signal.removeEventListener("abort", registeredAbortHandler);
			}
		}

		return results;
	}
}
