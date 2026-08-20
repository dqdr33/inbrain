/**
 * Historical market snapshots — the ground truth a backtest scores against.
 *
 * A snapshot is one resolved market plus its price history, frozen so a
 * retrodiction can be replayed deterministically. The whole point is that
 * NOTHING here is fetched at scoring time: a backtest that hits the network
 * mid-run can silently pick up post-resolution information, and the resulting
 * score is unfalsifiable.
 *
 * The as-of discipline lives in one function, `priceAsOf`, and it is
 * deliberately strict: it will return null rather than guess. Every softening
 * of that rule ("just take the nearest point", "fall back to the first price")
 * is a lookahead leak wearing a convenience costume.
 */

/** One point on a market's price curve. */
export interface PricePoint {
  /** Unix seconds. */
  t: number;
  /** P(YES) at that moment, 0-1. */
  p: number;
}

/** A resolved market, with enough history to ask "what did this look like on
 *  date D?" and enough truth to score the answer. */
export interface MarketSnapshot {
  /** Venue-native id. */
  id: string;
  venue: "polymarket" | "kalshi";
  question: string;
  /** Resolution rules as published by the venue, when available. Carried so a
   *  replay can show the model the same criteria a live run would see. */
  description?: string;
  slug?: string;
  /** When the market opened for trading. A forecast dated before this had no
   *  market to forecast. */
  createdAt: string;
  /** The venue's stated close date. */
  endDate: string;
  /** When it actually settled. */
  closedTime?: string;
  /** Ground truth. `true` = resolved YES. */
  outcome: boolean;
  /** Total traded volume — the liquidity filter's input. */
  volume: number;
  /** Ascending by `t`. May be empty for illiquid markets. */
  history: PricePoint[];
  /** Category label from the venue, where it has one. */
  category?: string;
}

/** A market replayed at one as-of date: what a forecaster could have known. */
export interface SnapshotView {
  snapshot: MarketSnapshot;
  /** The as-of instant this view was taken at. */
  asOf: Date;
  /** Venue price at `asOf`. */
  marketPrice: number;
  /** Days from `asOf` to the market's close. Always > 0 for a valid view. */
  horizonDays: number;
}

/**
 * Market price as of an instant — the last trade AT OR BEFORE it.
 *
 * Returns null rather than approximating when:
 *   - the history is empty
 *   - `asOf` predates the first recorded price
 *
 * Both cases mean "we do not know what this market was worth then", and the
 * only safe answer is to exclude the market from that as-of cohort. Returning
 * the first known price instead would import a price set AFTER the as-of date
 * — the exact leak this module exists to prevent.
 *
 * History is assumed ascending by `t` (the venue returns it that way and
 * `buildSnapshot` sorts defensively).
 */
export function priceAsOf(history: PricePoint[], asOf: Date): number | null {
  if (history.length === 0) return null;
  const cutoff = Math.floor(asOf.getTime() / 1000);

  // Binary search for the rightmost point with t <= cutoff.
  let lo = 0;
  let hi = history.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid]!.t <= cutoff) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (found === -1) return null; // asOf predates every recorded price
  const p = history[found]!.p;
  return Number.isFinite(p) ? p : null;
}

/**
 * Take a view of a market at an as-of date, or null if the market is not a
 * legitimate forecasting target then.
 *
 * Four rejections, each closing a distinct way a backtest flatters itself:
 *
 *  1. `asOf` is at or after the close — the outcome is known or imminent.
 *  2. `asOf` predates market creation — nothing existed to forecast.
 *  3. No price is known at `asOf` — see `priceAsOf`.
 *  4. The horizon is under `minHorizonDays` — a market closing in hours is a
 *     settlement formality, not a prediction. Its price is already ~0 or ~1,
 *     so including these manufactures spectacular fake accuracy.
 */
export function viewAsOf(
  snapshot: MarketSnapshot,
  asOf: Date,
  opts: { minHorizonDays?: number } = {},
): SnapshotView | null {
  const minHorizon = opts.minHorizonDays ?? 3;

  const end = new Date(snapshot.endDate);
  const created = new Date(snapshot.createdAt);
  if (Number.isNaN(end.getTime()) || Number.isNaN(created.getTime())) return null;

  if (asOf.getTime() >= end.getTime()) return null;
  if (asOf.getTime() < created.getTime()) return null;

  const horizonDays = (end.getTime() - asOf.getTime()) / 86_400_000;
  if (horizonDays < minHorizon) return null;

  const marketPrice = priceAsOf(snapshot.history, asOf);
  if (marketPrice === null) return null;

  return { snapshot, asOf, marketPrice, horizonDays };
}

/**
 * Polymarket settles a binary market to outcomePrices of exactly ["1","0"] or
 * ["0","1"]. Anything else — a 50-50 void, an unresolved dispute, a
 * multi-outcome market — has no binary ground truth and must not be scored.
 *
 * Returning null for the ambiguous cases is load-bearing: a 50-50 void coerced
 * to `false` would be counted as a NO the model was "wrong" about, poisoning
 * the calibration curve with events that never actually happened either way.
 */
export function parseBinaryOutcome(outcomePrices: unknown): boolean | null {
  let arr: unknown = outcomePrices;
  if (typeof outcomePrices === "string") {
    try {
      arr = JSON.parse(outcomePrices);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr) || arr.length !== 2) return null;

  const a = Number(arr[0]);
  const b = Number(arr[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  // Settled markets are exactly 1/0. Allow a hair of float slop, but reject
  // anything genuinely mid-range (an unresolved or voided market).
  const EPS = 1e-6;
  if (Math.abs(a - 1) < EPS && Math.abs(b) < EPS) return true;
  if (Math.abs(a) < EPS && Math.abs(b - 1) < EPS) return false;
  return null;
}

/** Sort history ascending and drop unusable points. The venue is usually
 *  well-behaved; `priceAsOf`'s binary search is not, if it is not. */
export function normalizeHistory(raw: unknown): PricePoint[] {
  if (!Array.isArray(raw)) return [];
  const out: PricePoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = Number((item as Record<string, unknown>).t);
    const p = Number((item as Record<string, unknown>).p);
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    // A probability outside [0,1] is corrupt, not clampable — a 1.4 would
    // become a confident YES and score as if the market said so.
    if (p < 0 || p > 1) continue;
    out.push({ t, p });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Standard as-of offsets, in days before a reference date. Mirrors the
 *  horizons the user asked to test: 1/2/3/6/9/12 months back. */
export const AS_OF_OFFSETS_DAYS = [30, 60, 90, 180, 270, 365] as const;

/** The as-of date that sits `days` before a market's close. Backtesting
 *  relative to CLOSE rather than to a wall-clock date is what makes the
 *  horizon buckets comparable across markets that closed at different times. */
export function asOfBeforeClose(snapshot: MarketSnapshot, days: number): Date {
  return new Date(new Date(snapshot.endDate).getTime() - days * 86_400_000);
}
