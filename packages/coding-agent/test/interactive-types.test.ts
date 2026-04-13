/**
 * Tests for interactive mode types and utilities.
 */

import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_SUBSCRIPTION_AUTH_WARNING,
	formatSkillsForPrompt,
	type InteractiveModeOptions,
	isAnthropicSubscriptionAuthKey,
	isExpandable,
	normalizeSlackMessageText,
	type SessionStore,
	type SettingsStore,
	type SkillInfo,
} from "../src/modes/interactive/types.js";

describe("interactive types", () => {
	describe("isExpandable", () => {
		it("returns true for objects with setExpanded method", () => {
			const obj = { setExpanded: (_expanded: boolean) => {} };
			expect(isExpandable(obj)).toBe(true);
		});

		it("returns false for objects without setExpanded", () => {
			const obj = { foo: "bar" };
			expect(isExpandable(obj)).toBe(false);
		});

		it("returns false for null", () => {
			expect(isExpandable(null)).toBe(false);
		});

		it("returns false for undefined", () => {
			expect(isExpandable(undefined)).toBe(false);
		});

		it("returns false for primitives", () => {
			expect(isExpandable("string")).toBe(false);
			expect(isExpandable(123)).toBe(false);
			expect(isExpandable(true)).toBe(false);
		});

		it("returns false when setExpanded is not a function", () => {
			const obj = { setExpanded: "not a function" };
			expect(isExpandable(obj)).toBe(false);
		});
	});

	describe("isAnthropicSubscriptionAuthKey", () => {
		it("returns true for OAuth tokens starting with sk-ant-oat", () => {
			expect(isAnthropicSubscriptionAuthKey("sk-ant-oat-xxx")).toBe(true);
		});

		it("returns true for tokens starting with sk-ant-oat", () => {
			expect(isAnthropicSubscriptionAuthKey("sk-ant-oat-xxx")).toBe(true);
		});

		it("returns false for regular API keys", () => {
			expect(isAnthropicSubscriptionAuthKey("sk-ant-api03-xxx")).toBe(false);
			expect(isAnthropicSubscriptionAuthKey("sk-ant-xxx")).toBe(false);
		});

		it("returns false for other providers", () => {
			expect(isAnthropicSubscriptionAuthKey("sk-openai-xxx")).toBe(false);
			const emptyKey = "";
			expect(isAnthropicSubscriptionAuthKey(emptyKey)).toBe(false);
		});

		it("returns false for undefined", () => {
			expect(isAnthropicSubscriptionAuthKey(undefined)).toBe(false);
		});
	});

	describe("ANTHROPIC_SUBSCRIPTION_AUTH_WARNING", () => {
		it("contains key information", () => {
			expect(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING).toContain("Anthropic subscription auth");
			expect(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING).toContain("extra usage");
			expect(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING).toContain("claude.ai/settings/usage");
		});
	});

	describe("InteractiveModeOptions", () => {
		it("can be created with no options", () => {
			const options: InteractiveModeOptions = {};
			expect(options.migratedProviders).toBeUndefined();
			expect(options.initialMessage).toBeUndefined();
		});

		it("can be created with all options", () => {
			const options: InteractiveModeOptions = {
				migratedProviders: ["anthropic", "openai"],
				modelFallbackMessage: "Model not found",
				initialMessage: "Hello",
				initialImages: [],
				initialMessages: ["Follow-up"],
				verbose: true,
			};
			expect(options.migratedProviders).toHaveLength(2);
			expect(options.verbose).toBe(true);
		});
	});

	describe("SessionStore interface", () => {
		it("can be implemented as a mock", () => {
			const mockStore: SessionStore = {
				getEntries: () => [],
				getSessionInfo: () => ({
					path: "/test/session.jsonl",
					createdAt: Date.now(),
					lastModifiedAt: Date.now(),
				}),
				getCwd: () => "/test",
				getSessionName: () => "test-session",
				appendSessionInfo: () => {},
			};
			expect(mockStore.getCwd()).toBe("/test");
			expect(mockStore.getSessionName()).toBe("test-session");
		});
	});

	describe("SettingsStore interface", () => {
		it("can be implemented as a mock", () => {
			const mockSettings: SettingsStore = {
				getTheme: () => "dark",
				setTheme: () => {},
				getHideThinkingBlock: () => false,
				setHideThinkingBlock: () => {},
				getEditorPaddingX: () => 1,
				setEditorPaddingX: () => {},
				getAutocompleteMaxVisible: () => 10,
				setAutocompleteMaxVisible: () => {},
				getShowHardwareCursor: () => false,
				setShowHardwareCursor: () => {},
				getClearOnShrink: () => true,
				setClearOnShrink: () => {},
				getShowImages: () => true,
				setShowImages: () => {},
			};
			expect(mockSettings.getTheme()).toBe("dark");
			expect(mockSettings.getEditorPaddingX()).toBe(1);
		});
	});

	// ========================================================================
	// Helper Functions
	// ========================================================================

	describe("normalizeSlackMessageText", () => {
		it("strips timestamp prefix from message", () => {
			const text = "[2024-01-01 12:00:00+00:00] [user]: Hello world";
			const result = normalizeSlackMessageText(text);
			expect(result).toBe("[user]: Hello world");
		});

		it("strips attachments section", () => {
			const text = "[2024-01-01 12:00:00+00:00] [user]: Hello\n\n<slack_attachments>\nfile.pdf";
			const result = normalizeSlackMessageText(text);
			expect(result).toBe("[user]: Hello");
		});

		it("returns original text if no timestamp", () => {
			const text = "Hello world";
			const result = normalizeSlackMessageText(text);
			expect(result).toBe("Hello world");
		});
	});

	describe("formatSkillsForPrompt", () => {
		it("returns empty string for no skills", () => {
			const result = formatSkillsForPrompt([]);
			expect(result).toBe("");
		});

		it("formats skills as bullet list", () => {
			const skills: SkillInfo[] = [
				{ name: "skill1", description: "Does thing 1", path: "/path/1", source: "workspace" },
				{ name: "skill2", description: "Does thing 2", path: "/path/2", source: "channel" },
			];
			const result = formatSkillsForPrompt(skills);
			expect(result).toContain("Available skills:");
			expect(result).toContain("- skill1:");
			expect(result).toContain("- skill2:");
		});
	});
});
