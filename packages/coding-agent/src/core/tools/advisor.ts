/**
 * Advisor Tool — Automatically calls Opus when executor needs guidance.
 *
 * Registered as a tool alongside read, bash, edit, write.
 * When the executor model (Sonnet/Haiku) encounters a complex decision,
 * it can call this tool to get Opus-level guidance.
 *
 * Usage: Just include in the agent's tool set. The model decides when to call it.
 */

import { complete } from "@oxipi/ai";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import type { ModelRegistry } from "../model-registry.js";

const advisorSchema = Type.Object({
	task: Type.String({ description: "The current task or problem the executor is working on" }),
	situation: Type.String({ description: "The specific situation or decision point where guidance is needed" }),
	progress: Type.Optional(Type.String({ description: "What has been done so far" })),
	question: Type.String({ description: "The specific question or decision for the advisor" }),
});

export type AdvisorToolDetails = { model?: string; duration?: number };

/** Create an AdvisorTool — call this with the ModelRegistry */
export function createAdvisorToolDefinition(
	registry: ModelRegistry,
	options?: {
		advisorProvider?: string;
		advisorModel?: string;
		maxTokens?: number;
	},
): ToolDefinition<typeof advisorSchema, AdvisorToolDetails> {
	const provider = options?.advisorProvider || "github-copilot";
	const modelId = options?.advisorModel || "claude-opus-4.6";
	const maxTokens = options?.maxTokens || 1024;

	return {
		name: "advisor",
		label: "Advisor",
		description:
			"Call the advisor (Opus-class model) for guidance on complex decisions. " +
			"Use when you need expert-level analysis for architecture, tricky bugs, or strategic decisions. " +
			"The advisor does NOT execute code — it only provides guidance.",
		parameters: advisorSchema,

		async execute(
			_toolCallId,
			{
				task,
				situation,
				progress,
				question,
			}: { task: string; situation: string; progress?: string; question: string },
			signal: AbortSignal | undefined,
			_onUpdate: any,
			_ctx: ExtensionContext,
		) {
			const startTime = Date.now();

			// Find the advisor model
			const advisorModel = registry.find(provider, modelId);
			if (!advisorModel) {
				return {
					content: [{ type: "text", text: `Error: Advisor model ${provider}/${modelId} not found.` }],
					details: { model: modelId, duration: Date.now() - startTime } as AdvisorToolDetails,
				};
			}

			// Authenticate
			const auth = await registry.getApiKeyAndHeaders(advisorModel);
			if (!auth.ok || !auth.apiKey) {
				return {
					content: [{ type: "text", text: `Error: Could not authenticate with advisor model.` }],
					details: { model: modelId, duration: Date.now() - startTime } as AdvisorToolDetails,
				};
			}

			const systemPrompt = `You are an expert advisor. The executor is working on a coding task and needs your guidance.

## Your role
- Provide clear, actionable guidance
- Do NOT write code directly — guide the executor
- Be concise and focused
- If the approach is good, say so and suggest next steps
- If there are issues, point them out specifically

## Response format
Start with APPROVED, NEEDS_CHANGE, or CONTINUE, then provide your guidance.`;

			const userContent = `## Task
${task}

## Situation
${situation}
${progress ? `\n## Progress So Far\n${progress}` : ""}

## Question
${question}`;

			const response = await complete(
				advisorModel,
				{ messages: [{ role: "user", content: userContent, timestamp: Date.now() }], systemPrompt },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens,
					abortSignal: signal,
				},
			);

			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");

			return {
				content: [{ type: "text", text }],
				details: { model: modelId, duration: Date.now() - startTime } as AdvisorToolDetails,
			};
		},
	};
}
