/**
 * OxiPi Advisor System — Real implementation with tools
 *
 * Architecture:
 *
 *   /advisor <task>
 *     │
 *     ├─ TaskClassifier → detects task type
 *     ├─ ModelRouter → picks advisor/worker models from routing.json
 *     │
 *     ├─ AdvisorOrchestrator
 *     │   ├─ Phase 1: Advisor (Opus/Sonnet) + readOnlyTools → plan
 *     │   ├─ Phase 2: Worker (Sonnet/Haiku) + codingTools → execute
 *     │   └─ Phase 3: iterate if needed
 *     │
 *     └─ SubAgentSpawner (forks child processes for parallel work)
 */

import { Agent, type AgentMessage, type ThinkingLevel } from "@oxipi/agent-core";
import { type Api, type Context, type Message, type Model, streamSimple } from "@oxipi/ai";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ModelRegistry } from "../model-registry.js";
import { type Tool, readOnlyTools, codingTools } from "../tools/index.js";
import { convertToLlm } from "../messages.js";

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
	| { type: "advisor_done"; plan: string }
	| { type: "worker_start"; model: string; iteration: number }
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
// Task Classifier
// =============================================================================

export class TaskClassifier {
	async classify(task: string): Promise<string> {
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
// Tool-bearing Agent Factory
// =============================================================================

class ToolAgent {
	private agent: Agent;
	private registry: ModelRegistry;

	constructor(model: Model<Api>, registry: ModelRegistry, tools: Tool[], systemPrompt: string) {
		this.registry = registry;

		this.agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: model.reasoning ? "medium" : ("off" as ThinkingLevel),
				tools: tools as any[],
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
			sessionId: `oxipi-advisor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		});
	}

	/** Run the agent with a user message, return all assistant text when done */
	async run(userMessage: string): Promise<string> {
		const messages: AgentMessage[] = [
			{ role: "user" as const, content: [{ type: "text" as const, text: userMessage }], timestamp: Date.now() },
		];

		// prompt() triggers the full agent loop: LLM call → tool calls → response
		await this.agent.prompt(messages);

		// Collect all assistant text from the agent's message history
		const state = this.agent.state;
		const texts: string[] = [];
		for (const msg of state.messages) {
			if (msg.role === "assistant") {
				for (const block of msg.content) {
					if (block.type === "text" && block.text.trim()) {
						texts.push(block.text);
					}
				}
			}
		}
		return texts.join("\n\n");
	}
}

// =============================================================================
// Advisor Orchestrator — Advisor + Worker with real tools
// =============================================================================

export class AdvisorOrchestrator {
	private registry: ModelRegistry;
	private router: ModelRouter;
	private classifier: TaskClassifier;

	constructor(registry: ModelRegistry, router: ModelRouter) {
		this.registry = registry;
		this.router = router;
		this.classifier = new TaskClassifier();
	}

	async run(task: string, taskType?: string, onProgress?: ProgressCallback): Promise<AdvisorResult> {
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

		// --- Phase 1: Advisor plans (read-only tools: can read files, grep, find) ---
		onProgress?.({ type: "advisor_start", model: modelInfo.advisor });

		let plan: string;
		try {
			const advisor = new ToolAgent(
				advisorModel,
				this.registry,
				readOnlyTools, // read, grep, find, ls — no mutation
				ADVISOR_SYSTEM_PROMPT,
			);
			plan = await advisor.run(task);
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

		// --- Phase 2: Worker executes (all coding tools) ---
		let workerOutput = "";
		let iteration = 0;

		for (iteration = 1; iteration <= routing.maxIterations; iteration++) {
			onProgress?.({ type: "worker_start", model: modelInfo.worker, iteration });

			try {
				const worker = new ToolAgent(
					workerModel,
					this.registry,
					codingTools, // read, bash, edit, write — full power
					WORKER_SYSTEM_PROMPT,
				);

				const prompt =
					iteration === 1
						? `## 태스크\n${task}\n\n## 실행 계획\n${plan}\n\n위 계획에 따라 작업을 시작하세요.`
						: `## 태스크\n${task}\n\n## 실행 계획\n${plan}\n\n## 이전 결과\n${workerOutput}\n\n아직 완료되지 않은 부분을 마저 진행하세요.`;

				workerOutput = await worker.run(prompt);
			} catch (error) {
				const msg = `Worker failed (iteration ${iteration}): ${error instanceof Error ? error.message : String(error)}`;
				onProgress?.({ type: "error", error: msg });
				return { success: false, error: msg, plan, iterations: iteration, models: modelInfo };
			}

			onProgress?.({ type: "worker_done", output: workerOutput });

			if (looksComplete(workerOutput)) break;
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
}

// =============================================================================
// SubAgent Spawner — child process parallel execution
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
	private children: Map<string, ChildProcess> = new Map();

	constructor(registry: ModelRegistry, router: ModelRouter) {
		this.registry = registry;
		this.router = router;
	}

	/** Spawn a sub-agent in a child process */
	spawnChild(id: string, task: string, taskType: string = "default"): ChildProcess {
		const self = process.execPath;
		const script = `
			import { createAdvisorSystem } from "./dist/core/advisor/index.js";
			import { ModelRegistry } from "./dist/core/model-registry.js";
			import { AuthStorage } from "./dist/core/auth-storage.js";
			import { getAgentDir } from "./dist/config.js";

			const dir = getAgentDir();
			const auth = AuthStorage.create(dir + "/auth.json");
			const registry = ModelRegistry.create(auth);
			const { orchestrator } = createAdvisorSystem(registry);

			orchestrator.run(process.argv[1], process.argv[2]).then(r => {
				if (r.success) {
					process.stdout.write(JSON.stringify({ id: "${id}", status: "completed", output: r.output, duration: 0 }));
				} else {
					process.stdout.write(JSON.stringify({ id: "${id}", status: "failed", error: r.error, duration: 0 }));
				}
				process.exit(0);
			}).catch(e => {
				process.stdout.write(JSON.stringify({ id: "${id}", status: "failed", error: e.message, duration: 0 }));
				process.exit(1);
			});
		`;

		const child = spawn(self, ["--input-type=module", "-e", script, task, taskType], {
			cwd: dirname(__filename).replace("/src/core/advisor", ""),
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		this.children.set(id, child);
		return child;
	}

	/** Spawn in same process (simpler, for sequential or small parallel work) */
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

	/** Spawn multiple tasks in parallel (uses child processes for isolation) */
	async spawnParallel(
		tasks: SubAgentTask[],
		onProgress?: (id: string, output: string) => void,
	): Promise<Map<string, SubAgentResult>> {
		// For now, run in same process with Promise.all
		// TODO: Use child processes for true isolation
		const results = await Promise.all(
			tasks.map((t) => this.spawn(t.id, t.task, t.type, (o) => onProgress?.(t.id, o))),
		);
		const map = new Map<string, SubAgentResult>();
		for (let i = 0; i < results.length; i++) {
			map.set(tasks[i].id, results[i]);
		}
		return map;
	}

	async mergeResults(results: Map<string, SubAgentResult>): Promise<string> {
		const parts: string[] = [];
		let ok = 0;
		let fail = 0;

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
		for (const [, child] of this.children) {
			child.kill("SIGTERM");
		}
		this.children.clear();
	}
}

// =============================================================================
// WorkTree — parallel branches with result merging
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
	const pos = ["완료했습니다", "완료되었습니다", "task completed", "done.", "finished"];
	const neg = ["not complete", "아직 완료", "not done", "실패"];
	return pos.some((p) => lower.includes(p)) && !neg.some((n) => lower.includes(n));
}

// =============================================================================
// System Prompts
// =============================================================================

const ADVISOR_SYSTEM_PROMPT = `당신은 숙련된 기술 리드입니다. 주어진 태스크를 분석하고 실행자를 위한 구체적인 실행 계획을 작성하세요.

## 규칙
- 파일을 읽고(read), 검색하여(grep, find) 코드베이스를 파악하세요
- 코드를 수정하지 마세요 — 분석과 계획만 작성
- 출력 형식:
  1. **분석**: 핵심 요구사항 (2-3문장)
  2. **실행 계획**: 파일별 구체적 단계
  3. **완료 조건**: 완료 판단 기준
- 간결하게 작성하세요`;

const WORKER_SYSTEM_PROMPT = `당신은 뛰어난 소프트웨어 엔지니어입니다. 주어진 실행 계획에 따라 코딩 작업을 수행하세요.

## 규칙
- 파일을 읽고(read), 검색하여(grep, find) 현재 상태를 파악하세요
- bash로 명령을 실행하고, edit/write로 파일을 수정하세요
- 각 단계를 수행한 후 결과를 명시하세요
- 모든 작업이 끝나면 "완료했습니다"로 끝맺으세요`;