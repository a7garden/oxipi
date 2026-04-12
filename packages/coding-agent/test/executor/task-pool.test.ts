import { describe, expect, it } from "vitest";
import type {
	QuestionPayload,
	SpawnOptions,
	Subtask,
	SubtaskProgressEvent,
	SubtaskResult,
	SubtaskStatus,
} from "../../src/core/executor/types.js";

describe("SubtaskPool Interface Contract", () => {
	describe("SubtaskStatus", () => {
		it("should include all valid status values", () => {
			const validStatuses: SubtaskStatus[] = ["completed", "failed", "cancelled", "timeout"];

			expect(validStatuses).toHaveLength(4);
			expect(validStatuses).toContain("completed");
			expect(validStatuses).toContain("failed");
			expect(validStatuses).toContain("cancelled");
			expect(validStatuses).toContain("timeout");
		});
	});

	describe("SubtaskResult structure", () => {
		it("should require id and status fields", () => {
			const result: SubtaskResult = {
				id: "task-1",
				status: "completed",
				duration: 1000,
				cleaned: true,
			};

			expect(result.id).toBe("task-1");
			expect(result.status).toBe("completed");
			expect(result.duration).toBe(1000);
			expect(result.cleaned).toBe(true);
		});

		it("should allow optional output and error fields", () => {
			const result: SubtaskResult = {
				id: "task-1",
				status: "completed",
				output: "task output text",
				error: undefined,
				duration: 1000,
				cleaned: true,
			};

			expect(result.output).toBe("task output text");
			expect(result.error).toBeUndefined();
		});

		it("should allow failureReason for non-failed statuses", () => {
			const timeoutResult: SubtaskResult = {
				id: "task-1",
				status: "timeout",
				failureReason: "timeout",
				duration: 300000,
				cleaned: false,
			};

			expect(timeoutResult.failureReason).toBe("timeout");

			const cancelledResult: SubtaskResult = {
				id: "task-2",
				status: "cancelled",
				failureReason: "cancelled",
				duration: 500,
				cleaned: false,
			};

			expect(cancelledResult.failureReason).toBe("cancelled");
		});

		it("should support worktree and branch fields for WorktreePool", () => {
			const result: SubtaskResult = {
				id: "task-1",
				status: "completed",
				worktree: "/path/to/worktree",
				branch: "feature/subtask-1",
				duration: 5000,
				cleaned: false,
			};

			expect(result.worktree).toBe("/path/to/worktree");
			expect(result.branch).toBe("feature/subtask-1");
		});

		it("should have boolean cleaned field", () => {
			const result: SubtaskResult = {
				id: "task-1",
				status: "completed",
				duration: 1000,
				cleaned: false,
			};

			expect(typeof result.cleaned).toBe("boolean");
		});
	});

	describe("SubtaskProgressEvent discriminated union", () => {
		it("should support started event type", () => {
			const event: SubtaskProgressEvent = {
				type: "started",
				subtaskId: "task-1",
			};

			expect(event.type).toBe("started");
			expect(event.subtaskId).toBe("task-1");
		});

		it("should support output event type", () => {
			const event: SubtaskProgressEvent = {
				type: "output",
				subtaskId: "task-1",
				text: "some output text",
			};

			expect(event.type).toBe("output");
			expect(event.subtaskId).toBe("task-1");
			expect(event.text).toBe("some output text");
		});

		it("should support question event type", () => {
			const event: SubtaskProgressEvent = {
				type: "question",
				subtaskId: "task-1",
				question: "What should I do?",
				correlationId: "corr-123",
			};

			expect(event.type).toBe("question");
			expect(event.subtaskId).toBe("task-1");
			expect(event.question).toBe("What should I do?");
			expect(event.correlationId).toBe("corr-123");
		});

		it("should support completed event type with result", () => {
			const result: SubtaskResult = {
				id: "task-1",
				status: "completed",
				duration: 1000,
				cleaned: true,
			};
			const event: SubtaskProgressEvent = {
				type: "completed",
				subtaskId: "task-1",
				result,
			};

			expect(event.type).toBe("completed");
			expect(event.subtaskId).toBe("task-1");
			expect(event.result).toEqual(result);
		});

		it("should discriminate between event types", () => {
			const events: SubtaskProgressEvent[] = [
				{ type: "started", subtaskId: "task-1" },
				{ type: "output", subtaskId: "task-2", text: "log" },
				{ type: "question", subtaskId: "task-3", question: "?", correlationId: "c1" },
				{
					type: "completed",
					subtaskId: "task-4",
					result: { id: "task-4", status: "completed", duration: 100, cleaned: true },
				},
			];

			expect(events[0].type).toBe("started");
			expect(events[1].type).toBe("output");
			expect(events[2].type).toBe("question");
			expect(events[3].type).toBe("completed");
		});
	});

	describe("QuestionPayload structure", () => {
		it("should have required fields", () => {
			const payload: QuestionPayload = {
				subAgentId: "agent-1",
				correlationId: "corr-456",
				question: "What approach should I take?",
			};

			expect(payload.subAgentId).toBe("agent-1");
			expect(payload.correlationId).toBe("corr-456");
			expect(payload.question).toBe("What approach should I take?");
		});

		it("should allow optional context field", () => {
			const payload: QuestionPayload = {
				subAgentId: "agent-1",
				correlationId: "corr-456",
				question: "What approach should I take?",
				context: "Previous task failed due to timeout",
			};

			expect(payload.context).toBe("Previous task failed due to timeout");
		});
	});

	describe("SpawnOptions interface", () => {
		it("should accept all optional fields", () => {
			const options: SpawnOptions = {
				maxConcurrency: 5,
				failFast: true,
				timeout: 60000,
				totalTimeout: 300000,
			};

			expect(options.maxConcurrency).toBe(5);
			expect(options.failFast).toBe(true);
			expect(options.timeout).toBe(60000);
			expect(options.totalTimeout).toBe(300000);
		});

		it("should accept signal option", () => {
			const controller = new AbortController();
			const options: SpawnOptions = {
				signal: controller.signal,
			};

			expect(options.signal).toBe(controller.signal);
		});

		it("should accept onProgress callback", () => {
			const onProgress = (event: SubtaskProgressEvent) => {
				console.log(event.type);
			};
			const options: SpawnOptions = {
				onProgress,
			};

			expect(options.onProgress).toBe(onProgress);
		});

		it("should accept onQuestion callback", () => {
			const onQuestion = (_q: QuestionPayload): Promise<string> | string => {
				return "yes";
			};
			const options: SpawnOptions = {
				onQuestion,
			};

			expect(options.onQuestion).toBe(onQuestion);
		});

		it("should work with empty options object", () => {
			const options: SpawnOptions = {};

			expect(options.maxConcurrency).toBeUndefined();
			expect(options.failFast).toBeUndefined();
		});

		it("should allow undefined for all optional fields", () => {
			const options: SpawnOptions = {
				maxConcurrency: undefined,
				failFast: undefined,
				timeout: undefined,
				totalTimeout: undefined,
				signal: undefined,
				onProgress: undefined,
				onQuestion: undefined,
			};

			expect(Object.keys(options).length).toBe(7);
		});
	});

	describe("Subtask structure", () => {
		it("should require id, description, and task fields", () => {
			const subtask: Subtask = {
				id: "subtask-1",
				description: "Run tests",
				task: "Execute the test suite and report results",
			};

			expect(subtask.id).toBe("subtask-1");
			expect(subtask.description).toBe("Run tests");
			expect(subtask.task).toBe("Execute the test suite and report results");
		});

		it("should allow optional type field", () => {
			const subtask: Subtask = {
				id: "subtask-1",
				description: "Run tests",
				task: "Execute the test suite",
				type: "test",
			};

			expect(subtask.type).toBe("test");
		});

		it("should allow undefined type", () => {
			const subtask: Subtask = {
				id: "subtask-1",
				description: "Run tests",
				task: "Execute the test suite",
			};

			expect(subtask.type).toBeUndefined();
		});
	});

	describe("SubtaskPool.spawn return type", () => {
		it("should return Promise of Map<string, SubtaskResult>", async () => {
			// Create a mock implementation to verify the return type contract
			const mockResults = new Map<string, SubtaskResult>([
				["task-1", { id: "task-1", status: "completed", duration: 100, cleaned: true }],
				["task-2", { id: "task-2", status: "failed", error: "failed", duration: 50, cleaned: false }],
			]);

			const spawnResult: Promise<Map<string, SubtaskResult>> = Promise.resolve(mockResults);
			const resolved = await spawnResult;

			expect(resolved).toBeInstanceOf(Map);
			expect(resolved.get("task-1")?.status).toBe("completed");
			expect(resolved.get("task-2")?.status).toBe("failed");
			expect(resolved.size).toBe(2);
		});

		it("should allow empty result map", async () => {
			const emptyResults = new Map<string, SubtaskResult>();
			const spawnResult: Promise<Map<string, SubtaskResult>> = Promise.resolve(emptyResults);
			const resolved = await spawnResult;

			expect(resolved.size).toBe(0);
		});
	});

	describe("Duration field", () => {
		it("should be a number representing milliseconds", () => {
			const result: SubtaskResult = {
				id: "task-1",
				status: "completed",
				duration: 5000,
				cleaned: true,
			};

			expect(typeof result.duration).toBe("number");
			expect(result.duration).toBe(5000);
		});

		it("should allow zero duration", () => {
			const result: SubtaskResult = {
				id: "task-1",
				status: "completed",
				duration: 0,
				cleaned: true,
			};

			expect(result.duration).toBe(0);
		});
	});
});
