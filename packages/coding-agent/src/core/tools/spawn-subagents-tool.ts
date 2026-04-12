import { Type } from "@sinclair/typebox";

/**
 * Schema for spawn-subagents tool.
 * The executor provides a task description, and optionally a reasoning hint.
 */
export const spawnSubagentsSchema = Type.Object({
	task: Type.String({
		description: "The task to split and execute in parallel",
	}),
	reasoning: Type.Optional(
		Type.String({
			description: "Why parallelism is needed (helps planner decompose)",
		}),
	),
	maxSubtasks: Type.Optional(Type.Number({ description: "Max number of subtasks (default: 4, max: 8)" })),
	options: Type.Optional(
		Type.Object({
			failFast: Type.Boolean({ description: "Stop if any subtask fails" }),
			timeoutMs: Type.Number({ description: "Per-subtask timeout in ms" }),
		}),
	),
});

export type SpawnSubagentsParams = {
	task: string;
	reasoning?: string;
	maxSubtasks?: number;
	options?: {
		failFast?: boolean;
		timeoutMs?: number;
	};
};

/**
 * Result returned to executor after all subtasks complete.
 */
export interface SpawnSubagentsResult {
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

import type { AgentToolResult } from "@oxipi/agent-core";
import type { ExtensionContext } from "../extensions/types.js";
import type { ModelRegistry } from "../model-registry.js";
import type { SubAgentSpawner } from "../sub-agent/sub-agent-executor.js";

// Tool schema
const spawnSubagentsToolSchema = Type.Object({
	task: Type.String({ description: "The task to split and execute in parallel" }),
	reasoning: Type.Optional(Type.String({ description: "Why parallelism is needed" })),
	maxSubtasks: Type.Optional(Type.Number({ description: "Max subtasks (default: 4, max: 8)" })),
	options: Type.Optional(
		Type.Object({
			failFast: Type.Boolean({ description: "Stop if any subtask fails" }),
			timeoutMs: Type.Number({ description: "Per-subtask timeout in ms" }),
		}),
	),
});

interface Subtask {
	id: string;
	description: string;
	task: string;
}

interface PlannerGuidance {
	verdict: "PROCEED" | "REVISE" | "DECIDE" | "STOP";
	reason: string;
	guidance: string;
	subtasks?: Subtask[];
}

/**
 * Create the spawn-subagents tool.
 * Called by executor when it judges a task needs parallel execution.
 */
export function createSpawnSubagentsToolDefinition(
	_registry: ModelRegistry,
	spawner: SubAgentSpawner,
	plannerTool: {
		execute: (
			toolCallId: string,
			params: any,
			signal: AbortSignal | undefined,
			onUpdate: any,
			ctx: any,
		) => Promise<AgentToolResult<any>>;
	},
) {
	return {
		name: "spawn_subagents",
		label: "Spawn Subagents",
		description:
			"Split a complex task into parallel subtasks and execute them simultaneously. " +
			"Use when a task can be broken into independent pieces that can run concurrently. " +
			"The planner tool guides task decomposition. Returns merged results when all subtasks complete.",
		parameters: spawnSubagentsToolSchema,

		async execute(
			_toolCallId: string,
			params: {
				task: string;
				reasoning?: string;
				maxSubtasks?: number;
				options?: { failFast?: boolean; timeoutMs?: number };
			},
			signal: AbortSignal | undefined,
			_onUpdate: any,
			ctx: ExtensionContext,
		): Promise<
			AgentToolResult<{ success: boolean; mergedOutput: string; failedCount: number; totalDurationMs: number }>
		> {
			const startTime = Date.now();
			const maxSubs = Math.min(params.maxSubtasks ?? 4, 8);
			const _timeoutMs = params.options?.timeoutMs ?? 300000;
			const failFast = params.options?.failFast ?? false;

			// Step 1: Consult planner for task decomposition
			const plannerResult = await plannerTool.execute(
				_toolCallId,
				{
					situation: `Task to decompose for parallel execution:\n${params.task}`,
					optionsConsidered: [
						`Execute as single task (no parallelism)`,
						`Split into ${maxSubs} parallel subtasks`,
						`Split into ${maxSubs * 2} parallel subtasks`,
					],
					contextSummary: params.reasoning ?? "No additional context provided",
					question: `How should this task be decomposed into parallel subtasks? Provide specific subtask descriptions.`,
				},
				signal,
				undefined,
				ctx,
			);

			const plannerText = plannerResult.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");

			const guidance = parsePlannerGuidance(plannerText);

			if (guidance.verdict === "STOP") {
				return {
					content: [
						{
							type: "text" as const,
							text: `[spawn_subagents] Planner rejected parallelization: ${guidance.reason}\n${guidance.guidance}`,
						},
					],
					details: {
						success: false,
						mergedOutput: "",
						failedCount: 0,
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			// Step 2: Extract subtasks from planner guidance
			const subtasks = guidance.subtasks ?? decomposeBasedOnGuidance(params.task, maxSubs);

			// Step 3: Spawn subtasks in parallel worktrees
			const taskDescriptions = subtasks.slice(0, maxSubs).map((s, i) => ({
				id: s.id || `subtask-${Date.now()}-${i}`,
				task: s.task,
				type: "default" as const,
			}));

			const results = await spawner.spawnParallel(
				taskDescriptions,
				undefined, // no per-task progress callback
			);

			// Step 4: Collect and merge results
			let mergedOutput = "";
			let failedCount = 0;

			const outputLines: string[] = [];
			for (const [id, result] of results) {
				if (result.status === "completed" && result.output) {
					outputLines.push(`## ${id} (OK)\n${result.output}`);
				} else {
					outputLines.push(`## ${id} (FAIL)\n${result.error ?? "Unknown error"}`);
					failedCount++;
				}
			}

			mergedOutput = `# Parallel Task Results — ${taskDescriptions.length - failedCount} OK, ${failedCount} Failed\n\n${outputLines.join("\n\n---\n\n")}`;

			if (failFast && failedCount > 0) {
				return {
					content: [{ type: "text" as const, text: mergedOutput }],
					details: {
						success: false,
						mergedOutput,
						failedCount,
						totalDurationMs: Date.now() - startTime,
					},
				};
			}

			return {
				content: [{ type: "text" as const, text: mergedOutput }],
				details: {
					success: failedCount === 0,
					mergedOutput,
					failedCount,
					totalDurationMs: Date.now() - startTime,
				},
			};
		},
	};
}

function parsePlannerGuidance(text: string): PlannerGuidance {
	// Try to extract VERDICT/REASON/GUIDANCE structure
	const verdictMatch = text.match(/^\*\*VERDICT\*\*:\s*(PROCEED|REVISE|DECIDE|STOP)/im);
	const reasonMatch = text.match(/^\*\*REASON\*\*:\s*(.+)/im);
	const guidanceMatch = text.match(/^\*\*GUIDANCE\*\*:\s*([\s\S]+)/im);

	const verdict = (verdictMatch?.[1]?.toUpperCase() as PlannerGuidance["verdict"]) ?? "PROCEED";
	const reason = reasonMatch?.[1] ?? "No reason provided";
	const guidance = guidanceMatch?.[1] ?? text;

	// Try to extract subtask list from guidance
	const subtasks: Subtask[] = [];
	const subtaskMatches = text.matchAll(/(?:^|\n)\s*(?:\d+\.|-)\s*(?: subtask:?\s*)?(.+)/gi);
	for (const match of subtaskMatches) {
		const desc = match[1]?.trim();
		if (desc && desc.length > 10) {
			subtasks.push({
				id: `subtask-${Date.now()}-${subtasks.length}`,
				description: desc,
				task: desc,
			});
		}
	}

	return { verdict, reason, guidance, subtasks };
}

function decomposeBasedOnGuidance(task: string, maxSubtasks: number): Subtask[] {
	// Fallback: split task by sentences or clauses
	const sentences = task.split(/[.!?]+/).filter((s) => s.trim().length > 10);
	if (sentences.length <= 1) {
		// Can't split meaningfully, return single task
		return [{ id: `subtask-${Date.now()}-0`, description: task, task }];
	}

	const subtasks: Subtask[] = [];
	const perBatch = Math.ceil(sentences.length / maxSubtasks);
	for (let i = 0; i < sentences.length && subtasks.length < maxSubtasks; i += perBatch) {
		const batch = sentences
			.slice(i, i + perBatch)
			.join(". ")
			.trim();
		if (batch) {
			subtasks.push({
				id: `subtask-${Date.now()}-${subtasks.length}`,
				description: `Part ${subtasks.length + 1}`,
				task: batch,
			});
		}
	}
	return subtasks;
}
