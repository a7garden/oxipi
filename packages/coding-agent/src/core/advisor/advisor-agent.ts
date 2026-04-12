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
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { convertToLlm } from "../messages.js";
import type { ModelRegistry } from "../model-registry.js";
import { codingTools, readOnlyTools } from "../tools/index.js";
import { SubAgentIpcBus, type SubAgentIpcMessage } from "./subagent-ipc.js";

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
	worktree?: string;
	branch?: string;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	head: string;
}

export interface SpawnOptions {
	model?: string;
	provider?: string;
	cwd?: string;
	timeout?: number;
	onStdout?: (line: string) => void;
	onStderr?: (line: string) => void;
	onQuestion?: (question: {
		subAgentId: string;
		correlationId: string;
		question: string;
		context?: string;
	}) => Promise<string> | string;
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
// Task Splitter — dynamic sub-task generation for parallel sub-agents
// =============================================================================

export class TaskSplitter {
	private registry: ModelRegistry | null;

	constructor(registry?: ModelRegistry) {
		this.registry = registry ?? null;
	}

	async split(task: string, primaryType: string = "default", minCount = 3, maxCount = 5): Promise<SubAgentTask[]> {
		if (this.registry) {
			try {
				const llmSplit = await this.splitWithLLM(task, minCount, maxCount);
				if (llmSplit.length > 0) return llmSplit;
			} catch {
				// Fallback to heuristic splitter
			}
		}
		return this.splitHeuristic(task, primaryType, minCount, maxCount);
	}

	private async splitWithLLM(task: string, minCount: number, maxCount: number): Promise<SubAgentTask[]> {
		const models = this.registry!.getAvailable();
		const fastModel =
			models.find((m) => m.id.includes("haiku") || m.id.includes("flash") || m.id.includes("mini")) ?? models[0];
		if (!fastModel) return [];

		const auth = await this.registry!.getApiKeyAndHeaders(fastModel);
		if (!auth.ok || !auth.apiKey) return [];

		const context: Context = {
			messages: [
				{
					role: "user",
					content: `Split this coding task into ${minCount}-${maxCount} parallel sub-tasks. Return STRICT JSON array only.\n\nEach item: {"id":"slug","task":"...","type":"reasoning|codeGeneration|review|default"}.\n\nTask:\n${task}`,
					timestamp: Date.now(),
				},
			],
			systemPrompt: "You are a task decomposition planner. Return JSON only.",
		};

		const result = await completeSimple(fastModel, context, {
			apiKey: auth.apiKey,
			headers: auth.headers,
		});

		const text = result.content
			.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();

		const start = text.indexOf("[");
		const end = text.lastIndexOf("]");
		if (start < 0 || end < 0 || end <= start) return [];

		const raw = JSON.parse(text.slice(start, end + 1)) as Array<{ id?: string; task?: string; type?: string }>;
		const normalized = raw
			.filter((r) => typeof r.task === "string" && r.task.trim().length > 0)
			.slice(0, maxCount)
			.map((r, idx) => ({
				id: `sub-${idx + 1}-${(r.id || `part-${idx + 1}`).toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
				task: r.task!.trim(),
				type: (r.type || "default").trim(),
			}));

		return normalized.length >= minCount ? normalized : [];
	}

	private splitHeuristic(task: string, primaryType: string, minCount: number, maxCount: number): SubAgentTask[] {
		const complexityHint =
			task.length > 700 ||
			/\b(and|also|plus|meanwhile|separately|in addition|migrate|refactor|test|docs)\b/i.test(task)
				? 5
				: task.length > 280
					? 4
					: 3;
		const count = Math.min(maxCount, Math.max(minCount, complexityHint));
		const focusPool: Array<{ slug: string; focus: string; type: string }> = [
			{ slug: "context", focus: "codebase context and relevant modules", type: "reasoning" },
			{ slug: "impl", focus: "concrete implementation approach and file-level changes", type: "codeGeneration" },
			{ slug: "risk", focus: "edge cases, risks, and validation strategy", type: "review" },
			{ slug: "tests", focus: "test scenarios and regression prevention", type: "review" },
			{ slug: "plan", focus: "execution ordering and dependency plan", type: primaryType || "default" },
		];
		return focusPool.slice(0, count).map((entry, idx) => ({
			id: `sub-${idx + 1}-${entry.slug}`,
			task: `${task}\n\nFocus: ${entry.focus}`,
			type: entry.type,
		}));
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
// =============================================================================
// WorktreeManager — git worktree lifecycle
// =============================================================================

export class WorktreeManager {
	private repoPath: string;

	constructor(repoPath: string) {
		this.repoPath = repoPath;
	}

	/** Create a new worktree with a dedicated branch */
	async create(branchName: string, baseBranch: string = "main"): Promise<WorktreeInfo> {
		const { execSync } = await import("child_process");
		const worktreesDir = join(this.repoPath, ".worktrees");
		const worktreePath = join(worktreesDir, branchName);

		// Ensure .worktrees directory exists
		execSync(`mkdir -p "${worktreesDir}"`, { cwd: this.repoPath });

		try {
			execSync(`git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`, {
				cwd: this.repoPath,
				stdio: "pipe",
			});
		} catch (e: any) {
			// Worktree might already exist — try to find it
			const output = execSync(`git worktree list --porcelain`, { cwd: this.repoPath, encoding: "utf-8" });
			const lines = output.split("\n");
			let current: WorktreeInfo | null = null;
			for (const line of lines) {
				if (line.startsWith("worktree ")) current = { path: line.slice(8).trim(), branch: "", head: "" };
				else if (line.startsWith("branch refs/heads/") && current) current.branch = line.slice(17).trim();
				else if (line.startsWith("HEAD ") && current) current.head = line.slice(5).trim();
				else if (line === "" && current && current.path === worktreePath) return current;
			}
			throw e;
		}

		return { path: worktreePath, branch: branchName, head: "" };
	}

	/** Remove a worktree */
	async remove(worktreePath: string, force: boolean = false): Promise<void> {
		const { execSync } = await import("child_process");
		execSync(`git worktree remove "${worktreePath}"${force ? " --force" : ""}`, {
			cwd: this.repoPath,
			stdio: "pipe",
		});
	}

	/** List all worktrees */
	async list(): Promise<WorktreeInfo[]> {
		const { execSync } = await import("child_process");
		const output = execSync(`git worktree list --porcelain`, { cwd: this.repoPath, encoding: "utf-8" });
		const worktrees: WorktreeInfo[] = [];
		const lines = output.split("\n");
		let current: WorktreeInfo | null = null;
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				if (current) worktrees.push(current);
				current = { path: line.slice(8).trim(), branch: "", head: "" };
			} else if (line.startsWith("branch refs/heads/") && current) {
				current.branch = line.slice(17).trim();
			} else if (line.startsWith("HEAD ") && current) {
				current.head = line.slice(5).trim();
			} else if (line === "" && current) {
				worktrees.push(current);
				current = null;
			}
		}
		if (current) worktrees.push(current);
		return worktrees;
	}
}

// =============================================================================
// SubAgent Spawner
// =============================================================================

export class SubAgentSpawner {
	private registry: ModelRegistry;
	private router: ModelRouter;
	private worktreeManager: WorktreeManager | null = null;

	constructor(registry: ModelRegistry, router: ModelRouter, repoPath?: string) {
		this.registry = registry;
		this.router = router;
		if (repoPath) this.worktreeManager = new WorktreeManager(repoPath);
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

	/**
	 * Spawn a sub-agent in a separate git worktree with its own oxipi process.
	 * Full isolation: separate git branch, file system, and process.
	 */
	async spawnInWorktree(
		id: string,
		task: string,
		taskType: string = "default",
		opts: SpawnOptions = {},
	): Promise<SubAgentResult> {
		const start = Date.now();
		const wm = opts.cwd ? new WorktreeManager(opts.cwd) : this.worktreeManager;
		const routing = this.router.getRouting(taskType);
		const model = opts.model || routing.worker.model;
		const branchName = `oxipi-${id}-${Date.now()}`;
		let worktreePath: string | null = null;

		if (!wm) return { id, status: "failed", error: "No worktree manager", duration: 0 };

		const cleanup = async () => {
			if (worktreePath) {
				try {
					await wm!.remove(worktreePath, true);
				} catch {}
			}
		};

		try {
			const info = await wm.create(branchName, "main");
			worktreePath = info.path;
			const ipcFile = join(worktreePath, ".oxipi", "subagent", `${id}.jsonl`);
			const bus = new SubAgentIpcBus(ipcFile);
			await bus.append({ type: "sub_ready", subAgentId: id, timestamp: Date.now() });

			let offset = 0;
			const questionLoop = setInterval(async () => {
				const read = await bus.readSince(offset);
				offset = read.nextOffset;
				for (const msg of read.messages) {
					if (msg.type !== "sub_question") continue;
					const replyText =
						(await opts.onQuestion?.({
							subAgentId: msg.subAgentId,
							correlationId: msg.correlationId,
							question: msg.question,
							context: msg.context,
						})) ?? "Proceed with best judgment and continue.";
					await bus.append({
						type: "parent_reply",
						subAgentId: msg.subAgentId,
						correlationId: msg.correlationId,
						reply: replyText,
						timestamp: Date.now(),
					});
				}
			}, 1000);

			const output = await this.runProcess("oxipi", ["-p", "--no-session", "--model", model, task], {
				cwd: worktreePath,
				timeout: opts.timeout || 300000,
				onStdout: opts.onStdout,
				onStderr: opts.onStderr,
				env: {
					OXIPI_SUBAGENT_IPC_FILE: ipcFile,
					OXIPI_SUBAGENT_ID: id,
				},
			});
			clearInterval(questionLoop);
			await bus.append({
				type: output.exitCode === 0 ? "sub_done" : "sub_error",
				subAgentId: id,
				timestamp: Date.now(),
				...(output.exitCode === 0
					? { summary: "Sub-agent finished." }
					: { error: output.stderr || "Sub-agent failed." }),
			} as SubAgentIpcMessage);

			return {
				id,
				status: output.exitCode === 0 ? "completed" : "failed",
				output: output.stdout,
				error: output.exitCode !== 0 ? output.stderr : undefined,
				duration: Date.now() - start,
				worktree: worktreePath,
				branch: branchName,
			};
		} catch (e: any) {
			return {
				id,
				status: "failed",
				error: e.message,
				duration: Date.now() - start,
				worktree: worktreePath || undefined,
				branch: branchName,
			};
		} finally {
			await cleanup();
		}
	}

	/** Spawn multiple agents in parallel, each in its own worktree */
	async spawnParallelInWorktrees(
		tasks: SubAgentTask[],
		opts: SpawnOptions = {},
		onProgress?: (id: string, line: string) => void,
	): Promise<Map<string, SubAgentResult>> {
		const wm = opts.cwd ? new WorktreeManager(opts.cwd) : this.worktreeManager!;
		const branches = new Map<string, WorktreeInfo>();

		// Pre-create all worktrees
		for (const task of tasks) {
			const branchName = `oxipi-${task.id}`;
			try {
				const info = await wm.create(branchName, "main");
				branches.set(task.id, info);
			} catch (e: any) {
				onProgress?.(task.id, `[worktree error] ${e.message}`);
			}
		}

		// Spawn all in parallel
		const spawns = tasks.map(async (task) => {
			const branch = branches.get(task.id);
			const routing = this.router.getRouting(task.type);
			const model = opts.model || routing.worker.model;
			const start = Date.now();
			let output = "";
			let errOut = "";

			try {
				const result = await this.runProcess("oxipi", ["-p", "--no-session", "--model", model, task.task], {
					cwd: branch?.path || opts.cwd || ".",
					timeout: opts.timeout || 300000,
					onStdout: (line) => {
						output += `${line}\n`;
						onProgress?.(task.id, line);
					},
					onStderr: (line) => {
						errOut += `${line}\n`;
					},
				});
				return {
					id: task.id,
					status: result.exitCode === 0 ? ("completed" as const) : ("failed" as const),
					output,
					error: result.exitCode !== 0 ? errOut : undefined,
					duration: Date.now() - start,
					worktree: branch?.path,
					branch: branch?.branch,
				};
			} catch (e: any) {
				return {
					id: task.id,
					status: "failed" as const,
					error: e.message,
					duration: Date.now() - start,
					worktree: branch?.path,
					branch: branch?.branch,
				};
			}
		});

		const results = await Promise.all(spawns);

		// Cleanup all worktrees
		await Promise.allSettled(Array.from(branches.values()).map((b) => wm.remove(b.path, true)));

		const map = new Map<string, SubAgentResult>();
		for (const r of results) map.set(r.id, r);
		return map;
	}

	private runProcess(
		cmd: string,
		args: string[],
		opts: {
			cwd?: string;
			timeout?: number;
			onStdout?: (line: string) => void;
			onStderr?: (line: string) => void;
			env?: Record<string, string>;
		},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let killed = false;

			const proc = spawn(cmd, args, {
				cwd: opts.cwd || process.cwd(),
				env: { ...process.env, FORCE_COLOR: "0", ...(opts.env ?? {}) },
				shell: false,
			});

			const timer = setTimeout(() => {
				killed = true;
				proc.kill("SIGTERM");
			}, opts.timeout || 300000);

			proc.stdout?.on("data", (data: Buffer) => {
				const line = data.toString();
				stdout += line;
				opts.onStdout?.(line.trim());
			});
			proc.stderr?.on("data", (data: Buffer) => {
				const line = data.toString();
				stderr += line;
				opts.onStderr?.(line.trim());
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				if (killed) stderr += "\n[timeout]";
				resolve({ stdout, stderr, exitCode: code ?? (killed ? -1 : 0) });
			});
			proc.on("error", (_e) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, exitCode: -1 });
			});
		});
	}

	async mergeResults(results: Map<string, SubAgentResult>): Promise<string> {
		const parts: string[] = [];
		let ok = 0;
		let fail = 0;

		for (const [id, r] of results) {
			if (r.status === "completed" && r.output) {
				ok++;
				parts.push(`## OK: ${id}${r.worktree ? ` [${r.branch}]` : ""}\n${r.output}`);
			} else {
				fail++;
				parts.push(`## FAIL: ${id}${r.worktree ? ` [${r.branch}]` : ""}\n${r.error || "Unknown error"}`);
			}
		}
		return `# Merged Results — ${ok} OK, ${fail} Failed\n\n${parts.join("\n\n---\n\n")}`;
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

	async executeInWorktrees(opts: SpawnOptions = {}, onProgress?: (id: string, line: string) => void): Promise<void> {
		this.results = await this.spawner.spawnParallelInWorktrees(Array.from(this.branches.values()), opts, onProgress);
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

export function createAdvisorSystem(registry: ModelRegistry, configPath?: string, repoPath?: string) {
	const router = new ModelRouter(registry, configPath);
	const orchestrator = new AdvisorOrchestrator(registry, router);
	const spawner = new SubAgentSpawner(registry, router, repoPath);
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
