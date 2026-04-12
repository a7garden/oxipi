import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SubAgentIpcMessage =
	| {
			type: "sub_ready";
			subAgentId: string;
			timestamp: number;
	  }
	| {
			type: "sub_question";
			subAgentId: string;
			correlationId: string;
			question: string;
			context?: string;
			timestamp: number;
	  }
	| {
			type: "parent_reply";
			subAgentId: string;
			correlationId: string;
			reply: string;
			timestamp: number;
	  }
	| {
			type: "sub_progress";
			subAgentId: string;
			text: string;
			timestamp: number;
	  }
	| {
			type: "sub_done";
			subAgentId: string;
			summary?: string;
			timestamp: number;
	  }
	| {
			type: "sub_error";
			subAgentId: string;
			error: string;
			timestamp: number;
	  };

export class SubAgentIpcBus {
	constructor(private readonly filePath: string) {}

	get path(): string {
		return this.filePath;
	}

	async append(message: SubAgentIpcMessage): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await appendFile(this.filePath, `${JSON.stringify(message)}\n`, "utf-8");
	}

	async readAll(): Promise<SubAgentIpcMessage[]> {
		let raw = "";
		try {
			raw = await readFile(this.filePath, "utf-8");
		} catch {
			return [];
		}

		const result: SubAgentIpcMessage[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				result.push(JSON.parse(trimmed) as SubAgentIpcMessage);
			} catch {
				// Ignore malformed lines in MVP mode.
			}
		}
		return result;
	}

	async readSince(offset: number): Promise<{ messages: SubAgentIpcMessage[]; nextOffset: number }> {
		const messages = await this.readAll();
		return {
			messages: messages.slice(Math.max(0, offset)),
			nextOffset: messages.length,
		};
	}
}
