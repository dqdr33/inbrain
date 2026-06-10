/**
 * v0.37.7.0 #1226 regression test.
 *
 * The autopilot lockfile was hardcoded at `~/.inbrain/autopilot.lock`
 * (via `process.env.HOME`), bypassing INBRAIN_HOME. Two brains pointed
 * at different INBRAIN_HOME directories would still write to the same
 * global lockfile; one would silently take over the other on each
 * restart.
 *
 * Fix: route through `inbrainPath('autopilot.lock')` which honors
 * INBRAIN_HOME. This file pins the contract via the canonical helper
 * directly, since the autopilot daemon's lifecycle is heavy to drive
 * in a unit test.
 */

import { describe, test, expect } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inbrainPath } from '../src/core/config.ts';

describe('autopilot lock path scoped to INBRAIN_HOME (#1226)', () => {
  test('one INBRAIN_HOME produces one canonical lock path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'inbrain-autopilot-lock-'));
    await withEnv({ INBRAIN_HOME: home }, async () => {
      const lockPath = inbrainPath('autopilot.lock');
      // Lockfile MUST live inside the per-brain INBRAIN_HOME, not under
      // process.env.HOME — that was the pre-fix bug.
      expect(lockPath.startsWith(home)).toBe(true);
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
    });
  });

  test('two INBRAIN_HOME values produce two distinct lockfiles', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'inbrain-autopilot-A-'));
    const homeB = mkdtempSync(join(tmpdir(), 'inbrain-autopilot-B-'));

    let lockA = '';
    let lockB = '';
    await withEnv({ INBRAIN_HOME: homeA }, async () => {
      lockA = inbrainPath('autopilot.lock');
    });
    await withEnv({ INBRAIN_HOME: homeB }, async () => {
      lockB = inbrainPath('autopilot.lock');
    });

    // The contract that prevents two brains from silently colliding:
    // distinct INBRAIN_HOME values MUST produce distinct lockfile paths.
    expect(lockA).not.toBe(lockB);
    expect(lockA.startsWith(homeA)).toBe(true);
    expect(lockB.startsWith(homeB)).toBe(true);
  });

  test('default (no INBRAIN_HOME override) still produces a valid path', async () => {
    // When INBRAIN_HOME is unset, inbrainPath falls through to its
    // default (`~/.inbrain`). The path must still exist as a string
    // and end with the expected filename — we don't assert the exact
    // home dir since that varies by environment.
    await withEnv({ INBRAIN_HOME: undefined }, async () => {
      const lockPath = inbrainPath('autopilot.lock');
      expect(typeof lockPath).toBe('string');
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
      expect(lockPath.length).toBeGreaterThan('autopilot.lock'.length);
    });
  });
});
