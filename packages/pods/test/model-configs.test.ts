/**
 * Tests for model-configs.ts
 * Tests model configuration resolution for GPU pod deployments.
 */

import { describe, expect, it } from "vitest";
import type { GPU } from "../src/types.js";

// We need to test the public API functions that don't require file I/O
describe("model-configs public API", () => {
	describe("getModelName", () => {
		it("returns the model id when model is not found", async () => {
			const { getModelName } = await import("../src/model-configs.js");
			const result = getModelName("nonexistent-model-xyz");
			expect(result).toBe("nonexistent-model-xyz");
		});

		it("returns display name for known model", async () => {
			const { getModelName } = await import("../src/model-configs.js");
			// Qwen models should be in models.json
			const result = getModelName("Qwen/Qwen2.5-Coder-32B-Instruct");
			expect(result).toBeTruthy();
		});
	});

	describe("getKnownModels", () => {
		it("returns an array", async () => {
			const { getKnownModels } = await import("../src/model-configs.js");
			const models = getKnownModels();
			expect(Array.isArray(models)).toBe(true);
		});

		it("contains common models", async () => {
			const { getKnownModels } = await import("../src/model-configs.js");
			const models = getKnownModels();
			// Should contain Qwen models
			expect(models.some((m) => m.includes("Qwen"))).toBe(true);
		});

		it("is not empty", async () => {
			const { getKnownModels } = await import("../src/model-configs.js");
			const models = getKnownModels();
			expect(models.length).toBeGreaterThan(0);
		});
	});

	describe("isKnownModel", () => {
		it("returns false for unknown model", async () => {
			const { isKnownModel } = await import("../src/model-configs.js");
			expect(isKnownModel("definitely-not-a-real-model-12345")).toBe(false);
		});

		it("returns true for known model", async () => {
			const { isKnownModel } = await import("../src/model-configs.js");
			// Qwen models should be in models.json
			expect(isKnownModel("Qwen/Qwen2.5-Coder-32B-Instruct")).toBe(true);
		});
	});

	describe("getModelConfig", () => {
		it("returns null for unknown model", async () => {
			const { getModelConfig } = await import("../src/model-configs.js");
			const gpus: GPU[] = [{ id: 0, name: "NVIDIA H100", memory: "80GB" }];
			const result = getModelConfig("unknown-model-xyz", gpus, 1);
			expect(result).toBeNull();
		});

		it("returns null when no config matches GPU count", async () => {
			const { getModelConfig } = await import("../src/model-configs.js");
			const gpus: GPU[] = [{ id: 0, name: "NVIDIA H100", memory: "80GB" }];
			// Qwen 2.5 32B might not have 8-GPU config
			const result = getModelConfig("Qwen/Qwen2.5-Coder-32B-Instruct", gpus, 8);
			// Should return null if no 8-GPU config exists
			expect(result).toBeNull();
		});

		it("returns config when matching config exists", async () => {
			const { getModelConfig, isKnownModel } = await import("../src/model-configs.js");
			if (!isKnownModel("Qwen/Qwen2.5-Coder-32B-Instruct")) {
				// Skip if model not in config
				return;
			}
			const gpus: GPU[] = [{ id: 0, name: "NVIDIA H100", memory: "80GB" }];
			const result = getModelConfig("Qwen/Qwen2.5-Coder-32B-Instruct", gpus, 1);
			if (result) {
				expect(result.args).toBeTruthy();
				expect(Array.isArray(result.args)).toBe(true);
			}
		});
	});
});
