/**
 * Child process entry point for SubAgentSpawner.
 * Receives task and type as CLI args, runs the advisor orchestrator,
 * and writes JSON result to stdout.
 */

import { getAgentDir } from "../../config.js";
import { AuthStorage } from "../auth-storage.js";
import { ModelRegistry } from "../model-registry.js";
import { createAdvisorSystem } from "./index.js";

const task = process.argv[1];
const taskType = process.argv[2];

if (!task) {
	process.stdout.write(JSON.stringify({ success: false, error: "No task provided" }));
	process.exit(1);
}

try {
	const dir = getAgentDir();
	const auth = AuthStorage.create(`${dir}/auth.json`);
	const registry = ModelRegistry.create(auth);
	const { orchestrator } = createAdvisorSystem(registry);

	const result = await orchestrator.run(task, taskType);
	process.stdout.write(JSON.stringify(result));
} catch (e) {
	process.stdout.write(JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e) }));
}
