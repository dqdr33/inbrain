#!/usr/bin/env bun
/**
 * Run the backtest: replay resolved markets at past as-of dates and score the
 * forecasts against what actually happened.
 *
 *   bun run scripts/backtest-run.ts --offsets 30,90,180 --limit 40
 *   bun run scripts/backtest-run.ts --blind          # the control run
 *
 * ALWAYS read the blind run next to the priced run. A model that scores well
 * blind is recalling outcomes from training, not forecasting — and a priced run
 * on its own cannot tell you which of the two you are looking at.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { replayOne, type ReplayResult } from "../src/prediction/backtest/replay.ts";
import {
  scoreForecasts,
  scoreByGroup,
  horizonBucket,
  formatScorecard,
  type ForecastRecord,
} from "../src/prediction/scoring.ts";
import {
  asOfBeforeClose,
  type MarketSnapshot,
} from "../src/prediction/backtest/snapshot.ts";
import { loadKeyPool } from "./lib/gemini-keys.ts";
import { createLlmCall, DEFAULT_GEMINI_MODEL, formatUsage } from "./lib/llm.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const SNAP_PATH = join(import.meta.dir, "..", ".backtest-snapshots.json");
const blind = flag("blind");
const OUT_PATH = join(
  import.meta.dir,
  "..",
  `.backtest-results${blind ? "-blind" : ""}.json`,
);

if (!existsSync(SNAP_PATH)) {
  console.error(`[backtest] no snapshot file at ${SNAP_PATH} — run scripts/backtest-fetch.ts first`);
  process.exit(1);
}

const snapshots = JSON.parse(readFileSync(SNAP_PATH, "utf-8")) as MarketSnapshot[];
const offsets = (arg("offsets", "30,90,180") ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const limit = Number(arg("limit", "40"));
const model = arg("model", DEFAULT_GEMINI_MODEL)!;
const concurrency = Number(arg("concurrency", "4"));

// Same transport, same model, same key pool as the live cycle. A backtest run
// against a different model than production measures a system nobody ships.
const keyPool = loadKeyPool();
const llmCall = createLlmCall(keyPool, { model });

console.log(
  `[backtest] ${snapshots.length} snapshots | offsets=${offsets.join(",")}d | ` +
    `limit=${limit} | model=${model} | ${blind ? "BLIND (control)" : "priced"}`,
);

/** Build the full task list: every (market, offset) pair that is a legitimate
 *  forecasting target. Shuffling is deliberate — taking the first N of a
 *  volume-sorted list would sample only mega-markets, which are exactly the
 *  ones a model is most likely to remember. */
interface Task {
  snapshot: MarketSnapshot;
  asOf: Date;
  offset: number;
}
const tasks: Task[] = [];
for (const s of snapshots) {
  for (const offset of offsets) {
    tasks.push({ snapshot: s, asOf: asOfBeforeClose(s, offset), offset });
  }
}

// Deterministic shuffle so slices walk the SAME global order every time. This
// is what makes `--append` work: slice 2 continues where slice 1 stopped
// instead of re-sampling and repeating work already paid for.
let seed = 20260819;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
tasks.sort(() => rand() - 0.5);

/**
 * Append mode: keep results from earlier slices and only run tasks not yet
 * attempted. Without this an opportunistic scheduler would overwrite its own
 * progress on every tick and never accumulate a usable sample.
 *
 * Identity is the replay signal id (`backtest_<venue>_<market>_<as-of-date>`),
 * which `signalFromView` builds deterministically — the same market at the same
 * as-of date is the same forecast, so re-running it would just cost money.
 */
const append = flag("append");
let priorResults: ReplayResult[] = [];
if (append && existsSync(OUT_PATH)) {
  try {
    const prior = JSON.parse(readFileSync(OUT_PATH, "utf-8")) as { results?: ReplayResult[] };
    priorResults = Array.isArray(prior.results) ? prior.results : [];
  } catch {
    console.error(`[backtest] ${OUT_PATH} unreadable — starting a fresh results file`);
  }
}
const alreadyDone = new Set(priorResults.map((r) => r.record.id));

const pending = append
  ? tasks.filter(
      (t) =>
        !alreadyDone.has(
          `backtest_${t.snapshot.venue}_${t.snapshot.id}_${t.asOf.toISOString().slice(0, 10)}`,
        ),
    )
  : tasks;

const selected = pending.slice(0, limit);
console.log(
  `[backtest] ${tasks.length} candidate views` +
    (append ? ` | ${priorResults.length} already banked | ${pending.length} pending` : "") +
    ` → running ${selected.length}`,
);

if (selected.length === 0) {
  console.log("[backtest] nothing left to run — every candidate view is already banked");
  process.exit(0);
}

const results: ReplayResult[] = [];
let done = 0;
let skippedInvalid = 0;

/** Persist prior + this slice's results so far. Called after every chunk: an
 *  opportunistic run can be killed at any moment (quota, reboot, scheduler
 *  timeout), and forecasts already paid for must survive that. */
function bank(): void {
  writeFileSync(
    OUT_PATH,
    JSON.stringify({ model, blind, offsets, results: [...priorResults, ...results] }, null, 2),
    "utf-8",
  );
}

for (let i = 0; i < selected.length; i += concurrency) {
  const chunk = selected.slice(i, i + concurrency);
  const batch = await Promise.all(
    chunk.map(async (t) => {
      try {
        return await replayOne(t.snapshot, t.asOf, { llmCall, modelId: model, blind });
      } catch (err) {
        console.error(`\n[backtest] ${t.snapshot.id} @ ${t.offset}d failed: ${(err as Error).message}`);
        return null;
      }
    }),
  );
  for (const r of batch) {
    if (r === null) skippedInvalid++;
    else results.push(r);
  }
  done += chunk.length;
  bank();
  process.stderr.write(`\r[backtest] ${done}/${selected.length} evaluated          `);
}
process.stderr.write("\n");

// Score the COMBINED set: a slice of 20 says nothing on its own, and the point
// of appending is that the scorecard sharpens as slices accumulate.
const allResults = [...priorResults, ...results];
const scored = allResults.filter((r) => !r.skipped);
const records: ForecastRecord[] = scored.map((r) => r.record);

console.log(
  `[backtest] this slice: ${results.length} evaluated, ${skippedInvalid} invalid views`,
);
console.log(
  `[backtest] cumulative: ${scored.length} scored, ` +
    `${allResults.length - scored.length} unusable, ${allResults.length} total\n`,
);

if (records.length === 0) {
  // Not a failure under --append: an early slice can legitimately produce only
  // gate rejections, and the results are banked either way. Exiting non-zero
  // would make a scheduler treat a normal tick as a broken run.
  console.log("[backtest] nothing scorable yet — banked for the next slice");
  process.exit(0);
}

const card = scoreForecasts(records);
console.log(formatScorecard(card, blind ? "BLIND control run" : "Backtest (priced)"));

console.log("\n\nBy horizon:");
for (const [bucket, sub] of [...scoreByGroup(records, horizonBucket)].sort()) {
  console.log(`\n${formatScorecard(sub, `  ${bucket}`)}`);
}

bank();
console.log(`\n[backtest] wrote ${OUT_PATH} (${allResults.length} forecast(s) banked)`);
console.log(`[backtest] gemini usage: ${formatUsage(llmCall.usage())}`);
