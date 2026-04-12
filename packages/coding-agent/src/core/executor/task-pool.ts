import type { SpawnOptions, Subtask, SubtaskResult } from "./types.js";

export interface SubtaskPool {
	/**
	 * Spawn multiple subtasks with configurable concurrency and error handling.
	 */
	spawn(tasks: Subtask[], options?: SpawnOptions): Promise<Map<string, SubtaskResult>>;
}
