/**
 * OxiPi Advisor System — Full implementation
 *
 *   /advisor <task>
 *     ├─ TaskClassifier (LLM-based)
 *     ├─ ModelRouter (routing.json)
 *     ├─ AdvisorOrchestrator
 *     │   ├─ AdvisorAgent (readOnlyTools + streaming)
 *     │   └─ WorkerAgent (codingTools + streaming)
 *     └─ SubAgentSpawner (git worktree + child processes)
 */

import {
	Agent,
	type AgentEvent as CoreAgentEvent,
	type AgentMessage,
	type ThinkingLevel,
} from "@oxipi/agent-core";
import {
	type Api,
	type AssistantMessageEvent,
	type Context,
	type Message,
	type Model,
	streamSimple,
} from "@oxipi/ai";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
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

export interface TaskConfig { provider: string; model: string }
export interface TaskRouting {
	description: string;
	advisor: TaskConfig;
	worker: TaskConfig;
	maxIterations: number;
}
export interface RoutingConfig { version: string; tasks: Record<string, TaskRouting> }

export interface AdvisorResult {
	success: boolean;
	plan?: string;
	output?: string;
	error?: string;
	iterations: number;
	models: { advisor: string; worker: string };
}

export interface SubAgentTask { id: string; task: string; type: string }

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
	| { type: "advisor_text"; text: string }           // streaming chunk
	| { type: "advisor_tool"; tool: string; args: any }
	| { type: "advisor_done"; plan: string }
	| { type: "worker_start"; model: string; iteration: number }
	| { type: "worker_text"; text: string }            // streaming chunk
	| { type: "worker_tool"; tool: string; args: any }
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
		try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return this.defaultConfig(); }
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
// Task Classifier — LLM-based with keyword fallback
// =============================================================================

export class TaskClassifier {
	private registry: ModelRegistry | null;

	constructor(registry?: ModelRegistry) {
		this.registry = registry ?? null;
	}

	async classify(task: string): Promise<string> {
		// Try LLM classification first if we have a registry
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
		// Find the cheapest available model for classification
		const models = this.registry!.getAvailable();
		const fastModel = models.find((m) =>
			m.id.includes("haiku") || m.id.includes("flash") || m.id.includes("mini"),
		) ?? models[0];

		if (!fastModel) return "default";

		const auth = await this.registry!.getApiKeyAndHeaders(fastModel);
		if (!auth.ok || !auth.apiKey) return "default";

		const { completeSimple } = await import("@oxipi/ai");
		const context: Context = {
			messages: [{
				role: "user",
				content: `Classify this task into exactly one category. Reply with ONLY the category name, nothing else.\n\nCategories: codeGeneration, webSearch, review, reasoning, imageProcessing, default\n\nTask: ${task}`,
				timestamp: Date.now(),
			}],
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

		// Match to known types
		const known = ["codegeneration", "websearch", "review", "reasoning", "imageprocessing", "default"];
		const match = known.find((k) => text.includes(k));
		return match || "default";
	}

	private classifyWithKeywords(task: string): string {
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
// ToolAgent — Agent with tools + streaming events
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
			sessionId: `oxipi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		});
	}

	/**
	 * Run with streaming events.
	 * Emits text/tool events as they happen, returns final accumulated text.
	 */
	async run(
		userMessage: string,
		onEvent?: (phase: "advisor" | "worker", event: CoreAgentEvent) => void,
	): Promise<string> {
		const phase: "advisor" | "worker" = "advisor"; // caller sets via onEvent closure

		const unsub = this.agent.subscribe((event) => {
			if (!onEvent) return;

			switch (event.type) {
				case "message_update":
					if ("content" in event.message) {
						for (const block of (event.message as any).content) {
							if (block.type === "text") onEvent(phase, event);
						}
					}
					break;
				case "tool_execution_start":
					onEvent(phase, event);
					break;
				case "tool_execution_end":
					onEvent(phase, event);
					break;
			}
		});

		try {
			const messages: AgentMessage[] = [
				{ role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() },
			];
			await this.agent.prompt(messages);

			// Collect all assistant text
			const texts: string[] = [];
			for (const msg of this.agent.state.messages) {
				if (msg.role === "assistant" && "content" in msg) {
					for (const block of (msg as any).content) {
						if (block.type === "text" && block.text.trim()) texts.push(block.text);
					}
				}
			}
			return texts.join("\n\n");
		} finally {
			unsub();
		}
	}
}

// =============================================================================
// Advisor Orchestrator — real tools + streaming
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
			plan = await advisor.run(task, (phase, evt) => {
				if (evt.type === "message_update") {
					for (const b of (evt.message as any).content) {
						if (b.type === "text") onProgress?.({ type: "advisor_text", text: b.text });
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
				const prompt = iteration === 1
					? `## 태스크\n${task}\n\n## 실행 계획\n${plan}\n\n위 계획에 따라 작업을 시작하세요.`
					: `## 태스크\n${task}\n\n## 실행 계획\n${plan}\n\n## 이전 결과\n${workerOutput}\n\n완료되지 않은 부분을 마저 진행하세요.`;

				workerOutput = await worker.run(prompt, (phase, evt) => {
					if (evt.type === "message_update") {
						for (const b of (evt.message as any).content) {
							if (b.type === "text") onProgress?.({ type: "worker_text", text: b.text });
						}
					}
					if (evt.type === "tool_execution_start") {
						onProgress?.({ type: "worker_tool", tool: evt.toolName, args: evt.args });
					}
				});
			} catch (error) {
				const msg = `Worker failed (iter ${iteration}): ${error instanceof Error ? error.message : String(error)}`;
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
// Git Worktree Manager
// =============================================================================

import { execSync } from "child_process";

export class WorktreeManager {
	private baseDir: string;
	private worktrees: Map<string, string> = new Map(); // branch → worktree path

	constructor(private cwd: string) {
		this.baseDir = join(cwd, ".oxipi", "worktrees");
	}

	/** Create a git worktree for a branch */
	async create(branchId: string): Promise<string> {
		await this.ensureDir(this.baseDir);
		const worktreePath = join(this.baseDir, branchId);

		// Remove if exists
		if (existsSync(worktreePath)) {
			try { execSync(`git worktree remove --force "${worktreePath}"`, { cwd: this.cwd, stdio: "pipe" }); } catch {}
		}

		// Create new branch + worktree
		try {
			execSync(`git worktree add -b "oxipi/${branchId}" "${worktreePath}" HEAD`, { cwd: this.cwd, stdio: "pipe" });
		} catch {
			// Branch might already exist, try without -b
			try {
				execSync(`git worktree add "${worktreePath}" HEAD`, { cwd: this.cwd, stdio: "pipe" });
			} catch (e) {
				throw new Error(`Failed to create worktree for ${branchId}: ${e}`);
			}
		}

		this.worktrees.set(branchId, worktreePath);
		return worktreePath;
	}

	/** Get worktree path */
	getPath(branchId: string): string | undefined {
		return this.worktrees.get(branchId);
	}

	/** Remove a worktree */
	async remove(branchId: string): Promise<void> {
		const path = this.worktrees.get(branchId);
		if (!path) return;

		try { execSync(`git worktree remove --force "${path}"`, { cwd: this.cwd, stdio: "pipe" }); } catch {}
		try { execSync(`git branch -D "oxipi/${branchId}"`, { cwd: this.cwd, stdio: "pipe" }); } catch {}
		this.worktrees.delete(branchId);
	}

	/** Remove all worktrees */
	async removeAll(): Promise<void> {
		for (const id of this.worktrees.keys()) {
			await this.remove(id);
		}
	}

	private async ensureDir(dir: string): Promise<void> {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
}

// =============================================================================
// SubAgent Spawner — git worktree + child processes
// =============================================================================

export class SubAgentSpawner {
	private registry: ModelRegistry;
	private router: ModelRouter;
	private children: Map<string, ChildProcess> = new Map();
	private worktreeManager: WorktreeManager | null = null;

	constructor(registry: ModelRegistry, router: ModelRouter, cwd?: string) {
		this.registry = registry;
		this.router = router;
		if (cwd) this.worktreeManager = new WorktreeManager(cwd);
	}

	/** Set worktree root */
	setCwd(cwd: string): void {
		this.worktreeManager = new WorktreeManager(cwd);
	}

	/** Spawn in same process */
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

	/** Spawn in a child process with its own git worktree */
	async spawnInWorktree(
		id: string,
		task: string,
		taskType: string = "default",
	): Promise<SubAgentResult> {
		const start = Date.now();

		// Create worktree
		let worktreePath: string | undefined;
		if (this.worktreeManager) {
			try {
				worktreePath = await this.worktreeManager.create(`agent-${id}`);
			} catch {
				// Fall back to same-process if worktree fails
			}
		}

		if (!worktreePath) {
			// No worktree, run in same process
			return this.spawn(id, task, taskType);
		}

		// Spawn child process in worktree
		return new Promise((resolve) => {
			const child = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
					import { createAdvisorSystem } from "./dist/core/advisor/index.js";
					import { ModelRegistry } from "./dist/core/model-registry.js";
					import { AuthStorage } from "./dist/core/auth-storage.js";
					import { getAgentDir } from "./dist/config.js";

					const task = process.argv[1];
					const type = process.argv[2];
					const dir = getAgentDir();
					const auth = AuthStorage.create(dir + "/auth.json");
					const reg = ModelRegistry.create(auth);
					const { orchestrator } = createAdvisorSystem(reg);
					orchestrator.run(task, type).then(r => {
						process.stdout.write(JSON.stringify(r));
					}).catch(e => {
						process.stdout.write(JSON.stringify({ success: false, error: e.message }));
					});
					`,
					task,
					taskType,
				],
				{
					cwd: worktreePath, // Run in the worktree!
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...process.env },
				},
			);

			this.children.set(id, child);

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
			child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

			child.on("close", (code) => {
				this.children.delete(id);

				// Cleanup worktree
				if (this.worktreeManager) {
					this.worktreeManager.remove(`agent-${id}`).catch(() => {});
				}

				try {
					const parsed = JSON.parse(stdout);
					resolve({
						id,
						status: parsed.success ? "completed" : "failed",
						output: parsed.output,
						error: parsed.error,
						duration: Date.now() - start,
					});
				} catch {
					resolve({
						id,
						status: "failed",
						error: stderr || `Process exited with code ${code}`,
						duration: Date.now() - start,
					});
				}
			});
		});
	}

	/** Spawn multiple tasks in parallel with git worktrees */
	async spawnParallel(
		tasks: SubAgentTask[],
		onProgress?: (id: string, output: string) => void,
	): Promise<Map<string, SubAgentResult>> {
		const useWorktree = this.worktreeManager !== null && tasks.length > 1;

		const results = await Promise.all(
			tasks.map((t) =>
				useWorktree
					? this.spawnInWorktree(t.id, t.task, t.type)
					: this.spawn(t.id, t.task, t.type, (o) => onProgress?.(t.id, o)),
			),
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
				parts.push(`## ✅ ${id}\n${r.output}`);
			} else {
				fail++;
				parts.push(`## ❌ ${id}\n${r.error || "Unknown error"}`);
			}
		}
		return `# 병합 결과\n성공: ${ok}, 실패: ${fail}\n\n${parts.join("\n\n---\n\n")}`;
	}

	killAll(): void {
		for (const [, child] of this.children) child.kill("SIGTERM");
		this.children.clear();
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
		this.results = await this.spawner.spawnParallel(
			Array.from(this.branches.values()),
			onProgress,
		);
	}

	getResult(id: string): SubAgentResult | undefined { return this.results.get(id); }
	getAllResults(): Map<string, SubAgentResult> { return this.results; }
	async merge(): Promise<string> { return this.spawner.mergeResults(this.results); }
}

// =============================================================================
// Factory
// =============================================================================

export function createAdvisorSystem(registry: ModelRegistry, configPath?: string, cwd?: string) {
	const router = new ModelRouter(registry, configPath);
	const orchestrator = new AdvisorOrchestrator(registry, router);
	const spawner = new SubAgentSpawner(registry, router, cwd);
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

const ADVISOR_PROMPT = `당신은 숙련된 기술 리드입니다. 주어진 태스크를 분석하고 실행자를 위한 구체적인 실행 계획을 작성하세요.

## 규칙
- 파일을 읽고(read), 검색하여(grep, find) 코드베이스를 파악하세요
- 코드를 수정하지 마세요 — 분석과 계획만 작성
- 출력 형식:
  1. **분석**: 핵심 요구사항 (2-3문장)
  2. **실행 계획**: 파일별 구체적 단계
  3. **완료 조건**: 완료 판단 기준
- 간결하게 작성하세요`;

const WORKER_PROMPT = `당신은 뛰어난 소프트웨어 엔지니어입니다. 주어진 실행 계획에 따라 코딩 작업을 수행하세요.

## 규칙
- 파일을 읽고(read), 검색하여(grep, find) 현재 상태를 파악하세요
- bash로 명령을 실행하고, edit/write로 파일을 수정하세요
- 각 단계를 수행한 후 결과를 명시하세요
- 모든 작업이 끝나면 "완료했습니다"로 끝맺으세요`;