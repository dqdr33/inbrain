/**
 * Unit tests for parseNiceFlag (issue #1815) — flag > INBRAIN_NICE env > undefined.
 */

import { describe, test, expect } from 'bun:test';
import { parseNiceFlag } from '../src/commands/jobs.ts';

describe('parseNiceFlag', () => {
  test('returns undefined when absent (no flag, no env)', () => {
    expect(parseNiceFlag(['jobs', 'work'], {})).toBeUndefined();
  });

  test('reads the --nice flag', () => {
    expect(parseNiceFlag(['jobs', 'work', '--nice', '10'], {})).toBe(10);
    expect(parseNiceFlag(['jobs', 'work', '--nice', '-5'], {})).toBe(-5);
  });

  test('falls back to INBRAIN_NICE env', () => {
    expect(parseNiceFlag(['jobs', 'work'], { INBRAIN_NICE: '7' })).toBe(7);
  });

  test('flag wins over env', () => {
    expect(parseNiceFlag(['jobs', 'work', '--nice', '3'], { INBRAIN_NICE: '15' })).toBe(3);
  });

  test('empty env string is treated as absent', () => {
    expect(parseNiceFlag(['jobs', 'work'], { INBRAIN_NICE: '' })).toBeUndefined();
  });
});
