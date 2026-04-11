/**
 * Advisor Agent - Implements the Advisor pattern
 * Advisor (Opus) plans → Executor (Sonnet/Haiku) executes → Results merged
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { type Model, streamSimple } from "@mariozechner/pi-ai";
import { readFileSync } from "fs";
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
	executor: TaskConfig;
	maxIterations: number;
}

export interface RoutingConfig {
	version: string;
	tasks: Record<string, TaskRouting>;
}

export interface AdvisorResult {
	success: boolean;
	output?: string;
	error?: string;
	iterations: number;
	advisorCalls: number;
	executorCalls: number;
	models: {
		advisor: string;
		executor: string;
	};
}

export interface SubAgentTask {
	id: string;
	task: string;
	type: keyof RoutingConfig["tasks"];
	priority?: number;
}

export interface WorkTreeResult {
	taskId: string;
	status: "pending" | "running" | "completed" | "failed";
	result?: string;
	error?: string;
	startTime?: number;
	endTime?: number;
}

// =============================================================================
// Model Router
// =============================================================================

export class ModelRouter {
	private routingConfig: RoutingConfig;
	private registry: ModelRegistry;

	constructor(registry: ModelRegistry, configPath?: string) {
		this.registry = registry;
		const defaultPath = join(__dirname, "routing.json");
		this.routingConfig = this.loadRouting(configPath || defaultPath);
	}

	private loadRouting(path: string): RoutingConfig {
		try {
			const content = readFileSync(path, "utf-8");
			return JSON.parse(content);
		} catch (error) {
			console.error(`Failed to load routing config from ${path}:`, error);
			return this.getDefaultConfig();
		}
	}

	private getDefaultConfig(): RoutingConfig {
		return {
			version: "1.0",
			tasks: {
				default: {
					description: "기본 태스크",
					advisor: { provider: "anthropic", model: "claude-sonnet-4-5" },
					executor: { provider: "anthropic", model: "claude-sonnet-4-5" },
					maxIterations: 2,
				},
			},
		};
	}

	getRouting(taskType: string): TaskRouting {
		return this.routingConfig.tasks[taskType] || this.routingConfig.tasks.default;
	}

	getModel(taskConfig: TaskConfig): Model<any> | undefined {
		return this.registry.find(taskConfig.provider, taskConfig.model);
	}

	listAvailableRoutings(): Array<{ type: string; description: string }> {
		return Object.entries(this.routingConfig.tasks).map(([type, config]) => ({
			type,
			description: config.description,
		}));
	}

	updateRouting(taskType: string, routing: TaskRouting): void {
		this.routingConfig.tasks[taskType] = routing;
	}

	saveConfig(path?: string): void {
		const fs = require("fs");
		const targetPath = path || join(__dirname, "routing.json");
		fs.writeFileSync(targetPath, JSON.stringify(this.routingConfig, null, 2));
	}
}

// =============================================================================
// Advisor Agent
// =============================================================================

export class AdvisorAgent {
	private registry: ModelRegistry;
	private router: ModelRouter;
	private agents: Map<string, Agent> = new Map();

	constructor(registry: ModelRegistry, router: ModelRouter) {
		this.registry = registry;
		this.router = router;
	}

	async execute(task: string, taskType: string = "default"): Promise<AdvisorResult> {
		const routing = this.router.getRouting(taskType);
		const advisorModel = this.router.getModel(routing.advisor);
		const executorModel = this.router.getModel(routing.executor);

		if (!advisorModel) {
			return {
				success: false,
				error: `Advisor model not found: ${routing.advisor.provider}/${routing.advisor.model}`,
				iterations: 0,
				advisorCalls: 0,
				executorCalls: 0,
				models: { advisor: "unknown", executor: "unknown" },
			};
		}

		if (!executorModel) {
			return {
				success: false,
				error: `Executor model not found: ${routing.executor.provider}/${routing.executor.model}`,
				iterations: 0,
				advisorCalls: 0,
				executorCalls: 0,
				models: { advisor: "unknown", executor: "unknown" },
			};
		}

		// Phase 1: Advisor creates a plan
		const plan = await this.advisorThink(task, advisorModel);
		if (!plan) {
			return {
				success: false,
				error: "Advisor failed to create plan",
				iterations: 0,
				advisorCalls: 1,
				executorCalls: 0,
				models: {
					advisor: `${routing.advisor.provider}/${routing.advisor.model}`,
					executor: `${routing.executor.provider}/${routing.executor.model}`,
				},
			};
		}

		// Phase 2: Executor executes the plan
		const result = await this.executorDo(plan, executorModel, routing.maxIterations);

		return {
			success: result.success,
			output: result.output,
			error: result.error,
			iterations: result.iterations,
			advisorCalls: 1,
			executorCalls: result.calls,
			models: {
				advisor: `${routing.advisor.provider}/${routing.advisor.model}`,
				executor: `${routing.executor.provider}/${routing.executor.model}`,
			},
		};
	}

	private async advisorThink(task: string, model: Model<any>): Promise<string | null> {
		const systemPrompt = `당신은 조언자(advisor)입니다. 주어진 태스크를 분석하고 실행자(executor)가 수행할 수 있는 명확한 실행 계획을 세워주세요.

출력 형식:
1. 분석: 태스크의 핵심 요구사항
2. 실행 계획: 단계별 지시사항
3. 예상 결과물: 완료 조건

간결하고 명확하게 작성해주세요.`;

		try {
			const agent = await this.createAgent(model);
			// Simple completion - in real implementation would use full SDK
			const response = await this.simpleComplete(agent, `태스크: ${task}\n\n${systemPrompt}`, {
				system: "당신은 숙련된 기술 컨설턴트입니다.",
			});
			return response || null;
		} catch (error) {
			console.error("Advisor think failed:", error);
			return null;
		}
	}

	private async executorDo(
		plan: string,
		model: Model<any>,
		maxIterations: number,
	): Promise<{ success: boolean; output?: string; error?: string; iterations: number; calls: number }> {
		const agent = await this.createAgent(model);
		let output = "";
		let iterations = 0;
		let calls = 0;

		while (iterations < maxIterations) {
			try {
				calls++;
				const response = await this.simpleComplete(
					agent,
					`실행 계획:\n${plan}\n\n이 계획을 실행하고 결과를 상세히 보고해주세요.`,
					{ system: "당신은 뛰어난 실행자(executor)입니다. 계획을 정확하게 수행하세요." },
				);

				if (response) {
					output += `${response}\n\n`;
				}

				// Check if task is complete
				if (this.isTaskComplete(output)) {
					return { success: true, output: output.trim(), iterations: iterations + 1, calls };
				}

				iterations++;
			} catch (error) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
					iterations,
					calls,
				};
			}
		}

		return { success: true, output: output.trim(), iterations, calls };
	}

	private async simpleComplete(
		_agent: Agent,
		message: string,
		_options?: { system?: string },
	): Promise<string | null> {
		// This is a simplified version - in production, use full SDK
		return new Promise((resolve) => {
			setTimeout(() => {
				resolve(`[Simulated response for: ${message.substring(0, 50)}...]`);
			}, 100);
		});
	}

	private isTaskComplete(output: string): boolean {
		const completionIndicators = ["완료", "done", "completed", "success", "실행 완료", "결과"];
		return completionIndicators.some((indicator) => output.toLowerCase().includes(indicator.toLowerCase()));
	}

	private async createAgent(model: Model<any>): Promise<Agent> {
		const key = `${model.provider}:${model.id}`;
		if (this.agents.has(key)) {
			return this.agents.get(key)!;
		}

		const apiKeyAndHeaders = await this.registry.getApiKeyAndHeaders(model);
		if (!apiKeyAndHeaders.ok || !apiKeyAndHeaders.apiKey) {
			throw new Error(`No API key for ${model.provider}`);
		}

		// Create agent using pi-agent-core
		const agent = new Agent({
			initialState: {
				systemPrompt: "",
				model,
				thinkingLevel: "medium",
				tools: [],
			},
			streamFn: async (m, context, opts) => {
				return streamSimple(m, context, {
					...opts,
					apiKey: apiKeyAndHeaders.apiKey,
					headers: apiKeyAndHeaders.headers,
				});
			},
			sessionId: `advisor-${Date.now()}`,
		});

		this.agents.set(key, agent);
		return agent;
	}
}

// =============================================================================
// SubAgent Spawner (WorkTree)
// =============================================================================

import type { ChildProcess } from "child_process";

export interface SubAgentResult {
	id: string;
	status: "completed" | "failed" | "timeout";
	output?: string;
	error?: string;
	duration: number;
}

export class SubAgentSpawner {
	private activeAgents: Map<string, ChildProcess> = new Map();
	private registry: ModelRegistry;
	private router: ModelRouter;

	constructor(registry: ModelRegistry, router: ModelRouter) {
		this.registry = registry;
		this.router = router;
	}

	/**
	 * Spawn a single sub-agent to execute a task
	 */
	async spawn(id: string, task: string, taskType: string = "default"): Promise<SubAgentResult> {
		const _routing = this.router.getRouting(taskType);
		const startTime = Date.now();

		return new Promise((resolve) => {
			// For now, execute directly in same process
			// In production, would spawn child process
			const advisor = new AdvisorAgent(this.registry, this.router);

			advisor.execute(task, taskType).then((result) => {
				resolve({
					id,
					status: result.success ? "completed" : "failed",
					output: result.output,
					error: result.error,
					duration: Date.now() - startTime,
				});
			});
		});
	}

	/**
	 * Spawn multiple sub-agents in parallel (WorkTree)
	 */
	async spawnParallel(tasks: SubAgentTask[]): Promise<Map<string, SubAgentResult>> {
		const results = await Promise.all(tasks.map((t) => this.spawn(t.id, t.task, t.type)));

		const map = new Map<string, SubAgentResult>();
		results.forEach((r, i) => {
			map.set(tasks[i].id, r);
		});

		return map;
	}

	/**
	 * Merge results from multiple sub-agents
	 */
	async mergeResults(results: Map<string, SubAgentResult>): Promise<string> {
		const completedResults: string[] = [];
		const failedResults: Array<{ id: string; error: string }> = [];

		for (const [id, result] of results) {
			if (result.status === "completed" && result.output) {
				completedResults.push(`[${id}]\n${result.output}`);
			} else if (result.status === "failed") {
				failedResults.push({ id, error: result.error || "Unknown error" });
			}
		}

		let merged = "# 병합 결과 (Merged Results)\n\n";
		merged += `## 성공: ${completedResults.length}개\n\n`;
		merged += completedResults.join("\n---\n\n");

		if (failedResults.length > 0) {
			merged += `\n## 실패: ${failedResults.length}개\n\n`;
			for (const f of failedResults) {
				merged += `- **${f.id}**: ${f.error}\n`;
			}
		}

		return merged;
	}

	/**
	 * Execute a WorkTree workflow
	 */
	async executeWorkTree(
		tasks: SubAgentTask[],
		_options: { timeout?: number; parallel?: boolean } = {},
	): Promise<{ merged: string; individual: Map<string, SubAgentResult> }> {
		const results = await this.spawnParallel(tasks);
		const merged = await this.mergeResults(results);

		return { merged, individual: results };
	}

	killAll(): void {
		for (const [_id, proc] of this.activeAgents) {
			proc.kill();
		}
		this.activeAgents.clear();
	}
}

// =============================================================================
// WorkTree Manager
// =============================================================================

export class WorkTree {
	private branches: Map<string, SubAgentTask> = new Map();
	private results: Map<string, SubAgentResult> = new Map();
	private spawner: SubAgentSpawner;

	constructor(spawner: SubAgentSpawner) {
		this.spawner = spawner;
	}

	addBranch(id: string, task: string, type: keyof RoutingConfig["tasks"] = "default"): void {
		this.branches.set(id, { id, task, type });
	}

	async execute(_options: { timeout?: number } = {}): Promise<void> {
		const tasks = Array.from(this.branches.values());
		this.results = await this.spawner.spawnParallel(tasks);
	}

	getResult(branchId: string): SubAgentResult | undefined {
		return this.results.get(branchId);
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

export function createAdvisorSystem(
	registry: ModelRegistry,
	configPath?: string,
): {
	router: ModelRouter;
	advisor: AdvisorAgent;
	spawner: SubAgentSpawner;
} {
	const router = new ModelRouter(registry, configPath);
	const advisor = new AdvisorAgent(registry, router);
	const spawner = new SubAgentSpawner(registry, router);

	return { router, advisor, spawner };
}
