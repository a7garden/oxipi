import { describe, it, expect } from 'vitest';
import { NESTING_GUARD } from './sub-agent-executor.js';

describe('SubAgent nesting guard', () => {
  it('should detect when running as sub-agent via OXIPI_SUBAGENT_ID', () => {
    // Initially no parent - should not be nested
    const original = process.env.OXIPI_SUBAGENT_ID;
    delete process.env.OXIPI_SUBAGENT_ID;
    expect(NESTING_GUARD.isNested()).toBe(false);

    // Simulate nested context
    process.env.OXIPI_SUBAGENT_ID = 'parent-agent-123';
    expect(NESTING_GUARD.isNested()).toBe(true);

    process.env.OXIPI_SUBAGENT_ID = original;
  });

  it('should throw when check() called in nested context', () => {
    const original = process.env.OXIPI_SUBAGENT_ID;
    process.env.OXIPI_SUBAGENT_ID = 'parent-agent-123';

    expect(() => NESTING_GUARD.check()).toThrow('Sub-agents cannot spawn sub-agents');

    process.env.OXIPI_SUBAGENT_ID = original;
  });

  it('should not throw when check() called in non-nested context', () => {
    const original = process.env.OXIPI_SUBAGENT_ID;
    delete process.env.OXIPI_SUBAGENT_ID;

    expect(() => NESTING_GUARD.check()).not.toThrow();

    process.env.OXIPI_SUBAGENT_ID = original;
  });
});