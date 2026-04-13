/**
 * `oxipi doctor` — Diagnose setup issues.
 *
 * Checks API keys, model availability, tool dependencies, and settings health.
 */

import { getEnvApiKey, getProviders, type KnownProvider } from "@oxipi/ai";
import chalk from "chalk";
import { existsSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import type { SettingsManager } from "../core/settings-manager.js";

interface DoctorCheck {
	label: string;
	status: "ok" | "warn" | "fail";
	message: string;
	detail?: string;
}

const STATUS_ICON: Record<DoctorCheck["status"], string> = {
	ok: chalk.green("\u2713"),
	warn: chalk.yellow("\u25CB"),
	fail: chalk.red("\u2717"),
};

function formatCheck(check: DoctorCheck): string {
	const icon = STATUS_ICON[check.status];
	const label = chalk.bold(check.label);
	const line = `${icon}  ${label}: ${check.message}`;
	return check.detail ? `${line}\n   ${chalk.dim(check.detail)}` : line;
}

export async function runDoctor(settingsManager: SettingsManager): Promise<void> {
	const checks: DoctorCheck[] = [];

	// --- Config directory ---
	const agentDir = getAgentDir();
	if (existsSync(agentDir)) {
		checks.push({ label: "Config", status: "ok", message: agentDir });
	} else {
		checks.push({
			label: "Config",
			status: "warn",
			message: `~/${CONFIG_DIR_NAME}/agent/ does not exist yet`,
			detail: "It will be created automatically on first run",
		});
	}

	// --- API Keys ---
	const providers = getProviders();
	const providersWithKeys: string[] = [];
	const providersWithoutKeys: string[] = [];

	for (const provider of providers) {
		const key = getEnvApiKey(provider as KnownProvider);
		if (key) {
			providersWithKeys.push(provider);
		} else {
			providersWithoutKeys.push(provider);
		}
	}

	if (providersWithKeys.length > 0) {
		checks.push({
			label: "API Keys",
			status: "ok",
			message: `${providersWithKeys.length} provider${providersWithKeys.length > 1 ? "s" : ""} configured`,
			detail: providersWithKeys.join(", "),
		});
	} else {
		checks.push({
			label: "API Keys",
			status: "fail",
			message: "No API keys detected",
			detail: `Set at least one: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.\n  Run ${chalk.bold(`${APP_NAME} --help`)} for the full list of environment variables`,
		});
	}

	// --- Settings ---
	const settingsErrors = settingsManager.drainErrors();
	if (settingsErrors.length === 0) {
		checks.push({ label: "Settings", status: "ok", message: "No issues detected" });
	} else {
		checks.push({
			label: "Settings",
			status: "warn",
			message: `${settingsErrors.length} issue${settingsErrors.length > 1 ? "s" : ""} found`,
			detail: settingsErrors.map((e) => `[${e.scope}] ${e.error.message}`).join("\n   "),
		});
	}

	// --- Tools ---
	const { getToolPath } = await import("../utils/tools-manager.js");
	const fdPath = getToolPath("fd");
	const rgPath = getToolPath("rg");

	if (fdPath && rgPath) {
		checks.push({ label: "Tools", status: "ok", message: "fd and rg available" });
	} else {
		const missing = [!fdPath ? "fd (file finder)" : "", !rgPath ? "rg (ripgrep)" : ""].filter(Boolean);
		checks.push({
			label: "Tools",
			status: "warn",
			message: `Missing: ${missing.join(", ")}`,
			detail: "They will be downloaded automatically on first interactive session",
		});
	}

	// --- Print results ---
	console.log(chalk.bold(`\n${APP_NAME} doctor`) + chalk.dim(` \u2014 diagnosing your setup\n`));

	const hasFail = checks.some((c) => c.status === "fail");
	const allOk = checks.every((c) => c.status === "ok");

	for (const check of checks) {
		console.log(formatCheck(check));
	}

	console.log();

	if (hasFail) {
		console.log(chalk.yellow("Some checks failed. Follow the suggestions above to fix them."));
		process.exitCode = 1;
	} else if (allOk) {
		console.log(chalk.green("All checks passed."));
	} else {
		console.log(chalk.dim("Checks passed with warnings. Nothing critical."));
	}
}
