#!/usr/bin/env bun
/**
 * Re-score a completed backtest run from its saved results — no LLM calls.
 *
 * Separating scoring from running is what makes a metric fix cheap: a bug in
 * the scorecard costs one second to correct instead of a whole re-run, and the
 * forecasts stay fixed while the metric changes, so a before/after is a genuine
 * comparison rather than two different samples.
 *
 *   bun run scripts/backtest-score.ts
 *   bun run scripts/backtest-score.ts --blind
 *   bun run scripts/backtest-score.ts --compare
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  scoreForecasts,
  scoreByGroup,
  horizonBucket,
  formatScorecard,
  type ForecastRecord,
} from "../src/prediction/scoring.ts";
import type { ReplayResult } from "../src/prediction/backtest/replay.ts";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface RunFile {
  model: string;
  blind: boolean;
  offsets: number[];
  results: ReplayResult[];
}

const ROOT = join(import.meta.dir, "..");

function load(blind: boolean): RunFile | null {
  const p = join(ROOT, `.backtest-results${blind ? "-blind" : ""}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as RunFile;
}

/**
 * Re-derive records from the saved per-forecast rows.
 *
 * Deliberately NOT reading the saved `scorecard` block: that was computed by
 * whatever version of the scorer ran at the time, and the entire point of this
 * script is to apply the current one.
 */
function records(run: RunFile): ForecastRecord[] {
  return run.results
    .filter((r) => !r.skipped && Number.isFinite(r.forecast))
    // Results written before the fallback guard landed carry the parse-failure
    // answer (0.5 at confidence 0.1) as if it were a forecast. Apply the same
    // rule here so old and new result files score identically.
    .filter((r) => !(r.forecast === 0.5 && r.confidence <= 0.1))
    .map((r) => r.record);
}

/** Rows that are not forecasts: gate rejections plus parse-failure fallbacks
 *  under either the old or new on-disk shape. */
function unusableCount(run: RunFile): number {
  return run.results.filter(
    (r) => r.skipped || !Number.isFinite(r.forecast) || (r.forecast === 0.5 && r.confidence <= 0.1),
  ).length;
}

function report(run: RunFile, label: string): void {
  const recs = records(run);
  const gateSkipped = unusableCount(run);

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${label}  —  model=${run.model}  offsets=${run.offsets.join(",")}d`);
  console.log(`${"=".repeat(72)}\n`);
  console.log(
    `  ${run.results.length} evaluated, ${recs.length} scorable, ` +
      `${gateSkipped} unusable (gate rejection or unparseable estimate)\n`,
  );

  console.log(formatScorecard(scoreForecasts(recs), "Overall"));

  console.log("\n\nBy horizon:");
  for (const [bucket, card] of [...scoreByGroup(recs, horizonBucket)].sort()) {
    console.log(`\n${formatScorecard(card, `  ${bucket}`)}`);
  }
}

const priced = load(false);
const blind = load(true);

if (flag("compare")) {
  if (!priced || !blind) {
    console.error(
      "[backtest-score] --compare needs BOTH runs: " +
        `priced=${priced ? "ok" : "missing"} blind=${blind ? "ok" : "missing"}`,
    );
    process.exit(1);
  }

  report(priced, "PRICED (model sees the venue quote)");
  report(blind, "BLIND CONTROL (price withheld)");

  const p = scoreForecasts(records(priced));
  const b = scoreForecasts(records(blind));

  console.log(`\n${"=".repeat(72)}`);
  console.log("VERDICT");
  console.log(`${"=".repeat(72)}\n`);
  console.log(`  Priced Brier ${p.meanBrier.toFixed(4)}   Blind Brier ${b.meanBrier.toFixed(4)}`);
  console.log(
    `  Priced skill vs base rate ${p.skill.vsBaseRate.toFixed(4)}   ` +
      `Blind ${b.skill.vsBaseRate.toFixed(4)}\n`,
  );

  // The interpretation, stated so a reader cannot take the priced number alone.
  if (Number.isFinite(b.skill.vsBaseRate) && b.skill.vsBaseRate > 0.15) {
    console.log(
      "  ⚠  The blind run has REAL skill without seeing any price.\n" +
        "     On questions that resolved before the model's training cutoff this\n" +
        "     is the signature of recall, not forecasting. Treat the priced\n" +
        "     numbers as an upper bound and re-run on post-cutoff markets.",
    );
  } else {
    console.log(
      "  ✓  The blind run collapses toward the base rate, as it should.\n" +
        "     The priced run's edge comes from the market anchor rather than\n" +
        "     memorised outcomes — which is the honest reading.",
    );
  }

  if (p.skill.vsMarketPrice < 0) {
    console.log(
      `\n  ⚠  Skill vs market price is ${p.skill.vsMarketPrice.toFixed(3)} (negative).\n` +
        "     The model is WORSE than simply reading the venue quote. There is no\n" +
        "     betting edge here regardless of how good the raw Brier looks.",
    );
  }
} else {
  const blindMode = flag("blind");
  const run = blindMode ? blind : priced;
  if (!run) {
    console.error(
      `[backtest-score] no ${blindMode ? "blind" : "priced"} results file — run scripts/backtest-run.ts first`,
    );
    process.exit(1);
  }
  report(run, blindMode ? "BLIND CONTROL" : "PRICED");
}
