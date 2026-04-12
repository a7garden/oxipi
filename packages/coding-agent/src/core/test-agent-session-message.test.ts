import { describe, expect, it } from "vitest";
import { SessionMessages } from "./sub-agent/sub-agent-executor.js";

describe("Agent session message integration", () => {
	it("should work with SessionMessages for sub-agent result aggregation", () => {
		const session = new SessionMessages();

		// Simulate sub-agent task flow
		session.addUser("Task: implement login");
		session.addAssistant("I will implement the login feature");
		session.addToolResult("tool_call_1", "Created auth.ts");

		// Session can be persisted/restored from message array alone
		const saved = JSON.stringify(session.getMessages());
		const restored = JSON.parse(saved);

		expect(restored.length).toBe(3);
		expect(restored[0].role).toBe("user");
		expect(restored[1].role).toBe("assistant");
		expect(restored[2].role).toBe("user");
	});
});
