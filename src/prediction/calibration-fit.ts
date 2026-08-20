/**
 * Fitting the calibration mapping — the numeric half of the feedback loop.
 *
 * Before this module, "self-learning" meant asking an LLM to eyeball 30 lines of
 * `Predicted 90% | Actual YES` and write prose aphorisms into a brain page. That
 * is not a correction; it is a vibe. This module fits an actual mapping from
 * claimed probability to observed frequency, on oracle-grade outcomes only, and
 * hands back something `applyCalibration` can apply deterministically.
 *
 * THE GOVERNING CONSTRAINT IS SAMPLE SIZE, NOT ALGORITHM CHOICE.
 *
 * The honest learning set is ~88 records. Ten reliability bins over 88 points is
 * ~9 points per bin. The worst-looking bin ([0.5,0.6), gap -0.291) holds nine
 * observations — an unregularised isotonic fit would map 0.55 -> 0.26 on nine
 * coin flips and, by monotonicity, drag everything above it down too. That is
 * not learning; it is memorising noise and calling it calibration.
 *
 * So: Platt (two parameters, cannot overfit a 9-point cell) until n >= 200, and
 * even then five stacked guards. The default behaviour on thin or degenerate
 * data is IDENTITY — a system that correctly declines to adjust is working
 * correctly, and that is the outcome this module is biased toward.
 */

import { isotonicFit } from "./monotonic.js";
import {
  expectedCalibrationError,
  reliabilityBins,
  type ForecastRecord,
} from "./scoring.js";

export type CalibrationMethod = "identity" | "platt" | "isotonic";

export interface CalibrationFit {
  method: CalibrationMethod;
  /** p' = sigmoid(a * logit(p) + b). Identity is exactly (1, 0). */
  a: number;
  b: number;
  /** Isotonic knots, ascending in x. Present only for method "isotonic". */
  knots?: Array<{ x: number; y: number }>;
  n: number;
  /** Sample-size shrinkage actually applied, 0..1. */
  shrink: number;
  fittedAt: string;
  /** Why this fit is what it is — including why it declined to adjust. */
  rationale: string;
}

/**
 * Below this, return identity.
 *
 * Set to 150 by MEASUREMENT, not by theory. Fitting Platt on the real 82-record
 * learning set produced a = 0.911, b = 0.044 — an adjustment inside the noise —
 * and a deterministic 70/30 holdout showed it actively hurting the records it
 * had not seen (out-of-sample ECE 0.2339 -> 0.2412, skill vs price -1.99 ->
 * -2.08). The in-sample ECE gate passed it (0.0911 -> 0.0881) precisely because
 * in-sample improvement is what an overfit looks like.
 *
 * The plan's original 40 was reasoned from "~20 events per parameter". The data
 * disagreed, so the threshold moved rather than the conclusion being explained
 * away. At a ~0.21 base rate, 150 records carry ~30 YES, which is the point at
 * which a two-parameter fit stops being a rumour.
 *
 * Until then the mapping is identity and `shrink.ts` does the real work — which
 * is the honest division of labour, since the measured problem is distance from
 * the market price, not the shape of the probability scale.
 */
export const MIN_FIT_SAMPLES = 150;

/** Isotonic needs enough mass per bin to be signal. At 200 records and 10 bins
 *  that is ~20 per bin — thin, but no longer pure noise. */
export const ISOTONIC_MIN_SAMPLES = 200;

/** Each class needs this many observations before a slope is meaningful.
 *  Separable data (all YES or all NO) sends the MLE slope to infinity. */
export const MIN_PER_CLASS = 5;

/** a is clipped to [1 - MAX_SLOPE_DEVIATION, 1 + MAX_SLOPE_DEVIATION]. */
export const MAX_SLOPE_DEVIATION = 0.5;

/** b is clipped to [-MAX_INTERCEPT, MAX_INTERCEPT] — about +/-0.25 at p = 0.5. */
export const MAX_INTERCEPT = 1.0;

/** Records needed for shrink to reach full strength. */
export const FULL_STRENGTH_SAMPLES = 200;

/** L2 pull toward (a=1, b=0). This is the prior that stops a 9-point bin from
 *  moving the slope; it is doing more work here than the optimiser is. */
export const RIDGE_LAMBDA = 2.0;

const IRLS_ITERATIONS = 50;

/** Matches `scoring.ts` so a probability clamps identically on both sides of
 *  the loop — otherwise logit(0) is -Infinity and the fit dies on one record. */
const EPS = 1e-6;

function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - EPS, Math.max(EPS, p));
}

function logit(p: number): number {
  const c = clampProb(p);
  return Math.log(c / (1 - c));
}

function sigmoid(z: number): number {
  // Branch to avoid overflow of exp() on large |z|.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export const IDENTITY_FIT: CalibrationFit = {
  method: "identity",
  a: 1,
  b: 0,
  n: 0,
  shrink: 0,
  fittedAt: new Date(0).toISOString(),
  rationale: "identity (no fit)",
};

function identity(n: number, rationale: string): CalibrationFit {
  return { ...IDENTITY_FIT, n, fittedAt: new Date().toISOString(), rationale };
}

/**
 * Apply the mapping.
 *
 * A non-finite input is returned UNCHANGED rather than clamped to 0.5. A NaN
 * probability is a broken upstream estimate; laundering it into a plausible
 * mid-range number is how a pipeline failure comes to read as a forecast.
 */
export function applyCalibration(p: number, fit: CalibrationFit): number {
  if (!Number.isFinite(p)) return p;
  if (fit.method === "identity") return p;

  if (fit.method === "isotonic" && fit.knots && fit.knots.length > 0) {
    return interpolateKnots(p, fit.knots);
  }

  return sigmoid(fit.a * logit(p) + fit.b);
}

/** Piecewise-linear interpolation between isotonic knots, flat outside them. */
function interpolateKnots(p: number, knots: Array<{ x: number; y: number }>): number {
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  if (p <= first.x) return first.y;
  if (p >= last.x) return last.y;

  for (let i = 1; i < knots.length; i++) {
    const lo = knots[i - 1]!;
    const hi = knots[i]!;
    if (p <= hi.x) {
      const span = hi.x - lo.x;
      if (span <= 0) return hi.y;
      const t = (p - lo.x) / span;
      return lo.y + t * (hi.y - lo.y);
    }
  }
  return last.y;
}

/** Ridge-regularised IRLS for the two-parameter Platt model. */
function fitPlatt(records: ForecastRecord[]): { a: number; b: number; converged: boolean } {
  const x = records.map((r) => logit(r.forecast));
  const y = records.map((r) => (r.outcome ? 1 : 0));

  let a = 1;
  let b = 0;

  for (let iter = 0; iter < IRLS_ITERATIONS; iter++) {
    // Gradient and Hessian of the penalised negative log-likelihood.
    let g0 = 0;
    let g1 = 0;
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;

    for (let i = 0; i < x.length; i++) {
      const xi = x[i]!;
      const mu = sigmoid(a * xi + b);
      const resid = mu - y[i]!;
      // Floor the weight: mu(1-mu) underflows to 0 at saturation and would
      // make the Hessian singular exactly where the fit is most extreme.
      const w = Math.max(mu * (1 - mu), 1e-9);

      g0 += resid * xi;
      g1 += resid;
      h00 += w * xi * xi;
      h01 += w * xi;
      h11 += w;
    }

    // Ridge toward (1, 0), not toward (0, 0): the null hypothesis is "already
    // calibrated", so the penalty must pull the slope to 1, not flatten it.
    g0 += RIDGE_LAMBDA * (a - 1);
    g1 += RIDGE_LAMBDA * b;
    h00 += RIDGE_LAMBDA;
    h11 += RIDGE_LAMBDA;

    const det = h00 * h11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      return { a, b, converged: false };
    }

    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;

    a -= da;
    b -= db;

    if (!Number.isFinite(a) || !Number.isFinite(b)) return { a: 1, b: 0, converged: false };
    if (Math.abs(da) < 1e-10 && Math.abs(db) < 1e-10) return { a, b, converged: true };
  }

  return { a, b, converged: true };
}

/** Isotonic knots from reliability bins: claimed -> observed, made monotone. */
function fitIsotonicKnots(records: ForecastRecord[]): Array<{ x: number; y: number }> {
  const bins = reliabilityBins(records, 10).filter((bin) => bin.count > 0);
  if (bins.length === 0) return [];

  const values = bins.map((bin) => bin.observedFrequency);
  const weights = bins.map((bin) => bin.count);
  const smoothed = isotonicFit(values, weights);

  return bins.map((bin, i) => ({ x: bin.meanForecast, y: smoothed[i]! }));
}

/**
 * Fit a calibration mapping, or decline to.
 *
 * Every early return here is a feature: identity means "this data cannot
 * support a correction", which is a true and useful answer.
 */
export function fitCalibration(records: ForecastRecord[]): CalibrationFit {
  const clean = records.filter((r) => Number.isFinite(r.forecast));
  const n = clean.length;

  if (n < MIN_FIT_SAMPLES) {
    return identity(n, `n=${n} < ${MIN_FIT_SAMPLES}; identity mapping`);
  }

  const yesCount = clean.filter((r) => r.outcome).length;
  const noCount = n - yesCount;
  if (yesCount < MIN_PER_CLASS || noCount < MIN_PER_CLASS) {
    return identity(
      n,
      `only ${yesCount} YES / ${noCount} NO (need ${MIN_PER_CLASS} each); ` +
        `near-separable data has no finite slope; identity mapping`,
    );
  }

  const eceBefore = expectedCalibrationError(clean, 10);
  const shrink = Math.min(1, n / FULL_STRENGTH_SAMPLES);
  const notes: string[] = [];

  const useIsotonic = n >= ISOTONIC_MIN_SAMPLES;
  let candidate: CalibrationFit;

  if (useIsotonic) {
    const knots = fitIsotonicKnots(clean);
    if (knots.length < 2) {
      return identity(n, `isotonic needs >= 2 populated bins, got ${knots.length}; identity`);
    }
    // Shrink each knot toward the identity line y = x by the same rule Platt
    // uses, so the two methods are equally conservative at the same n.
    const shrunk = knots.map((k) => ({ x: k.x, y: k.x + shrink * (k.y - k.x) }));
    candidate = {
      method: "isotonic",
      a: 1,
      b: 0,
      knots: shrunk,
      n,
      shrink,
      fittedAt: new Date().toISOString(),
      rationale: `isotonic over ${knots.length} populated bins (n=${n} >= ${ISOTONIC_MIN_SAMPLES})`,
    };
  } else {
    const { a: rawA, b: rawB, converged } = fitPlatt(clean);
    if (!converged) {
      return identity(n, `Platt IRLS did not converge (singular Hessian); identity mapping`);
    }

    const loA = 1 - MAX_SLOPE_DEVIATION;
    const hiA = 1 + MAX_SLOPE_DEVIATION;
    const clippedA = Math.min(hiA, Math.max(loA, rawA));
    const clippedB = Math.min(MAX_INTERCEPT, Math.max(-MAX_INTERCEPT, rawB));

    if (clippedA !== rawA) {
      notes.push(`slope clipped ${rawA.toFixed(3)} -> ${clippedA.toFixed(3)}`);
    }
    if (clippedB !== rawB) {
      notes.push(`intercept clipped ${rawB.toFixed(3)} -> ${clippedB.toFixed(3)}`);
    }

    candidate = {
      method: "platt",
      a: 1 + shrink * (clippedA - 1),
      b: shrink * clippedB,
      n,
      shrink,
      fittedAt: new Date().toISOString(),
      rationale:
        `Platt on ${n} oracle-grade records (shrink ${shrink.toFixed(2)})` +
        (notes.length ? `; ${notes.join("; ")}` : ""),
    };
  }

  // Acceptance gate, OUT OF SAMPLE.
  //
  // An in-sample gate is worse than no gate: it passes exactly the fits that
  // overfit. Measured on the real 82-record set, in-sample ECE improved
  // (0.0911 -> 0.0881) while the same fit degraded held-out records
  // (0.2339 -> 0.2412). The gate must therefore ask the only question that
  // matters — does this mapping help data it has not seen?
  const oos = holdoutEce(clean);
  if (oos && oos.after >= oos.before) {
    return identity(
      n,
      `fit rejected: held-out ECE ${oos.before.toFixed(4)} -> ${oos.after.toFixed(4)} ` +
        `(no out-of-sample improvement); identity mapping`,
    );
  }

  const adjusted = clean.map((r) => ({ ...r, forecast: applyCalibration(r.forecast, candidate) }));
  const eceAfter = expectedCalibrationError(adjusted, 10);

  return {
    ...candidate,
    rationale:
      `${candidate.rationale}; in-sample ECE ${eceBefore.toFixed(4)} -> ${eceAfter.toFixed(4)}` +
      (oos ? `; held-out ${oos.before.toFixed(4)} -> ${oos.after.toFixed(4)}` : ""),
  };
}

/**
 * Refit on a deterministic 70% split and score the held-out 30%.
 *
 * Deterministic (sorted by id) so the verdict is reproducible: a random split
 * would make the gate flap between runs and invite re-rolling until it passes.
 * Returns null when either side is too thin for the answer to mean anything, in
 * which case the caller keeps its other guards rather than inventing a verdict.
 */
function holdoutEce(records: ForecastRecord[]): { before: number; after: number } | null {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const cut = Math.floor(sorted.length * 0.7);
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  if (train.length < MIN_PER_CLASS * 4 || test.length < 10) return null;

  const trainFit = fitOnce(train);
  if (!trainFit) return null;

  const before = expectedCalibrationError(test, 10);
  const after = expectedCalibrationError(
    test.map((r) => ({ ...r, forecast: applyCalibration(r.forecast, trainFit) })),
    10,
  );
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return { before, after };
}

/** The fitting core without the acceptance gate — used by the holdout check,
 *  which must not recurse back into the gate it is feeding. */
function fitOnce(records: ForecastRecord[]): CalibrationFit | null {
  const yesCount = records.filter((r) => r.outcome).length;
  if (yesCount < MIN_PER_CLASS || records.length - yesCount < MIN_PER_CLASS) return null;

  const shrink = Math.min(1, records.length / FULL_STRENGTH_SAMPLES);
  const { a, b, converged } = fitPlatt(records);
  if (!converged) return null;

  const loA = 1 - MAX_SLOPE_DEVIATION;
  const hiA = 1 + MAX_SLOPE_DEVIATION;
  const clippedA = Math.min(hiA, Math.max(loA, a));
  const clippedB = Math.min(MAX_INTERCEPT, Math.max(-MAX_INTERCEPT, b));

  return {
    method: "platt",
    a: 1 + shrink * (clippedA - 1),
    b: shrink * clippedB,
    n: records.length,
    shrink,
    fittedAt: new Date().toISOString(),
    rationale: "holdout probe",
  };
}

/** Heading the machine-readable block lives under on the calibration page. */
export const FIT_BLOCK_HEADING = "## Machine-readable fit";

/** Serialize as a fenced JSON block so one page carries both the narrative and
 *  the mapping, and the two cannot drift apart. */
export function serializeFit(fit: CalibrationFit): string {
  return `${FIT_BLOCK_HEADING}\n\n\`\`\`json\n${JSON.stringify(fit, null, 2)}\n\`\`\``;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Recover a fit from a rendered page. Any malformed or out-of-range value
 * yields null, and callers fall back to identity — a page mangled in transit
 * must never be able to move a live probability.
 */
export function parseFit(pageText: string): CalibrationFit | null {
  if (!pageText) return null;

  const fence = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(pageText)) !== null) {
    let raw: unknown;
    try {
      raw = JSON.parse(match[1]!);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;

    const o = raw as Record<string, unknown>;
    if (o.method !== "identity" && o.method !== "platt" && o.method !== "isotonic") continue;
    if (!isFiniteNumber(o.a) || !isFiniteNumber(o.b)) continue;

    // Re-apply the clip on read. A page could have been hand-edited, and the
    // bounds are a safety property of the system, not merely of the fitter.
    const loA = 1 - MAX_SLOPE_DEVIATION;
    const hiA = 1 + MAX_SLOPE_DEVIATION;
    if (o.a < loA || o.a > hiA) continue;
    if (o.b < -MAX_INTERCEPT || o.b > MAX_INTERCEPT) continue;

    let knots: Array<{ x: number; y: number }> | undefined;
    if (Array.isArray(o.knots)) {
      const parsed: Array<{ x: number; y: number }> = [];
      for (const k of o.knots) {
        if (!k || typeof k !== "object") return null;
        const kk = k as Record<string, unknown>;
        if (!isFiniteNumber(kk.x) || !isFiniteNumber(kk.y)) return null;
        parsed.push({ x: kk.x, y: kk.y });
      }
      knots = parsed;
    }
    if (o.method === "isotonic" && (!knots || knots.length < 2)) continue;

    return {
      method: o.method,
      a: o.a,
      b: o.b,
      ...(knots ? { knots } : {}),
      n: isFiniteNumber(o.n) ? o.n : 0,
      shrink: isFiniteNumber(o.shrink) ? o.shrink : 0,
      fittedAt: typeof o.fittedAt === "string" ? o.fittedAt : new Date(0).toISOString(),
      rationale: typeof o.rationale === "string" ? o.rationale : "",
    };
  }

  return null;
}
