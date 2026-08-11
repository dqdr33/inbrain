#!/usr/bin/env bun
/**
 * scripts/run-dream-cycle.ts — nightly self-evolution pass.
 *
 * Scores resolved markets with Brier, derives calibration rules from them, and
 * publishes those rules to the brain page the Brain Agent reads before every
 * evaluation. That last step is what closes the learning loop.
 *
 * The markets come from .prediction-state.json, written by
 * run-prediction-cycle.ts. Previously this script constructed DreamCycle
 * without getActiveMarkets/getResolvedMarkets, so both defaulted to `() => []`
 * and every phase operated on an empty list: Brier was never computed, the
 * meta-model returned early, and the calibration page was never produced.
 *
 * Usage:
 *   bun run scripts/run-dream-cycle.ts
 *   bun run scripts/run-dream-cycle.ts --dry-run
 */

import { DreamCycle } from "../src/prediction/dream-cycle.ts";
import { loadKeyPool } from "./lib/gemini-keys.ts";
import { createLlmCall, formatUsage } from "./lib/llm.ts";
import { brainQuery, brainWrite as brainWriteRaw } from "./lib/brain-cli.ts";
import { loadState } from "./lib/market-store.ts";
import { acquireLockOrExit, PIPELINE_LOCK } from "./lib/run-lock.ts";

const DRY_RUN = process.argv.includes("--dry-run");

const keyPool = loadKeyPool();
console.log(
  `[run-dream-cycle] key pool: ${keyPool.size()} key(s) ` +
    `(${keyPool.freeCount()} free, ${keyPool.paidCount()} paid reserve), starting on ${keyPool.activeLabel()}`,
);

const llmCall = createLlmCall(keyPool);

async function brainWrite(slug: string, content: string): Promise<void> {
  await brainWriteRaw(slug, content, { dryRun: DRY_RUN });
}

async function main(): Promise<void> {
  // Shares the prediction cycle's lock: reading markets while that run is
  // mid-flight yields a half-updated picture, and both draw on one API quota.
  acquireLockOrExit(PIPELINE_LOCK);

  const state = loadState();
  console.log(
    `[run-dream-cycle] state: ${state.activeMarkets.length} active, ${state.resolvedMarkets.length} resolved market(s)`,
  );

  if (state.resolvedMarkets.length === 0) {
    console.log(
      "[run-dream-cycle] no resolved markets yet — calibration will be published as " +
        '"not enough history", and Brier scoring is skipped.',
    );
  }

  const dreamCycle = new DreamCycle({
    brainQuery,
    brainWrite,
    llmCall,
    getActiveMarkets: () => state.activeMarkets,
    getResolvedMarkets: () => state.resolvedMarkets,
    maxRunTimeMinutes: 45,
  });

  const report = await dreamCycle.run();
  console.log(
    `[run-dream-cycle] completed ${report.id}: ${report.marketsReviewed} market(s) reviewed, ` +
      `${report.metaModelUpdates.length} calibration rule(s), ` +
      `${report.knowledgeGapsFilled.length}/${report.knowledgeGapsFound.length} gap(s) filled`,
  );
  console.log(`[run-dream-cycle] gemini usage: ${formatUsage(llmCall.usage())}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[run-dream-cycle] FATAL:", err);
    process.exit(1);
  },
);
