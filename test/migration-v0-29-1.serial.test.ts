import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine } from '../src/core/engine-factory.ts';
import { __testing } from '../src/commands/migrations/v0_29_1.ts';

const opts = {
  yes: true,
  dryRun: false,
  noAutopilotInstall: true,
};

describe('v0.29.1 migration', () => {
  let tmp: string;
  let oldGbrainHome: string | undefined;

  beforeEach(async () => {
    oldGbrainHome = process.env.INBRAIN_HOME;
    tmp = mkdtempSync(join(tmpdir(), 'inbrain-v0291-'));
    process.env.INBRAIN_HOME = tmp;

    const inbrainHome = join(tmp, '.inbrain');
    const dbPath = join(tmp, 'brain-db');
    mkdirSync(inbrainHome, { recursive: true });
    writeFileSync(
      join(inbrainHome, 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: dbPath }, null, 2) + '\n',
    );

    const engine = await createEngine({ engine: 'pglite', database_path: dbPath });
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    try {
      await engine.initSchema();
    } finally {
      await engine.disconnect();
    }
  });

  afterEach(() => {
    if (oldGbrainHome === undefined) delete process.env.INBRAIN_HOME;
    else process.env.INBRAIN_HOME = oldGbrainHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('connects the PGLite engine before backfill and verify phases', async () => {
    const backfill = await __testing.phaseBBackfill(opts);
    expect(backfill.status).toBe('complete');
    expect(backfill.detail).toContain('examined=0');

    const verify = await __testing.phaseCVerify(opts);
    expect(verify).toEqual({
      name: 'verify',
      status: 'complete',
      detail: '0 pages with NULL effective_date',
    });
  });
});
