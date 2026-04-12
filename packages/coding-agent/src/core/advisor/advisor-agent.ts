/**
 * OxiPi Advisor System — Advisor/Worker orchestration with real tools
 *
 *   /advisor <task>
 *     ├─ TaskClassifier (LLM-based with keyword fallback)
 *     ├─ ModelRouter (routing.json)
 *     ├─ AdvisorOrchestrator
 *     │   ├─ Advisor phase: read-only tools → plan
 *     │   └─ Worker phase: coding tools → execute
 *     └─ SubAgentSpawner (parallel execution)
 */

import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type AgentEvent as CoreAgentEvent,
	type ThinkingLevel,
} from "@oxipi/agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Message,
	type Model,
	streamSimple,
} from "@oxipi/ai";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { convertToLlm } from "../messages.js";
import type { ModelRegistry } from "../model-registry.js";
import { codingTools, readOnlyTools } from "../tools/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =============================================================================
// Types
// =============================================================================

export interface TaskConfig {
	provider: string;
	model: string;
}

export interface TaskRouting {
	description: string;
	advisor: TaskConfig;
	worker: TaskConfig;
	maxIterations: number;
}

export interface RoutingConfig {
	version: string;
	tasks: Record<string, TaskRouting>;
}

export interface AdvisorResult {
	success: boolean;
	plan?: string;
	output?: string;
	error?: string;
	iterations: number;
	models: { advisor: string; worker: string };
}

export interface SubAgentTask {
	id: string;
	task: string;
	type: string;
}

export interface SubAgentResult {
	id: string;
	status: "completed" | "failed";
	output?: string;
	error?: string;
	duration: number;
}

export type ProgressCallback = (event: AdvisorEvent) => void;

export type AdvisorEvent =
	| { type: "advisor_start"; model: string }
	| { type: "advisor_text"; text: string }
	| { type: "advisor_tool"; tool: string; args: unknown }
	| { type: "advisor_done"; plan: string }
	| { type: "worker_start"; model: string; iteration: number }
	| { type: "worker_text"; text: string }
	| { type: "worker_tool"; tool: string; args: unknown }
	| { type: "worker_done"; output: string }
	| { type: "error"; error: string }
	| { type: "complete"; result: AdvisorResult };

// =============================================================================
// Model Router
// =============================================================================

export class ModelRouter {
	config: RoutingConfig;
	private registry: ModelRegistry;

	constructor(registry: ModelRegistry, configPath?: string) {
		this.registry = registry;
		this.config = this.loadConfig(configPath || join(__dirname, "routing.json"));
	}

	private loadConfig(configPath: string): RoutingConfig {
		if (!existsSync(configPath)) return this.defaultConfig();
		try {
			return JSON.parse(readFileSync(configPath, "utf-8"));
		} catch {
			return this.defaultConfig();
		}
	}

	private defaultConfig(): RoutingConfig {
		return {
			version: "1.0",
			tasks: {
				default: {
					description: "Default task type",
					advisor: { provider: "github-copilot", model: "claude-sonnet-4.5" },
					worker: { provider: "github-copilot", model: "claude-sonnet-4.5" },
					maxIterations: 2,
				},
			},
		};
	}

	getRouting(taskType: string): TaskRouting {
		return this.config.tasks[taskType] || this.config.tasks.default;
	}

	getModel(tc: TaskConfig): Model<Api> | undefined {
		return this.registry.find(tc.provider, tc.model);
	}

	allRoutings(): Array<{ type: string; routing: TaskRouting }> {
		return Object.entries(this.config.tasks).map(([type, routing]) => ({ type, routing }));
	}

	save(path?: string): void {
		writeFileSync(path || join(__dirname, "routing.json"), JSON.stringify(this.config, null, 2));
	}
}

// =============================================================================
// Task Classifier — LLM-based with keyword fallback
// =============================================================================

export class TaskClassifier {
	private registry: ModelRegistry | null;

	constructor(registry?: ModelRegistry) {
		this.registry = registry ?? null;
	}

	async classify(task: string): Promise<string> {
		if (this.registry) {
			try {
				return await this.classifyWithLLM(task);
			} catch {
				// Fall through to keyword matching
			}
		}
		return this.classifyWithKeywords(task);
	}

	private async classifyWithLLM(task: string): Promise<string> {
		const models = this.registry!.getAvailable();
		const fastModel =
			models.find((m) => m.id.includes("haiku") || m.id.includes("flash") || m.id.includes("mini")) ?? models[0];

		if (!fastModel) return "default";

		const auth = await this.registry!.getApiKeyAndHeaders(fastModel);
		if (!auth.ok || !auth.apiKey) return "default";

		const context: Context = {
			messages: [
				{
					role: "user",
					content: `Classify this task into exactly one category. Reply with ONLY the category name, nothing else.\n\nCategories: codeGeneration, webSearch, review, reasoning, imageProcessing, default\n\nTask: ${task}`,
					timestamp: Date.now(),
				},
			],
			systemPrompt: "You are a task classifier. Reply with exactly one category name.",
		};

		const result = await completeSimple(fastModel, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
		});

		const text = result.content
			.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim()
			.toLowerCase();

		const known = ["codegeneration", "websearch", "review", "reasoning", "imageprocessing", "default"];
		const match = known.find((k) => text.includes(k));
		return match || "default";
	}

	private classifyWithKeywords(task: string): string {
		const t = task.toLowerCase();
		if (/\b(code|implement|write|refactor|function|class|method)\b/.test(t)) return "codeGeneration";
		if (/\b(search|lookup|find information|research)\b/.test(t)) return "webSearch";
		if (/\b(review|debug|fix|investigate|diagnose)\b/.test(t)) return "review";
		if (/\b(analyze|reason|design|architecture|plan|strategy)\b/.test(t)) return "reasoning";
		if (/\b(image|screenshot|diagram|visual)\b/.test(t)) return "imageProcessing";
		return "default";
	}
}

// =============================================================================
// ToolAgent — Agent with tools + streaming events
// =============================================================================

class ToolAgent {
	private agent: Agent;

	constructor(model: Model<Api>, registry: ModelRegistry, tools: AgentTool[], systemPrompt: string) {
		this.agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: model.reasoning ? ("medium" as ThinkingLevel) : ("off" as ThinkingLevel),
				tools,
			},
			convertToLlm,
			streamFn: async (m, context, options) => {
				const auth = await registry.getApiKeyAndHeaders(m);
				if (!auth.ok) throw new Error(auth.error);
				return streamSimple(m, context, {
					...options,
					apiKey: auth.apiKey,
					headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
				});
			},
			sessionId: `oxipi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		});
	}

	async run(userMessage: string, onEvent?: (event: CoreAgentEvent) => void): Promise<string> {
		const unsub = onEvent
			? this.agent.subscribe((event) => {
					if (
						event.type === "message_update" ||
						event.type === "tool_execution_start" ||
						event.type === "tool_execution_end"
					) {
						onEvent(event);
					}
				})
			: null;

		try {
			const messages: AgentMessage[] = [
				{
					role: "user",
					content: [{ type: "text", text: userMessage }],
					timestamp: Date.now(),
				},
			];
			await this.agent.prompt(messages);

			const texts: string[] = [];
			for (const msg of this.agent.state.messages as Message[]) {
				if (msg.role === "assistant") {
					for (const block of (msg as AssistantMessage).content) {
						if (block.type === "text" && block.text.trim()) texts.push(block.text);
					}
				}
			}
			return texts.join("\n\n");
		} finally {
			unsub?.();
		}
	}
}

// =============================================================================
// Advisor Orchestrator
// =============================================================================

export class AdvisorOrchestrator {
	private registry: ModelRegistry;
	private router: ModelRouter;
	private classifier: TaskClassifier;

	constructor(registry: ModelRegistry, router: ModelRouter) {
		this.registry = registry;
		this.router = router;
		this.classifier = new TaskClassifier(registry);
	}

	async run(task: string, taskType?: string, onProgress?: ProgressCallback): Promise<AdvisorResult> {
		const resolvedType = taskType || (await this.classifier.classify(task));
		const routing = this.router.getRouting(resolvedType);
		const advisorModel = this.router.getModel(routing.advisor);
		const workerModel = this.router.getModel(routing.worker);

		const models = {
			advisor: `${routing.advisor.provider}/${routing.advisor.model}`,
			worker: `${routing.worker.provider}/${routing.worker.model}`,
		};

		if (!advisorModel || !workerModel) {
			const missing = !advisorModel ? models.advisor : models.worker;
			const err = `Model not found: ${missing}`;
			onProgress?.({ type: "error", error: err });
			return { success: false, error: err, iterations: 0, models };
		}

		// --- Phase 1: Advisor (read-only tools) ---
		onProgress?.({ type: "advisor_start", model: models.advisor });

		let plan: string;
		try {
			const advisor = new ToolAgent(advisorModel, this.registry, readOnlyTools, ADVISOR_PROMPT);
			plan = await advisor.run(task, (evt) => {
				if (evt.type === "message_update") {
					const m = evt.message as Message;
					if (m.role === "assistant") {
						for (const b of (m as AssistantMessage).content) {
							if (b.type === "text") onProgress?.({ type: "advisor_text", text: b.text });
						}
					}
				}
				if (evt.type === "tool_execution_start") {
					onProgress?.({ type: "advisor_tool", tool: evt.toolName, args: evt.args });
				}
			});
			onProgress?.({ type: "advisor_done", plan });
		} catch (error) {
			const msg = `Advisor failed: ${error instanceof Error ? error.message : String(error)}`;
			onProgress?.({ type: "error", error: msg });
			return { success: false, error: msg, iterations: 0, models };
		}

		if (!plan.trim()) {
			const msg = "Advisor returned empty plan";
			onProgress?.({ type: "error", error: msg });
			return { success: false, error: msg, iterations: 0, plan, models };
		}

		// --- Phase 2: Worker (full coding tools) ---
		let workerOutput = "";
		let iteration = 0;

		for (iteration = 1; iteration <= routing.maxIterations; iteration++) {
			onProgress?.({ type: "worker_start", model: models.worker, iteration });

			try {
				const worker = new ToolAgent(workerModel, this.registry, codingTools, WORKER_PROMPT);
				const prompt =
					iteration === 1
						? `## Task\n${task}\n\n## Execution Plan\n${plan}\n\nExecute the plan above.`
						: `## Task\n${task}\n\n## Execution Plan\n${plan}\n\n## Previous Result\n${workerOutput}\n\nContinue any remaining work.`;

				workerOutput = await worker.run(prompt, (evt) => {
					if (evt.type === "message_update") {
						const m = evt.message as Message;
						if (m.role === "assistant") {
							for (const b of (m as AssistantMessage).content) {
								if (b.type === "text") onProgress?.({ type: "worker_text", text: b.text });
							}
						}
					}
					if (evt.type === "tool_execution_start") {
						onProgress?.({ type: "worker_tool", tool: evt.toolName, args: evt.args });
					}
				});
			} catch (error) {
				const msg = `Worker failed (iteration ${iteration}): ${error instanceof Error ? error.message : String(error)}`;
				onProgress?.({ type: "error", error: msg });
				return { success: false, error: msg, plan, iterations: iteration, models };
			}

			onProgress?.({ type: "worker_done", output: workerOutput });
			if (looksComplete(workerOutput)) break;
		}

		const result = { success: true as const, plan, output: workerOutput, iterations: iteration, models };
		onProgress?.({ type: "complete", result });
		return result;
	}
}

// =============================================================================
// SubAgent Spawner
// =============================================================================

export class SubAgentSpawner {
	private registry: ModelRegistry;
	private router: ModelRouter;

	constructor(registry: ModelRegistry, router: ModelRouter) {
		this.registry = registry;
		this.router = router;
	}

	async spawn(
		id: string,
		task: string,
		taskType: string = "default",
		onProgress?: (output: string) => void,
	): Promise<SubAgentResult> {
		const start = Date.now();
		const orchestrator = new AdvisorOrchestrator(this.registry, this.router);
		const result = await orchestrator.run(task, taskType, (evt) => {
			if (evt.type === "worker_done") onProgress?.(evt.output);
		});
		return {
			id,
			status: result.success ? "completed" : "failed",
			output: result.output,
			error: result.error,
			duration: Date.now() - start,
		};
	}

	async spawnParallel(
		tasks: SubAgentTask[],
		onProgress?: (id: string, output: string) => void,
	): Promise<Map<string, SubAgentResult>> {
		const results = await Promise.all(
			tasks.map((t) => this.spawn(t.id, t.task, t.type, (o) => onProgress?.(t.id, o))),
		);
		const map = new Map<string, SubAgentResult>();
		for (let i = 0; i < results.length; i++) map.set(tasks[i].id, results[i]);
		return map;
	}

	async mergeResults(results: Map<string, SubAgentResult>): Promise<string> {
		const parts: string[] = [];
		let ok = 0;
		let fail = 0;

		for (const [id, r] of results) {
			if (r.status === "completed" && r.output) {
				ok++;
				parts.push(`## OK: ${id}\n${r.output}`);
			} else {
				fail++;
				parts.push(`## FAIL: ${id}\n${r.error || "Unknown error"}`);
			}
		}
		return `# Merged Results\nCompleted: ${ok}, Failed: ${fail}\n\n${parts.join("\n\n---\n\n")}`;
	}
}

// =============================================================================
// WorkTree — parallel branches
// =============================================================================

export class WorkTree {
	private branches: Map<string, SubAgentTask> = new Map();
	private results: Map<string, SubAgentResult> = new Map();
	private spawner: SubAgentSpawner;

	constructor(spawner: SubAgentSpawner) {
		this.spawner = spawner;
	}

	addBranch(id: string, task: string, type: string = "default"): void {
		this.branches.set(id, { id, task, type });
	}

	async execute(onProgress?: (id: string, output: string) => void): Promise<void> {
		this.results = await this.spawner.spawnParallel(Array.from(this.branches.values()), onProgress);
	}

	getResult(id: string): SubAgentResult | undefined {
		return this.results.get(id);
	}
	getAllResults(): Map<string, SubAgentResult> {
		return this.results;
	}
	async merge(): Promise<string> {
		return this.spawner.mergeResults(this.results);
	}
}

// =============================================================================
// Factory
// =============================================================================

export function createAdvisorSystem(registry: ModelRegistry, configPath?: string) {
	const router = new ModelRouter(registry, configPath);
	const orchestrator = new AdvisorOrchestrator(registry, router);
	const spawner = new SubAgentSpawner(registry, router);
	return { router, orchestrator, spawner };
}

// =============================================================================
// Helpers
// =============================================================================

function looksComplete(output: string): boolean {
	const lower = output.toLowerCase();
	const positive = ["task completed", "done.", "finished", "all changes", "complete"];
	const negative = ["not complete", "not done", "failed", "remaining"];
	return positive.some((p) => lower.includes(p)) && !negative.some((n) => lower.includes(n));
}

// =============================================================================
// System Prompts
// =============================================================================

const ADVISOR_PROMPT = `You are an experienced technical lead. Analyze the given task and produce a concrete execution plan for the worker.

## Rules
- Read files (read) and search (grep, find) to understand the codebase
- Do NOT modify any code — analysis and planning only
- Output format:
  1. **Analysis**: Key requirements (2-3 sentences)
  2. **Execution Plan**: File-by-file concrete steps
  3. **Completion Criteria**: How to judge completion
- Be concise`;

const WORKER_PROMPT = `You are a skilled software engineer. Execute coding tasks according to the given plan.

## Rules
- Read files (read) and search (grep, find) to understand current state
- Use bash for commands, edit/write for file modifications
- State the result after each step
- End with "Task completed" when all work is done`;
