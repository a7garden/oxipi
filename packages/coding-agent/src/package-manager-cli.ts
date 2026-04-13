import chalk from "chalk";
import { selectConfig } from "./cli/config-selector.js";
import { APP_NAME, getAgentDir } from "./config.js";
import { DefaultPackageManager } from "./core/package-manager.js";
import { SettingsManager } from "./core/settings-manager.js";

export type PackageCommand = "install" | "remove" | "update" | "list";

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	local: boolean;
	help: boolean;
	invalidOption?: string;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l]`;
		case "update":
			return `${APP_NAME} update [source]`;
		case "list":
			return `${APP_NAME} list`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local    Install project-locally (.pi/settings.json)

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local    Remove from project settings (.pi/settings.json)

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update installed packages.
If <source> is provided, only that package is updated.
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let help = false;
	let invalidOption: string | undefined;
	let source: string | undefined;

	for (const arg of rest) {
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		}
	}

	return { command, source, local, help, invalidOption };
}

const CONFIG_GETTERS: Record<string, { getter: (sm: SettingsManager) => unknown; description: string }> = {
	theme: { getter: (sm) => sm.getTheme(), description: "UI theme name" },
	"quiet-startup": { getter: (sm) => sm.getQuietStartup(), description: "Suppress startup banner" },
	"default-provider": { getter: (sm) => sm.getDefaultProvider(), description: "Default LLM provider" },
	"default-model": { getter: (sm) => sm.getDefaultModel(), description: "Default model ID" },
	"default-thinking": { getter: (sm) => sm.getDefaultThinkingLevel(), description: "Default thinking level" },
	"enabled-models": { getter: (sm) => sm.getEnabledModels(), description: "Model patterns for Ctrl+P" },
	transport: { getter: (sm) => sm.getTransport(), description: "API transport (sse or streamable-http)" },
	"hide-thinking": { getter: (sm) => sm.getHideThinkingBlock(), description: "Hide thinking blocks" },
	"session-dir": { getter: (sm) => sm.getSessionDir(), description: "Custom session directory" },
	"shell-path": { getter: (sm) => sm.getShellPath(), description: "Custom shell path" },
	"shell-command-prefix": {
		getter: (sm) => sm.getShellCommandPrefix(),
		description: "Prefix prepended to every bash command",
	},
	"collapse-changelog": { getter: (sm) => sm.getCollapseChangelog(), description: "Collapse changelog on startup" },
	"editor-padding-x": { getter: (sm) => sm.getEditorPaddingX(), description: "Editor horizontal padding" },
	"autocomplete-max-visible": {
		getter: (sm) => sm.getAutocompleteMaxVisible(),
		description: "Max visible autocomplete items",
	},
};

function printConfigHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} config                     Open TUI config selector
  ${APP_NAME} config get <key>            Print a setting value
  ${APP_NAME} config set <key> <value>    Set a setting value
  ${APP_NAME} config list                 List all settings

${chalk.bold("Available keys:")}
${Object.entries(CONFIG_GETTERS)
	.map(([key, { description }]) => `  ${key.padEnd(28)}${chalk.dim(description)}`)
	.join("\n")}
`);
}

function handleConfigGet(settingsManager: SettingsManager, key: string): void {
	const entry = CONFIG_GETTERS[key];
	if (!entry) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`Run \`${APP_NAME} config get --help\` for available keys.`));
		process.exitCode = 1;
		return;
	}
	const value = entry.getter(settingsManager);
	if (value === undefined || value === null) {
		console.log(chalk.dim("(not set)"));
	} else if (Array.isArray(value)) {
		console.log(value.join(", "));
	} else {
		console.log(String(value));
	}
}

function handleConfigSet(args: string[], settingsManager: SettingsManager): void {
	const key = args[0];
	const value = args[1];

	if (!key || !value) {
		console.error(chalk.red(`Usage: ${APP_NAME} config set <key> <value>`));
		process.exitCode = 1;
		return;
	}

	switch (key) {
		case "theme":
			settingsManager.setTheme(value);
			break;
		case "quiet-startup":
			settingsManager.setQuietStartup(value === "true");
			break;
		case "default-provider":
			settingsManager.setDefaultProvider(value);
			break;
		case "default-model":
			settingsManager.setDefaultModel(value);
			break;
		case "default-thinking":
			settingsManager.setDefaultThinkingLevel(value as any);
			break;
		case "enabled-models":
			settingsManager.setEnabledModels(value.split(",").map((s) => s.trim()));
			break;
		case "hide-thinking":
			settingsManager.setHideThinkingBlock(value === "true");
			break;
		case "session-dir":
			console.error(chalk.yellow(`session-dir cannot be set via CLI. Edit settings.json directly.`));
			process.exitCode = 1;
			return;
		case "shell-path":
			settingsManager.setShellPath(value);
			break;
		case "shell-command-prefix":
			settingsManager.setShellCommandPrefix(value);
			break;
		case "collapse-changelog":
			settingsManager.setCollapseChangelog(value === "true");
			break;
		case "editor-padding-x":
			settingsManager.setEditorPaddingX(parseInt(value, 10));
			break;
		case "autocomplete-max-visible":
			settingsManager.setAutocompleteMaxVisible(parseInt(value, 10));
			break;
		default:
			console.error(chalk.red(`Unknown setting: ${key}`));
			console.error(chalk.dim(`Run \`${APP_NAME} config set --help\` for available keys.`));
			process.exitCode = 1;
			return;
	}
	console.log(chalk.green(`Set ${key} = ${value}`));
}

function handleConfigList(settingsManager: SettingsManager): void {
	for (const [key, { description, getter }] of Object.entries(CONFIG_GETTERS)) {
		const value = getter(settingsManager);
		const display = value === undefined || value === null ? chalk.dim("(not set)") : String(value);
		console.log(`${chalk.bold(key.padEnd(28))}${display}  ${chalk.dim(description)}`);
	}
}

export async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const subArgs = args.slice(1);
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "config command");

	// config get <key>
	if (subArgs[0] === "get") {
		if (subArgs[1] === "--help" || subArgs[1] === "-h") {
			printConfigHelp();
			return true;
		}
		if (!subArgs[1]) {
			printConfigHelp();
			return true;
		}
		handleConfigGet(settingsManager, subArgs[1]);
		return true;
	}

	// config set <key> <value>
	if (subArgs[0] === "set") {
		if (subArgs[1] === "--help" || subArgs[1] === "-h") {
			printConfigHelp();
			return true;
		}
		handleConfigSet(subArgs.slice(1), settingsManager);
		return true;
	}

	// config list
	if (subArgs[0] === "list") {
		handleConfigList(settingsManager);
		return true;
	}

	// config (no subcommand) — open TUI
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

export async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "package command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(
						chalk.dim(`No packages installed. Run ${chalk.bold(`${APP_NAME} install <source>`)} to add one.`),
					);
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update":
				await packageManager.update(source);
				if (source) {
					console.log(chalk.green(`Updated ${source}`));
				} else {
					console.log(chalk.green("Updated packages"));
				}
				return true;
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
