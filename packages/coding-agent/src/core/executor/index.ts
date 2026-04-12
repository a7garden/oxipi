/**
 * Executor — main orchestrator for task decomposition and subtask spawning.
 *
 * Owns InProcessPool and WorktreePool behind the SubtaskPool interface.
 * Provides spawnSubtasks() for unified parallel execution and decomposeTask()
 * for simple task decomposition.
 */

import type { ModelRegistry } from "../model-registry.js";
import { InProcessPool } from "./in-process-pool.js";
import type { SubtaskPool } from "./task-pool.js";
import type { SpawnOptions, Subtask, SubtaskResult } from "./types.js";
import { WorktreePool } from "./worktree-pool.js";

export type ExecutorMode = "inprocess" | "worktree";

export interface ExecutorOptions {
	/** Default execution mode (default: "inprocess") */
	defaultMode?: ExecutorMode;
	/** Maximum concurrent subtasks for inprocess mode (default: 3) */
	maxConcurrency?: number;
	/** Model ID for worktree mode subagents (default: "default") */
	worktreeModel?: string;
}

interface SubtaskDecomposition {
	subtasks: Subtask[];
	reason: string;
}

/**
 * Executor — main orchestrator for task decomposition and subtask spawning.
 *
 * Routes spawnSubtasks() to either InProcessPool (same-process, fast) or
 * WorktreePool (isolated git-worktree subprocesses, heavier but more isolated).
 */
export class Executor {
	private readonly inProcessPool: InProcessPool;
	private readonly worktreePool: WorktreePool;
	private readonly defaultMode: ExecutorMode;

	constructor(
		registry: ModelRegistry,
		executorModel: import("@a7garden/ai").Model<import("@a7garden/ai").Api>,
		plannerModel: import("@a7garden/ai").Model<import("@a7garden/ai").Api>,
		repoPath: string,
		options?: ExecutorOptions,
	) {
		const maxConcurrency = options?.maxConcurrency ?? 3;
		this.defaultMode = options?.defaultMode ?? "inprocess";

		this.inProcessPool = new InProcessPool(registry, executorModel, plannerModel, { maxConcurrency });
		this.worktreePool = new WorktreePool(repoPath, options?.worktreeModel ?? "default", maxConcurrency);
	}

	/**
	 * Spawn subtasks using the specified or default execution mode.
	 *
	 * Routes to InProcessPool for same-process execution or WorktreePool
	 * for isolated git-worktree subprocess execution.
	 */
	async spawnSubtasks(
		tasks: Subtask[],
		options?: SpawnOptions & { mode?: ExecutorMode },
	): Promise<Map<string, SubtaskResult>> {
		const mode = options?.mode ?? this.defaultMode;
		const pool: SubtaskPool = mode === "worktree" ? this.worktreePool : this.inProcessPool;
		return pool.spawn(tasks, options ?? {});
	}

	/**
	 * Clean up a worktree created during worktree-mode subtask execution.
	 *
	 * When spawnSubtasks() succeeds with worktree mode, it returns results with
	 * `cleaned: false` for successful subtasks. The caller is responsible for cleanup —
	 * this method delegates to WorktreePool.cleanup() to release the worktree resources.
	 */
	async cleanupWorktree(worktreePath: string): Promise<void> {
		return this.worktreePool.cleanup(worktreePath);
	}

	/**
	 * Decompose a task into subtasks using simple sentence-split decomposition.
	 *
	 * Splits on sentence boundaries (.!?) and groups sentences into at most
	 * maxSubtasks buckets. Returns a single subtask if the task cannot be split.
	 *
	 * The planner is kept as advisory-only — this implementation provides a
	 * deterministic fallback so the Executor is never blocked on planner availability.
	 */
	decomposeTask(task: string, maxSubtasks: number = 4): SubtaskDecomposition {
		const sentences = task
			.split(/[.!?]+/)
			.map((s) => s.trim())
			.filter((s) => s.length > 10);

		if (sentences.length <= 1) {
			return {
				subtasks: [
					{
						id: `subtask-${Date.now()}-0`,
						description: task.slice(0, 80),
						task,
					},
				],
				reason: "Task too short to split meaningfully",
			};
		}

		const perBatch = Math.ceil(sentences.length / maxSubtasks);
		const subtasks: Subtask[] = [];

		for (let i = 0; i < sentences.length && subtasks.length < maxSubtasks; i += perBatch) {
			const batch = sentences
				.slice(i, i + perBatch)
				.join(". ")
				.trim();
			if (!batch) continue;

			subtasks.push({
				id: `subtask-${Date.now()}-${subtasks.length}`,
				description: `Part ${subtasks.length + 1}`,
				task: batch,
			});
		}

		return {
			subtasks,
			reason: `Split ${sentences.length} sentences into ${subtasks.length} subtasks`,
		};
	}
}
