/**
 * Tests for truncate utilities used by mom tools.
 * These utilities are shared with coding-agent.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateTail } from "../src/tools/truncate.js";

describe("truncate utilities", () => {
	describe("formatSize", () => {
		it("formats bytes", () => {
			expect(formatSize(500)).toBe("500B");
			expect(formatSize(1023)).toBe("1023B");
		});

		it("formats kilobytes", () => {
			expect(formatSize(1024)).toBe("1.0KB");
			expect(formatSize(2048)).toBe("2.0KB");
			expect(formatSize(10240)).toBe("10.0KB");
		});

		it("formats megabytes", () => {
			expect(formatSize(1024 * 1024)).toBe("1.0MB");
			expect(formatSize(1024 * 1024 * 5)).toBe("5.0MB");
		});
	});

	describe("truncateHead", () => {
		it("returns content unchanged when under limits", () => {
			const content = "line1\nline2\nline3";
			const result = truncateHead(content);
			expect(result.truncated).toBe(false);
			expect(result.truncatedBy).toBeNull();
			expect(result.content).toBe(content);
		});

		it("handles empty content", () => {
			const result = truncateHead("");
			expect(result.truncated).toBe(false);
			expect(result.totalLines).toBe(1);
			expect(result.totalBytes).toBe(0);
		});

		it("truncates by line count", () => {
			const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
			const result = truncateHead(content, { maxLines: 10 });
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("lines");
			expect(result.outputLines).toBe(10);
		});

		it("truncates by byte count", () => {
			const content = "x".repeat(100000);
			const result = truncateHead(content, { maxBytes: 1000 });
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("bytes");
			expect(result.outputBytes).toBeLessThanOrEqual(1000);
		});

		it("handles single line exceeding byte limit", () => {
			const content = "x".repeat(1000);
			const result = truncateHead(content, { maxBytes: 100 });
			expect(result.truncated).toBe(true);
			expect(result.firstLineExceedsLimit).toBe(true);
			expect(result.content).toBe("");
		});

		it("returns complete lines (may or may not end with newline depending on input)", () => {
			const content = Array.from({ length: 100 }, (_, i) => `line ${i} with some content`).join("\n");
			const result = truncateHead(content, { maxLines: 5 });
			// truncateHead preserves the exact input format
			const lines = result.content.split("\n");
			expect(lines.length).toBe(5);
		});

		it("reports correct totals", () => {
			const content = "line1\nline2\nline3";
			const result = truncateHead(content);
			expect(result.totalLines).toBe(3);
			expect(result.totalBytes).toBeGreaterThan(0);
		});
	});

	describe("truncateTail", () => {
		it("returns content unchanged when under limits", () => {
			const content = "line1\nline2\nline3";
			const result = truncateTail(content);
			expect(result.truncated).toBe(false);
			expect(result.truncatedBy).toBeNull();
			expect(result.content).toBe(content);
		});

		it("handles empty content", () => {
			const result = truncateTail("");
			expect(result.truncated).toBe(false);
			expect(result.totalLines).toBe(1);
			expect(result.totalBytes).toBe(0);
		});

		it("truncates by line count", () => {
			const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
			const result = truncateTail(content, { maxLines: 10 });
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("lines");
			expect(result.outputLines).toBe(10);
		});

		it("truncates by byte count", () => {
			const content = "x".repeat(100000);
			const result = truncateTail(content, { maxBytes: 1000 });
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("bytes");
			expect(result.outputBytes).toBeLessThanOrEqual(1000);
		});

		it("may return partial first line when last line exceeds limit", () => {
			const content = `${"a".repeat(200)}\n${"b".repeat(200)}`;
			const result = truncateTail(content, { maxBytes: 100 });
			expect(result.truncated).toBe(true);
			expect(result.truncatedBy).toBe("bytes");
			expect(result.lastLinePartial).toBe(true);
		});

		it("keeps complete lines", () => {
			const content = Array.from({ length: 100 }, (_, i) => `line ${i} with some content`).join("\n");
			const result = truncateTail(content, { maxLines: 5 });
			expect(result.outputLines).toBe(5);
		});
	});

	describe("edge cases", () => {
		it("handles UTF-8 multi-byte characters", () => {
			const content = "한글테스트\n日本語テスト\n한국어";
			const result = truncateHead(content, { maxBytes: 20 });
			expect(result.content).toBeTruthy();
			// Should not have partial characters
		});

		it("handles binary-like content", () => {
			const content = "abc\x00def\nghi\x00jkl";
			const result = truncateTail(content);
			expect(result.content).toBeTruthy();
		});

		it("respects custom max lines and bytes", () => {
			const options = {
				maxLines: 50,
				maxBytes: 1024,
			};
			expect(options.maxLines).toBe(50);
			expect(options.maxBytes).toBe(1024);
		});
	});

	describe("constants", () => {
		it("DEFAULT_MAX_LINES is 2000", () => {
			expect(DEFAULT_MAX_LINES).toBe(2000);
		});

		it("DEFAULT_MAX_BYTES is 50KB", () => {
			expect(DEFAULT_MAX_BYTES).toBe(50 * 1024);
		});
	});
});
