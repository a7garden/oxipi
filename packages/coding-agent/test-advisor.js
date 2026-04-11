#!/usr/bin/env node
/**
 * Test script for Advisor System
 */

import { ModelRegistry } from "./dist/core/model-registry.js";
import { AuthStorage } from "./dist/core/auth-storage.js";
import { createAdvisorSystem } from "./dist/core/advisor/index.js";
import { getAgentDir, getAuthPath } from "./dist/config.js";

async function main() {
	console.log("🚀 Advisor System Test\n");

	// Initialize registry
	const agentDir = getAgentDir();
	const authStorage = AuthStorage.create(getAuthPath(agentDir));
	const registry = ModelRegistry.create(authStorage);

	console.log(`📁 Agent dir: ${agentDir}`);
	console.log(`📋 Available models: ${registry.getAvailable().length}`);

	// List some models
	const available = registry.getAvailable().slice(0, 5);
	console.log("\n🧠 Sample available models:");
	available.forEach(m => {
		console.log(`  - ${m.provider}/${m.id}`);
	});

	// Create advisor system
	const { router, advisor, spawner } = createAdvisorSystem(registry);

	console.log("\n📡 Available task routings:");
	router.listAvailableRoutings().forEach(r => {
		console.log(`  - ${r.type}: ${r.description}`);
	});

	// Test routing config
	const reasoning = router.getRouting("reasoning");
	console.log("\n🎯 Reasoning routing:");
	console.log(`  Advisor: ${reasoning.advisor.provider}/${reasoning.advisor.model}`);
	console.log(`  Executor: ${reasoning.executor.provider}/${reasoning.executor.model}`);

	// Check if models exist
	const advisorModel = router.getModel(reasoning.advisor);
	const executorModel = router.getModel(reasoning.executor);

	console.log(`\n✅ Advisor model found: ${!!advisorModel}`);
	console.log(`✅ Executor model found: ${!!executorModel}`);

	// Example WorkTree
	console.log("\n🌳 Testing WorkTree (simulated):");
	const tree = new (await import("./dist/core/advisor/index.js")).WorkTree(spawner);
	tree.addBranch("task-1", "Read the package.json and list dependencies", "simple");
	tree.addBranch("task-2", "Check the build configuration", "codeGeneration");
	
	console.log("  Added 2 branches");
	console.log("  (Real execution would spawn sub-agents)");

	console.log("\n✨ Advisor System initialized successfully!");
	console.log("\n📝 Next steps:");
	console.log("  1. Configure API keys in ~/.pi/agent/auth.json");
	console.log("  2. Update routing.json with your preferred models");
	console.log("  3. Run: node dist/cli.js");
}

main().catch(console.error);