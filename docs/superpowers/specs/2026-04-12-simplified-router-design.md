# Simplified Router Architecture

## Status: Implemented

## Overview

OxiPi uses a multi-provider model architecture. The user has:
- **minimax/m2.7**: Fast, good at coding, weak at planning
- **minimax/glm-5.1**: Slower, smarter, better at planning

Goal: Automatic model selection based on task type — no manual switching.

## Architecture

### Single Unified Routing Config

`routing.json` is the single source of truth:

```json
{
  "version": "2.0",
  "defaults": {
    "coding": "minimax/m2.7",
    "planning": "minimax/glm-5.1"
  },
  "tasks": {
    "reasoning": {
      "description": "Complex reasoning, analysis, strategy",
      "model": "planning"
    },
    "codeGeneration": {
      "description": "Code writing, refactoring",
      "model": "coding"
    },
    "review": {
      "description": "Code review, debugging",
      "model": "coding"
    },
    "simple": {
      "description": "Simple tasks, summary, translation",
      "model": "coding"
    },
    "default": {
      "description": "Default task",
      "model": "coding"
    }
  }
}
```

### Flow

1. Task arrives at `AdvisorAgent.run(task)`
2. `TaskClassifier.classify(task)` → task type string
3. `ModelRouter.getModelForTask(type)` → resolves model via routing
4. Agent runs with selected model

### Component Changes

#### ModelRouter
- `getModelForTask(taskType: string): Model<Api>` — new method
- `getRouting(taskType)` returns full `TaskRouting` (has `advisor`, `worker`, `maxIterations`)
- `getModelForTask(taskType)` resolves the actual `Model<Api>` from routing defaults

#### TaskClassifier
- Classifies task into: `reasoning`, `codeGeneration`, `review`, `simple`, `default`
- Uses LLM if registry available, falls back to keyword matching
- Already exists, just needs to be wired in

#### AdvisorAgent.run()
- Creates `TaskClassifier` with registry
- Classifies task before model selection
- Uses `ModelRouter.getModelForTask()` to select model

#### Config Consolidation
- Remove `advisor-config.json`
- Merge settings into `routing.json`:
  - `defaults.coding` and `defaults.planning` for model pairs
  - `settings.advisorMaxUses`, `settings.maxIterations` for agent behavior

## Files to Modify

1. `routing.json` — new v2.0 schema
2. `advisor-config.json` — delete after merge
3. `advisor-agent.ts`:
   - Update `ModelRouter.getModelForTask()`
   - Integrate `TaskClassifier` in `AdvisorAgent.run()`
   - Remove `loadAdvisorConfig()`, use router only
4. `advisor.ts`:
   - Fix `advisorUsagePerRun` memory leak (use WeakMap or add cleanup)

## Design Decisions

- **Keyword fallback for classification**: Zero latency, simple. LLM classification adds intelligence for ambiguous tasks.
- **No advisor tool**: User's actual need is model selection, not advisory guidance pattern.
- **Single config**: Easier to understand, no duplication.

## Tasks

- [x] Update routing.json to v2.0 schema
- [x] Update ModelRouter to support getModelForTask
- [x] Integrate TaskClassifier into AdvisorAgent.run()
- [x] Remove advisor-config.json
- [x] Fix advisorUsagePerRun memory leak
