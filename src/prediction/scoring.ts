/**
 * Forecast scoring — how good were the probabilities, really?
 *
 * Consumed by the backtest harness (evaluate a past signal as of its own date,
 * compare against the known outcome) and by the calibration loop over markets
 * this pipeline resolved live. Pure functions over (forecast, outcome) pairs —
 * no clock, no network, no brain.
 *
 * THE THREE NUMBERS THAT MATTER, and why one alone is a trap:
 *
 *   Brier / log loss  — how wrong, on average. Lower is better. Neither says
 *                       whether the error is bias or noise.
 *   Reliability       — when you said 70%, did it happen ~70% of the time?
 *                       This is the one a calibration layer can actually fix.
 *   Skill vs baseline — did you beat the market price and the base rate?
 *                       A great Brier that loses to the venue price is worth
 *                       nothing to a bettor; see `skillScore`.
 *
 * A model that always answers the base rate scores a respectable Brier on the
 * skewed "will X happen by date Y" questions that dominate prediction venues
 * (most resolve NO). Reporting Brier without `skillScore` against that constant
 * is how a pipeline convinces itself it has alpha it does not have.
 */

/** One scored forecast: what was predicted, and what actually happened. */
export interface ForecastRecord {
  /** Market/question identity, for grouping and for tracing a bad bucket back. */
  id: string;
  /** P(YES) as forecast, 0-1. */
  forecast: number;
  /** Ground truth. `true` = the event happened. */
  outcome: boolean;
  /**
   * The venue's price at forecast time, 0-1, when there was one. This is the
   * baseline that decides whether the forecast is USEFUL rather than merely
   * accurate — beating a coin flip is easy, beating the market is the job.
   */
  marketPrice?: number;
  /** Days from forecast to resolution. Enables per-horizon breakdown: a model
   *  can be sharp at 30 days and worthless at 365, and one pooled number hides
   *  exactly that. */
  horizonDays?: number;
  /** Free-form grouping key (category, source, venue). */
  group?: string;
}

/** Clamp into (0,1) so log loss stays finite. A forecast of exactly 0 or 1 that
 *  turns out wrong is infinitely penalised, which makes one overconfident call
 *  swallow the whole average. */
const EPS = 1e-6;

function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - EPS, Math.max(EPS, p));
}

/** Brier score for one forecast: squared error against the 0/1 outcome.
 *  0 is perfect, 0.25 is "always said 50%", 1 is maximally wrong. */
export function brierScore(forecast: number, outcome: boolean): number {
  const p = clampProb(forecast);
  return (p - (outcome ? 1 : 0)) ** 2;
}

/** Log loss (negative log likelihood) for one forecast. Punishes confident
 *  mistakes far harder than Brier does — the metric to watch when the failure
 *  mode you fear is overconfidence. */
export function logLoss(forecast: number, outcome: boolean): number {
  const p = clampProb(forecast);
  return outcome ? -Math.log(p) : -Math.log(1 - p);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** One bucket of the reliability diagram. */
export interface ReliabilityBin {
  /** Half-open [lower, upper), except the last bin which includes 1.0. */
  lower: number;
  upper: number;
  count: number;
  /** Mean forecast in this bin — what the model claimed. */
  meanForecast: number;
  /** Fraction that actually resolved YES — what reality delivered. */
  observedFrequency: number;
  /** observed - claimed. Positive = underconfident here, negative = over. */
  gap: number;
}

/**
 * Reliability diagram: bucket forecasts and compare claimed vs observed.
 *
 * This is the diagnostic that tells you WHAT to fix. A uniformly negative `gap`
 * across the high bins means systematic overconfidence — exactly what a Platt /
 * isotonic layer corrects. Noise with no pattern means the model has no signal
 * and no post-hoc correction will manufacture one.
 *
 * Bins holding very few records are noise, not evidence: `observedFrequency`
 * over 3 samples can only be 0, 1/3, 2/3 or 1. Read `count` before believing
 * a gap.
 */
export function reliabilityBins(
  records: ForecastRecord[],
  binCount = 10,
): ReliabilityBin[] {
  if (binCount < 1) throw new Error("binCount must be >= 1");
  const bins: ForecastRecord[][] = Array.from({ length: binCount }, () => []);

  for (const r of records) {
    const p = clampProb(r.forecast);
    // Math.min guards p === 1 landing in a bin that does not exist.
    const idx = Math.min(binCount - 1, Math.floor(p * binCount));
    bins[idx]!.push(r);
  }

  return bins.map((bucket, i) => {
    const lower = i / binCount;
    const upper = (i + 1) / binCount;
    if (bucket.length === 0) {
      return { lower, upper, count: 0, meanForecast: NaN, observedFrequency: NaN, gap: NaN };
    }
    const meanForecast = mean(bucket.map((r) => clampProb(r.forecast)));
    const observedFrequency = mean(bucket.map((r) => (r.outcome ? 1 : 0)));
    return {
      lower,
      upper,
      count: bucket.length,
      meanForecast,
      observedFrequency,
      gap: observedFrequency - meanForecast,
    };
  });
}

/**
 * Expected Calibration Error: average |claimed - observed| across bins,
 * weighted by bin population. 0 = perfectly calibrated.
 *
 * A single number for "how miscalibrated", useful for tracking across runs.
 * It does NOT capture direction or sharpness — a model answering the base rate
 * every time is perfectly calibrated and completely useless. Always read it
 * next to `skillScore`.
 */
export function expectedCalibrationError(
  records: ForecastRecord[],
  binCount = 10,
): number {
  if (records.length === 0) return NaN;
  const bins = reliabilityBins(records, binCount);
  let acc = 0;
  for (const b of bins) {
    if (b.count === 0) continue;
    acc += (b.count / records.length) * Math.abs(b.gap);
  }
  return acc;
}

/** How a set of forecasts scored against the constant and market baselines. */
export interface BaselineComparison {
  /** Mean Brier of the forecasts under test. */
  model: number;
  /** Always predicting the sample's own base rate. The bar a skewed question
   *  set makes deceptively easy to clear by accident. */
  baseRate: number;
  /** Always 50%. The floor; losing to this means something is inverted. */
  alwaysFifty: number;
  /** The venue price, over the subset that had one. NaN when no record carried
   *  a `marketPrice`. This is the only baseline that matters commercially. */
  marketPrice: number;
  /** Records that carried a market price — the denominator for `marketPrice`. */
  marketPriceSampleSize: number;
}

/**
 * Brier skill score: fractional improvement over a reference.
 *
 *   +1  perfect
 *    0  no better than the reference
 *   <0  WORSE than the reference
 *
 * Report this, not raw Brier, whenever the question is "is this worth acting
 * on". Raw Brier answers "how close were the numbers"; skill answers "did we
 * add anything over just reading the price off the screen".
 */
export function skillScore(modelBrier: number, referenceBrier: number): number {
  if (!Number.isFinite(modelBrier) || !Number.isFinite(referenceBrier)) return NaN;
  // A reference this good is a degenerate sample, not a benchmark: it happens
  // when every record resolved the same way, so "always predict the base rate"
  // is exactly right by construction and its Brier collapses to ~0. The ratio
  // then explodes to an arbitrarily large negative number that looks like a
  // catastrophic finding and is pure artifact. NaN says "not measurable here",
  // which is the truth, and formatScorecard prints it as n/a.
  //
  // Note that a merely SMALL reference still yields a huge finite ratio: a
  // near-certain venue price (0.99 on a YES) scores ~1e-4, and real data
  // produced per-group skill of -8065 and -11393 that way. That is arithmetic,
  // not a bug — the number is correct and simply unreadable as a magnitude.
  // Suppressing it here would hide a legitimate measurement from callers that
  // want it, so presentation layers cap it instead (see `skillText` in
  // calibration.ts). This function stays honest; the page stays readable.
  if (referenceBrier < 1e-9) return NaN;
  return 1 - modelBrier / referenceBrier;
}

/** Full scorecard for a set of forecasts. */
export interface Scorecard {
  count: number;
  /** Fraction of records that resolved YES. The skew that makes raw Brier
   *  flattering — surface it so no reader forgets it. */
  baseRate: number;
  meanBrier: number;
  meanLogLoss: number;
  expectedCalibrationError: number;
  bins: ReliabilityBin[];
  baselines: BaselineComparison;
  /** Skill of the model against each baseline. */
  skill: {
    vsBaseRate: number;
    vsAlwaysFifty: number;
    /** NaN when no record carried a market price. */
    vsMarketPrice: number;
  };
}

/**
 * Score a set of forecasts against their outcomes.
 *
 * Records with a non-finite forecast are dropped rather than coerced: a NaN
 * probability is a broken upstream estimate, and silently treating it as 0.5
 * would let a pipeline failure read as mediocre-but-working.
 */
export function scoreForecasts(
  records: ForecastRecord[],
  binCount = 10,
): Scorecard {
  const clean = records.filter((r) => Number.isFinite(r.forecast));
  const dropped = records.length - clean.length;
  if (dropped > 0) {
    console.warn(
      `[scoring] dropped ${dropped} record(s) with a non-finite forecast — ` +
        `these are upstream estimate failures, not 50% predictions`,
    );
  }

  if (clean.length === 0) {
    const nanBaselines: BaselineComparison = {
      model: NaN,
      baseRate: NaN,
      alwaysFifty: NaN,
      marketPrice: NaN,
      marketPriceSampleSize: 0,
    };
    return {
      count: 0,
      baseRate: NaN,
      meanBrier: NaN,
      meanLogLoss: NaN,
      expectedCalibrationError: NaN,
      bins: reliabilityBins([], binCount),
      baselines: nanBaselines,
      skill: { vsBaseRate: NaN, vsAlwaysFifty: NaN, vsMarketPrice: NaN },
    };
  }

  const baseRate = mean(clean.map((r) => (r.outcome ? 1 : 0)));
  const meanBrier = mean(clean.map((r) => brierScore(r.forecast, r.outcome)));
  const meanLogLoss = mean(clean.map((r) => logLoss(r.forecast, r.outcome)));

  const baseRateBrier = mean(clean.map((r) => brierScore(baseRate, r.outcome)));
  const fiftyBrier = mean(clean.map((r) => brierScore(0.5, r.outcome)));

  // The market baseline is scored ONLY over records that carried a price, and
  // the model is re-scored over that same subset. Comparing a model average
  // taken over all records against a market average taken over a subset would
  // be a different question on a different sample.
  const withPrice = clean.filter((r) => Number.isFinite(r.marketPrice ?? NaN));
  const marketBrier =
    withPrice.length > 0
      ? mean(withPrice.map((r) => brierScore(r.marketPrice!, r.outcome)))
      : NaN;
  const modelBrierOnPricedSubset =
    withPrice.length > 0
      ? mean(withPrice.map((r) => brierScore(r.forecast, r.outcome)))
      : NaN;

  return {
    count: clean.length,
    baseRate,
    meanBrier,
    meanLogLoss,
    expectedCalibrationError: expectedCalibrationError(clean, binCount),
    bins: reliabilityBins(clean, binCount),
    baselines: {
      model: meanBrier,
      baseRate: baseRateBrier,
      alwaysFifty: fiftyBrier,
      marketPrice: marketBrier,
      marketPriceSampleSize: withPrice.length,
    },
    skill: {
      vsBaseRate: skillScore(meanBrier, baseRateBrier),
      vsAlwaysFifty: skillScore(meanBrier, fiftyBrier),
      vsMarketPrice: skillScore(modelBrierOnPricedSubset, marketBrier),
    },
  };
}

/** Score each group separately. Use for per-horizon or per-category breakdowns,
 *  where a pooled number hides that the model is strong in one regime and
 *  actively harmful in another. */
export function scoreByGroup(
  records: ForecastRecord[],
  keyOf: (r: ForecastRecord) => string,
  binCount = 10,
): Map<string, Scorecard> {
  const groups = new Map<string, ForecastRecord[]>();
  for (const r of records) {
    const key = keyOf(r);
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }
  const out = new Map<string, Scorecard>();
  for (const [key, rs] of groups) out.set(key, scoreForecasts(rs, binCount));
  return out;
}

/** Standard horizon buckets for `scoreByGroup`. A forecast with no
 *  `horizonDays` groups as "unknown" rather than being silently binned. */
export function horizonBucket(r: ForecastRecord): string {
  const d = r.horizonDays;
  if (d === undefined || !Number.isFinite(d)) return "unknown";
  if (d <= 7) return "0-7d";
  if (d <= 30) return "8-30d";
  if (d <= 90) return "31-90d";
  if (d <= 180) return "91-180d";
  if (d <= 365) return "181-365d";
  return "365d+";
}

function fmt(x: number, digits = 4): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "n/a";
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

/**
 * Human-readable scorecard.
 *
 * Leads with the skill lines rather than raw Brier, because raw Brier on a
 * skewed question set is the number most likely to be misread as success.
 */
export function formatScorecard(card: Scorecard, title = "Forecast scorecard"): string {
  if (card.count === 0) return `${title}\n  no scorable forecasts`;

  // An all-YES or all-NO sample cannot support a skill claim against the base
  // rate: the constant is right by construction. Say so rather than letting a
  // bare "n/a" read as a formatting glitch.
  const degenerate = card.baseRate === 0 || card.baseRate === 1;

  const lines: string[] = [
    title,
    `  n = ${card.count}   base rate (YES) = ${pct(card.baseRate)}` +
      (degenerate ? "   [degenerate: every record resolved the same way]" : ""),
    "",
    "  Skill (fraction better than baseline; <= 0 means no edge)",
    `    vs market price   ${fmt(card.skill.vsMarketPrice)}   ` +
      `(n = ${card.baselines.marketPriceSampleSize})`,
    `    vs base rate      ${fmt(card.skill.vsBaseRate)}`,
    `    vs always-50%     ${fmt(card.skill.vsAlwaysFifty)}`,
    "",
    "  Raw scores (lower is better)",
    `    Brier    model ${fmt(card.meanBrier)}   ` +
      `base-rate ${fmt(card.baselines.baseRate)}   ` +
      `market ${fmt(card.baselines.marketPrice)}   ` +
      `always-50% ${fmt(card.baselines.alwaysFifty)}`,
    `    LogLoss  ${fmt(card.meanLogLoss)}`,
    `    ECE      ${fmt(card.expectedCalibrationError)}`,
    "",
    "  Reliability (claimed vs observed; gap < 0 = overconfident)",
  ];

  for (const b of card.bins) {
    if (b.count === 0) continue;
    const range = `${(b.lower * 100).toFixed(0)}-${(b.upper * 100).toFixed(0)}%`;
    // Bins this small cannot support a conclusion; say so inline rather than
    // letting a 1-sample 100% gap read as a finding.
    const thin = b.count < 5 ? "  (thin)" : "";
    lines.push(
      `    ${range.padEnd(9)} n=${String(b.count).padStart(4)}   ` +
        `claimed ${pct(b.meanForecast).padStart(6)}   ` +
        `observed ${pct(b.observedFrequency).padStart(6)}   ` +
        `gap ${(b.gap >= 0 ? "+" : "") + (b.gap * 100).toFixed(1)}pp${thin}`,
    );
  }

  return lines.join("\n");
}
