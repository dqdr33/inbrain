/**
 * The learning set — what the calibration loop is allowed to learn from.
 *
 * This module exists because the pipeline was learning from its own guesses.
 * Of 96 resolved markets, 83 carried `resolvedBy: "auto"`, meaning no exchange
 * ever confirmed the outcome: the LLM was asked what happened and answered from
 * a brain that holds no news. Fitting a calibration curve on those is fitting
 * the auto-resolver's coin flip, and the "overconfidence" it reports (claimed
 * 97.8%, observed 55.9% in the top bin) is mostly that coin, not the estimator.
 *
 * So the rule is structural rather than advisory: only ORACLE_GRADE outcomes —
 * venue-confirmed settlements and human adjudications — plus backtest records
 * (which replay against known venue outcomes) may ever reach `fitCalibration`.
 * The `auto` rows are still returned, separately, because they are worth
 * reporting; they are simply not evidence about our own probabilities.
 *
 * Pure functions over already-loaded data: no clock, no network, no I/O.
 */

import type { ForecastRecord } from "./scoring.js";
import type { MarketResolution, PredictionMarket } from "./types.js";

/**
 * Outcomes trustworthy enough to train on.
 *
 * `oracle` is a venue settlement (Polymarket/Kalshi reported it). `manual` is a
 * human adjudication. `auto` — an LLM's guess at what happened — is excluded by
 * its absence, which is the whole point of naming the set.
 */
export const ORACLE_GRADE: ReadonlySet<MarketResolution["resolvedBy"]> = new Set([
  "oracle",
  "manual",
]);

/** The legacy parse-failure answer from `generateEstimate`'s catch block: 0.5 at
 *  confidence <= 0.1. It is not a forecast, and admitting it would let upstream
 *  breakage read as a mediocre-but-working mid-range prediction.
 *
 *  Kept for rows already in the state and in saved backtest runs. New failures
 *  carry `estimateFailed` and confidence 0 instead, which is the check that
 *  matters: the fallback now uses the venue price where one exists, so the
 *  forecast is no longer reliably 0.5 and cannot be recognised by its value. */
const FALLBACK_FORECAST = 0.5;
const FALLBACK_CONFIDENCE_MAX = 0.1;

export interface LearningSet {
  /** Oracle-grade records. The ONLY input `fitCalibration` may see. */
  records: ForecastRecord[];
  /** LLM-resolved records: reported for transparency, never fitted. */
  excludedAuto: ForecastRecord[];
  /** How many of `records` carry a venue price — the denominator for any
   *  skill-vs-market claim, which is the metric that maps to profitability. */
  pricedCount: number;
  sources: { live: number; backtest: number };
}

/** Minimal shape this module needs from a saved backtest run, declared
 *  structurally so it does not drag the replay module's imports along. */
export interface BacktestRunLike {
  results: Array<{
    record: ForecastRecord;
    forecast: number;
    confidence: number;
    skipped: boolean;
  }>;
}

function finite(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function toDate(x: unknown): Date | undefined {
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? undefined : x;
  if (typeof x === "string") {
    const d = new Date(x);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/**
 * Convert one resolved market into a scorable record, or null when it is not
 * evidence about our calibration.
 *
 * The forecast is read from `aiEstimate.rawYesProbability` when present — the
 * pre-calibration model output. Training on the post-calibration number would
 * compound the correction nightly (0.55 -> 0.45 -> 0.38 -> ... -> base rate),
 * which looks like learning while destroying sharpness. The `??` fallback is
 * what makes the pre-existing records correct: nothing was calibrated when they
 * were written, so their stored probability IS the raw one.
 */
function marketToRecord(market: PredictionMarket): ForecastRecord | null {
  const resolution = market.resolution;
  if (!resolution) return null;
  // A cancelled market has no ground truth to score against.
  if (resolution.outcome === "cancelled") return null;

  const meta = (market.metadata ?? {}) as Record<string, unknown>;
  const forecast =
    finite(market.aiEstimate?.rawYesProbability) ??
    finite(meta.rawYesProbability) ??
    finite(market.aiEstimate?.yesProbability);
  if (forecast === undefined) return null;

  // An explicitly-marked failure, whatever number sits beside it.
  if (market.aiEstimate?.estimateFailed) return null;

  const confidence = finite(market.aiEstimate?.confidence);
  // Zero confidence means the estimator declined. Training on it would teach the
  // calibration fit from a placeholder.
  if (confidence === 0) return null;
  if (
    forecast === FALLBACK_FORECAST &&
    confidence !== undefined &&
    confidence <= FALLBACK_CONFIDENCE_MAX
  ) {
    return null;
  }

  const createdAt = toDate(market.createdAt);
  const resolvedAt = toDate(resolution.resolvedAt) ?? toDate(market.resolvedAt);
  const horizonDays =
    createdAt && resolvedAt
      ? (resolvedAt.getTime() - createdAt.getTime()) / 86_400_000
      : undefined;

  return {
    id: market.id,
    forecast,
    outcome: resolution.outcome === "yes",
    // Written by BrainAgent.buildMarket from the venue quote the signal carried.
    // Absent stays absent: defaulting to 0.5 would invent a market price and
    // silently corrupt the one baseline that decides commercial value.
    marketPrice: finite(meta.crowdProbability),
    horizonDays: horizonDays !== undefined && horizonDays >= 0 ? horizonDays : undefined,
    group: market.category,
  };
}

/** Split resolved markets into what may teach and what may only be reported. */
export function recordsFromMarkets(markets: PredictionMarket[]): {
  oracle: ForecastRecord[];
  auto: ForecastRecord[];
} {
  const oracle: ForecastRecord[] = [];
  const auto: ForecastRecord[] = [];

  for (const market of markets) {
    const record = marketToRecord(market);
    if (!record) continue;
    if (ORACLE_GRADE.has(market.resolution!.resolvedBy)) oracle.push(record);
    else auto.push(record);
  }

  return { oracle, auto };
}

/**
 * Backtest rows are already `ForecastRecord`s scored against real venue
 * outcomes, so they are oracle-grade by construction. The skip rules mirror
 * `scripts/backtest-score.ts` exactly so a record counted there is counted here.
 */
export function recordsFromBacktest(run: BacktestRunLike | null | undefined): ForecastRecord[] {
  if (!run?.results) return [];
  return run.results
    .filter((r) => !r.skipped && Number.isFinite(r.forecast))
    .filter((r) => !(r.forecast === FALLBACK_FORECAST && r.confidence <= FALLBACK_CONFIDENCE_MAX))
    .map((r) => r.record)
    .filter((r) => r && Number.isFinite(r.forecast));
}

/** Build the honest learning set from live resolutions plus a backtest run. */
export function buildLearningSet(opts: {
  markets: PredictionMarket[];
  backtest?: BacktestRunLike | null;
}): LearningSet {
  const { oracle, auto } = recordsFromMarkets(opts.markets);
  const backtest = recordsFromBacktest(opts.backtest);
  const records = [...oracle, ...backtest];

  return {
    records,
    excludedAuto: auto,
    pricedCount: records.filter((r) => Number.isFinite(r.marketPrice ?? NaN)).length,
    sources: { live: oracle.length, backtest: backtest.length },
  };
}
