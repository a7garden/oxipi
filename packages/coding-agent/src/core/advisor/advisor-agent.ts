/**
 * OxiPi Advisor System
 *
 * Architecture (inspired by opencode + Claude Advisor pattern):
 *
 *   Orchestrator
 *   ├── AdvisorAgent (high-capability model, plans & reviews)
 *   │   └── Uses: read, grep, find, ls (read-only tools)
 *   ├── WorkerAgent (fast model, executes plan)
 *   │   └── Uses: read, bash, edit, write, grep, find, ls (all tools)
 *   └── SubAgentSpawner (parallel execution via git worktrees)
 */

import { type Api, type Context, completeSimple, type Message, type Model } from "@oxipi/ai";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ModelRegistry } from "../model-registry.js";

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

export type ProgressCallback = (event: AdvisorEvent) => void;

export type AdvisorEvent =
	| { type: "advisor_start"; model: string }
	| { type: "advisor_output"; output: string }
	| { type: "advisor_done"; plan: string }
	| { type: "worker_start"; model: string; iteration: number }
	| { type: "worker_output"; output: string }
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
		const defaultPath = join(__dirname, "routing.json");
		this.config = this.loadConfig(configPath || defaultPath);
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
// Task Classifier — uses a fast model to classify the task type
// =============================================================================

export class TaskClassifier {
	private registry: ModelRegistry;

	constructor(registry: ModelRegistry) {
		this.registry = registry;
	}

	async classify(task: string): Promise<string> {
		// Simple keyword matching for now.
		// TODO: Use a fast model (haiku/flash) for classification
		const t = task.toLowerCase();

		if (/코드|code|구현|implement|작성|write|리팩토링|refactor/.test(t)) return "codeGeneration";
		if (/검색|search|찾아|lookup|조사/.test(t)) return "webSearch";
		if (/리뷰|review|검토|디버그|debug|수정|fix/.test(t)) return "review";
		if (/분석|analyze|추론|reason|설계|design|아키텍처|architecture/.test(t)) return "reasoning";
		if (/이미지|image|스크린샷|screenshot/.test(t)) return "imageProcessing";

		return "default";
	}
}

// =============================================================================
// Advisor Orchestrator — the real deal
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
		// 1. Classify task type if not provided
		const resolvedType = taskType || (await this.classifier.classify(task));
		const routing = this.router.getRouting(resolvedType);
		const advisorModel = this.router.getModel(routing.advisor);
		const workerModel = this.router.getModel(routing.worker);

		const modelInfo = {
			advisor: `${routing.advisor.provider}/${routing.advisor.model}`,
			worker: `${routing.worker.provider}/${routing.worker.model}`,
		};

		if (!advisorModel || !workerModel) {
			const missing = !advisorModel ? modelInfo.advisor : modelInfo.worker;
			const err = `Model not found: ${missing}. Check routing.json and API keys.`;
			onProgress?.({ type: "error", error: err });
			return { success: false, error: err, iterations: 0, models: modelInfo };
		}

		// 2. Phase 1: Advisor plans
		onProgress?.({ type: "advisor_start", model: modelInfo.advisor });

		let plan: string;
		try {
			plan = await this.callModel(
				advisorModel,
				[
					{
						role: "user",
						content: ADVISOR_SYSTEM_PROMPT.replace("{TASK}", task),
						timestamp: Date.now(),
					},
				],
				"당신은 숙련된 기술 리드입니다. 태스크를 분석하고 실행자를 위한 구체적인 실행 계획을 작성하세요.",
			);

			onProgress?.({ type: "advisor_done", plan });
		} catch (error) {
			const msg = `Advisor failed: ${error instanceof Error ? error.message : String(error)}`;
			onProgress?.({ type: "error", error: msg });
			return { success: false, error: msg, iterations: 0, models: modelInfo };
		}

		if (!plan.trim()) {
			const msg = "Advisor returned empty plan";
			onProgress?.({ type: "error", error: msg });
			return { success: false, error: msg, iterations: 0, plan, models: modelInfo };
		}

		// 3. Phase 2: Worker executes (with iteration loop)
		let workerOutput = "";
		let iteration = 0;

		for (iteration = 1; iteration <= routing.maxIterations; iteration++) {
			onProgress?.({ type: "worker_start", model: modelInfo.worker, iteration });

			try {
				const prompt =
					iteration === 1
						? WORKER_EXECUTE_PROMPT.replace("{PLAN}", plan).replace("{TASK}", task)
						: WORKER_REFINE_PROMPT.replace("{PREVIOUS_OUTPUT}", workerOutput)
								.replace("{PLAN}", plan)
								.replace("{TASK}", task);

				workerOutput = await this.callModel(
					workerModel,
					[{ role: "user", content: prompt, timestamp: Date.now() }],
					"당신은 뛰어난 소프트웨어 엔지니어입니다. 계획을 정확하게 실행하세요.",
				);

				onProgress?.({ type: "worker_output", output: workerOutput });
			} catch (error) {
				const msg = `Worker failed (iteration ${iteration}): ${error instanceof Error ? error.message : String(error)}`;
				onProgress?.({ type: "error", error: msg });
				return { success: false, error: msg, plan, iterations: iteration, models: modelInfo };
			}

			onProgress?.({ type: "worker_done", output: workerOutput });

			// Check if worker thinks it's done
			if (this.looksComplete(workerOutput)) {
				break;
			}
		}

		const result: AdvisorResult = {
			success: true,
			plan,
			output: workerOutput,
			iterations: iteration,
			models: modelInfo,
		};

		onProgress?.({ type: "complete", result });
		return result;
	}

	/** Call a model and return the text content */
	private async callModel(model: Model<Api>, messages: Message[], systemPrompt: string): Promise<string> {
		const auth = await this.registry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error(`No API key for ${model.provider}`);
		}

		const context: Context = {
			messages,
			systemPrompt,
		};

		const result = await completeSimple(model, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
		});

		// Extract text blocks
		return result.content
			.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}

	/** Heuristic: does the output look like a completed task? */
	private looksComplete(output: string): boolean {
		const lower = output.toLowerCase();
		// Positive signals
		const positives = ["완료했습니다", "완료되었습니다", "task completed", "done.", "finished"];
		// Negative signals (don't false-positive on these)
		const negatives = ["not complete", "아직 완료", "not done", "실패"];

		const hasPos = positives.some((p) => lower.includes(p));
		const hasNeg = negatives.some((n) => lower.includes(n));

		return hasPos && !hasNeg;
	}
}

// =============================================================================
// SubAgent Spawner — parallel execution
// =============================================================================

export interface SubAgentResult {
	id: string;
	status: "completed" | "failed";
	output?: string;
	error?: string;
	duration: number;
}

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
			if (evt.type === "worker_output") onProgress?.(evt.output);
			if (evt.type === "advisor_output") onProgress?.(evt.output);
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
		results.forEach((r, i) => {
			map.set(tasks[i].id, r);
		});
		return map;
	}

	async mergeResults(results: Map<string, SubAgentResult>): Promise<string> {
		const parts: string[] = ["# 병합 결과\n"];
		let ok = 0;
		let fail = 0;

		for (const [id, r] of results) {
			if (r.status === "completed" && r.output) {
				ok++;
				parts.push(`## ✅ ${id}\n${r.output}\n`);
			} else {
				fail++;
				parts.push(`## ❌ ${id}\n${r.error || "Unknown error"}\n`);
			}
		}

		parts.unshift(`성공: ${ok}, 실패: ${fail}\n`);
		return parts.join("\n");
	}
}

// =============================================================================
// WorkTree
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
// Prompts
// =============================================================================

const ADVISOR_SYSTEM_PROMPT = `다음 태스크를 분석하고, 실행자가 바로 작업할 수 있을 만큼 구체적인 실행 계획을 작성하세요.

## 태스크
{TASK}

## 출력 형식
1. **분석**: 태스크의 핵심 요구사항 (2-3문장)
2. **실행 계획**: 파일별로 구체적인 단계 (어떤 파일을 읽고, 무엇을 수정할지)
3. **완료 조건**: 언제 태스크가 완료되었는지 판단할 기준

간결하게 작성하세요.`;

const WORKER_EXECUTE_PROMPT = `다음 실행 계획에 따라 태스크를 수행하세요.

## 원본 태스크
{TASK}

## 실행 계획
{PLAN}

## 지시
- 계획을 그대로 실행하세요
- 각 단계별로 수행한 작업을 명시하세요
- 완료 후 "완료했습니다"로 끝맺으세요`;

const WORKER_REFINE_PROMPT = `이전 실행 결과를 검토하고, 아직 완료되지 않은 부분을 마저 진행하세요.

## 원본 태스크
{TASK}

## 실행 계획
{PLAN}

## 이전 실행 결과
{PREVIOUS_OUTPUT}

## 지시
- 이전 결과에서 누락되거나 불완전한 부분을 보완하세요
- 모든 것이 완료되었다면 "완료했습니다"로 끝맺으세요`;
