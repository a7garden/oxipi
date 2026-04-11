/**
 * OxiPi Advisor TUI Components — streaming support
 */

import { Container, Markdown, Spacer, Text } from "@oxipi/tui";
import { theme, getMarkdownTheme } from "../theme/theme.js";

// =============================================================================
// Advisor Progress — shows streaming phases in chat
// =============================================================================

export class AdvisorProgressComponent extends Container {
	private phaseText: Text;
	private advisorSection: Container;
	private advisorContent: Text;
	private advisorTools: Text;
	private workerSection: Container;
	private workerContent: Text;
	private workerTools: Text;
	private resultSection: Container;

	constructor() {
		super();

		this.phaseText = new Text(theme.fg("muted", "◆ Advisor 대기"), 1, 0);
		this.addChild(this.phaseText);

		// Advisor
		this.advisorSection = new Container();
		this.advisorContent = new Text("", 1, 0);
		this.advisorTools = new Text("", 1, 0);
		this.advisorSection.addChild(new Text(theme.fg("accent", "📋 Advisor"), 1, 0));
		this.advisorSection.addChild(this.advisorContent);
		this.advisorSection.addChild(this.advisorTools);
		this.addChild(this.advisorSection);

		// Worker
		this.workerSection = new Container();
		this.workerContent = new Text("", 1, 0);
		this.workerTools = new Text("", 1, 0);
		this.workerSection.addChild(new Text(theme.fg("muted", "⚡ Worker (대기)"), 1, 0));
		this.workerSection.addChild(this.workerContent);
		this.workerSection.addChild(this.workerTools);
		this.addChild(this.workerSection);

		// Result
		this.resultSection = new Container();
		this.addChild(this.resultSection);
	}

	// --- Advisor ---

	setAdvisorPlanning(model: string): void {
		this.phaseText.setText(theme.fg("accent", `🤔 Advisor 분석 중 (${model})`));
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("accent", "📋 Advisor — 분석 중..."), 1, 0));
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("muted", "⚡ Worker (대기)"), 1, 0));
	}

	updateAdvisorStream(text: string): void {
		const preview = text.split("\n").slice(-6).join("\n");
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("accent", "📋 Advisor"), 1, 0));
		this.advisorSection.addChild(new Text(theme.fg("text", preview), 1, 0));
		this.advisorSection.addChild(this.advisorTools);
	}

	setAdvisorTool(tool: string): void {
		this.advisorTools.setText(theme.fg("dim", `  🔧 ${tool}...`));
	}

	setAdvisorDone(): void {
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("success", "📋 Advisor — 계획 완료 ✓"), 1, 0));
		this.advisorTools.setText("");
	}

	// --- Worker ---

	setExecutorRunning(model: string): void {
		this.phaseText.setText(theme.fg("accent", `⚡ Worker 실행 중 (${model})`));
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("accent", "⚡ Worker — 실행 중..."), 1, 0));
	}

	updateWorkerStream(text: string): void {
		const preview = text.split("\n").slice(-6).join("\n");
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("accent", "⚡ Worker"), 1, 0));
		this.workerSection.addChild(new Text(theme.fg("text", preview), 1, 0));
		this.workerSection.addChild(this.workerTools);
	}

	setWorkerTool(tool: string): void {
		this.workerTools.setText(theme.fg("dim", `  🔧 ${tool}...`));
	}

	// --- Result ---

	setCompleted(result: string): void {
		this.phaseText.setText(theme.fg("success", "✅ 완료!"));
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("success", "⚡ Worker — 완료 ✓"), 1, 0));
		this.resultSection.clear();
		this.resultSection.addChild(new Spacer(1));
		this.resultSection.addChild(new Markdown(result.substring(0, 1500), 1, 0, getMarkdownTheme()));
	}

	setError(error: string): void {
		this.phaseText.setText(theme.fg("error", `❌ ${error.substring(0, 80)}`));
	}
}

// =============================================================================
// WorkTree Progress — parallel branches
// =============================================================================

export class WorkTreeProgressComponent extends Container {
	private branches: Map<string, { text: Text; completed: boolean; failed: boolean }> = new Map();
	private statusLine: Text;

	constructor(branchIds: string[]) {
		super();

		this.addChild(new Text(theme.fg("accent", `🌳 WorkTree — ${branchIds.length} 병렬 브랜치`), 1, 0));
		this.addChild(new Spacer(1));

		for (const id of branchIds) {
			const t = new Text(theme.fg("muted", `○ ${id}`), 1, 0);
			this.branches.set(id, { text: t, completed: false, failed: false });
			this.addChild(t);
		}

		this.statusLine = new Text("", 1, 0);
		this.addChild(this.statusLine);
	}

	setBranchRunning(id: string): void {
		const b = this.branches.get(id);
		if (b) b.text.setText(theme.fg("accent", `◐ ${id} — 실행 중`));
	}

	setBranchCompleted(id: string): void {
		const b = this.branches.get(id);
		if (b) { b.completed = true; b.text.setText(theme.fg("success", `● ${id} — 완료`)); }
		this.updateStatus();
	}

	setBranchFailed(id: string, error: string): void {
		const b = this.branches.get(id);
		if (b) { b.failed = true; b.text.setText(theme.fg("error", `✗ ${id}: ${error.substring(0, 40)}`)); }
		this.updateStatus();
	}

	private updateStatus(): void {
		let completed = 0;
		let failed = 0;
		for (const [, b] of this.branches) {
			if (b.completed) completed++;
			else if (b.failed) failed++;
		}
		this.statusLine.setText(
			theme.fg("muted", `${completed}/${this.branches.size} 완료${failed > 0 ? `, ${failed} 실패` : ""}`),
		);
	}
}