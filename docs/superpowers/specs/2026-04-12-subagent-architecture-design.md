# Parallel Subagent Architecture Design

**Date**: 2026-04-12
**Status**: Draft

## Overview

Rebuild the parallel subagent system with clear separation between Executor (task orchestration) and subagent execution pools. The goal is reliable isolation, configurable concurrency, and consistent error handling.

## Architecture

```
┌─────────────────────────────────────────────┐
│            Executor (Agent)                │
│  - Task decomposition (with Planner advice) │
│  - Subtask execution orchestration          │
│  - Result aggregation                       │
└─────────────────────────────────────────────┘
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
┌───────────────────┐   ┌───────────────────┐
│  InProcessPool    │   │   WorktreePool    │
│  - Promise.all    │   │   - git worktree  │
│  - Fast, same     │   │   - IPC via JSONL │
│    process        │   │   - Full isolation│
└───────────────────┘   └───────────────────┘
        │                       │
        └───────────┬───────────┘
                    ▼
         ┌──────────────────┐
         │   SubtaskPool    │
         │   Interface      │
         │   (unified API)  │
         └──────────────────┘
```

## Key Design Decisions

## Key Design Decisions

### 1. Executor vs Planner Roles

- **Executor**: 기존 `SubAgentExecutor` 패턴 재사용. 메인 agent로서 최종 결정권, task 분해 및 실행 orchestration 담당. Planner는 advisory 역할만 수행.
- **Planner**: Executor가 필요시 consult하는 advisory (권고만 제공, 실행 결정 아님)
- Task decomposition은 **Executor 책임** — Planner는 조언만, 실행은 Executor

### 2. Task vs Subagent Distinction

- **Task (Subtask)**: 작업의 단위 — "파일 10개 refactor하기"
- **Subagent**: 작업을 실행하는 주체 — 별도 process/agent instance

이 둘은 분리된 개념으로, Task는 설명(envelope)이고 Subagent는 실행자

### 3. Execution Model: Hybrid with Worktree Default

- **Default**: Worktree isolation (안전성 우선)
- **In-process**: 명시적 옵션 `mode: "inprocess"` — 빠른 작업용

```typescript
// 사용 예
executor.spawnSubtasks(tasks, { mode: "worktree" }) // 기본값
executor.spawnSubtasks(tasks, { mode: "inprocess" }) // 빠른 작업
```

### 4. Concurrency Control: Dynamic per-call

Pool worker 수를 호출마다 지정:

```typescript
executor.spawnSubtasks(tasks, {
  maxConcurrency: 3,  // 동시 실행 수
})
```

### 5. Error Handling: Configurable

실행 전략 선택 가능:

```typescript
executor.spawnSubtasks(tasks, {
  failFast: true,   // 하나 실패하면 전체 취소
  failFast: false,  // 모든 task 완료까지 대기 (default)
})
```

### 6. IPC: JSONL File Polling (유지)

Worktree 기반 서브에이전트와 부모 간 통신:
- 파일: `.oxipi/subagent/{subagentId}.jsonl`
- Polling loop로 메시지 읽기/쓰기
- Debugging 용이 (파일 직접 확인 가능)

### 7. Task Decomposition: Executor + Planner Advisory

```
Task → Executor (decompose with Planner advice)
            ↓
      Subtask[]
            ↓
      SubPool.spawn(subtasks)
```

- Executor가 직접 분해 (Planner는 필요시 조언만)
- Planner는 advisory 역할만 (실행 책임 없음)

## Components

### SubtaskPool Interface

```typescript
interface SubtaskPool {
  spawn(
    tasks: Subtask[],
    options: {
      maxConcurrency?: number
      failFast?: boolean
      timeout?: number
      onProgress?: (id: string, line: string) => void
    }
  ): Promise<Map<string, SubtaskResult>>
}
```

### InProcessPool

- Promise.all 기반 동시 실행
- 같은 프로세스에서 실행 (빠름)
- 리소스 경합 가능성 있음

### WorktreePool

- git worktree 생성 후 별도 process 실행
- IPC: JSONL file polling
- 완전한 격리 (filesystem, git state 독립)

### Subtask

```typescript
interface Subtask {
  id: string
  description: string  // human-readable
  task: string         // task description for agent
  type?: string        // optional task type hint
}
```

### SubtaskResult

```typescript
interface SubtaskResult {
  id: string
  status: "completed" | "failed" | "cancelled"
  output?: string
  error?: string
  duration: number
}
```

## Directory Structure (Target)

```
packages/coding-agent/src/
  core/
    executor/
      index.ts           # Executor class
      task-pool.ts       # SubtaskPool interface
      in-process-pool.ts # InProcessPool implementation
      worktree-pool.ts    # WorktreePool implementation
      types.ts           # Subtask, SubtaskResult interfaces
    tools/
      spawn-subtasks.ts  # spawn_subtasks tool (replaces spawn-subagents)
    planner/             # (existing, advisory only)
```

## Phases

### Phase 1: Interface + Types

- Define `Subtask`, `SubtaskResult`, `SubtaskPool` types
- Extract from existing `sub-agent-executor.ts`

### Phase 2: InProcessPool

- Simple Promise.all implementation
- Test with existing `spawnParallel`

### Phase 3: WorktreePool

- Migrate from `SubAgentSpawner.spawnInWorktree`
- JSONL IPC mechanism
- Cleanup handling

### Phase 4: Executor

- Replace `spawn-subagents-tool.ts` logic
- Integrate with Planner (advisory pattern)
- Unify InProcessPool + WorktreePool behind interface

### Phase 5: Cleanup

- Remove old `spawn-subagents-tool.ts` (or keep as wrapper)
- Remove duplicate `SubAgentExecutor` class if redundant
- Update tests

## OpenCode Reference Points

- **Worktree lifecycle**: `packages/opencode/src/worktree/index.ts` — Effect service pattern
- **Runner state machine**: `packages/opencode/src/effect/runner.ts` — Fiber/Deferred pattern
- **IPC via SSE**: `packages/opencode/src/control-plane/workspace.ts` — event-driven sync

## Notes

- Nested subagent prevention: `NESTING_GUARD` 유지 (env var `OXIPI_SUBAGENT_ID`)
- Planner is advisory only — Executor가 최종 decision maker
- Worktree default = isolation safety优先