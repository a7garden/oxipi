/**
 * Child process entry point for SubAgentSpawner.
 * Receives task and type as CLI args, runs the planner agent,
 * and writes JSON result to stdout.
 */

import { getAgentDir } from "../../config.js";
import { AuthStorage } from "../auth-storage.js";
import { ModelRegistry } from "../model-registry.js";
import { createSubAgentSystem } from "./index.js";

const task = process.argv[1];
const _taskType = process.argv[2];

if (!task) {
	process.stdout.write(JSON.stringify({ success: false, error: "No task provided" }));
	process.exit(1);
}

try {
	const dir = getAgentDir();
	const auth = AuthStorage.create(`${dir}/auth.json`);
	const registry = ModelRegistry.create(auth);
	const { router, createAgent } = createSubAgentSystem(registry);

	// Create agent with router - model selection is automatic based on task type
	const agent = createAgent(router);

	const result = await agent.run(task);
	process.stdout.write(JSON.stringify(result));
} catch (e) {
	process.stdout.write(JSON.stringify({ success: false, error: e instanceof Error ? e.message : String(e) }));
}
