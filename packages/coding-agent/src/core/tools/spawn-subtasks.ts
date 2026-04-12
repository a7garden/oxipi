/**
 * Spawn Subtasks Tool — uses Executor to decompose a task into subtasks
 * and spawn them in parallel, returning merged results.
 */

import type { AgentToolResult } from "@a7garden/agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor, ExecutorMode } from "../executor/index.js";
import type { ExtensionContext } from "../extensions/types.js";

/**
 * Schema for spawn_subtasks tool.
 */
export const spawnSubtasksSchema = Type.Object({
	task: Type.String({
		description: "The task to decompose and execute in parallel",
	}),
	maxSubtasks: Type.Optional(Type.Number({ description: "Maximum number of subtasks to spawn (default: 4, max: 8)" })),
	mode: Type.Optional(
		Type.Union([Type.Literal("inprocess"), Type.Literal("worktree")], {
			description: "Execution mode for subtasks (default: inprocess)",
		}),
	),
	options: Type.Optional(
		Type.Object({
			failFast: Type.Boolean({ description: "Stop remaining subtasks if any fails (default: false)" }),
			timeoutMs: Type.Number({ description: "Per-subtask timeout in milliseconds (default: 300000)" }),
			maxConcurrency: Type.Number({ description: "Maximum concurrent subtasks (default: 3)" }),
		}),
	),
});

export type SpawnSubtasksParams = {
	task: string;
	maxSubtasks?: number;
	mode?: ExecutorMode;
	options?: {
		failFast?: boolean;
		timeoutMs?: number;
		maxConcurrency?: number;
	};
};

/**
 * Result returned after all subtasks complete.
 */
export interface SpawnSubtasksResult {
	success: boolean;
	subtasks: Array<{
		id: string;
		status: "completed" | "failed";
		output?: string;
		error?: string;
	}>;
	mergedOutput: string;
	failedCount: number;
	totalDurationMs: number;
}

/**
 * Details included in the tool result.
 */
export interface SpawnSubtasksToolDetails {
	success: boolean;
	mergedOutput: string;
	failedCount: number;
	totalDurationMs: number;
}

/**
 * Create the spawn_subtasks tool definition.
 *
 * Uses the Executor to decompose a task into subtasks and spawn them in parallel.
 */
export function createSpawnSubtasksToolDefinition(executor: Executor) {
	return {
		name: "spawn_subtasks",
		label: "Spawn Subtasks",
		description:
			"Split a complex task into parallel subtasks and execute them simultaneously. " +
			"Decomposes the task into independent subtasks and spawns them via the Executor. " +
			"Returns merged results when all subtasks complete. Use when a task can be broken " +
			"into independent pieces that can run concurrently.",
		parameters: spawnSubtasksSchema,

		async execute(
			_toolCallId: string,
			params: SpawnSubtasksParams,
			signal: AbortSignal | undefined,
			_onUpdate: any,
			_ctx: ExtensionContext,
		): Promise<AgentToolResult<SpawnSubtasksToolDetails>> {
			const startTime = Date.now();
			const maxSubs = Math.min(params.maxSubtasks ?? 4, 8);
			const mode = params.mode ?? "inprocess";
			const failFast = params.options?.failFast ?? false;
			const timeoutMs = params.options?.timeoutMs ?? 300_000;
			const maxConcurrency = params.options?.maxConcurrency ?? 3;

			// Step 1: Decompose task into subtasks using Executor
			const decomposition = executor.decomposeTask(params.task, maxSubs);
			const subtasks = decomposition.subtasks;

			// Step 2: Spawn subtasks via Executor
			const results = await executor.spawnSubtasks(subtasks, {
				mode,
				failFast,
				timeout: timeoutMs,
				maxConcurrency,
				signal,
			});

			// Step 3: Collect and merge results
			const outputLines: string[] = [];
			let failedCount = 0;

			for (const [id, result] of results) {
				if (result.status === "completed" && result.output) {
					outputLines.push(`## ${id} (OK)\n${result.output}`);
				} else {
					outputLines.push(`## ${id} (FAIL)\n${result.error ?? "Unknown error"}`);
					failedCount++;
				}
			}

			const mergedOutput =
				`# Parallel Task Results — ${subtasks.length - failedCount} OK, ${failedCount} Failed\n\n` +
				outputLines.join("\n\n---\n\n");

			const details: SpawnSubtasksToolDetails = {
				success: failedCount === 0,
				mergedOutput,
				failedCount,
				totalDurationMs: Date.now() - startTime,
			};

			return {
				content: [{ type: "text" as const, text: mergedOutput }],
				details,
			};
		},
	};
}
