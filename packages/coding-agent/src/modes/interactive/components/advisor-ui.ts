/**
 * OxiPi Advisor TUI Components
 */

import { Container, Markdown, Spacer, Text } from "@oxipi/tui";
import { theme, getMarkdownTheme } from "../theme/theme.js";

export type AdvisorPhase = "idle" | "advisor-planning" | "worker-running" | "completed" | "error";

/**
 * Shows advisor/worker progress inline in the chat
 */
export class AdvisorProgressComponent extends Container {
	private phaseText: Text;
	private advisorBox: Container;
	private workerBox: Container;

	constructor() {
		super();

		this.phaseText = new Text(theme.fg("muted", "◆ Advisor 대기"), 1, 0);
		this.addChild(this.phaseText);

		// Advisor section
		this.advisorBox = new Container();
		this.advisorBox.addChild(new Text(theme.fg("accent", "📋 Advisor"), 1, 0));
		this.addChild(this.advisorBox);

		// Worker section
		this.workerBox = new Container();
		this.workerBox.addChild(new Text(theme.fg("muted", "⚡ Worker (대기)"), 1, 0));
		this.addChild(this.workerBox);
	}

	setAdvisorPlanning(model: string): void {
		this.phaseText.setText(theme.fg("accent", `🤔 Advisor 분석 중 (${model})`));
		this.advisorBox.clear();
		this.advisorBox.addChild(new Text(theme.fg("accent", "📋 Advisor — 분석 중..."), 1, 0));
	}

	updateAdvisorOutput(output: string): void {
		this.advisorBox.clear();
		// Show as markdown for nice rendering
		const preview = output.split("\n").slice(0, 8).join("\n");
		this.advisorBox.addChild(new Text(theme.fg("text", preview), 1, 0));
	}

	setAdvisorDone(): void {
		this.advisorBox.clear();
		this.advisorBox.addChild(new Text(theme.fg("success", "📋 Advisor — 계획 완료 ✓"), 1, 0));
	}

	setExecutorRunning(model: string): void {
		this.phaseText.setText(theme.fg("accent", `⚡ Worker 실행 중 (${model})`));
		this.workerBox.clear();
		this.workerBox.addChild(new Text(theme.fg("accent", "⚡ Worker — 실행 중..."), 1, 0));
	}

	updateExecutorOutput(output: string): void {
		this.workerBox.clear();
		const preview = output.split("\n").slice(0, 8).join("\n");
		this.workerBox.addChild(new Text(theme.fg("text", preview), 1, 0));
	}

	setCompleted(result: string): void {
		this.phaseText.setText(theme.fg("success", "✅ 완료!"));
		this.workerBox.clear();
		this.workerBox.addChild(new Text(theme.fg("success", "⚡ Worker — 완료 ✓"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Markdown(result.substring(0, 1000), 1, 0, getMarkdownTheme()));
	}

	setError(error: string): void {
		this.phaseText.setText(theme.fg("error", `❌ ${error.substring(0, 60)}`));
	}
}

/**
 * Shows parallel WorkTree branches with status indicators
 */
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
		if (b) {
			b.completed = true;
			b.text.setText(theme.fg("success", `● ${id} — 완료`));
		}
		this.updateStatus();
	}

	setBranchFailed(id: string, error: string): void {
		const b = this.branches.get(id);
		if (b) {
			b.failed = true;
			b.text.setText(theme.fg("error", `✗ ${id}: ${error.substring(0, 40)}`));
		}
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