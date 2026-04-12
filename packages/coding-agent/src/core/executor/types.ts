export type SubtaskStatus = "completed" | "failed" | "cancelled" | "timeout";

export interface Subtask {
	id: string;
	description: string; // human-readable label
	task: string; // task description for agent
	type?: string; // optional task type hint
}

export interface SubtaskResult {
	id: string;
	status: SubtaskStatus;
	output?: string;
	error?: string;
	failureReason?: "cancelled" | "timeout"; // failed가 아닌 경우의 구체적 원인
	duration: number;
	worktree?: string; // WorktreePool 전용: worktree 경로
	branch?: string; // WorktreePool 전용: 브랜치명
	cleaned: boolean; // true면 pool이 worktree 정리 완료, false면 caller가 정리
}

export type SubtaskProgressEvent =
	| { type: "started"; subtaskId: string }
	| { type: "output"; subtaskId: string; text: string }
	| { type: "question"; subtaskId: string; question: string; correlationId: string }
	| { type: "completed"; subtaskId: string; result: SubtaskResult };

export interface QuestionPayload {
	subAgentId: string;
	correlationId: string;
	question: string;
	context?: string;
}

export interface SpawnOptions {
	maxConcurrency?: number; // 동시 실행 worker 수 (default: 3)
	failFast?: boolean; // 하나 실패 시 전체 취소 (default: false)
	timeout?: number; // per-task timeout ms (default: 300_000)
	totalTimeout?: number; // 전체 pool deadline ms
	signal?: AbortSignal; // 외부 취소 시그널
	onProgress?: (event: SubtaskProgressEvent) => void;
	onQuestion?: (q: QuestionPayload) => Promise<string> | string;
}
