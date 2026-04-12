/**
 * OxiPi Advisor TUI Components
 */

import { Container, Markdown, Spacer, Text } from "@oxipi/tui";
import type { HistoryEntry, SubAgentTask, TaskRouting, TokenUsage } from "../../../core/advisor/index.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

function fmtUsage(u: TokenUsage): string {
	const cost = u.estimatedCost > 0 ? ` ($${u.estimatedCost.toFixed(4)})` : "";
	return `${(u.totalTokens / 1000).toFixed(1)}k tokens${cost}`;
}

export class AdvisorProgressComponent extends Container {
	private phaseText: Text;
	private advisorSection: Container;
	private workerSection: Container;
	private reviewSection: Container;
	private splitSection: Container;
	private usageText: Text;
	private resultSection: Container;
	constructor() {
		super();
		this.phaseText = new Text(theme.fg("muted", "Advisor waiting"), 1, 0);
		this.addChild(this.phaseText);
		this.advisorSection = new Container();
		this.addChild(this.advisorSection);
		this.workerSection = new Container();
		this.addChild(this.workerSection);
		this.reviewSection = new Container();
		this.addChild(this.reviewSection);
		this.splitSection = new Container();
		this.addChild(this.splitSection);
		this.usageText = new Text("", 1, 0);
		this.addChild(this.usageText);
		this.resultSection = new Container();
		this.addChild(this.resultSection);
	}
	setAdvisorPlanning(model: string): void {
		this.phaseText.setText(theme.fg("accent", `Advisor analyzing (${model})`));
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("accent", "Advisor - analyzing..."), 1, 0));
	}
	updateAdvisorStream(text: string): void {
		const preview = text.split("\n").slice(-6).join("\n");
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("accent", "Advisor"), 1, 0));
		this.advisorSection.addChild(new Text(theme.fg("text", preview), 1, 0));
	}
	setAdvisorTool(tool: string): void {
		this.advisorSection.addChild(new Text(theme.fg("dim", `  tool: ${tool}...`), 1, 0));
	}
	setAdvisorDone(): void {
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("success", "Advisor - done"), 1, 0));
	}
	setExecutorRunning(model: string, iteration: number): void {
		this.phaseText.setText(theme.fg("accent", `Worker running (${model}) #${iteration}`));
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("accent", `Worker #${iteration} - running...`), 1, 0));
	}
	updateWorkerStream(text: string): void {
		const preview = text.split("\n").slice(-6).join("\n");
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("accent", "Worker"), 1, 0));
		this.workerSection.addChild(new Text(theme.fg("text", preview), 1, 0));
	}
	setWorkerTool(tool: string): void {
		this.workerSection.addChild(new Text(theme.fg("dim", `  tool: ${tool}...`), 1, 0));
	}
	setWorkerDone(iteration: number): void {
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("success", `Worker #${iteration} - done`), 1, 0));
	}
	setReviewRunning(model: string): void {
		this.reviewSection.clear();
		this.reviewSection.addChild(new Text(theme.fg("warning", `Review (${model})...`), 1, 0));
	}
	setReviewDone(approved: boolean, _feedback: string): void {
		this.reviewSection.clear();
		if (approved) {
			this.reviewSection.addChild(new Text(theme.fg("success", "Review - approved"), 1, 0));
		} else {
			this.reviewSection.addChild(new Text(theme.fg("warning", "Review - needs fix"), 1, 0));
		}
	}
	setSplitStarted(subTasks: SubAgentTask[]): void {
		this.splitSection.clear();
		this.splitSection.addChild(new Text(theme.fg("accent", `Split into ${subTasks.length} subtasks`), 1, 0));
	}
	setSplitProgress(id: string, status: "running" | "completed" | "failed"): void {
		const icon = status === "completed" ? "ok" : status === "failed" ? "X" : "...";
		this.splitSection.addChild(new Text(theme.fg("muted", `  ${icon} ${id}`), 1, 0));
	}
	updateUsage(phase: string, usage: TokenUsage): void {
		this.usageText.setText(theme.fg("dim", `  ${phase}: ${fmtUsage(usage)}`));
	}
	setCompleted(result: string, totalUsage: TokenUsage, duration: number): void {
		this.phaseText.setText(theme.fg("success", "Completed!"));
		this.resultSection.clear();
		this.resultSection.addChild(new Spacer(1));
		this.resultSection.addChild(
			new Text(theme.fg("dim", `${(duration / 1000).toFixed(1)}s | ${fmtUsage(totalUsage)}`), 1, 0),
		);
		this.resultSection.addChild(new Spacer(1));
		this.resultSection.addChild(new Markdown(result.substring(0, 2000), 1, 0, getMarkdownTheme()));
	}
	setError(error: string): void {
		this.phaseText.setText(theme.fg("error", `Error: ${error.substring(0, 80)}`));
	}
}

export class AdvisorConfigComponent extends Container {
	constructor(routings: Array<{ type: string; routing: TaskRouting }>) {
		super();
		this.addChild(new Text(theme.fg("accent", "Advisor Routing Config"), 1, 0));
		this.addChild(new Spacer(1));
		for (const { type, routing } of routings) {
			this.addChild(new Text(theme.fg("text", `  ${type}`) + theme.fg("dim", ` - ${routing.description}`), 1, 0));
			this.addChild(
				new Text(theme.fg("muted", `    A: ${routing.advisor.provider}/${routing.advisor.model}`), 1, 0),
			);
			this.addChild(new Text(theme.fg("muted", `    W: ${routing.worker.provider}/${routing.worker.model}`), 1, 0));
			this.addChild(new Spacer(1));
		}
	}
}

export class AdvisorHistoryComponent extends Container {
	constructor(entries: HistoryEntry[]) {
		super();
		if (entries.length === 0) {
			this.addChild(new Text(theme.fg("muted", "No history."), 1, 0));
			return;
		}
		this.addChild(new Text(theme.fg("accent", `History (${entries.length})`), 1, 0));
		this.addChild(new Spacer(1));
		for (const entry of entries.slice(0, 10)) {
			const date = new Date(entry.timestamp).toLocaleString("ko-KR", {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
			const icon = entry.result.success ? "ok" : "X";
			const dur = (entry.result.duration / 1000).toFixed(1);
			this.addChild(new Text(theme.fg("text", `${icon} [${date}] ${entry.task.substring(0, 60)}`), 1, 0));
			this.addChild(
				new Text(theme.fg("dim", `    ${entry.taskType} | ${dur}s | ${fmtUsage(entry.result.usage.total)}`), 1, 0),
			);
		}
	}
}

export class WorkTreeProgressComponent extends Container {
	private branches: Map<string, { text: Text; completed: boolean; failed: boolean }> = new Map();
	private statusLine: Text;
	constructor(branchIds: string[]) {
		super();
		this.addChild(new Text(theme.fg("accent", `WorkTree - ${branchIds.length} branches`), 1, 0));
		for (const id of branchIds) {
			const t = new Text(theme.fg("muted", `o ${id}`), 1, 0);
			this.branches.set(id, { text: t, completed: false, failed: false });
			this.addChild(t);
		}
		this.statusLine = new Text("", 1, 0);
		this.addChild(this.statusLine);
	}
}
