/**
 * Advisor UI Components - Placeholder (simplified for initial build)
 * TODO: Full implementation with real TUI components
 */

import { Container, Text } from "@oxipi/tui";
import { theme } from "../theme/theme.js";

export type AdvisorPhase = "idle" | "advisor-planning" | "executor-running" | "completed" | "error";

export interface AdvisorProgress {
	phase: AdvisorPhase;
	advisorOutput?: string;
	executorOutput?: string;
	iterations: number;
	maxIterations: number;
	error?: string;
}

/**
 * Simple Advisor Progress Component
 */
export class AdvisorProgressComponent extends Container {
	private phaseText: Text;
	private contentText: Text;

	constructor() {
		super();
		this.phaseText = new Text(theme.fg("muted", "◆ Advisor 대기"), 1);
		this.contentText = new Text("", 1);
		this.addChild(this.phaseText);
		this.addChild(this.contentText);
	}

	setIdle(): void {
		this.phaseText.setText(theme.fg("muted", "◆ 대기"));
		this.contentText.setText("");
	}

	setAdvisorPlanning(model: string): void {
		this.phaseText.setText(`🤔 Advisor (${model})`);
		this.contentText.setText(theme.fg("muted", "Planning..."));
	}

	updateAdvisorOutput(output: string): void {
		this.contentText.setText(output.substring(0, 100));
	}

	setExecutorRunning(model: string): void {
		this.phaseText.setText(`⚡ Executor (${model})`);
		this.contentText.setText(theme.fg("muted", "Running..."));
	}

	updateExecutorOutput(output: string): void {
		this.contentText.setText(output.substring(0, 100));
	}

	setIteration(_current: number, _max: number): void {
		// No-op for now
	}

	setCompleted(result: string): void {
		this.phaseText.setText(theme.fg("success", "✅ 완료"));
		this.contentText.setText(result.substring(0, 200));
	}

	setError(error: string): void {
		this.phaseText.setText(theme.fg("error", "❌ 오류"));
		this.contentText.setText(error.substring(0, 100));
	}

	getProgress(): AdvisorProgress | undefined {
		return undefined;
	}
}

/**
 * WorkTree Progress Component
 */
export class WorkTreeProgressComponent extends Container {
	private statusText: Text;

	constructor(branchIds: string[]) {
		super();
		this.statusText = new Text(theme.fg("accent", `🌳 WorkTree: ${branchIds.length} 브랜치`), 1);
		this.addChild(this.statusText);
	}

	setBranchRunning(_id: string): void {}
	setBranchCompleted(_id: string): void {}
	setBranchFailed(_id: string, _error: string): void {}
}
