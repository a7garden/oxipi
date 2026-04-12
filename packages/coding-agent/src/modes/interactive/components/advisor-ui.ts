/**
 * OxiPi Advisor TUI Components
 */

import { Container, Markdown, Spacer, Text } from "@oxipi/tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

export class AdvisorProgressComponent extends Container {
	private phaseText: Text;
	private advisorSection: Container;
	private advisorTools: Text;
	private workerSection: Container;
	private workerTools: Text;
	private resultSection: Container;

	constructor() {
		super();
		this.phaseText = new Text(theme.fg("muted", "Advisor idle"), 1, 0);
		this.addChild(this.phaseText);
		this.advisorSection = new Container();
		this.advisorTools = new Text("", 1, 0);
		this.advisorSection.addChild(new Text(theme.fg("accent", "Advisor"), 1, 0));
		this.advisorSection.addChild(this.advisorTools);
		this.addChild(this.advisorSection);
		this.workerSection = new Container();
		this.workerTools = new Text("", 1, 0);
		this.workerSection.addChild(new Text(theme.fg("muted", "Worker (waiting)"), 1, 0));
		this.workerSection.addChild(this.workerTools);
		this.addChild(this.workerSection);
		this.resultSection = new Container();
		this.addChild(this.resultSection);
	}

	setAdvisorPlanning(model: string): void {
		this.phaseText.setText(theme.fg("accent", `Advisor analyzing (${model})`));
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("accent", "Advisor -- analyzing..."), 1, 0));
		this.advisorSection.addChild(this.advisorTools);
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("muted", "Worker (waiting)"), 1, 0));
		this.workerSection.addChild(this.workerTools);
	}

	updateAdvisorStream(text: string): void {
		const preview = text.split("\n").slice(-6).join("\n");
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("accent", "Advisor"), 1, 0));
		this.advisorSection.addChild(new Text(theme.fg("text", preview), 1, 0));
		this.advisorSection.addChild(this.advisorTools);
	}

	setAdvisorTool(tool: string): void {
		this.advisorTools.setText(theme.fg("dim", `  ${tool}...`));
	}

	setAdvisorDone(): void {
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("success", "Advisor -- plan complete"), 1, 0));
		this.advisorTools.setText("");
	}

	setExecutorRunning(model: string, _iteration: number): void {
		this.phaseText.setText(theme.fg("accent", `Worker executing (${model})`));
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("accent", "Worker -- executing..."), 1, 0));
		this.workerSection.addChild(this.workerTools);
	}

	updateWorkerStream(text: string): void {
		const preview = text.split("\n").slice(-6).join("\n");
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("accent", "Worker"), 1, 0));
		this.workerSection.addChild(new Text(theme.fg("text", preview), 1, 0));
		this.workerSection.addChild(this.workerTools);
	}

	setWorkerTool(tool: string): void {
		this.workerTools.setText(theme.fg("dim", `  ${tool}...`));
	}

	setWorkerDone(_iteration: number): void {
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("success", "Worker -- done"), 1, 0));
	}

	setCompleted(result: string): void {
		this.phaseText.setText(theme.fg("success", "Completed"));
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("success", "Worker -- done"), 1, 0));
		this.resultSection.clear();
		this.resultSection.addChild(new Spacer(1));
		this.resultSection.addChild(new Markdown(result.substring(0, 1500), 1, 0, getMarkdownTheme()));
	}

	setError(error: string): void {
		this.phaseText.setText(theme.fg("error", `Error: ${error.substring(0, 80)}`));
	}
}

export class WorkTreeProgressComponent extends Container {
	private branches: Map<string, { text: Text; completed: boolean; failed: boolean }> = new Map();
	private statusLine: Text;

	constructor(branchIds: string[]) {
		super();
		this.addChild(new Text(theme.fg("accent", `WorkTree -- ${branchIds.length} parallel branches`), 1, 0));
		this.addChild(new Spacer(1));
		for (const id of branchIds) {
			const t = new Text(theme.fg("muted", `o ${id}`), 1, 0);
			this.branches.set(id, { text: t, completed: false, failed: false });
			this.addChild(t);
		}
		this.statusLine = new Text("", 1, 0);
		this.addChild(this.statusLine);
	}

	setBranchRunning(id: string): void {
		const b = this.branches.get(id);
		if (b) b.text.setText(theme.fg("accent", `~ ${id} -- running`));
	}

	setBranchCompleted(id: string): void {
		const b = this.branches.get(id);
		if (b) {
			b.completed = true;
			b.text.setText(theme.fg("success", `* ${id} -- done`));
		}
		this.updateStatus();
	}

	setBranchFailed(id: string, error: string): void {
		const b = this.branches.get(id);
		if (b) {
			b.failed = true;
			b.text.setText(theme.fg("error", `x ${id}: ${error.substring(0, 40)}`));
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
		const parts = [`${completed}/${this.branches.size} done`];
		if (failed > 0) parts.push(`${failed} failed`);
		this.statusLine.setText(theme.fg("muted", parts.join(", ")));
	}
}
