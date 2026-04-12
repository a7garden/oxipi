# Native Planner System Prompt Design

## Status
- **Date**: 2026-04-12
- **Author**: claude
- **Review**: pending

## Context

OxiPi uses an executor/planner pattern where:
- **Executor**: Main coding agent that runs tasks end-to-end
- **Planner**: Consulted via planner-tool when executor encounters complex decisions

The planner needs a native system prompt that makes it effective at providing guidance without executing code.

## Design Decision

### Approach: Static System Prompt

The planner system prompt is static — same core prompt for all tasks. The user chose this for simplicity and consistency.

### Response Format: Structured with Keywords

Selected approach B (semi-structured): Keywords (PROCEED/REVISE/DECIDE/STOP) + structured response sections (VERDICT/REASON/GUIDANCE).

### Executor Guidance Handling: Optional

Selected approach C: executor can choose whether to follow guidance. Planner provides high-quality advice but executor makes final decisions.

## System Prompt

```markdown
You are a senior software architect and technical advisor.

## Your Role
- Analyze code, architecture, and technical decisions
- Provide clear, actionable guidance
- Identify risks and alternatives
- Do NOT execute code — guide the executor

## Guidance Format
Always respond with this structure:

**VERDICT**: [PROCEED|REVISE|DECIDE|STOP]
**REASON**: One sentence explaining why
**GUIDANCE**: 2-3 sentences with specific, actionable advice

## Keywords
- PROCEED: The approach is sound. Continue.
- REVISE: The approach has flaws. Correct as described.
- DECIDE: Multiple valid options exist. Choose based on context.
- STOP: This path is blocked or dangerous. Stop and reconsider.

## Rules
- Be concise (max 500 tokens)
- Read the provided code/context before deciding
- Prioritize maintainability and simplicity
- Flag security, performance, architecture issues
- Provide alternatives when rejecting an approach
```

## Key Differences from Previous Design

| Aspect | Previous | New |
|--------|----------|-----|
| Role | "expert senior technical planner" | "senior software architect and technical advisor" |
| Format | keyword + free text | VERDICT/REASON/GUIDANCE structured |
| Keywords | APPROVED/NEEDS_CHANGE/CONTINUE/STOP | PROCEED/REVISE/DECIDE/STOP |
| Rules | 4 simple guidelines | 6 specific rules with emphasis on risks |

## Implementation

Update `src/core/tools/planner-tool.ts`:
1. Replace `buildPlannerSystemPrompt()` with new prompt
2. Update `parseGuidanceResponse()` to handle new VERDICT/REASON/GUIDANCE format
3. Update `plannerSchema` description if needed

## Verification

- Build must pass
- planner tool must return properly formatted guidance
- Executor must be able to parse and optionally follow guidance