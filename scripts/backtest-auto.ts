#!/usr/bin/env bun
/**
 * Opportunistic backtest runner — runs only when free Gemini quota exists.
 *
 * The backtest is never urgent: it scores history, and history does not move.
 * What it must never do is bill the paid key, which is held in reserve for the
 * live prediction cycle. So this script's whole job is to decide "is there free
 * capacity right now?" and to exit quietly when the answer is no.
 *
 * Designed to be safe under a scheduler (cron / Task Scheduler / `/loop`):
 * every exit path is idempotent, a run in progress is not duplicated, and
 * partial progress is banked so a killed run resumes instead of restarting.
 *
 *   bun run scripts/backtest-auto.ts              # run a slice if quota allows
 *   bun run scripts/backtest-auto.ts --status     # report, change nothing
 *   bun run scripts/backtest-auto.ts --budget 40  # cap calls this slice
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadKeyPool } from "./lib/gemini-keys.ts";
import { acquireLock, LockBusyError } from "./lib/run-lock.ts";

const ROOT = join(import.meta.dir, "..");
const PROGRESS_PATH = join(ROOT, ".backtest-progress.json");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Which lane still needs work.
 *
 * The blind control matters more than extra priced samples: without it the
 * priced numbers cannot be distinguished from memorised outcomes, so a fresh
 * blind slice is always worth more than another priced one.
 */
type Lane = "blind" | "priced";

interface Progress {
  /** Forecasts banked per lane. */
  done: Record<Lane, number>;
  /** Target per lane; the runner stops when both are met. */
  target: number;
  lastRunAt: string;
  lastOutcome: string;
  /** Consecutive slices that ended with no free quota. Purely informational —
   *  it tells a human reading the log that the scheduler is alive and waiting,
   *  not that something is broken. */
  quotaWaits: number;
}

const EMPTY: Progress = {
  done: { blind: 0, priced: 0 },
  target: 90,
  lastRunAt: new Date(0).toISOString(),
  lastOutcome: "never run",
  quotaWaits: 0,
};

function loadProgress(): Progress {
  if (!existsSync(PROGRESS_PATH)) return { ...EMPTY, done: { ...EMPTY.done } };
  try {
    const p = JSON.parse(readFileSync(PROGRESS_PATH, "utf-8")) as Partial<Progress>;
    return {
      done: {
        blind: Number(p.done?.blind) || 0,
        priced: Number(p.done?.priced) || 0,
      },
      target: Number(p.target) || EMPTY.target,
      lastRunAt: typeof p.lastRunAt === "string" ? p.lastRunAt : EMPTY.lastRunAt,
      lastOutcome: typeof p.lastOutcome === "string" ? p.lastOutcome : EMPTY.lastOutcome,
      quotaWaits: Number(p.quotaWaits) || 0,
    };
  } catch {
    // A corrupt progress file must not wedge the scheduler forever.
    console.error("[backtest-auto] progress file unreadable — starting fresh");
    return { ...EMPTY, done: { ...EMPTY.done } };
  }
}

function saveProgress(p: Progress): void {
  writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2), "utf-8");
}

/** Count forecasts already banked in a lane's results file. */
function bankedCount(blind: boolean): number {
  const p = join(ROOT, `.backtest-results${blind ? "-blind" : ""}.json`);
  if (!existsSync(p)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as { results?: unknown[] };
    return Array.isArray(parsed.results) ? parsed.results.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Is there free (non-billing) capacity right now?
 *
 * `loadKeyPool()` throws when every key is marked spent for the quota day, and
 * exposes whether the key it settled on bills to a card. Both are refusals: the
 * paid key exists for the live cycle, and a backtest that quietly spends it
 * turns a free background task into a recurring charge.
 */
function freeCapacity(): { ok: true; label: string } | { ok: false; reason: string } {
  let pool: ReturnType<typeof loadKeyPool>;
  try {
    pool = loadKeyPool();
  } catch (err) {
    return { ok: false, reason: (err as Error).message.split("\n")[0]! };
  }
  if (pool.activeIsPaid()) {
    return {
      ok: false,
      reason: `only the paid key is available (${pool.activeLabel()}) — held in reserve for the live cycle`,
    };
  }
  return { ok: true, label: pool.activeLabel() };
}

const progress = loadProgress();
progress.done.blind = Math.max(progress.done.blind, bankedCount(true));
progress.done.priced = Math.max(progress.done.priced, bankedCount(false));

// --- status: report and exit, touching nothing ------------------------------
if (flag("status")) {
  const cap = freeCapacity();
  console.log("[backtest-auto] status");
  console.log(`  blind   ${progress.done.blind}/${progress.target}`);
  console.log(`  priced  ${progress.done.priced}/${progress.target}`);
  console.log(`  quota   ${cap.ok ? `free (${cap.label})` : `unavailable — ${cap.reason}`}`);
  console.log(`  last    ${progress.lastRunAt} — ${progress.lastOutcome}`);
  if (progress.quotaWaits > 0) console.log(`  waits   ${progress.quotaWaits} slice(s) skipped for quota`);
  process.exit(0);
}

// --- pick the lane ----------------------------------------------------------
const lane: Lane | null =
  progress.done.blind < progress.target
    ? "blind"
    : progress.done.priced < progress.target
      ? "priced"
      : null;

if (lane === null) {
  console.log(
    `[backtest-auto] both lanes complete (${progress.done.blind} blind, ` +
      `${progress.done.priced} priced) — nothing to do`,
  );
  progress.lastOutcome = "complete";
  saveProgress(progress);
  process.exit(0);
}

// --- quota gate -------------------------------------------------------------
const cap = freeCapacity();
if (!cap.ok) {
  progress.quotaWaits++;
  progress.lastRunAt = new Date().toISOString();
  progress.lastOutcome = `waiting for quota: ${cap.reason}`;
  saveProgress(progress);
  console.log(`[backtest-auto] no free quota — ${cap.reason}`);
  console.log("[backtest-auto] nothing spent; will retry on the next slice");
  process.exit(0);
}

// --- run one slice ----------------------------------------------------------
// Slices are small on purpose: a free key carries a daily request budget shared
// with the live prediction cycle, and the live cycle has priority. Twenty
// forecasts is ~40 calls, which leaves the day's budget largely intact.
const budget = Number(arg("budget", "20"));
const remaining = progress.target - progress.done[lane];
const sliceSize = Math.min(budget, remaining);

console.log(
  `[backtest-auto] free quota on ${cap.label} — running ${sliceSize} ${lane} forecast(s) ` +
    `(${progress.done[lane]}/${progress.target} banked)`,
);

// The run lock is what makes this safe under a scheduler: a slice that outlives
// its interval must not have a second copy started on top of it.
let release: () => void;
try {
  release = acquireLock("backtest-auto", { staleAfterMs: 90 * 60_000 });
} catch (err) {
  if (err instanceof LockBusyError) {
    console.log("[backtest-auto] another slice is already running — skipping this tick");
    process.exit(0);
  }
  throw err;
}

let exitCode: number;
try {
  const args = [
    "run",
    join(ROOT, "scripts", "backtest-run.ts"),
    "--limit",
    String(sliceSize),
    "--offsets",
    arg("offsets", "30,90,180")!,
    "--concurrency",
    arg("concurrency", "3")!,
    "--append",
  ];
  if (lane === "blind") args.push("--blind");

  const proc = Bun.spawn(["bun", ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  exitCode = await proc.exited;
} finally {
  release();
}

const banked = bankedCount(lane === "blind");
const gained = banked - progress.done[lane];
progress.done[lane] = banked;
progress.lastRunAt = new Date().toISOString();
progress.quotaWaits = 0;
progress.lastOutcome =
  exitCode === 0
    ? `${lane}: +${gained} forecast(s), ${banked}/${progress.target}`
    : `${lane}: run exited ${exitCode} after +${gained}`;
saveProgress(progress);

console.log(`[backtest-auto] ${progress.lastOutcome}`);
process.exit(exitCode === 0 ? 0 : 1);
