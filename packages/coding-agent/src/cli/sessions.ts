/**
 * `oxipi sessions` — List and search sessions from the CLI (non-interactive).
 *
 * Supports listing sessions for the current project or all projects,
 * with optional fuzzy search filtering.
 */

import chalk from "chalk";
import { SessionManager } from "../core/session-manager.js";

interface SessionsOptions {
	all?: boolean;
	search?: string;
	help?: boolean;
}

export function printSessionsHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  oxipi sessions [search] [--all] [-h]

List sessions for the current project, or all projects with --all.
Optionally filter by a fuzzy search pattern.

${chalk.bold("Options:")}
  --all    List sessions across all projects
  -h       Show this help
`);
}

export function parseSessionsArgs(args: string[]): SessionsOptions {
	const result: SessionsOptions = {};
	for (const arg of args) {
		if (arg === "--all") {
			result.all = true;
		} else if (arg === "-h" || arg === "--help") {
			result.help = true;
		} else if (!arg.startsWith("-")) {
			result.search = arg;
		}
	}
	return result;
}

function relativeTime(date: Date): string {
	const now = Date.now();
	const diff = now - date.getTime();
	const minutes = Math.floor(diff / 60_000);
	const hours = Math.floor(diff / 3_600_000);
	const days = Math.floor(diff / 86_400_000);

	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 30) return `${days}d ago`;
	return date.toISOString().slice(0, 10);
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}\u2026`;
}

export async function runSessions(
	options: SessionsOptions,
	cwd: string,
	sessionDir: string | undefined,
): Promise<void> {
	const sessions = options.all ? await SessionManager.listAll() : await SessionManager.list(cwd, sessionDir);

	if (sessions.length === 0) {
		console.log(chalk.dim("No sessions found."));
		return;
	}

	// Simple fuzzy filter if search provided
	let filtered = sessions;
	if (options.search) {
		const search = options.search.toLowerCase();
		filtered = sessions.filter(
			(s) =>
				s.firstMessage.toLowerCase().includes(search) ||
				s.name?.toLowerCase().includes(search) ||
				s.id.includes(search) ||
				s.cwd.toLowerCase().includes(search),
		);
		if (filtered.length === 0) {
			console.log(chalk.dim(`No sessions matching "${options.search}"`));
			return;
		}
	}

	// Sort by modified date (newest first)
	filtered.sort((a, b) => b.modified.getTime() - a.modified.getTime());

	// Calculate column widths
	const idWidth = 8;
	const msgsWidth = 5;
	const timeWidth = 10;

	// Header
	const header = [
		chalk.dim("ID".padEnd(idWidth)),
		chalk.dim("Msgs".padEnd(msgsWidth)),
		chalk.dim("Modified".padEnd(timeWidth)),
		chalk.dim("Preview"),
	].join("  ");
	console.log(header);
	console.log(chalk.dim("\u2500".repeat(Math.min(80, header.length + 30))));

	// Rows
	for (const s of filtered) {
		const id = chalk.cyan(s.id.slice(0, idWidth));
		const msgs = String(s.messageCount).padEnd(msgsWidth);
		const time = relativeTime(s.modified).padEnd(timeWidth);
		const preview = truncate(s.name ?? s.firstMessage, 50);
		const projectTag =
			options.all && s.cwd ? chalk.dim(` (${truncate(s.cwd.replace(process.env.HOME ?? "", "~"), 30)})`) : "";

		console.log(`${id}  ${msgs}  ${time}  ${preview}${projectTag}`);
	}

	console.log();
	console.log(
		chalk.dim(`${filtered.length} session${filtered.length !== 1 ? "s" : ""}${options.all ? " (all projects)" : ""}`),
	);
}
