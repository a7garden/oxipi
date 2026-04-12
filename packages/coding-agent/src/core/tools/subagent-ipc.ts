import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { SubAgentIpcBus } from "../sub-agent/subagent-ipc.js";

const sendReplySchema = Type.Object({
	question: Type.String({ description: "Question to ask parent agent" }),
	context: Type.Optional(Type.String({ description: "Optional context for the question" })),
	correlationId: Type.Optional(Type.String({ description: "Optional correlation ID for matching parent reply" })),
});

const receiveReplySchema = Type.Object({
	correlationId: Type.Optional(Type.String({ description: "Optional specific correlation ID to wait for" })),
	waitMs: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds", default: 60000 })),
	pollMs: Type.Optional(Type.Number({ description: "Polling interval in milliseconds", default: 1000 })),
});

function getIpcBusFromEnv(): { bus: SubAgentIpcBus; subAgentId: string } | null {
	const file = process.env.OXIPI_SUBAGENT_IPC_FILE;
	const subAgentId = process.env.OXIPI_SUBAGENT_ID;
	if (!file || !subAgentId) return null;
	return { bus: new SubAgentIpcBus(file), subAgentId };
}

export function createSendReplyToParentToolDefinition(): ToolDefinition<
	typeof sendReplySchema,
	{ correlationId: string }
> {
	return {
		name: "sendReplyToParent",
		label: "Send Reply To Parent",
		description: "Sub-agent tool: send a question or status update to the parent orchestrator.",
		parameters: sendReplySchema,
		async execute(_toolCallId, { question, context, correlationId }) {
			const ipc = getIpcBusFromEnv();
			if (!ipc) {
				return {
					content: [{ type: "text", text: "No parent IPC channel available." }],
					details: { correlationId: correlationId ?? "" },
				};
			}
			const cid = correlationId || randomUUID();
			await ipc.bus.append({
				type: "sub_question",
				subAgentId: ipc.subAgentId,
				correlationId: cid,
				question,
				context,
				timestamp: Date.now(),
			});
			return {
				content: [{ type: "text", text: `Question sent to parent. correlationId=${cid}` }],
				details: { correlationId: cid },
			};
		},
	};
}

export function createReceiveFromParentToolDefinition(): ToolDefinition<
	typeof receiveReplySchema,
	{ correlationId: string; found: boolean }
> {
	return {
		name: "receiveFromParent",
		label: "Receive From Parent",
		description: "Sub-agent tool: wait for a parent reply from the IPC channel.",
		parameters: receiveReplySchema,
		async execute(_toolCallId, { correlationId, waitMs, pollMs }) {
			const ipc = getIpcBusFromEnv();
			if (!ipc) {
				return {
					content: [{ type: "text", text: "No parent IPC channel available." }],
					details: { correlationId: correlationId ?? "", found: false },
				};
			}

			const timeoutMs = waitMs ?? 60_000;
			const intervalMs = pollMs ?? 1_000;
			const start = Date.now();

			while (Date.now() - start < timeoutMs) {
				const all = await ipc.bus.readAll();
				const match = all
					.filter(
						(m): m is Extract<typeof m, { type: "parent_reply" }> =>
							m.type === "parent_reply" && m.subAgentId === ipc.subAgentId,
					)
					.find((m) => !correlationId || m.correlationId === correlationId);
				if (match) {
					return {
						content: [{ type: "text", text: match.reply }],
						details: { correlationId: match.correlationId, found: true },
					};
				}
				await new Promise((resolve) => setTimeout(resolve, intervalMs));
			}

			return {
				content: [{ type: "text", text: "No parent reply received within timeout." }],
				details: { correlationId: correlationId ?? "", found: false },
			};
		},
	};
}

export function createSubAgentIpcToolDefinitionsFromEnv(): ToolDefinition<any, any>[] {
	const ipc = getIpcBusFromEnv();
	if (!ipc) return [];
	return [
		createSendReplyToParentToolDefinition() as ToolDefinition<any, any>,
		createReceiveFromParentToolDefinition() as ToolDefinition<any, any>,
	];
}
