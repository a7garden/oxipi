/**
 * OxiPi Advisor System — Complete implementation
 */

import { Agent, type AgentMessage, type AgentEvent as CoreAgentEvent, type ThinkingLevel } from "@oxipi/agent-core";
import { type Api, type Context, type Model, streamSimple } from "@oxipi/ai";
import { type ChildProcess, execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { convertToLlm } from "../messages.js";
import type { ModelRegistry } from "../model-registry.js";
import { codingTools, readOnlyTools, type Tool } from "../tools/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface TaskConfig {
	provider: string;
	model: string;
}
export interface TaskRouting {
	description: string;
	advisor: TaskConfig;
	worker: TaskConfig;
	maxIterations: number;
	reviewEnabled?: boolean;
	autoSplit?: boolean;
}
export interface RoutingConfig {
	version: string;
	tasks: Record<string, TaskRouting>;
}
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	estimatedCost: number;
}
export interface AdvisorResult {
	success: boolean;
	plan?: string;
	output?: string;
	error?: string;
	iterations: number;
	models: { advisor: string; worker: string };
	usage: { advisor: TokenUsage; worker: TokenUsage; reviewer: TokenUsage; total: TokenUsage };
	subTasks?: SubAgentResult[];
	duration: number;
	taskType: string;
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
	usage?: TokenUsage;
}
export interface HistoryEntry {
	id: string;
	timestamp: number;
	task: string;
	taskType: string;
	result: AdvisorResult;
}
export type ProgressCallback = (event: AdvisorEvent) => void;
export type AdvisorEvent =
	| { type: "advisor_start"; model: string }
	| { type: "advisor_text"; text: string }
	| { type: "advisor_tool"; tool: string; args: any }
	| { type: "advisor_done"; plan: string }
	| { type: "worker_start"; model: string; iteration: number }
	| { type: "worker_text"; text: string }
	| { type: "worker_tool"; tool: string; args: any }
	| { type: "worker_done"; output: string; iteration: number }
	| { type: "review_start"; model: string }
	| { type: "review_done"; feedback: string; approved: boolean }
	| { type: "split_start"; subTasks: SubAgentTask[] }
	| { type: "split_progress"; id: string; status: "running" | "completed" | "failed" }
	| { type: "usage"; phase: "advisor" | "worker" | "reviewer"; usage: TokenUsage }
	| { type: "error"; error: string }
	| { type: "complete"; result: AdvisorResult };

function emptyUsage(): TokenUsage {
	return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0 };
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
	"claude-opus-4.6": { input: 15, output: 75 },
	"claude-sonnet-4.5": { input: 3, output: 15 },
	"claude-haiku-4.5": { input: 0.8, output: 4 },
	"gpt-4o": { input: 2.5, output: 10 },
	"gpt-4o-mini": { input: 0.15, output: 0.6 },
};

function calcCost(input: number, output: number, modelId: string): number {
	const p = MODEL_PRICING[modelId] || { input: 1, output: 5 };
	return (input * p.input + output * p.output) / 1_000_000;
}

export class UsageTracker {
	private data: Map<string, TokenUsage> = new Map();
	add(phase: string, input: number, output: number, modelId: string): TokenUsage {
		const cost = calcCost(input, output, modelId);
		const prev = this.data.get(phase) || emptyUsage();
		const next: TokenUsage = {
			inputTokens: prev.inputTokens + input,
			outputTokens: prev.outputTokens + output,
			totalTokens: prev.totalTokens + input + output,
			estimatedCost: prev.estimatedCost + cost,
		};
		this.data.set(phase, next);
		return next;
	}
	get(phase: string): TokenUsage {
		return this.data.get(phase) || emptyUsage();
	}
	total(): TokenUsage {
		const t = emptyUsage();
		for (const u of this.data.values()) {
			t.inputTokens += u.inputTokens;
			t.outputTokens += u.outputTokens;
			t.totalTokens += u.totalTokens;
			t.estimatedCost += u.estimatedCost;
		}
		return t;
	}
}

export class ModelRouter {
	config: RoutingConfig;
	private registry: ModelRegistry;
	constructor(registry: ModelRegistry, configPath?: string) {
		this.registry = registry;
		this.config = this.loadConfig(configPath || join(__dirname, "routing.json"));
	}
	private loadConfig(path: string): RoutingConfig {
		if (!existsSync(path)) return this.defaultConfig();
		try {
			return JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			return this.defaultConfig();
		}
	}
	private defaultConfig(): RoutingConfig {
		return {
			version: "1.0",
			tasks: {
				default: {
					description: "기본",
					advisor: { provider: "github-copilot", model: "claude-sonnet-4.5" },
					worker: { provider: "github-copilot", model: "claude-sonnet-4.5" },
					maxIterations: 2,
					reviewEnabled: true,
					autoSplit: false,
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
	updateRouting(taskType: string, routing: Partial<TaskRouting>): void {
		this.config.tasks[taskType] = { ...this.config.tasks[taskType], ...routing } as TaskRouting;
	}
	save(path?: string): void {
		writeFileSync(path || join(__dirname, "routing.json"), JSON.stringify(this.config, null, 2));
	}
}

export class TaskClassifier {
	private registry: ModelRegistry | null;
	constructor(registry?: ModelRegistry) {
		this.registry = registry ?? null;
	}
	async classify(task: string): Promise<string> {
		if (this.registry) {
			try {
				return await this.classifyLLM(task);
			} catch {}
		}
		return this.classifyKeyword(task);
	}
	private async classifyLLM(task: string): Promise<string> {
		const models = this.registry!.getAvailable();
		const fast =
			models.find((m) => m.id.includes("haiku") || m.id.includes("flash") || m.id.includes("mini")) ?? models[0];
		if (!fast) return "default";
		const auth = await this.registry!.getApiKeyAndHeaders(fast);
		if (!auth.ok || !auth.apiKey) return "default";
		const { completeSimple } = await import("@oxipi/ai");
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content:
						"Reply with ONLY one category: codeGeneration, webSearch, review, reasoning, imageProcessing, simple, default\n\nTask: " +
						task,
					timestamp: Date.now(),
				},
			],
			systemPrompt: "You are a task classifier. One word only.",
		};
		const r = await completeSimple(fast, ctx, { apiKey: auth.apiKey, headers: auth.headers });
		const t = r.content
			.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim()
			.toLowerCase();
		return (
			["codegeneration", "websearch", "review", "reasoning", "imageprocessing", "simple", "default"].find((k) =>
				t.includes(k),
			) || "default"
		);
	}
	private classifyKeyword(task: string): string {
		const t = task.toLowerCase();
		if (/코드|code|구현|implement|작성|write|리팩토링|refactor/.test(t)) return "codeGeneration";
		if (/검색|search|찾아|lookup|조사/.test(t)) return "webSearch";
		if (/리뷰|review|검토|디버그|debug|수정|fix/.test(t)) return "review";
		if (/분석|analyze|추론|reason|설계|design|아키텍처|architecture/.test(t)) return "reasoning";
		if (/이미지|image|스크린샷|screenshot/.test(t)) return "imageProcessing";
		if (/간단|요약|번역|summar|translat|simple/.test(t)) return "simple";
		return "default";
	}
}

export class TaskSplitter {
	private registry: ModelRegistry;
	constructor(registry: ModelRegistry) {
		this.registry = registry;
	}
	async split(task: string, plan: string): Promise<SubAgentTask[]> {
		const models = this.registry.getAvailable();
		const m = models.find((x) => x.id.includes("sonnet") || x.id.includes("gpt-4o")) ?? models[0];
		if (!m) return [{ id: "main", task, type: "default" }];
		const auth = await this.registry.getApiKeyAndHeaders(m);
		if (!auth.ok || !auth.apiKey) return [{ id: "main", task, type: "default" }];
		const { completeSimple } = await import("@oxipi/ai");
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content:
						"Split into 2-5 independent parallel subtasks. JSON only.\n\nTask: " +
						task +
						"\n\nPlan:\n" +
						plan +
						'\n\nOutput: [{"id":"subtask-1","task":"...","type":"codeGeneration"}]',
					timestamp: Date.now(),
				},
			],
			systemPrompt: "You decompose tasks. Output only JSON array.",
		};
		const r = await completeSimple(m, ctx, { apiKey: auth.apiKey, headers: auth.headers });
		const t = r.content
			.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
		const match = t.match(/\[[\s\S]*\]/);
		if (!match) return [{ id: "main", task, type: "default" }];
		try {
			const parsed = JSON.parse(match[0]);
			if (Array.isArray(parsed) && parsed[0]?.id && parsed[0]?.task)
				return parsed.map((p: any) => ({
					id: String(p.id),
					task: String(p.task),
					type: String(p.type || "default"),
				}));
		} catch {}
		return [{ id: "main", task, type: "default" }];
	}
}

export class History {
	private dir: string;
	constructor(baseDir: string) {
		this.dir = join(baseDir, ".oxipi", "history");
		if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
	}
	save(entry: HistoryEntry): void {
		writeFileSync(
			join(this.dir, `${new Date(entry.timestamp).toISOString().replace(/[:.]/g, "-")}-${entry.id}.json`),
			JSON.stringify(entry, null, 2),
		);
	}
	list(limit: number = 20): HistoryEntry[] {
		if (!existsSync(this.dir)) return [];
		try {
			const { readdirSync } = require("fs") as typeof import("fs");
			return readdirSync(this.dir)
				.filter((f) => f.endsWith(".json"))
				.sort()
				.reverse()
				.slice(0, limit)
				.map((f) => {
					try {
						return JSON.parse(readFileSync(join(this.dir, f), "utf-8"));
					} catch {
						return null;
					}
				})
				.filter((x): x is HistoryEntry => x !== null);
		} catch {
			return [];
		}
	}
}

export const PROMPT_TEMPLATES: Record<string, { label: string; template: string }> = {
	refactor: { label: "리팩토링", template: "다음 코드를 리팩토링하세요:\n\n대상: {{target}}\n목표: {{goal}}" },
	feature: { label: "기능 구현", template: "새 기능을 구현하세요:\n\n기능: {{feature}}\n관련 파일: {{files}}" },
	bugfix: { label: "버그 수정", template: "버그를 수정하세요:\n\n증상: {{symptom}}\n재현: {{reproduce}}" },
	test: { label: "테스트 작성", template: "테스트를 작성하세요:\n\n대상: {{target}}\n프레임워크: {{framework}}" },
	review: { label: "코드 리뷰", template: "코드를 리뷰하세요:\n\n대상: {{target}}" },
	docs: { label: "문서화", template: "문서를 작성하세요:\n\n대상: {{target}}" },
};

class ToolAgent {
	private agent: Agent;
	private registry: ModelRegistry;
	private modelId: string;
	constructor(model: Model<Api>, registry: ModelRegistry, tools: Tool[], systemPrompt: string) {
		this.registry = registry;
		this.modelId = model.id;
		this.agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: model.reasoning ? "medium" : ("off" as ThinkingLevel),
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
	abort(): void {
		this.agent.abort();
	}
	async run(
		userMessage: string,
		onEvent?: (event: CoreAgentEvent) => void,
	): Promise<{ text: string; usage: TokenUsage }> {
		const unsub = onEvent
			? this.agent.subscribe((event) => {
					if (
						event.type === "message_update" ||
						event.type === "tool_execution_start" ||
						event.type === "tool_execution_end"
					)
						onEvent(event);
				})
			: null;
		try {
			const messages: AgentMessage[] = [
				{ role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() },
			];
			await this.agent.prompt(messages);
			const texts: string[] = [];
			let totalIn = 0,
				totalOut = 0;
			for (const msg of this.agent.state.messages) {
				if (msg.role === "assistant" && "content" in msg) {
					for (const block of (msg as any).content) {
						if (block.type === "text" && block.text.trim()) texts.push(block.text);
					}
					if ((msg as any).usage) {
						totalIn += (msg as any).usage.inputTokens || 0;
						totalOut += (msg as any).usage.outputTokens || 0;
					}
				}
			}
			return {
				text: texts.join("\n\n"),
				usage: {
					inputTokens: totalIn,
					outputTokens: totalOut,
					totalTokens: totalIn + totalOut,
					estimatedCost: calcCost(totalIn, totalOut, this.modelId),
				},
			};
		} finally {
			unsub?.();
		}
	}
}

export class WorktreeManager {
	private baseDir: string;
	private worktrees: Map<string, string> = new Map();
	constructor(private cwd: string) {
		this.baseDir = join(cwd, ".oxipi", "worktrees");
	}
	async create(branchId: string): Promise<string> {
		if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
		const p = join(this.baseDir, branchId);
		if (existsSync(p)) {
			try {
				execSync(`git worktree remove --force ${JSON.stringify(p)}`, { cwd: this.cwd, stdio: "pipe" });
			} catch {}
		}
		try {
			execSync(`git worktree add -b oxipi/${branchId} ${JSON.stringify(p)} HEAD`, {
				cwd: this.cwd,
				stdio: "pipe",
			});
		} catch {
			try {
				execSync(`git worktree add ${JSON.stringify(p)} HEAD`, { cwd: this.cwd, stdio: "pipe" });
			} catch (e) {
				throw new Error(`Worktree failed: ${e}`);
			}
		}
		this.worktrees.set(branchId, p);
		return p;
	}
	async remove(branchId: string): Promise<void> {
		const p = this.worktrees.get(branchId);
		if (!p) return;
		try {
			execSync(`git worktree remove --force ${JSON.stringify(p)}`, { cwd: this.cwd, stdio: "pipe" });
		} catch {}
		try {
			execSync(`git branch -D oxipi/${branchId}`, { cwd: this.cwd, stdio: "pipe" });
		} catch {}
		this.worktrees.delete(branchId);
	}
	async removeAll(): Promise<void> {
		for (const id of Array.from(this.worktrees.keys())) await this.remove(id);
	}
}

export class AdvisorOrchestrator {
	private registry: ModelRegistry;
	private router: ModelRouter;
	private classifier: TaskClassifier;
	private splitter: TaskSplitter;
	private usage: UsageTracker;
	private currentAgent: ToolAgent | null = null;
	constructor(registry: ModelRegistry, router: ModelRouter) {
		this.registry = registry;
		this.router = router;
		this.classifier = new TaskClassifier(registry);
		this.splitter = new TaskSplitter(registry);
		this.usage = new UsageTracker();
	}
	abort(): void {
		this.currentAgent?.abort();
	}
	async run(task: string, taskType?: string, onProgress?: ProgressCallback): Promise<AdvisorResult> {
		const startTime = Date.now();
		this.usage = new UsageTracker();
		const resolvedType = taskType || (await this.classifier.classify(task));
		const routing = this.router.getRouting(resolvedType);
		const advisorModel = this.router.getModel(routing.advisor);
		const workerModel = this.router.getModel(routing.worker);
		const models = {
			advisor: `${routing.advisor.provider}/${routing.advisor.model}`,
			worker: `${routing.worker.provider}/${routing.worker.model}`,
		};
		const mkErr = (err: string, plan?: string, iter = 0): AdvisorResult => ({
			success: false,
			error: err,
			plan,
			iterations: iter,
			models,
			usage: {
				advisor: this.usage.get("advisor"),
				worker: this.usage.get("worker"),
				reviewer: this.usage.get("reviewer"),
				total: this.usage.total(),
			},
			duration: Date.now() - startTime,
			taskType: resolvedType,
		});
		if (!advisorModel || !workerModel) {
			const err = `Model not found: ${!advisorModel ? models.advisor : models.worker}`;
			onProgress?.({ type: "error", error: err });
			return mkErr(err);
		}
		// Phase 1: Advisor
		onProgress?.({ type: "advisor_start", model: models.advisor });
		let plan: string;
		try {
			const advisor = new ToolAgent(advisorModel, this.registry, readOnlyTools, ADVISOR_PROMPT);
			this.currentAgent = advisor;
			const { text, usage } = await advisor.run(task, (evt) => {
				if (evt.type === "message_update" && "content" in evt.message) {
					for (const b of (evt.message as any).content) {
						if (b.type === "text") onProgress?.({ type: "advisor_text", text: b.text });
					}
				}
				if (evt.type === "tool_execution_start")
					onProgress?.({ type: "advisor_tool", tool: evt.toolName, args: evt.args });
			});
			this.currentAgent = null;
			plan = text;
			const u = this.usage.add("advisor", usage.inputTokens, usage.outputTokens, advisorModel.id);
			onProgress?.({ type: "usage", phase: "advisor", usage: u });
			onProgress?.({ type: "advisor_done", plan });
		} catch (error) {
			this.currentAgent = null;
			const msg = `Advisor failed: ${error instanceof Error ? error.message : String(error)}`;
			onProgress?.({ type: "error", error: msg });
			return mkErr(msg);
		}
		if (!plan.trim()) {
			onProgress?.({ type: "error", error: "Empty plan" });
			return mkErr("Empty plan", plan);
		}
		// Phase 1.5: Auto-split
		if (routing.autoSplit) {
			const subTasks = await this.splitter.split(task, plan);
			if (subTasks.length > 1) {
				onProgress?.({ type: "split_start", subTasks });
				const spawner = new SubAgentSpawner(this.registry, this.router);
				const subResults = await spawner.spawnParallel(subTasks);
				for (const [id, r] of subResults) onProgress?.({ type: "split_progress", id, status: r.status });
				const merged = await spawner.mergeResults(subResults);
				const result: AdvisorResult = {
					success: Array.from(subResults.values()).every((r) => r.status === "completed"),
					plan,
					output: merged,
					iterations: 1,
					models,
					usage: {
						advisor: this.usage.get("advisor"),
						worker: emptyUsage(),
						reviewer: emptyUsage(),
						total: this.usage.total(),
					},
					subTasks: Array.from(subResults.values()),
					duration: Date.now() - startTime,
					taskType: resolvedType,
				};
				onProgress?.({ type: "complete", result });
				return result;
			}
		}
		// Phase 2+3: Worker + Review loop
		let workerOutput = "";
		let iteration = 0;
		for (iteration = 1; iteration <= routing.maxIterations; iteration++) {
			onProgress?.({ type: "worker_start", model: models.worker, iteration });
			try {
				const worker = new ToolAgent(workerModel, this.registry, codingTools, WORKER_PROMPT);
				this.currentAgent = worker;
				const prompt =
					iteration === 1
						? `## 태스크\n${task}\n\n## 실행 계획\n${plan}\n\n위 계획에 따라 작업을 시작하세요.`
						: "## 태스크\n" +
							task +
							"\n\n## 실행 계획\n" +
							plan +
							"\n\n## 이전 결과\n" +
							workerOutput +
							"\n\n리뷰 피드백에 따라 수정하세요.";
				const { text, usage } = await worker.run(prompt, (evt) => {
					if (evt.type === "message_update" && "content" in evt.message) {
						for (const b of (evt.message as any).content) {
							if (b.type === "text") onProgress?.({ type: "worker_text", text: b.text });
						}
					}
					if (evt.type === "tool_execution_start")
						onProgress?.({ type: "worker_tool", tool: evt.toolName, args: evt.args });
				});
				this.currentAgent = null;
				workerOutput = text;
				const u = this.usage.add("worker", usage.inputTokens, usage.outputTokens, workerModel.id);
				onProgress?.({ type: "usage", phase: "worker", usage: u });
			} catch (error) {
				this.currentAgent = null;
				const msg = `Worker failed (iter ${iteration}): ${error instanceof Error ? error.message : String(error)}`;
				onProgress?.({ type: "error", error: msg });
				return mkErr(msg, plan, iteration);
			}
			onProgress?.({ type: "worker_done", output: workerOutput, iteration });
			// Review
			if (routing.reviewEnabled !== false && iteration < routing.maxIterations) {
				onProgress?.({ type: "review_start", model: models.advisor });
				try {
					const reviewer = new ToolAgent(advisorModel, this.registry, readOnlyTools, REVIEWER_PROMPT);
					const { text: reviewText, usage: revUsage } = await reviewer.run(
						"## 원본 태스크\n" +
							task +
							"\n\n## 실행 계획\n" +
							plan +
							"\n\n## Worker 결과\n" +
							workerOutput +
							"\n\n검토하세요. 완료: APPROVED. 수정 필요: NEEDS_FIX + 수정사항.",
					);
					const ru = this.usage.add("reviewer", revUsage.inputTokens, revUsage.outputTokens, advisorModel.id);
					onProgress?.({ type: "usage", phase: "reviewer", usage: ru });
					const approved = reviewText.trim().toUpperCase().startsWith("APPROVED");
					onProgress?.({ type: "review_done", feedback: reviewText, approved });
					if (approved) break;
				} catch {
					if (looksComplete(workerOutput)) break;
				}
			} else {
				if (looksComplete(workerOutput)) break;
			}
		}
		const result: AdvisorResult = {
			success: true,
			plan,
			output: workerOutput,
			iterations: iteration,
			models,
			usage: {
				advisor: this.usage.get("advisor"),
				worker: this.usage.get("worker"),
				reviewer: this.usage.get("reviewer"),
				total: this.usage.total(),
			},
			duration: Date.now() - startTime,
			taskType: resolvedType,
		};
		onProgress?.({ type: "complete", result });
		return result;
	}
}

export class SubAgentSpawner {
	private registry: ModelRegistry;
	private router: ModelRouter;
	private children: Map<string, ChildProcess> = new Map();
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
		const orch = new AdvisorOrchestrator(this.registry, this.router);
		const result = await orch.run(task, taskType, (evt) => {
			if (evt.type === "worker_done") onProgress?.(evt.output);
		});
		return {
			id,
			status: result.success ? "completed" : "failed",
			output: result.output,
			error: result.error,
			duration: Date.now() - start,
			usage: result.usage.total,
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
		let ok = 0,
			fail = 0;
		for (const [id, r] of results) {
			if (r.status === "completed" && r.output) {
				ok++;
				parts.push(`## ✅ ${id}\n${r.output}`);
			} else {
				fail++;
				parts.push(`## ❌ ${id}\n${r.error || "Unknown error"}`);
			}
		}
		return `# 병합 결과\n성공: ${ok}, 실패: ${fail}\n\n${parts.join("\n\n---\n\n")}`;
	}
	killAll(): void {
		for (const [, c] of this.children) c.kill("SIGTERM");
		this.children.clear();
	}
}

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

export function createAdvisorSystem(registry: ModelRegistry, configPath?: string, _cwd?: string) {
	const router = new ModelRouter(registry, configPath);
	const orchestrator = new AdvisorOrchestrator(registry, router);
	const spawner = new SubAgentSpawner(registry, router);
	return { router, orchestrator, spawner };
}

function looksComplete(output: string): boolean {
	const lower = output.toLowerCase();
	return (
		["완료했습니다", "완료되었습니다", "task completed", "done.", "finished"].some((p) => lower.includes(p)) &&
		!["not complete", "아직 완료", "not done", "실패"].some((n) => lower.includes(n))
	);
}

const ADVISOR_PROMPT =
	"당신은 숙련된 기술 리드입니다. 주어진 태스크를 분석하고 실행자를 위한 구체적인 실행 계획을 작성하세요.\n\n## 규칙\n- 파일을 읽고(read), 검색하여(grep, find) 코드베이스를 파악하세요\n- 코드를 수정하지 마세요 — 분석과 계획만 작성\n- 출력 형식:\n  1. **분석**: 핵심 요구사항 (2-3문장)\n  2. **실행 계획**: 파일별 구체적 단계\n  3. **완료 조건**: 완료 판단 기준\n- 간결하게 작성하세요";

const WORKER_PROMPT =
	"당신은 뛰어난 소프트웨어 엔지니어입니다. 주어진 실행 계획에 따라 코딩 작업을 수행하세요.\n\n## 규칙\n- 파일을 읽고(read), 검색하여(grep, find) 현재 상태를 파악하세요\n- bash로 명령을 실행하고, edit/write로 파일을 수정하세요\n- 각 단계를 수행한 후 결과를 명시하세요\n- 모든 작업이 끝나면 완료했습니다로 끝맺으세요";

const REVIEWER_PROMPT =
	"당신은 깐깐한 코드 리뷰어입니다. Worker가 작업한 결과물을 검토하세요.\n\n## 검토 기준\n1. 원본 태스크의 모든 요구사항이 충족되었는가?\n2. 코드 품질 (가독성, 에러 처리, 엣지 케이스)\n3. 빠뜨린 부분이 없는가?\n\n## 출력 규칙\n- 완료: APPROVED로 시작\n- 수정 필요: NEEDS_FIX로 시작 후 구체적 수정사항 나열";
