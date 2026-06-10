// v0.38 Phase C: inbrain schema CLI smoke tests.
//
// Tests the runSchema dispatch + each subcommand's output shape via
// the public CLI entrypoint. Hermetic — uses Bun's subprocess to run
// the CLI like a user would.

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

// Default-isolated INBRAIN_HOME for every inbrain() call. Without this,
// tests that read `~/.inbrain/config.json` inherit the developer's real
// brain config — and sibling Conductor worktrees writing to the same
// config (e.g. via `schema use` or `config set` during their own tests)
// cause flakes (the failing test pre-fix saw `schema_pack: "inbrain-base-v2"`
// from another worktree, which doesn't exist in the bundle, and got
// exit 1 instead of the asserted 0).
let DEFAULT_INBRAIN_HOME: string;

beforeAll(() => {
  DEFAULT_INBRAIN_HOME = mkdtempSync(join(tmpdir(), 'inbrain-schema-cli-default-'));
});

afterAll(() => {
  rmSync(DEFAULT_INBRAIN_HOME, { recursive: true, force: true });
});

function inbrain(
  args: string[],
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; code: number } {
  // bun's spawnSync does NOT inherit env mutations done via process.env = ...,
  // so pass env explicitly. CLAUDE.md flags this pattern as load-bearing for
  // any subprocess test that needs INBRAIN_HOME isolation.
  const env = { ...process.env, INBRAIN_HOME: DEFAULT_INBRAIN_HOME, ...extraEnv };
  const result = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? -1,
  };
}

describe('inbrain schema CLI (Phase C)', () => {
  test('schema with no subcommand shows help text', () => {
    // Note: `schema --help` is intercepted by the CLI's parent help system
    // and prints generic help (`inbrain --help` for full command list). The
    // schema-specific help fires when no subcommand is provided.
    const r = inbrain(['schema']);
    expect(r.stdout + r.stderr).toMatch(/schema|active|list|show|validate|use/i);
  });

  test('schema list shows inbrain-base bundled', () => {
    const r = inbrain(['schema', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Bundled packs:');
    expect(r.stdout).toContain('inbrain-base');
  });

  test('schema show inbrain-base prints manifest details', () => {
    const r = inbrain(['schema', 'show', 'inbrain-base']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('inbrain-base v1.0.0');
    // v0.41.11.0: page types extended from 22 to 24 by promoting
    // `conversation` and `atom` into inbrain-base.
    // v0.41.23.0: extended to 25 by adding `extract_receipt` for the
    // unified extract receipt-writer surface (D-EXTRACT-19 belt+suspenders).
    expect(r.stdout).toContain('Page types (25)');
    expect(r.stdout).toContain('Link verbs (12)');
    expect(r.stdout).toContain('Takes kinds: fact, take, bet, hunch');
    expect(r.stdout).toContain('person :: entity');
    expect(r.stdout).toContain('company :: entity');
  });

  test('schema validate inbrain-base passes', () => {
    const r = inbrain(['schema', 'validate', 'inbrain-base']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✓');
    expect(r.stdout).toContain('valid manifest');
  });

  test('schema active reports default resolution', () => {
    const r = inbrain(['schema', 'active']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Active pack:');
    expect(r.stdout).toContain('Pack identity:');
  });

  test('schema show unknown-pack errors with hint', () => {
    const r = inbrain(['schema', 'show', 'nonexistent-pack']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown pack');
    expect(r.stderr).toContain('schema list');
  });

  test('unknown subcommand exits with hint', () => {
    const r = inbrain(['schema', 'frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown schema subcommand');
  });

  test('schema use without arg shows usage hint', () => {
    const r = inbrain(['schema', 'use']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage:');
  });
});

describe('inbrain schema use (Phase C, gap-fill T3)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'inbrain-schema-use-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('writes schema_pack to ~/.inbrain/config.json on happy path', () => {
    const r = inbrain(['schema', 'use', 'inbrain-base'], { INBRAIN_HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Active schema pack set to: inbrain-base');
    expect(r.stdout).toContain('schema active');
    const cfgPath = join(home, '.inbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.schema_pack).toBe('inbrain-base');
  });

  test('preserves pre-existing config fields when writing schema_pack', () => {
    // Pre-seed a config with engine + a custom key so the merge preserves them.
    mkdirSync(join(home, '.inbrain'), { recursive: true });
    const cfgPath = join(home, '.inbrain', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', openai_key: 'sk-fake' }, null, 2), 'utf-8');
    const r = inbrain(['schema', 'use', 'inbrain-base'], { INBRAIN_HOME: home });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.engine).toBe('pglite');
    expect(cfg.openai_key).toBe('sk-fake');
    expect(cfg.schema_pack).toBe('inbrain-base');
  });

  test('overwrites prior schema_pack value on re-run', () => {
    // First set a placeholder, then overwrite via the CLI.
    mkdirSync(join(home, '.inbrain'), { recursive: true });
    const cfgPath = join(home, '.inbrain', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', schema_pack: 'something-else' }, null, 2), 'utf-8');
    const r = inbrain(['schema', 'use', 'inbrain-base'], { INBRAIN_HOME: home });
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.schema_pack).toBe('inbrain-base');
  });

  test('unknown pack rejected with exit 1 + paste-ready hint', () => {
    const r = inbrain(['schema', 'use', 'no-such-pack-xyz'], { INBRAIN_HOME: home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown pack');
    expect(r.stderr).toContain('schema list');
    // Importantly: a failed `use` must NOT have written a config.
    const cfgPath = join(home, '.inbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(false);
  });
});
