/**
 * Executor — barrel exports
 *
 * Single import point for all executor-related types and classes.
 */

export type { ExecutorOptions } from "./executor/index.js";

export { Executor } from "./executor/index.js";
export type { SubtaskPool } from "./executor/task-pool.js";
export type {
	QuestionPayload,
	SpawnOptions,
	Subtask,
	SubtaskProgressEvent,
	SubtaskResult,
} from "./executor/types.js";
