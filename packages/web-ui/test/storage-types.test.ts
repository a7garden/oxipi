/**
 * Tests for storage types and interfaces.
 */

import { describe, expect, it } from "vitest";
import type { StorageBackend, StorageTransaction } from "../src/storage/types.js";

describe("storage types", () => {
	describe("StorageBackend interface", () => {
		it("is a valid interface type", () => {
			// Test that the type is properly exported
			const backend: StorageBackend = {
				get: async () => null,
				set: async () => {},
				delete: async () => {},
				keys: async () => [],
			};
			expect(backend).toBeTruthy();
		});
	});

	describe("StorageTransaction interface", () => {
		it("is a valid interface type", () => {
			const tx: StorageTransaction = {
				get: async () => null,
				set: async () => {},
				delete: async () => {},
			};
			expect(tx).toBeTruthy();
		});
	});
});
