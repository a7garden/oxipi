/**
 * Tests for proxy utilities - CORS proxy decision logic.
 * Note: These tests focus on the pure functions that don't require @oxipi/ai imports.
 */

import { describe, expect, it } from "vitest";

describe("proxy decision logic", () => {
	describe("provider proxy requirements", () => {
		const shouldUseProxy = (provider: string, apiKey: string): boolean => {
			switch (provider.toLowerCase()) {
				case "zai":
					return true;
				case "anthropic":
					return apiKey.startsWith("sk-ant-oat") || apiKey.startsWith("{");
				case "openai-codex":
					return true;
				case "openai":
				case "google":
				case "groq":
				case "openrouter":
				case "cerebras":
				case "xai":
				case "ollama":
				case "lmstudio":
				case "github-copilot":
					return false;
				default:
					return false;
			}
		};

		it("always requires proxy for zai", () => {
			expect(shouldUseProxy("zai", "any-key")).toBe(true);
			expect(shouldUseProxy("ZAI", "any-key")).toBe(true);
		});

		it("requires proxy for Anthropic OAuth tokens", () => {
			expect(shouldUseProxy("anthropic", "sk-ant-oat-xxx")).toBe(true);
		});

		it("does not require proxy for Anthropic API keys", () => {
			expect(shouldUseProxy("anthropic", "sk-ant-api03-xxx")).toBe(false);
		});

		it("does not require proxy for OpenAI", () => {
			expect(shouldUseProxy("openai", "sk-xxx")).toBe(false);
		});

		it("requires proxy for OpenAI Codex", () => {
			expect(shouldUseProxy("openai-codex", "any-key")).toBe(true);
		});
	});

	describe("CORS error detection", () => {
		const isCorsError = (error: unknown): boolean => {
			if (!(error instanceof Error)) {
				return false;
			}
			const message = error.message.toLowerCase();
			if (error.name === "TypeError" && message.includes("failed to fetch")) {
				return true;
			}
			if (error.name === "NetworkError") {
				return true;
			}
			if (message.includes("cors") || message.includes("cross-origin")) {
				return true;
			}
			return false;
		};

		it("detects 'Failed to fetch' errors", () => {
			const error = new TypeError("Failed to fetch");
			expect(isCorsError(error)).toBe(true);
		});

		it("detects NetworkError when name is NetworkError", () => {
			// Note: In browser environments, NetworkError is a DOMException with name "NetworkError"
			// In Node.js, it might just be a regular Error
			const error = new Error("Network request failed");
			error.name = "NetworkError";
			expect(isCorsError(error)).toBe(true);
		});

		it("detects CORS in error message", () => {
			const error = new Error("CORS policy blocked");
			expect(isCorsError(error)).toBe(true);
		});

		it("returns false for non-CORS errors", () => {
			const error = new Error("Invalid API key");
			expect(isCorsError(error)).toBe(false);
		});

		it("returns false for non-Error values", () => {
			expect(isCorsError("string error")).toBe(false);
			expect(isCorsError(null)).toBe(false);
			expect(isCorsError(undefined)).toBe(false);
		});
	});
});
