/**
 * Interactive Mode Command Handlers
 * Extracts command handling logic from InteractiveMode for better organization.
 */

import type { Container, TUI } from "@oxipi/tui";
import { Spacer, Text } from "@oxipi/tui";
import type { AgentSession } from "../../core/agent-session.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import { theme } from "./theme/theme.js";

export interface InteractiveModeCommandsDeps {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	ui: TUI;
	chatContainer: Container;
	statusContainer: Container;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	showWarning: (message: string) => void;
	updateTerminalTitle: () => void;
}

export class InteractiveModeCommands {
	private session: AgentSession;
	private sessionManager: SessionManager;
	private settingsManager: SettingsManager;
	private ui: TUI;
	private chatContainer: Container;
	private statusContainer: Container;
	private showStatus: (message: string) => void;
	private showError: (message: string) => void;
	private showWarning: (message: string) => void;
	private updateTerminalTitle: () => void;

	constructor(deps: InteractiveModeCommandsDeps) {
		this.session = deps.session;
		this.sessionManager = deps.sessionManager;
		this.settingsManager = deps.settingsManager;
		this.ui = deps.ui;
		this.chatContainer = deps.chatContainer;
		this.statusContainer = deps.statusContainer;
		this.showStatus = deps.showStatus;
		this.showError = deps.showError;
		this.showWarning = deps.showWarning;
		this.updateTerminalTitle = deps.updateTerminalTitle;
	}

	async handleExportCommand(text: string): Promise<void> {
		const parts = text.split(/\s+/);
		const outputPath = parts.length > 1 ? parts[1] : undefined;

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = this.session.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.session.exportToHtml(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		this.statusContainer.clear();

		try {
			await this.session.compact(customInstructions);
		} catch {
			// Ignore, will be emitted as an event
		}
	}

	async handlePlannerCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showPlannerSelector();
			return;
		}

		// Try to set the planner model directly
		try {
			this.settingsManager.setPlannerModel(searchTerm);
			this.showStatus(`Planner model: ${searchTerm}`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showPlannerSelector(): void {
		// For now, show available models that could be used as planners
		const currentPlanner = this.settingsManager.getPlannerModel();
		this.chatContainer.addChild(new Spacer(1));
		let info = `${theme.bold("Planner Model")}\n\n`;
		info += `${theme.fg("dim", "Current:")} ${currentPlanner ?? "Not set"}\n\n`;
		info += `${theme.fg("dim", "Usage:")} /planner <provider/model>\n`;
		info += `${theme.fg("dim", "Example:")} /planner zai/glm-5.1`;
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}
}
