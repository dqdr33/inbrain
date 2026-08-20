/**
 * Shrinking toward the venue price — the step that decides profitability.
 *
 * Calibration fixes how wrong our numbers are. It does NOT fix losing to the
 * market, and those are different failures: a perfectly calibrated forecast can
 * still be worthless to a bettor if the exchange quote is closer to the truth.
 *
 * The backtest says exactly that. Over 75 records with real venue outcomes:
 *
 *     model Brier 0.0754   market-price Brier 0.0428   skill vs price -0.760
 *
 * The reliability bins say WHERE it goes wrong. The [0,0.1) bin holds 47 of 75
 * records with a gap of +0.0007 — that is the zone where the model essentially
 * agrees with the price, and it is fine there. The [0.5,0.6) bin holds 9 records
 * with a gap of -0.291: claimed ~55%, reality delivered ~26%. Almost all of the
 * error lives in the ~25 records where the model departs from the quote.
 *
 * So the correction is not a curve over probability, it is a rule about
 * DISTANCE FROM THE PRICE. Keep half of any departure, discard half:
 *
 *     d = raw - price
 *     p = price + sign(d) * max(0, |d| - FREE_DEPARTURE) * (1 - LAMBDA)
 *
 * lambda = 0.5 is an explicit prior, not a fitted parameter: the evidence is
 * that departures have been net value-destroying, so the defensible position is
 * that half of any departure is signal and half is noise. lambda = 1 (pure
 * price-following) is not the "safe" choice — it scores exactly 0 skill against
 * the price by construction and guarantees the pipeline never finds alpha.
 *
 * The deadband exists so the 47 well-calibrated records are untouched: a 0.01
 * disagreement is agreement, and squeezing it would damage the one zone that
 * currently works to fix a zone that does not. It also keeps the mapping
 * continuous at d = 0.
 */

/** Fraction of a departure discarded as noise. */
export const PRICE_SHRINK_LAMBDA = 0.5;

/** Departures at or below this are left entirely alone. */
export const FREE_DEPARTURE = 0.05;

export interface ShrinkResult {
  /** Input probability, post-calibration. */
  raw: number;
  price: number | undefined;
  /** What to publish. Equals `raw` when no price or inside the deadband. */
  shrunk: number;
  applied: boolean;
}

/**
 * Pull a probability toward the venue price.
 *
 * With no price there is nothing to shrink toward, so the forecast passes
 * through untouched — the honest behaviour, since the absence of a quote is
 * exactly the case where our own reading is all there is.
 */
export function shrinkTowardPrice(raw: number, price: number | undefined): ShrinkResult {
  if (!Number.isFinite(raw) || price === undefined || !Number.isFinite(price)) {
    return { raw, price, shrunk: raw, applied: false };
  }

  const d = raw - price;
  const magnitude = Math.abs(d);
  if (magnitude <= FREE_DEPARTURE) {
    return { raw, price, shrunk: raw, applied: false };
  }

  const kept = (magnitude - FREE_DEPARTURE) * (1 - PRICE_SHRINK_LAMBDA);
  const shrunk = price + Math.sign(d) * kept;

  // Clamp into the interval spanned by the two inputs. The formula cannot
  // overshoot analytically, but floating point at the extremes should never be
  // able to produce a probability outside [0,1].
  const lo = Math.min(raw, price);
  const hi = Math.max(raw, price);
  return { raw, price, shrunk: Math.min(hi, Math.max(lo, shrunk)), applied: true };
}
