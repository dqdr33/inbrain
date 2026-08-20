#!/usr/bin/env bun
/**
 * Re-ask the venues about outcomes an LLM guessed, and sweep stuck markets.
 *
 * Two jobs, both about the honesty of the learning set:
 *
 *   1. UPGRADE. 83 of 96 stored resolutions carry `resolvedBy: "auto"` — the
 *      retired path where an LLM was asked what happened and answered from a
 *      brain holding no news. Those are excluded from calibration (see
 *      learning-set.ts), so each one the venue can actually settle converts a
 *      discarded row into a real training record.
 *
 *      Expect a small yield here: only 6 of the 83 came from a venue at all
 *      (76 are Telegram, 1 RSS), and a market with no `venueMarketId` has
 *      nothing to look up. That is a fact about the data, not a bug — and it is
 *      the reason the backtest, not this script, is the main path to a usable
 *      sample size.
 *
 *   2. SWEEP. Markets stuck in `pending_resolution` long past their deadline
 *      will never be settled by anyone: the non-venue sources publish no
 *      machine-readable outcome and no human is going to adjudicate them by
 *      hand. Left alone they inflate the active set forever. After
 *      STALE_AFTER_DAYS they are marked `cancelled`, which every scorer already
 *      excludes — this removes them from the backlog without inventing an
 *      outcome for them.
 *
 * Both steps are conservative: nothing is ever downgraded, no outcome is ever
 * guessed, and --dry-run shows exactly what would change.
 *
 *   bun run scripts/prediction-reresolve.ts --dry-run
 *   bun run scripts/prediction-reresolve.ts
 *   bun run scripts/prediction-reresolve.ts --no-sweep
 */

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadState, saveState, STATE_PATH } from "./lib/market-store.ts";
import { fetchVenueResolution } from "./lib/venue-settle.ts";
import { acquireLockOrExit, PIPELINE_LOCK } from "./lib/run-lock.ts";
import type { PredictionMarket } from "../src/prediction/types.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const NO_SWEEP = process.argv.includes("--no-sweep");

/** A pending market older than this is never going to settle. 90 days is well
 *  past any venue's dispute window, so nothing still resolvable is swept. */
const STALE_AFTER_DAYS = 90;

const REQUEST_GAP_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function daysSince(d: Date | undefined, now: Date): number {
  if (!d || Number.isNaN(d.getTime())) return 0;
  return (now.getTime() - d.getTime()) / 86_400_000;
}

function backupState(): void {
  if (DRY_RUN || !existsSync(STATE_PATH)) return;
  const dest = `${STATE_PATH}.bak-reresolve-${Date.now()}`;
  copyFileSync(STATE_PATH, dest);
  console.log(`[reresolve] state backed up to ${dest.split(/[\\/]/).pop()}`);
}

async function main(): Promise<void> {
  // Shares the pipeline lock: rewriting resolutions while the prediction cycle
  // is mid-flight would race its own saveState.
  acquireLockOrExit(PIPELINE_LOCK);

  const state = loadState();
  const now = new Date();

  console.log(
    `[reresolve] state: ${state.activeMarkets.length} active, ${state.resolvedMarkets.length} resolved`,
  );

  // ---- 1. Upgrade auto resolutions the venue can confirm -----------------
  const autoMarkets = state.resolvedMarkets.filter((m) => m.resolution?.resolvedBy === "auto");
  const lookupable = autoMarkets.filter(
    (m) => typeof m.metadata?.venueMarketId === "string" && m.metadata.venueMarketId,
  );

  console.log(
    `[reresolve] ${autoMarkets.length} auto resolution(s), ` +
      `${lookupable.length} carry a venue id and can be re-checked`,
  );

  let upgraded = 0;
  let corrected = 0;

  for (const market of lookupable) {
    const venueResolution = await fetchVenueResolution(market);
    await sleep(REQUEST_GAP_MS);
    if (!venueResolution) continue;

    const previous = market.resolution!.outcome;
    const settled = venueResolution.outcome;

    if (previous !== settled) {
      // The LLM's guess was wrong. Worth logging loudly: these are exactly the
      // rows that made the pooled accuracy figure meaningless.
      corrected++;
      console.log(
        `[reresolve] CORRECTED "${market.title.slice(0, 60)}": ` +
          `guessed ${previous.toUpperCase()}, venue settled ${settled.toUpperCase()}`,
      );
    }

    if (!DRY_RUN) {
      market.resolution = {
        outcome: settled,
        resolvedBy: "oracle",
        // VenueResolution carries single strings; the market record wants
        // arrays. Same shape execution-agent.ts writes on the venue path.
        evidence: [venueResolution.evidence],
        verificationSources: [venueResolution.source],
        resolvedAt: market.resolution!.resolvedAt,
      };
    }
    upgraded++;
  }

  // ---- 2. Sweep markets nothing will ever settle -------------------------
  let swept = 0;
  if (!NO_SWEEP) {
    const stuck = state.activeMarkets.filter(
      (m) => m.status === "pending_resolution" && daysSince(m.expiresAt, now) > STALE_AFTER_DAYS,
    );

    console.log(
      `[reresolve] ${stuck.length} market(s) pending longer than ${STALE_AFTER_DAYS} days`,
    );

    for (const market of stuck) {
      // Give the venue one last chance before writing it off.
      const venueResolution =
        typeof market.metadata?.venueMarketId === "string" && market.metadata.venueMarketId
          ? await fetchVenueResolution(market)
          : null;
      if (venueResolution) await sleep(REQUEST_GAP_MS);

      if (venueResolution) {
        if (!DRY_RUN) {
          market.status = "resolved";
          market.resolvedAt = now;
          market.resolution = {
            outcome: venueResolution.outcome,
            resolvedBy: "oracle",
            evidence: [venueResolution.evidence],
            verificationSources: [venueResolution.source],
            resolvedAt: now,
          };
          state.resolvedMarkets.push(market);
        }
        upgraded++;
        console.log(`[reresolve] late settlement: "${market.title.slice(0, 60)}"`);
        continue;
      }

      // No outcome is invented here. "cancelled" means "we never learned", and
      // every scorer already drops it rather than treating it as a NO.
      if (!DRY_RUN) {
        market.status = "cancelled";
        market.resolvedAt = now;
        market.resolution = {
          outcome: "cancelled",
          resolvedBy: "manual",
          evidence: [
            `No venue settlement ${STALE_AFTER_DAYS}+ days after the deadline; ` +
              `source "${market.metadata?.signalSource ?? "unknown"}" publishes no machine-readable outcome.`,
          ],
          verificationSources: [],
          resolvedAt: now,
        };
      }
      swept++;
    }

    if (!DRY_RUN && swept > 0) {
      const cancelled = new Set(
        state.activeMarkets.filter((m) => m.status === "cancelled").map((m) => m.id),
      );
      const settledLate = new Set(
        state.activeMarkets.filter((m) => m.status === "resolved").map((m) => m.id),
      );
      state.activeMarkets = state.activeMarkets.filter(
        (m: PredictionMarket) => !cancelled.has(m.id) && !settledLate.has(m.id),
      );
    }
  }

  console.log(
    `[reresolve] summary: ${upgraded} upgraded to oracle ` +
      `(${corrected} had the wrong outcome), ${swept} swept as cancelled`,
  );

  if (DRY_RUN) {
    console.log("[reresolve] dry run — no changes written");
    return;
  }

  if (upgraded === 0 && swept === 0) {
    console.log("[reresolve] nothing changed — state left untouched");
    return;
  }

  backupState();
  saveState(state);
  console.log(
    `[reresolve] saved: ${state.activeMarkets.length} active, ${state.resolvedMarkets.length} resolved`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`[reresolve] failed: ${(err as Error).message}`);
    process.exit(1);
  },
);
