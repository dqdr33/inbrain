/**
 * Tests for `reference --apply-clean-hunks` (D15, TODO-3 folded).
 *
 * Pins:
 *   - clean apply: user's local file gets inbrain's upstream changes
 *     where context is unchanged
 *   - conflict reporting: conflicting hunks listed with file:line+kind
 *   - identical / missing / binary files reported, not touched
 *   - dry-run: outcomes computed, no writes
 *   - paired source files included
 *   - --all is intentionally NOT supported (apply one skill at a time)
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runReferenceApply } from '../src/core/skillpack/reference.ts';
import { runScaffold } from '../src/core/skillpack/scaffold.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratchGbrain(): string {
  const root = mkdtempSync(join(tmpdir(), 'sp-refapply-inbrain-'));
  created.push(root);
  mkdirSync(join(root, 'src', 'commands'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), '// stub');

  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  // Long SKILL.md so the diff has well-isolated hunks.
  const baseLines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join('\n') + '\n';
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), baseLines);

  writeFileSync(
    join(root, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        name: 'inbrain-test',
        version: '0.33.0-test',
        skills: ['skills/demo'],
        shared_deps: [],
      },
      null,
      2,
    ),
  );
  return root;
}

function scratchWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'sp-refapply-ws-'));
  created.push(ws);
  return ws;
}

describe('runReferenceApply — happy paths', () => {
  it('applies upstream inbrain changes to a file the user has not edited', () => {
    const inbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    // inbrain ships a new version with line 15 updated. User has not
    // touched the file locally.
    const inbrainSkill = join(inbrainRoot, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      inbrainSkill,
      readFileSync(inbrainSkill, 'utf-8').replace('Line 15\n', 'Line 15 UPDATED\n'),
    );

    const userSkill = join(ws, 'skills', 'demo', 'SKILL.md');
    const result = runReferenceApply({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    expect(result.summary.filesApplied).toBe(1);
    expect(result.summary.totalHunksApplied).toBe(1);
    expect(result.summary.totalHunksConflicted).toBe(0);
    expect(readFileSync(userSkill, 'utf-8')).toContain('Line 15 UPDATED');
  });

  it('two-way limitation: user edits in differing area DO get replaced by inbrain content', () => {
    // D15 contract: this is a TWO-WAY diff against inbrain's current
    // bundle. Without scaffold-time base tracking, we cannot tell
    // whether a difference came from inbrain or from the user. Applied
    // hunks therefore align everything to inbrain. The agent uses
    // --dry-run / reference (read-only) BEFORE applying to decide.
    const inbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    // inbrain changes line 25. User changes line 5 (independent areas).
    const inbrainSkill = join(inbrainRoot, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      inbrainSkill,
      readFileSync(inbrainSkill, 'utf-8').replace('Line 25\n', 'Line 25 INBRAIN\n'),
    );
    const userSkill = join(ws, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      userSkill,
      readFileSync(userSkill, 'utf-8').replace('Line 5\n', 'Line 5 USER\n'),
    );

    const result = runReferenceApply({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    expect(result.summary.totalHunksApplied).toBeGreaterThanOrEqual(1);
    // inbrain's change lands…
    expect(readFileSync(userSkill, 'utf-8')).toContain('Line 25 INBRAIN');
    // …AND the user's edit gets overwritten (the two-way limitation).
    expect(readFileSync(userSkill, 'utf-8')).not.toContain('Line 5 USER');
  });

  it('identical file: reported as identical, not touched', () => {
    const inbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    const before = readFileSync(join(ws, 'skills', 'demo', 'SKILL.md'), 'utf-8');
    const result = runReferenceApply({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    const after = readFileSync(join(ws, 'skills', 'demo', 'SKILL.md'), 'utf-8');

    expect(result.summary.filesIdentical).toBe(1);
    expect(after).toBe(before);
  });

  it('missing file: reported as missing, not created', () => {
    const inbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    // Don't scaffold — leave target missing.

    const result = runReferenceApply({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    expect(result.summary.filesMissing).toBe(1);
    expect(existsSync(join(ws, 'skills', 'demo', 'SKILL.md'))).toBe(false);
  });
});

describe('runReferenceApply — applied-status surface', () => {
  it('applied_clean status set when every hunk lands without conflict', () => {
    // runReferenceApply uses just-in-time diff (user→inbrain), so its
    // own before-blocks are by construction always found in the user
    // file. The conflict path is exercised structurally by the
    // underlying applyHunks tests (apply-hunks.test.ts) — see those
    // for the conflict_missing / conflict_ambiguous coverage. Here we
    // just pin the status-label surface that the CLI reports.
    const inbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    const inbrainSkill = join(inbrainRoot, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      inbrainSkill,
      readFileSync(inbrainSkill, 'utf-8').replace('Line 15\n', 'Line 15 INBRAIN\n'),
    );

    const result = runReferenceApply({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    expect(result.files.some(f => f.status === 'applied_clean')).toBe(true);
  });
});

describe('runReferenceApply — dry-run', () => {
  it('reports apply outcomes without writing the file', () => {
    const inbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    runScaffold({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    // inbrain ships an upstream change.
    const inbrainSkill = join(inbrainRoot, 'skills', 'demo', 'SKILL.md');
    writeFileSync(
      inbrainSkill,
      readFileSync(inbrainSkill, 'utf-8').replace('Line 15\n', 'Line 15 INBRAIN\n'),
    );

    const userSkill = join(ws, 'skills', 'demo', 'SKILL.md');
    const before = readFileSync(userSkill, 'utf-8');

    const result = runReferenceApply({
      inbrainRoot,
      targetWorkspace: ws,
      skillSlug: 'demo',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.summary.totalHunksApplied).toBeGreaterThan(0);
    // File NOT modified (dry-run).
    expect(readFileSync(userSkill, 'utf-8')).toBe(before);
  });
});

describe('runReferenceApply — binary files', () => {
  it('binary files are reported binary_skip and not touched', () => {
    const inbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();

    const binPath = join(inbrainRoot, 'skills', 'demo', 'icon.png');
    writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    runScaffold({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });

    writeFileSync(join(ws, 'skills', 'demo', 'icon.png'), Buffer.from([0x89, 0x50, 0x00]));

    const result = runReferenceApply({ inbrainRoot, targetWorkspace: ws, skillSlug: 'demo' });
    expect(result.summary.filesBinarySkipped).toBeGreaterThan(0);
    const bin = result.files.find(f => f.target.endsWith('icon.png'))!;
    expect(bin.status).toBe('binary_skip');
  });
});

describe('runReferenceApply — --all is not supported', () => {
  it('throws when called with skillSlug: null', () => {
    const inbrainRoot = scratchGbrain();
    const ws = scratchWorkspace();
    expect(() =>
      runReferenceApply({ inbrainRoot, targetWorkspace: ws, skillSlug: null }),
    ).toThrow(/--all\+--apply-clean-hunks is intentionally not supported|apply one skill/);
  });
});
