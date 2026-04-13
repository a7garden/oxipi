# OXI Architecture Analysis & Improvement Plan

Date: 2026-04-12

---

## 1. Project Overview

OXI is a TypeScript monorepo for building AI agents and managing LLM deployments. It consists of 7 packages with a layered architecture spanning LLM API abstraction, agent runtime, terminal/web UIs, and infrastructure tooling.

### Scale

| Metric | Value |
|--------|-------|
| Total source lines | ~118,000 |
| Total test lines | ~46,000 |
| Test files | 167 |
| Packages | 7 |
| LLM providers | 15+ |
| Source files | ~250+ |

---

## 2. Package Dependency Graph

```
                    ┌──────────┐
                    │ @oxipi/ai│ ← Core LLM abstraction
                    └────┬─────┘
                         │
            ┌────────────┼────────────┐
            │            │            │
     ┌──────▼──────┐     │     ┌──────▼──────┐
     │@oxipi/agent │     │     │ @oxipi/tui  │
     │   -core     │     │     │ (terminal)  │
     └──────┬──────┘     │     └──────┬──────┘
            │            │            │
     ┌──────▼────────────▼────────────▼──────┐
     │       @oxipi/coding-agent (CLI)        │
     └──────┬────────────────────────────────┘
            │
     ┌──────▼──────┐     ┌──────────────┐
     │  @oxipi/mom │     │ @oxipi/pods  │
     │ (Slack bot) │     │ (GPU deploy) │
     └─────────────┘     └──────────────┘

     @oxipi/web-ui ──→ @oxipi/ai, @oxipi/agent-core (browser)
```

### Dependency Matrix

| Package | ai | agent | tui | coding-agent |
|---------|:--:|:-----:|:---:|:------------:|
| ai | - | | | |
| agent-core | ✅ | - | | |
| coding-agent | ✅ | ✅ | ✅ | - |
| mom | ✅ | ✅ | | ✅ |
| web-ui | ✅ | ✅ | ⚠️ | |
| pods | | ✅ | | |

> ⚠️ `web-ui` declares `@oxipi/tui` in `package.json` but does not import it in source code.

---

## 3. Strengths

### 3.1 Clear Layer Separation

The three-tier architecture (AI → Agent → UI) keeps concerns well-isolated:

- **AI Layer** (`@oxipi/ai`): Provider abstraction, streaming, token/cost tracking, model registry
- **Agent Layer** (`@oxipi/agent-core`): Stateful agent loop, tool execution, event streaming
- **UI Layer** (`@oxipi/tui`, `@oxipi/web-ui`): Rendering, input handling, component model

Each layer can be used independently. `@oxipi/ai` works in both Node.js and browser. `@oxipi/agent-core` is UI-agnostic.

### 3.2 Comprehensive Provider Coverage

15+ LLM providers with a unified streaming interface. Cross-provider handoffs preserve context including thinking blocks, tool calls, and tool results. Provider-specific quirks are handled via a `compat` configuration system.

### 3.3 Extensible Plugin Architecture

The extension system in `coding-agent` is well-designed:

- **Extensions**: TypeScript modules with full API access (tools, commands, UI, events)
- **Skills**: Markdown-based instruction packs following the Agent Skills standard
- **Prompt Templates**: Reusable parameterized prompts
- **Themes**: Hot-reloadable visual customization
- **Packages**: npm/git distributable bundles of the above

This avoids the "kitchen sink" anti-pattern. Features like sub-agents, plan mode, and permission popups are intentionally externalized.

### 3.4 Event-Driven Architecture

All packages use consistent event streaming patterns:

- `@oxipi/ai`: `AssistantMessageEventStream` with typed events (text_delta, toolcall_end, etc.)
- `@oxipi/agent-core`: `AgentEvent` with lifecycle events (agent_start, turn_end, tool_execution_end, etc.)
- `@oxipi/coding-agent`: EventBus for decoupled internal communication

### 3.5 Faux Provider for Testing

`@oxipi/ai` includes a `registerFauxProvider()` that creates deterministic in-memory providers. This enables testing agent behavior without API keys or network calls.

### 3.6 Session Model

JSONL-based session storage with tree structure (id/parentId) enables in-place branching without file duplication. The `/tree` view provides full session navigation.

---

## 4. Weaknesses

### 4.1 W-1: `mom` → `coding-agent` Upward Dependency

**Severity: High**

`@oxipi/mom` imports 8 symbols from `@oxipi/coding-agent`:

```typescript
// mom/src/agent.ts
import {
  AgentSession,
  AuthStorage,
  convertToLlm,
  createExtensionRuntime,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  ModelRegistry,
  SessionManager,
} from "@oxipi/coding-agent";
```

This creates an upward dependency in the layering. `coding-agent` is a CLI application package, not a library. Mom depends on application-level concerns (extension runtime, skills loader, session management) that should live in lower layers.

**Impact**: Mom is coupled to coding-agent's internal API. Changes to coding-agent's session manager, extension runtime, or skill loading directly break mom.

### 4.2 W-2: Tool Code Duplication (mom vs coding-agent)

**Severity: Medium**

Both packages implement the same core tools independently:

| Tool | coding-agent (lines) | mom (lines) | Overlap |
|------|---------------------|-------------|---------|
| read | 269 | 159 | Schema + truncation logic |
| write | 285 | 45 | Schema definition |
| edit | 307 | 165 | Schema + diff logic |
| bash | 441 | 97 | Schema + execution |
| truncate | 265 | 236 | ~90% identical |

Total: ~4,200 lines in coding-agent, ~770 lines in mom, with significant logic overlap.

### 4.3 W-3: `web-ui` Phantom Dependency

**Severity: Low**

`@oxipi/web-ui/package.json` declares `@oxipi/tui` as a dependency, but no source file imports from `@oxipi/tui`. This is dead weight in the dependency tree and could cause unnecessary installs.

### 4.4 W-4: Test Coverage Gaps

**Severity: High**

Test coverage is heavily skewed:

| Package | Source Lines | Test Lines | Ratio |
|---------|-------------|------------|-------|
| ai | 26,928 | 11,815 | 0.44 |
| agent-core | 1,859 | 1,625 | 0.87 |
| coding-agent | 45,602 | 23,081 | 0.51 |
| tui | 10,917 | 9,537 | 0.87 |
| **web-ui** | **14,620** | **0** | **0.00** |
| **mom** | **4,046** | **0** | **0.00** |
| **pods** | **1,773** | **0** | **0.00** |

Three packages (web-ui, mom, pods) totaling **20,439 source lines** have zero tests.

### 4.5 W-5: Large Files Exceeding Maintainability Threshold

**Severity: Medium**

Several files exceed 1,000 lines, making them difficult to navigate and maintain:

| File | Lines | Package |
|------|-------|---------|
| `models.generated.ts` | 14,243 | ai |
| `interactive-mode.ts` | 4,732 | coding-agent |
| `agent-session.ts` | 3,052 | coding-agent |
| `test-sessions.ts` | 2,357 | web-ui (test util) |
| `package-manager.ts` | 2,254 | coding-agent |
| `editor.ts` (component) | 2,230 | tui |
| `extensions/types.ts` | 1,445 | coding-agent |
| `session-manager.ts` | 1,420 | coding-agent |
| `keys.ts` | 1,356 | tui |
| `tui.ts` | 1,243 | tui |
| `tree-selector.ts` | 1,239 | coding-agent |
| `theme.ts` | 1,141 | coding-agent |

### 4.6 W-6: `interactive-mode.ts` God File

**Severity: Medium**

At 4,732 lines, `interactive-mode.ts` handles too many responsibilities:
- Command processing
- Key binding dispatch
- Steering/follow-up message handling
- Extension lifecycle
- Tool output rendering
- Session management
- UI layout orchestration

This is the highest-risk file for regression bugs.

### 4.7 W-7: No Shared Utilities Package

**Severity: Low**

Common patterns are reimplemented across packages:
- Path resolution utilities (coding-agent, mom)
- Settings/config loading (coding-agent, mom)
- Tool schema definitions (coding-agent, mom)
- Truncation logic (coding-agent, mom)

A shared `@oxipi/common` or `@oxipi/tools` package would eliminate this.

### 4.8 W-8: Lockstep Versioning Constraint

**Severity: Low (by design)**

All packages share the same version number regardless of whether they changed. This simplifies release management but can bloat changelogs and confuse consumers. A patch to `mom` bumps `@oxipi/tui` even if unchanged.

This is explicitly documented as a design choice, but worth noting for consumer-facing packages.

---

## 5. Improvement Proposals

### P-1: Extract Shared Services to Lower Layers

**Addresses: W-1, W-2, W-7**
**Priority: High**
**Effort: Large**

Move reusable services from `coding-agent` into `agent-core` or a new intermediate package:

```
@oxipi/agent-core (current)
    ├── Agent, agentLoop, types

@oxipi/agent-core (proposed additions)
    ├── tools/
    │   ├── read.ts        ← from coding-agent, parameterized
    │   ├── write.ts       ← from coding-agent, parameterized
    │   ├── edit.ts        ← from coding-agent, parameterized
    │   ├── bash.ts        ← from coding-agent, parameterized
    │   └── truncate.ts    ← shared truncation logic
    ├── session-manager.ts ← from coding-agent (or new package)
    ├── settings-manager.ts← from coding-agent (or new package)
    └── skills-loader.ts   ← from coding-agent
```

Alternatively, create `@oxipi/agent-tools`:

```
@oxipi/agent-tools (new)
    ├── read, write, edit, bash, truncate
    ├── session-manager
    ├── settings-manager
    ├── skills-loader
    └── convertToLlm (shared impl)
```

**Before**:
```
coding-agent ──→ agent-core ──→ ai
mom ──→ coding-agent ──→ agent-core ──→ ai  (upward dep)
```

**After**:
```
coding-agent ──→ agent-tools ──→ agent-core ──→ ai
mom ──→ agent-tools ──→ agent-core ──→ ai     (clean)
```

**Trade-offs**:
- (+) Eliminates upward dependency
- (+) Removes tool code duplication
- (+) mom, web-ui, pods can share infrastructure
- (-) New package to maintain
- (-) Need to parameterize tools for different execution contexts (host vs Docker vs browser)

### P-2: Decompose `interactive-mode.ts`

**Addresses: W-5, W-6**
**Priority: Medium**
**Effort: Medium**

Split the 4,732-line file into focused modules:

```
interactive-mode/
    ├── index.ts                    ← orchestration only (~500 lines)
    ├── command-handler.ts          ← /command processing
    ├── keybinding-handler.ts       ← keyboard dispatch
    ├── message-queue-handler.ts    ← steering + follow-up
    ├── extension-lifecycle.ts      ← extension load/reload/unload
    ├── tool-renderer.ts            ← tool output formatting
    └── ui-layout.ts               ← component assembly
```

The `index.ts` file should only wire the pieces together. Each sub-module should be independently testable.

### P-3: Add Test Infrastructure for Untested Packages

**Addresses: W-4**
**Priority: High**
**Effort: Large**

#### web-ui (14,620 lines, 0 tests)
- Use `@oxipi/ai`'s faux provider for deterministic testing
- Test component rendering with `@xterm/headless` or jsdom
- Test storage layer (IndexedDB mock)
- Test message transformers (convertToLlm variants)

#### mom (4,046 lines, 0 tests)
- Test context sync logic (log.jsonl → context.jsonl)
- Test event scheduling (immediate, one-shot, periodic)
- Test tool execution in both host and Docker modes
- Test compaction logic

#### pods (1,773 lines, 0 tests)
- Test model configuration resolution
- Test GPU memory calculations
- Test SSH command generation
- Test pod lifecycle management

### P-4: Remove Phantom `@oxipi/tui` from web-ui

**Addresses: W-3**
**Priority: Low**
**Effort: Trivial**

Remove `@oxipi/tui` from `web-ui`'s `package.json` dependencies. No source code references it.

### P-5: Split `models.generated.ts`

**Addresses: W-5**
**Priority: Low**
**Effort: Small**

The 14,243-line generated file can be split per provider:

```
models.generated/
    ├── index.ts            ← re-exports all
    ├── anthropic.ts
    ├── openai.ts
    ├── google.ts
    ├── bedrock.ts
    ├── mistral.ts
    ├── groq.ts
    ├── xai.ts
    └── ...
```

This improves IDE performance (syntax highlighting, go-to-definition) and reduces merge conflicts when multiple providers are updated.

### P-6: Establish File Size Guidelines

**Addresses: W-5**
**Priority: Low**
**Effort: Small**

Add to `AGENTS.md` or `CONTRIBUTING.md`:

```markdown
## File Size Guidelines
- Target: < 500 lines per file
- Soft limit: 800 lines (justification required in PR)
- Hard limit: 1,200 lines (must refactor before merge)
- Generated files are exempt
```

This prevents future god files from accumulating.

---

## 6. Priority Matrix

| Proposal | Impact | Effort | Priority |
|----------|--------|--------|----------|
| P-1: Extract shared services | High | Large | **P1** |
| P-3: Add test infrastructure | High | Large | **P1** |
| P-2: Decompose interactive-mode | Medium | Medium | **P2** |
| P-4: Remove phantom dep | Low | Trivial | **P3** |
| P-5: Split models.generated | Low | Small | **P3** |
| P-6: File size guidelines | Low | Small | **P3** |

### Recommended Sequence

```
Phase 1 (immediate)
├── P-4: Remove phantom dep         ← 5 minutes
├── P-6: File size guidelines       ← 30 minutes
└── P-5: Split models.generated     ← 1 hour

Phase 2 (next sprint)
├── P-3: web-ui + mom tests         ← 2-3 days
└── P-2: Decompose interactive-mode ← 2-3 days

Phase 3 (major refactor)
└── P-1: Extract agent-tools        ← 1-2 weeks
```

---

## 7. Architecture Metrics Summary

| Metric | Score | Notes |
|--------|-------|-------|
| Modularity | 8/10 | Clean layer boundaries, one upward dep (mom→coding-agent) |
| Extensibility | 9/10 | Extension/skill/package system is excellent |
| Consistency | 7/10 | Event patterns unified, DI usage inconsistent |
| Testability | 5/10 | 3 packages with zero tests, faux provider is good pattern |
| Maintainability | 6/10 | God files, duplicated tools, phantom deps |
| Documentation | 9/10 | Comprehensive READMEs, inline docs, AGENTS.md |
| Overall | **7.3/10** | Solid foundation, needs targeted refactoring |

---

## 8. Dependency Flow (Current vs Proposed)

### Current

```
     ┌───────────────────────────────────────────┐
     │              apps                          │
     │  ┌─────────────┐  ┌───────┐  ┌─────────┐ │
     │  │coding-agent │  │  mom  │  │  pods   │ │
     │  └──────┬──────┘  └──┬─┬──┘  └────┬────┘ │
     │         │            │ │          │       │
     │  ┌──────▼──────┐     │ │    ┌────▼────┐  │
     │  │  agent-core │◄────┘ │    │agent-core│  │
     │  └──────┬──────┘       │    └────┬────┘  │
     │         │              │         │        │
     │  ┌──────▼──────┐  ┌───▼─────────▼───┐    │
     │  │   @oxipi/ai │  │   @oxipi/ai     │    │
     │  └─────────────┘  └────────────────┘    │
     └───────────────────────────────────────────┘
     
     mom → coding-agent (upward!)     pods → agent-core (clean)
```

### Proposed

```
     ┌───────────────────────────────────────────────┐
     │                  apps                          │
     │  ┌─────────────┐  ┌───────┐  ┌─────────────┐ │
     │  │coding-agent │  │  mom  │  │    pods     │ │
     │  └──────┬──────┘  └──┬────┘  └──────┬──────┘ │
     │         │            │              │         │
     │  ┌──────▼────────────▼──────────────▼──────┐  │
     │  │          @oxipi/agent-tools (new)        │  │
     │  │  tools, session-mgr, settings, skills    │  │
     │  └──────────────────┬──────────────────────┘  │
     │                     │                          │
     │  ┌──────────────────▼──────────────────────┐  │
     │  │            @oxipi/agent-core             │  │
     │  └──────────────────┬──────────────────────┘  │
     │                     │                          │
     │  ┌──────────────────▼──────────────────────┐  │
     │  │              @oxipi/ai                   │  │
     │  └─────────────────────────────────────────┘  │
     └───────────────────────────────────────────────┘
     
     All dependencies flow downward. No upward deps.
```

---

## Appendix: Data Collection Commands

```bash
# Package dependency check
grep -E '"@oxipi/' packages/*/package.json

# Test coverage per package
for pkg in ai agent coding-agent tui web-ui mom pods; do
  tests=$(find packages/$pkg -name "*.test.ts" | wc -l)
  src=$(find packages/$pkg/src -name "*.ts" -exec cat {} + | wc -l)
  echo "$pkg: $tests tests, $src src lines"
done

# Largest source files
find packages -name "*.ts" -path "*/src/*" -exec wc -l {} + | sort -rn | head -20

# Cross-package imports from mom
grep -rn "from.*@oxipi" packages/mom/src/

# Phantom dependency check
grep "tui" packages/web-ui/package.json
grep -rn "@oxipi/tui" packages/web-ui/src/
```
