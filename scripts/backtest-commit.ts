#!/usr/bin/env bun
/**
 * Commit backtest RUN DATA to a dedicated orphan branch, never to main.
 *
 * Run data and code have opposite lifecycles. Code is reviewed, bisected, and
 * read as history. Run data is append-only measurement that grows by a slice
 * every time free quota appears — dozens of large JSON commits that say nothing
 * about the software. Mixed into main they would drown `git log`, wreck
 * `git bisect`, and bloat every clone forever.
 *
 * So they live on an ORPHAN branch (`backtest-data`) with no shared history
 * with main. It is a filing cabinet in the same repo, not a fork of the code.
 *
 *   bun run scripts/backtest-commit.ts            # commit current run data
 *   bun run scripts/backtest-commit.ts --push     # …and push it
 *   bun run scripts/backtest-commit.ts --log      # show the data history
 *
 * The working tree is never touched: everything goes through a temporary index
 * and plumbing commands, so an in-flight edit on main cannot be disturbed and
 * there is no branch switch to get stuck halfway through.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BRANCH = "backtest-data";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Run a git command, returning trimmed stdout. Throws on non-zero exit. */
function git(...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (p.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${p.exitCode}): ${new TextDecoder().decode(p.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(p.stdout).trim();
}

/** Same, but returns null instead of throwing — for "does this exist" probes. */
function gitOk(...args: string[]): string | null {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (p.exitCode !== 0) return null;
  return new TextDecoder().decode(p.stdout).trim();
}

if (flag("log")) {
  const log = gitOk("log", "--oneline", "-30", BRANCH);
  if (log === null) {
    console.log(`[backtest-commit] no ${BRANCH} branch yet — nothing committed`);
    process.exit(0);
  }
  console.log(`[backtest-commit] ${BRANCH} history:\n`);
  console.log(log);
  process.exit(0);
}

// --- gather the artifacts ---------------------------------------------------
// Only measurement outputs. Snapshots are deliberately NOT included: they are a
// large, regenerable cache of public venue data (`backtest-fetch.ts` rebuilds
// them), and committing them would put tens of MB of price history into the
// repo to save one API call.
const ARTIFACTS = [
  ".backtest-results.json",
  ".backtest-results-blind.json",
  ".backtest-progress.json",
];

const present = ARTIFACTS.filter((f) => existsSync(join(ROOT, f)));
if (present.length === 0) {
  console.log("[backtest-commit] no run data on disk — nothing to commit");
  process.exit(0);
}

/** Summarise a results file for the commit message, so `git log` on the data
 *  branch is readable without checking anything out. */
function summarize(file: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, file), "utf-8")) as {
      model?: string;
      blind?: boolean;
      results?: Array<{ skipped?: boolean; forecast?: number; confidence?: number }>;
    };
    const rs = raw.results ?? [];
    const scorable = rs.filter(
      (r) =>
        !r.skipped &&
        Number.isFinite(r.forecast) &&
        !(r.forecast === 0.5 && (r.confidence ?? 1) <= 0.1),
    ).length;
    const lane = raw.blind ? "blind" : "priced";
    return `${lane}: ${scorable} scorable / ${rs.length} evaluated (${raw.model ?? "?"})`;
  } catch {
    return null;
  }
}

const summaries = present
  .filter((f) => f.startsWith(".backtest-results"))
  .map(summarize)
  .filter((s): s is string => s !== null);

// --- build a tree without touching the working tree or index ----------------
// A temporary index file keeps the real one untouched, so this is safe to run
// with uncommitted work in progress on main.
const tmpIndex = join(
  process.env.TEMP ?? process.env.TMPDIR ?? ROOT,
  `.backtest-index-${process.pid}`,
);
const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

function gitEnv(...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd: ROOT, env });
  if (p.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${p.exitCode}): ${new TextDecoder().decode(p.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(p.stdout).trim();
}

// Hash each artifact into the object store and stage it in the temp index.
// `--add --cacheinfo` writes an index entry directly; no checkout involved.
for (const file of present) {
  const hash = git("hash-object", "-w", join(ROOT, file));
  gitEnv("update-index", "--add", "--cacheinfo", `100644,${hash},${file}`);
}

const tree = gitEnv("write-tree");

// --- commit onto the orphan branch ------------------------------------------
const parent = gitOk("rev-parse", "--verify", `${BRANCH}^{commit}`);

// Nothing changed since the last data commit? Say so and stop — an
// opportunistic scheduler calls this every tick, and empty commits would bury
// the real ones.
if (parent) {
  const parentTree = gitOk("rev-parse", `${parent}^{tree}`);
  if (parentTree === tree) {
    console.log("[backtest-commit] run data unchanged since the last commit — nothing to do");
    process.exit(0);
  }
}

const totalBytes = present.reduce((n, f) => n + statSync(join(ROOT, f)).size, 0);
const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);

const message =
  `backtest run ${stamp}\n\n` +
  summaries.map((s) => `- ${s}`).join("\n") +
  `\n\nFiles: ${present.join(", ")} (${(totalBytes / 1024).toFixed(0)} KB)\n` +
  `Measurement data only — no source changes. See docs/eval/BACKTEST_METHODOLOGY.md on main.\n`;

const args = ["commit-tree", tree, "-m", message];
if (parent) args.push("-p", parent);
const commit = git(...args);

git("update-ref", `refs/heads/${BRANCH}`, commit);

console.log(`[backtest-commit] committed ${commit.slice(0, 8)} to ${BRANCH}`);
for (const s of summaries) console.log(`  ${s}`);
if (!parent) {
  console.log(`\n[backtest-commit] created ${BRANCH} as an orphan branch (no shared history with main)`);
}

if (flag("push")) {
  const remote = gitOk("remote", "get-url", "origin");
  if (!remote) {
    console.log("[backtest-commit] no origin remote — skipping push");
  } else {
    git("push", "origin", `${BRANCH}:${BRANCH}`);
    console.log(`[backtest-commit] pushed ${BRANCH} to origin`);
  }
} else {
  console.log(`\n[backtest-commit] not pushed. To publish: git push origin ${BRANCH}`);
}
