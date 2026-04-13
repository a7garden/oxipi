/**
 * Tests for format utilities in web-ui.
 */

import type { Usage } from "@oxipi/ai";
import { describe, expect, it } from "vitest";
import { formatCost, formatModelCost, formatTokenCount, formatUsage } from "../src/utils/format.js";

describe("format utilities", () => {
	describe("formatCost", () => {
		it("formats zero cost", () => {
			expect(formatCost(0)).toBe("$0.0000");
		});

		it("formats small cost", () => {
			expect(formatCost(0.0012)).toBe("$0.0012");
		});

		it("formats typical cost", () => {
			expect(formatCost(0.05)).toBe("$0.0500");
		});

		it("formats larger cost", () => {
			expect(formatCost(5.5)).toBe("$5.5000");
		});
	});

	describe("formatTokenCount", () => {
		it("formats numbers below 1000", () => {
			expect(formatTokenCount(0)).toBe("0");
			expect(formatTokenCount(500)).toBe("500");
			expect(formatTokenCount(999)).toBe("999");
		});

		it("formats numbers 1000-9999 with one decimal", () => {
			expect(formatTokenCount(1000)).toBe("1.0k");
			expect(formatTokenCount(1500)).toBe("1.5k");
			expect(formatTokenCount(9999)).toBe("10.0k");
		});

		it("formats numbers 10000+ as rounded k", () => {
			expect(formatTokenCount(10000)).toBe("10k");
			expect(formatTokenCount(50000)).toBe("50k");
			expect(formatTokenCount(100000)).toBe("100k");
		});
	});

	describe("formatUsage", () => {
		it("returns empty string for empty usage", () => {
			expect(formatUsage({})).toBe("");
			expect(formatUsage(undefined as any)).toBe("");
		});

		it("formats input tokens", () => {
			const usage: Usage = { input: 1000 };
			expect(formatUsage(usage)).toBe("↑1.0k");
		});

		it("formats output tokens", () => {
			const usage: Usage = { output: 2000 };
			expect(formatUsage(usage)).toBe("↓2.0k");
		});

		it("formats all token types", () => {
			const usage: Usage = {
				input: 1000,
				output: 2000,
				cacheRead: 500,
				cacheWrite: 100,
			};
			const result = formatUsage(usage);
			expect(result).toContain("↑1.0k");
			expect(result).toContain("↓2.0k");
			expect(result).toContain("R500");
			expect(result).toContain("W100");
		});

		it("includes cost when present", () => {
			const usage: Usage = {
				input: 1000,
				cost: { total: 0.005 },
			};
			expect(formatUsage(usage)).toContain("$0.0050");
		});

		it("handles partial usage", () => {
			const usage: Usage = { input: 100, output: 50 };
			expect(formatUsage(usage)).toBe("↑100 ↓50");
		});
	});

	describe("formatModelCost", () => {
		// Note: These tests skip i18n-dependent cases since localStorage is not available in test environment
		// formatModelCost uses i18n() which requires browser environment

		it("formats both costs", () => {
			const result = formatModelCost({ input: 3, output: 5 });
			expect(result).toBe("$3/$5");
		});
	});
});
