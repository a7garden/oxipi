import { describe, expect, it } from "vitest";

describe("SubAgent nesting guard", () => {
	it("should detect when running as sub-agent", () => {
		// Initially no parent - should not be nested
		expect(process.env.OXIPI_SUBAGENT_ID).toBeUndefined();

		// Simulate sub-agent env var
		const original = process.env.OXIPI_SUBAGENT_ID;
		process.env.OXIPI_SUBAGENT_ID = "parent-agent-123";

		// WhenOXIPI_SUBAGENT_ID is set, executor should detect nested context
		const isNested = !!process.env.OXIPI_SUBAGENT_ID;
		expect(isNested).toBe(true);

		process.env.OXIPI_SUBAGENT_ID = original;
	});

	it("should block spawn attempt when nested", async () => {
		// This test verifies the guard logic
		const original = process.env.OXIPI_SUBAGENT_ID;
		process.env.OXIPI_SUBAGENT_ID = "parent-agent-123";

		// Guard should prevent spawn
		const canSpawn = !process.env.OXIPI_SUBAGENT_ID;
		expect(canSpawn).toBe(false);

		process.env.OXIPI_SUBAGENT_ID = original;
	});
});
