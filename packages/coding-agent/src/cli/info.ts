/**
 * `oxipi info` — Display current environment summary.
 *
 * Shows version, runtime, config paths, loaded resources, and session stats.
 */

import chalk from "chalk";
import { existsSync, readdirSync } from "fs";
import { arch, platform, release, type } from "os";
import { join } from "path";
import {
	APP_NAME,
	detectInstallMethod,
	getAgentDir,
	getBinDir,
	getModelsPath,
	getSettingsPath,
	VERSION,
} from "../config.js";
import type { SettingsManager } from "../core/settings-manager.js";

function dim(text: string): string {
	return chalk.dim(text);
}

function label(key: string, value: string): string {
	return `${chalk.bold(key.padEnd(14))}${value}`;
}

function countSessions(sessionDir: string): number {
	try {
		const sessionsDir = join(sessionDir, "sessions");
		if (!existsSync(sessionsDir)) return 0;
		return readdirSync(sessionsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.reduce((sum, dir) => {
				try {
					return sum + readdirSync(join(sessionsDir, dir.name)).filter((f) => f.endsWith(".jsonl")).length;
				} catch {
					return sum;
				}
			}, 0);
	} catch {
		return 0;
	}
}

export async function runInfo(settingsManager: SettingsManager): Promise<void> {
	const agentDir = getAgentDir();
	const installMethod = detectInstallMethod();
	const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`;
	const sessionDir = settingsManager.getSessionDir();

	console.log();
	console.log(label("Version", `${chalk.cyan(APP_NAME)} ${chalk.bold(`v${VERSION}`)}`));
	console.log(label("Runtime", runtime));
	console.log(label("Platform", `${type()} ${release()} (${platform()}/${arch()})`));
	console.log(label("Install", installMethod));
	console.log();

	// Paths
	console.log(chalk.bold("Paths"));
	console.log(label("Config", agentDir));
	console.log(label("Settings", getSettingsPath()));
	console.log(
		label("Models", `${getModelsPath()}${existsSync(getModelsPath()) ? dim(" (exists)") : dim(" (not found)")}`),
	);
	console.log(label("Binaries", getBinDir()));
	const sessionCount = countSessions(sessionDir ?? "");
	console.log(
		label(
			"Sessions",
			`${sessionDir ?? "(default)"}${dim(` (${sessionCount} session${sessionCount !== 1 ? "s" : ""})`)}`,
		),
	);
	console.log();

	// Settings summary
	const theme = settingsManager.getTheme();
	const quietStartup = settingsManager.getQuietStartup();
	const defaultProvider = settingsManager.getDefaultProvider();
	const defaultModel = settingsManager.getDefaultModel();
	const enabledModels = settingsManager.getEnabledModels();

	console.log(chalk.bold("Settings"));
	console.log(label("Theme", theme ?? "(default)"));
	console.log(label("Quiet startup", String(quietStartup)));
	if (defaultProvider) console.log(label("Provider", defaultProvider));
	if (defaultModel) console.log(label("Model", defaultModel));
	if (enabledModels && enabledModels.length > 0) {
		console.log(label("Model scope", enabledModels.join(", ")));
	}
	console.log();

	// Resources
	const extensions = settingsManager.getExtensionPaths();
	const skills = settingsManager.getSkillPaths();
	const prompts = settingsManager.getPromptTemplatePaths();
	const themes = settingsManager.getThemePaths();
	const packages = settingsManager.getPackages();

	if (packages.length > 0 || extensions.length > 0 || skills.length > 0 || prompts.length > 0 || themes.length > 0) {
		console.log(chalk.bold("Resources"));
		if (packages.length > 0) console.log(label("Packages", String(packages.length)));
		if (extensions.length > 0) console.log(label("Extensions", String(extensions.length)));
		if (skills.length > 0) console.log(label("Skills", String(skills.length)));
		if (prompts.length > 0) console.log(label("Prompts", String(prompts.length)));
		if (themes.length > 0) console.log(label("Themes", String(themes.length)));
		console.log();
	}
}
