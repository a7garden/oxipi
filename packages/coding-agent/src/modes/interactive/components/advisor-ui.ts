import { Container, Markdown, Spacer, Text } from "@oxipi/tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

function previewText(input: string, maxLines: number): string {
	const lines = input
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	return lines.slice(-maxLines).join("\n");
}

function shorten(input: string, maxChars: number): string {
	return input.length > maxChars ? `${input.substring(0, maxChars)}...` : input;
}

export class AdvisorProgressComponent extends Container {
	private phaseText: Text;
	private advisorSection: Container;
	private advisorTools: Text;
	private workerSection: Container;
	private workerTools: Text;
	private resultSection: Container;

	constructor() {
		super();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Advisor Pipeline")), 1, 0));
		this.phaseText = new Text(theme.fg("muted", "phase: idle"), 1, 0);
		this.addChild(this.phaseText);
		this.addChild(new Spacer(1));

		this.advisorSection = new Container();
		this.advisorTools = new Text("", 1, 0);
		this.advisorSection.addChild(new Text(theme.fg("accent", "advisor: waiting"), 1, 0));
		this.advisorSection.addChild(this.advisorTools);
		this.addChild(this.advisorSection);

		this.workerSection = new Container();
		this.workerTools = new Text("", 1, 0);
		this.workerSection.addChild(new Text(theme.fg("muted", "worker: waiting"), 1, 0));
		this.workerSection.addChild(this.workerTools);
		this.addChild(this.workerSection);

		this.resultSection = new Container();
		this.addChild(this.resultSection);
	}

	setAdvisorPlanning(model: string): void {
		this.phaseText.setText(theme.fg("accent", `phase: advisor planning (${model})`));
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("accent", `advisor: planning (${model})`), 1, 0));
		this.advisorSection.addChild(this.advisorTools);

		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("muted", "worker: waiting"), 1, 0));
		this.workerSection.addChild(this.workerTools);
	}

	updateAdvisorStream(text: string): void {
		const preview = previewText(text, 6);
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("accent", "advisor: planning"), 1, 0));
		if (preview) {
			this.advisorSection.addChild(new Text(theme.fg("text", preview), 1, 0));
		}
		this.advisorSection.addChild(this.advisorTools);
	}

	setAdvisorTool(tool: string): void {
		this.advisorTools.setText(theme.fg("dim", `  tool: ${tool}`));
	}

	setAdvisorDone(): void {
		this.advisorSection.clear();
		this.advisorSection.addChild(new Text(theme.fg("success", "advisor: plan ready"), 1, 0));
		this.advisorTools.setText("");
	}

	setExecutorRunning(model: string, iteration: number): void {
		this.phaseText.setText(theme.fg("accent", `phase: worker executing (${model})`));
		this.workerSection.clear();
		this.workerSection.addChild(
			new Text(theme.fg("accent", `worker: executing (${model}, pass ${iteration})`), 1, 0),
		);
		this.workerSection.addChild(this.workerTools);
	}

	updateWorkerStream(text: string): void {
		const preview = previewText(text, 6);
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("accent", "worker: executing"), 1, 0));
		if (preview) {
			this.workerSection.addChild(new Text(theme.fg("text", preview), 1, 0));
		}
		this.workerSection.addChild(this.workerTools);
	}

	setWorkerTool(tool: string): void {
		this.workerTools.setText(theme.fg("dim", `  tool: ${tool}`));
	}

	setWorkerDone(iteration: number): void {
		this.workerSection.clear();
		this.workerSection.addChild(new Text(theme.fg("success", `worker: done (pass ${iteration})`), 1, 0));
		this.workerTools.setText("");
	}

	setCompleted(result: string): void {
		this.phaseText.setText(theme.fg("success", "phase: completed"));
		this.resultSection.clear();
		this.resultSection.addChild(new Spacer(1));
		this.resultSection.addChild(new Text(theme.fg("accent", "result"), 1, 0));
		this.resultSection.addChild(new Markdown(result.substring(0, 2000), 1, 0, getMarkdownTheme()));
	}

	setError(error: string): void {
		this.phaseText.setText(theme.fg("error", `phase: error (${shorten(error, 120)})`));
	}
}

export class AdvisorPendingQuestionsComponent extends Container {
	private title: Text;
	private hint: Text;
	private lines: Text[] = [];
	private questions = new Map<string, { subAgentId: string; question: string }>();
	private filterSubAgentId: string | undefined;

	constructor() {
		super();
		this.title = new Text(theme.fg("accent", "Sub-agent Questions (pending: 0)"), 1, 0);
		this.hint = new Text(theme.fg("dim", "Reply command: /advisor-reply <correlationId> <text>"), 1, 0);
		this.addChild(this.title);
		this.addChild(this.hint);
	}

	upsertQuestion(correlationId: string, subAgentId: string, question: string): void {
		this.questions.set(correlationId, { subAgentId, question });
		this.renderQuestions();
	}

	removeQuestion(correlationId: string): void {
		this.questions.delete(correlationId);
		this.renderQuestions();
	}

	setFilter(subAgentId?: string): void {
		this.filterSubAgentId = subAgentId?.trim() || undefined;
		this.renderQuestions();
	}

	private renderQuestions(): void {
		for (const line of this.lines) {
			this.removeChild(line);
		}
		this.lines = [];
		const visible = Array.from(this.questions.entries()).filter(([, q]) =>
			this.filterSubAgentId ? q.subAgentId === this.filterSubAgentId : true,
		);
		const filterLabel = this.filterSubAgentId ? `, filter: ${this.filterSubAgentId}` : "";
		this.title.setText(theme.fg("accent", `Sub-agent Questions (pending: ${visible.length}${filterLabel})`));

		for (const [id, q] of visible) {
			const text = new Text(theme.fg("muted", `- ${id} [${q.subAgentId}] ${shorten(q.question, 120)}`), 1, 0);
			this.lines.push(text);
			this.addChild(text);
		}
	}
}

export class WorkTreeProgressComponent extends Container {
	private branches: Map<string, { text: Text; state: "queued" | "running" | "done" | "failed" }> = new Map();
	private statusLine: Text;

	constructor(branchIds: string[]) {
		super();
		this.addChild(new Text(theme.fg("accent", `Worktree Sub-agents (${branchIds.length})`), 1, 0));
		this.addChild(new Spacer(1));

		for (const id of branchIds) {
			const text = new Text(theme.fg("muted", `[queued] ${id}`), 1, 0);
			this.branches.set(id, { text, state: "queued" });
			this.addChild(text);
		}

		this.statusLine = new Text("", 1, 0);
		this.addChild(new Spacer(1));
		this.addChild(this.statusLine);
		this.updateStatus();
	}

	setBranchRunning(id: string): void {
		const branch = this.branches.get(id);
		if (!branch) return;
		branch.state = "running";
		branch.text.setText(theme.fg("accent", `[running] ${id}`));
		this.updateStatus();
	}

	setBranchCompleted(id: string): void {
		const branch = this.branches.get(id);
		if (!branch) return;
		branch.state = "done";
		branch.text.setText(theme.fg("success", `[done] ${id}`));
		this.updateStatus();
	}

	setBranchFailed(id: string, error: string): void {
		const branch = this.branches.get(id);
		if (!branch) return;
		branch.state = "failed";
		branch.text.setText(theme.fg("error", `[failed] ${id}: ${shorten(error, 72)}`));
		this.updateStatus();
	}

	private updateStatus(): void {
		let queued = 0;
		let running = 0;
		let done = 0;
		let failed = 0;
		for (const branch of this.branches.values()) {
			switch (branch.state) {
				case "queued":
					queued++;
					break;
				case "running":
					running++;
					break;
				case "done":
					done++;
					break;
				case "failed":
					failed++;
					break;
			}
		}
		this.statusLine.setText(
			theme.fg("muted", `queued: ${queued}, running: ${running}, done: ${done}, failed: ${failed}`),
		);
	}
}
