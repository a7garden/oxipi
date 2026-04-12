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
    })
  ),
  maxSubtasks: Type.Optional(
    Type.Number({ description: "Max number of subtasks (default: 4, max: 8)" })
  ),
  options: Type.Optional(
    Type.Object({
      failFast: Type.Boolean({ description: "Stop if any subtask fails" }),
      timeoutMs: Type.Number({ description: "Per-subtask timeout in ms" }),
    })
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
