/**
 * Planner Tool — Native planner tool for consulting a higher-tier model.
 *
 * The executor (main coding agent) runs tasks end-to-end,
 * calling tools, reading results, and iterating. When it hits a decision it
 * can't reasonably solve, it calls this planner tool to consult a smarter
 * model for guidance.
 *
 * Key differences from original Claude implementation:
 * - Works within pi's multi-provider architecture
 * - Planner model is user-configurable (any registered model)
 * - maxUses controls cost per request
 * - Guidance is returned to executor, not executed directly
 *
 * Usage: Include in the executor agent's tool set alongside coding tools.
 * The executor model decides when to call it based on task complexity.
 */

import type { AgentToolResult } from "@oxipi/agent-core";
import { complete } from "@oxipi/ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext } from "../extensions/types.js";
import type { ModelRegistry } from "../model-registry.js";

const plannerSchema = Type.Object({
	situation: Type.String({
		description: "Current situation or decision point where guidance is needed",
	}),
	optionsConsidered: Type.Optional(
		Type.Array(Type.String(), { description: "Options being considered by the executor" }),
	),
	contextSummary: Type.Optional(Type.String({ description: "Summary of relevant code/context for the planner" })),
	question: Type.Optional(Type.String({ description: "Specific question or decision for the planner" })),
});

export type PlannerToolDetails = {
	model: string;
	duration: number;
	guided: boolean;
};

// Track usage per session+run to enforce maxUses
// Session-scoped to prevent cross-session usage bleed
// Uses a bounded cache with timestamp-based cleanup to prevent memory leak
const plannerUsagePerRun = new Map<string, { count: number; lastAccess: number; sessionId: string }>();
const USAGE_CACHE_MAX_ENTRIES = 1000;
const USAGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cleanupPlannerUsageCache(): void {
	if (plannerUsagePerRun.size < USAGE_CACHE_MAX_ENTRIES) return;
	const now = Date.now();
	for (const [key, value] of plannerUsagePerRun) {
		if (now - value.lastAccess > USAGE_CACHE_TTL_MS) {
			plannerUsagePerRun.delete(key);
		}
	}
	// If still too full, clear oldest half
	if (plannerUsagePerRun.size > USAGE_CACHE_MAX_ENTRIES / 2) {
		const entries = Array.from(plannerUsagePerRun.entries());
		entries.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
		for (let i = 0; i < entries.length / 2; i++) {
			plannerUsagePerRun.delete(entries[i][0]);
		}
	}
}

/** Generate a unique run ID to prevent collisions in concurrent calls */
function generateRunId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).slice(2, 8);
	// Use crypto for additional randomness if available
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return `${timestamp}-${globalThis.crypto.randomUUID()}`;
	}
	return `${timestamp}-${random}`;
}

export interface PlannerConfig {
	plannerModel: string;
	maxUses: number;
	trigger: "complexity" | "error" | "manual" | "cost";
}

const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
	plannerModel: "", // Must be set
	maxUses: 3,
	trigger: "manual",
};

/**
 * Create a PlannerTool for use in executor agent's tool set.
 *
 * The executor model calls this tool when it needs guidance on complex
 * decisions. The tool consults the configured planner model and returns
 * guidance (APPROVED / NEEDS_CHANGE / CONTINUE / STOP).
 */
export function createPlannerToolDefinition(registry: ModelRegistry, config: Partial<PlannerConfig> = {}) {
	const mergedConfig = { ...DEFAULT_PLANNER_CONFIG, ...config };

	return {
		name: "planner",
		label: "Planner",
		description:
			"Consult a senior planner for guidance on complex decisions, architecture choices, or tricky problems. " +
			"Use when you need expert-level analysis. The planner provides guidance (APPROVED/NEEDS_CHANGE/CONTINUE/STOP) " +
			"but does NOT execute code — you continue based on the guidance.",
		parameters: plannerSchema,

		async execute(
			_toolCallId: string,
			params: {
				situation: string;
				optionsConsidered?: string[];
				contextSummary?: string;
				question?: string;
			},
			signal: AbortSignal | undefined,
			_onUpdate: any,
			ctx: ExtensionContext,
		) {
			const startTime = Date.now();

			// Get session ID for cache scoping (prevents cross-session bleed)
			const sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
			// Generate unique run ID for this specific planner invocation
			const runId = ctx.signal ? generateRunId() : "single";
			const cacheKey = `${sessionId}:${runId}`;

			cleanupPlannerUsageCache();
			const entry = plannerUsagePerRun.get(cacheKey) ?? { count: 0, lastAccess: 0, sessionId };
			const currentUsage = entry.count;

			if (currentUsage >= mergedConfig.maxUses) {
				const result: AgentToolResult<PlannerToolDetails> = {
					content: [
						{
							type: "text" as const,
							text: `[Planner] maxUses (${mergedConfig.maxUses}) reached. Continue with your best judgment.`,
						},
					],
					details: {
						model: mergedConfig.plannerModel,
						duration: Date.now() - startTime,
						guided: false,
					},
				};
				return result as AgentToolResult<PlannerToolDetails>;
			}

			// Find planner model from registry
			const { provider, modelId } = parseModelString(mergedConfig.plannerModel);
			const plannerModel = registry.find(provider, modelId);

			if (!plannerModel) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`[Planner] Error: Model '${mergedConfig.plannerModel}' not found in registry. ` +
								`Available models: ${registry
									.getAvailable()
									.map((m) => m.id)
									.join(", ")}`,
						},
					],
					details: {
						model: mergedConfig.plannerModel,
						duration: Date.now() - startTime,
						guided: false,
					} as PlannerToolDetails,
				};
			}

			// Authenticate
			const auth = await registry.getApiKeyAndHeaders(plannerModel);
			if (!auth.ok || !auth.apiKey) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[Planner] Error: Could not authenticate with ${provider}. Please check API key configuration.`,
						},
					],
					details: {
						model: mergedConfig.plannerModel,
						duration: Date.now() - startTime,
						guided: false,
					} as PlannerToolDetails,
				};
			}

			// Build guidance request for planner model
			const systemPrompt = buildPlannerSystemPrompt();
			const userContent = buildPlannerUserMessage(params);

			try {
				const response = await complete(
					plannerModel,
					{ messages: [{ role: "user", content: userContent, timestamp: Date.now() }], systemPrompt },
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						maxTokens: 1024,
						abortSignal: signal,
					},
				);

				plannerUsagePerRun.set(cacheKey, { count: currentUsage + 1, lastAccess: Date.now(), sessionId });

				const guidance = parseGuidanceResponse(response);

				return {
					content: [{ type: "text" as const, text: guidance }],
					details: {
						model: mergedConfig.plannerModel,
						duration: Date.now() - startTime,
						guided: true,
					} as PlannerToolDetails,
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `[Planner] Error: ${error instanceof Error ? error.message : String(error)}. Continue with your best judgment.`,
						},
					],
					details: {
						model: mergedConfig.plannerModel,
						duration: Date.now() - startTime,
						guided: false,
					} as PlannerToolDetails,
				};
			}
		},
	};
}

function parseModelString(modelString: string): { provider: string; modelId: string } {
	// Handle "provider/model" format
	if (modelString.includes("/")) {
		const [provider, modelId] = modelString.split("/");
		return { provider, modelId };
	}
	// If no provider specified, use default
	return { provider: "github-copilot", modelId: modelString };
}

function buildPlannerSystemPrompt(): string {
	return `You are a senior software architect and technical planner.

## Your Role
- Analyze code, architecture, and technical decisions
- Provide clear, actionable guidance
- Identify risks and alternatives
- Do NOT execute code — guide the executor

## Guidance Format
Always respond with this structure:

**VERDICT**: [PROCEED|REVISE|DECIDE|STOP]
**REASON**: One sentence explaining why
**GUIDANCE**: 2-3 sentences with specific, actionable advice

## Keywords
- PROCEED: The approach is sound. Continue.
- REVISE: The approach has flaws. Correct as described.
- DECIDE: Multiple valid options exist. Choose based on context.
- STOP: This path is blocked or dangerous. Stop and reconsider.

## Rules
- Be concise (max 500 tokens)
- Read the provided code/context before deciding
- Prioritize maintainability and simplicity
- Flag security, performance, architecture issues
- Provide alternatives when rejecting an approach`;
}

function buildPlannerUserMessage(params: {
	situation: string;
	optionsConsidered?: string[];
	contextSummary?: string;
	question?: string;
}): string {
	let message = `## Situation\n${params.situation}`;

	if (params.optionsConsidered && params.optionsConsidered.length > 0) {
		message += `\n\n## Options Being Considered\n${params.optionsConsidered.map((o, i) => `${i + 1}. ${o}`).join("\n")}`;
	}

	if (params.contextSummary) {
		message += `\n\n## Relevant Context\n${params.contextSummary}`;
	}

	if (params.question) {
		message += `\n\n## Specific Question\n${params.question}`;
	}

	return message;
}

function parseGuidanceResponse(response: { content: Array<{ type: string; text?: string }> }): string {
	const text = response.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("");

	if (!text) {
		return "[Planner] No guidance returned. Continue with your best judgment.";
	}

	const trimmed = text.trim();

	// Check for VERDICT keyword pattern
	const verdictMatch = trimmed.match(/^\*\*VERDICT\*\*:\s*(PROCEED|REVISE|DECIDE|STOP)/i);
	if (verdictMatch) {
		// Already properly formatted
		return trimmed;
	}

	// Try to extract from old format (APPROVED, NEEDS_CHANGE, CONTINUE, STOP)
	const oldKeywordMatch = trimmed.match(/^(APPROVED|NEEDS_CHANGE|CONTINUE|STOP)/i);
	if (oldKeywordMatch) {
		const oldKeyword = oldKeywordMatch[1].toUpperCase();
		// Convert old keywords to new format
		const newKeyword =
			oldKeyword === "APPROVED"
				? "PROCEED"
				: oldKeyword === "NEEDS_CHANGE"
					? "REVISE"
					: oldKeyword === "CONTINUE"
						? "PROCEED"
						: oldKeyword;
		const rest = trimmed.replace(/^(APPROVED|NEEDS_CHANGE|CONTINUE|STOP)\s*[-–—]?\s*/i, "");
		return `**VERDICT**: ${newKeyword}\n**REASON**: Old keyword converted.\n**GUIDANCE**: ${rest}`;
	}

	// If no keyword found, wrap the response
	return `**VERDICT**: PROCEED\n**REASON**: Guidance provided without explicit verdict.\n**GUIDANCE**: ${trimmed}`;
}
