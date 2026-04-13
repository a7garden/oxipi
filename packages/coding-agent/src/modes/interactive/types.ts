/**
 * Shared types, interfaces, and helper functions for interactive mode.
 *
 * This module contains:
 * - Core types for InteractiveMode (options, expandables, keybindings)
 * - Constants (warning messages, auth helpers)
 * - Session message types for chat display
 * - Abstract interfaces for dependency injection (SessionStore, SettingsStore)
 */

import type { ImageContent } from "@oxipi/ai";

// ============================================================================
// Core Types
// ============================================================================

/** Interface for components that can be expanded/collapsed */
export interface Expandable {
	setExpanded(expanded: boolean): void;
}

export function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
};

// ============================================================================
// Constants
// ============================================================================

export const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party usage now draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

export function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

// ============================================================================
// InteractiveMode Options
// ============================================================================

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
}

// ============================================================================
// Keybinding Types
// ============================================================================

export type AppKeybinding =
	| "app.interrupt"
	| "app.quit"
	| "app.cancel"
	| "app.collapseAll"
	| "app.toggleThinking"
	| "app.cycleModel.forward"
	| "app.cycleModel.backward"
	| "app.selectModel"
	| "app.toggleToolOutput"
	| "app.reload"
	| "app.debug";

export type EditorKeybinding =
	| "tui.editor.submit"
	| "tui.editor.newLine"
	| "tui.editor.cursorUp"
	| "tui.editor.cursorDown"
	| "tui.editor.cursorLeft"
	| "tui.editor.cursorRight"
	| "tui.editor.cursorWordLeft"
	| "tui.editor.cursorWordRight"
	| "tui.editor.cursorLineStart"
	| "tui.editor.cursorLineEnd"
	| "tui.editor.deleteForward"
	| "tui.editor.deleteBackward"
	| "tui.editor.deleteWordForward"
	| "tui.editor.deleteWordBackward"
	| "tui.editor.transmit"
	| "tui.editor.clear"
	| "tui.editor.historyUp"
	| "tui.editor.historyDown"
	| "tui.editor.complete"
	| "tui.editor.cancel";

// ============================================================================
// Abstract Interfaces for Dependency Injection
// These interfaces allow components to be decoupled from specific implementations
// ============================================================================

/**
 * Abstract interface for session storage.
 * Used by InteractiveMode to be independent of coding-agent's SessionManager.
 *
 * This enables:
 * - Different session storage backends (file, database, remote)
 * - Testing without file system dependencies
 * - Alternative session formats (Slack, Discord, etc.)
 */
export interface SessionStore {
	/** Get all session entries */
	getEntries(): SessionEntry[];

	/** Get session info (name, path, stats) */
	getSessionInfo(): SessionInfo;

	/** Get current working directory */
	getCwd(): string;

	/** Get session name */
	getSessionName(): string | undefined;

	/** Append session info entry */
	appendSessionInfo(name: string): void;
}

/**
 * Session entry types.
 * Matches coding-agent's SessionEntry format.
 */
export interface SessionEntry {
	id: string;
	parentId?: string;
	timestamp: number;
	type:
		| "message"
		| "custom"
		| "file"
		| "session-info"
		| "model-change"
		| "thinking-level-change"
		| "compaction"
		| "branch-summary";
	message?: unknown;
}

export interface SessionInfo {
	name?: string;
	path: string;
	cwd?: string;
	createdAt: number;
	lastModifiedAt: number;
}

/**
 * Abstract interface for settings storage.
 * Used by both InteractiveMode and mom for configuration management.
 */
export interface SettingsStore {
	getTheme(): string;
	setTheme(name: string): void;

	getHideThinkingBlock(): boolean;
	setHideThinkingBlock(value: boolean): void;

	getEditorPaddingX(): number;
	setEditorPaddingX(value: number): void;

	getAutocompleteMaxVisible(): number;
	setAutocompleteMaxVisible(value: number): void;

	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(value: boolean): void;

	getClearOnShrink(): boolean;
	setClearOnShrink(value: boolean): void;

	getShowImages(): boolean;
	setShowImages(value: boolean): void;
}

// ============================================================================
// Skill Loading Types
// These types support both coding-agent and mom to load and format skills
// ============================================================================

export interface SkillInfo {
	name: string;
	description: string;
	path: string;
	source: string;
}

export interface LoadSkillsOptions {
	dir: string;
	source: string;
}

export interface LoadedSkills {
	skills: SkillInfo[];
	errors: string[];
}

// ============================================================================
// Helper Functions for Both coding-agent and mom
// ============================================================================

/**
 * Normalize Slack message text by stripping timestamp prefix.
 *
 * Format: [YYYY-MM-DD HH:MM:SS+HH:MM] [username]: text
 *
 * @param text - The message text to normalize
 * @returns Normalized text without timestamp prefix
 */
export function normalizeSlackMessageText(text: string): string {
	// Strip timestamp prefix
	let normalized = text.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");

	// Strip attachments section
	const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
	if (attachmentsIdx !== -1) {
		normalized = normalized.substring(0, attachmentsIdx);
	}

	return normalized;
}

/**
 * Format skills as a prompt string.
 *
 * @param skills - Array of skill information
 * @returns Formatted skills string for system prompt
 */
export function formatSkillsForPrompt(skills: SkillInfo[]): string {
	if (skills.length === 0) {
		return "";
	}

	const lines = skills.map((skill) => {
		return `- ${skill.name}: ${skill.description}`;
	});

	return `\nAvailable skills:\n${lines.join("\n")}\n`;
}
