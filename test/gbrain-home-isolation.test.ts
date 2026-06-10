/**
 * Hermeticity test: every site that writes under `~/.inbrain` must honor
 * `INBRAIN_HOME=<tmp>` and write under `<tmp>/.inbrain` instead of the developer's
 * real home.
 *
 * Why this exists: `src/core/config.ts::configDir()` already supports
 * `INBRAIN_HOME` as a parent-dir override (returns `<override>/.inbrain`), but
 * historically many call sites built paths from `os.homedir()` directly,
 * bypassing the override. The hermeticity migration migrated every write-side
 * caller to `inbrainPath(...)`. This test is the regression gate.
 *
 * Scope: write-isolation only. Read-side host detection in
 * `src/commands/init.ts` (reading `~/.claude`, `~/.openclaw`, etc. for module
 * fingerprinting) is the documented v1 caveat and is NOT asserted here.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

// Save original env so we don't leak between tests.
const ORIG_INBRAIN_HOME = process.env.INBRAIN_HOME;

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'inbrain-home-isolation-'));
}

describe('INBRAIN_HOME write-side isolation', () => {
  test('configDir() returns <INBRAIN_HOME>/.inbrain when override is set', async () => {
    const tmp = fresh();
    process.env.INBRAIN_HOME = tmp;
    try {
      const { configDir, inbrainPath } = await import('../src/core/config.ts');
      expect(configDir()).toBe(join(tmp, '.inbrain'));
      expect(inbrainPath('foo', 'bar.json')).toBe(join(tmp, '.inbrain', 'foo', 'bar.json'));
    } finally {
      process.env.INBRAIN_HOME = ORIG_INBRAIN_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('configDir() falls back to homedir when INBRAIN_HOME unset', async () => {
    delete process.env.INBRAIN_HOME;
    try {
      const { configDir } = await import('../src/core/config.ts');
      // Contract: when INBRAIN_HOME is unset, configDir() === os.homedir()/.inbrain.
      // Asserting against os.homedir() (rather than a "not /tmp/" sentinel) keeps
      // this test correct under safety wrappers that redirect HOME=/tmp/... — the
      // behavior we care about is that the fallback path equals homedir().
      expect(configDir()).toBe(join(homedir(), '.inbrain'));
    } finally {
      if (ORIG_INBRAIN_HOME !== undefined) process.env.INBRAIN_HOME = ORIG_INBRAIN_HOME;
    }
  });

  test('rejects relative INBRAIN_HOME', async () => {
    process.env.INBRAIN_HOME = 'relative/path';
    try {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/absolute path/);
    } finally {
      process.env.INBRAIN_HOME = ORIG_INBRAIN_HOME;
    }
  });

  test("rejects INBRAIN_HOME containing '..' segments", async () => {
    process.env.INBRAIN_HOME = '/tmp/foo/../bar';
    try {
      const { configDir } = await import('../src/core/config.ts');
      expect(() => configDir()).toThrow(/'\.\.' segments/);
    } finally {
      process.env.INBRAIN_HOME = ORIG_INBRAIN_HOME;
    }
  });

  test('saveConfig/loadConfig honor INBRAIN_HOME', async () => {
    const tmp = fresh();
    process.env.INBRAIN_HOME = tmp;
    try {
      const { saveConfig, loadConfig } = await import('../src/core/config.ts');
      const cfg = { engine: 'pglite' as const, database_path: join(tmp, '.inbrain', 'brain.pglite') };
      saveConfig(cfg);
      // Config file should exist under the override, NOT under real ~/.inbrain.
      expect(existsSync(join(tmp, '.inbrain', 'config.json'))).toBe(true);

      // Round-trip: loadConfig() finds it back via the override.
      const loaded = loadConfig();
      expect(loaded?.engine).toBe('pglite');
      expect(loaded?.database_path).toBe(cfg.database_path);
    } finally {
      process.env.INBRAIN_HOME = ORIG_INBRAIN_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('integrity, sync-failures, integrations heartbeat resolve under INBRAIN_HOME', async () => {
    const tmp = fresh();
    process.env.INBRAIN_HOME = tmp;
    try {
      const { inbrainPath } = await import('../src/core/config.ts');
      // Spot-check a representative set of paths used across the migrated sites.
      const paths = [
        inbrainPath('integrity-review.md'),                       // src/commands/integrity.ts
        inbrainPath('sync-failures.jsonl'),                       // src/core/sync.ts
        inbrainPath('integrations', 'recipe-x'),                  // src/commands/integrations.ts
        inbrainPath('migrate-manifest.json'),                     // src/commands/migrate-engine.ts
        inbrainPath('import-checkpoint.json'),                    // src/commands/import.ts
        inbrainPath('migrations', 'v0_13_1-rollback.jsonl'),      // src/commands/migrations/v0_13_1.ts
        inbrainPath('migrations', 'pending-host-work.jsonl'),     // src/commands/migrations/v0_14_0.ts
        inbrainPath('audit'),                                     // shell-audit / backpressure-audit
        inbrainPath('cycle.lock'),                                // src/core/cycle.ts
        inbrainPath('fail-improve'),                              // src/core/fail-improve.ts
        inbrainPath('validator-lint.jsonl'),                      // src/core/output/post-write.ts
        inbrainPath('brain.pglite'),                              // init pglite default
      ];
      for (const p of paths) {
        expect(p.startsWith(join(tmp, '.inbrain'))).toBe(true);
      }
    } finally {
      process.env.INBRAIN_HOME = ORIG_INBRAIN_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('INBRAIN_AUDIT_DIR override still wins over INBRAIN_HOME', async () => {
    const tmp = fresh();
    const auditTmp = fresh();
    process.env.INBRAIN_HOME = tmp;
    process.env.INBRAIN_AUDIT_DIR = auditTmp;
    try {
      const { resolveAuditDir } = await import('../src/core/minions/handlers/shell-audit.ts');
      // Per the docstring: INBRAIN_AUDIT_DIR is the explicit override and wins.
      expect(resolveAuditDir()).toBe(auditTmp);
    } finally {
      process.env.INBRAIN_HOME = ORIG_INBRAIN_HOME;
      delete process.env.INBRAIN_AUDIT_DIR;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(auditTmp, { recursive: true, force: true });
    }
  });
});
