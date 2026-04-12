import type { Message } from "@oxipi/ai";
import { describe, expect, it } from "vitest";

describe("Message-based state", () => {
	it("should maintain message array as session state", () => {
		// Simulate message array state (like claw-code conversation.rs)
		const messages: Message[] = [];

		// Add user message
		messages.push({
			role: "user",
			content: [{ type: "text", text: "task: fix bug" }],
			timestamp: Date.now(),
		});

		// Add assistant message
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: "looking at the issue" }],
			timestamp: Date.now(),
		});

		// Add tool result
		messages.push({
			role: "user", // tool results are injected as user messages
			content: [{ type: "tool_result", tool_use_id: "abc", content: "file contents" }],
			timestamp: Date.now(),
		});

		expect(messages.length).toBe(3);
		expect(messages[0].role).toBe("user");
		expect(messages[1].role).toBe("assistant");
		expect(messages[2].role).toBe("user"); // tool result as user
	});

	it("should reconstruct full state from message history", () => {
		// Key insight: the entire session state is just the message array
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "fix login" }], timestamp: 1000 },
			{ role: "assistant", content: [{ type: "text", text: "I will fix" }], timestamp: 1001 },
		];

		// State = message array (no separate iteration counter needed)
		const state = { messages };

		expect(state.messages.length).toBe(2);
		// Can reconstruct full context from just messages
		expect(state.messages[0].content[0]).toEqual({ type: "text", text: "fix login" });
	});
});
