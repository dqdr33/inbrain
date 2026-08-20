import { describe, test, expect } from "bun:test";
import {
  applyCalibration,
  fitCalibration,
  parseFit,
  serializeFit,
  IDENTITY_FIT,
  MIN_FIT_SAMPLES,
  MIN_PER_CLASS,
  MAX_SLOPE_DEVIATION,
  FULL_STRENGTH_SAMPLES,
  ISOTONIC_MIN_SAMPLES,
  type CalibrationFit,
} from "../../src/prediction/calibration-fit.ts";
import { renderFactualCalibrationPage } from "../../src/prediction/calibration.ts";
import { scoreForecasts, type ForecastRecord } from "../../src/prediction/scoring.ts";

/**
 * Deterministic records carrying a KNOWN miscalibration.
 *
 * `overclaim` pushes the STATED probability away from the true one that
 * actually generates the outcome, so the fitter has a real, recoverable bias to
 * find. Pushing the forecast toward the truth instead would leave nothing to
 * correct and every fit would (rightly) come back identity.
 */
function records(n: number, overclaim: number, seed = 1): ForecastRecord[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  return Array.from({ length: n }, (_, i) => {
    // The truth that decides the outcome.
    const truth = 0.05 + rand() * 0.9;
    const outcome = rand() < truth;
    // What the model claims: the same belief, stretched away from 0.5 in
    // log-odds. This is exactly the overconfidence a Platt slope can undo.
    const lo = Math.log(truth / (1 - truth));
    const claimed = 1 / (1 + Math.exp(-lo * (1 + overclaim)));
    const forecast = Math.min(0.99, Math.max(0.01, claimed));
    return { id: `r${String(i).padStart(4, "0")}`, forecast, outcome, marketPrice: truth };
  });
}

describe("guards: the fitter declines rather than inventing a correction", () => {
  test(`under ${MIN_FIT_SAMPLES} records the mapping is identity`, () => {
    const fit = fitCalibration(records(MIN_FIT_SAMPLES - 1, 0.5));
    expect(fit.method).toBe("identity");
    expect(fit.rationale).toContain(`< ${MIN_FIT_SAMPLES}`);
  });

  test("identity leaves every probability bit-for-bit unchanged", () => {
    for (const p of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      expect(applyCalibration(p, IDENTITY_FIT)).toBe(p);
    }
  });

  test("a non-finite probability is not laundered into a plausible number", () => {
    // A NaN is a broken upstream estimate. Turning it into 0.5 is how a
    // pipeline failure comes to read as a mediocre-but-working forecast.
    expect(Number.isNaN(applyCalibration(NaN, IDENTITY_FIT))).toBe(true);
    const platt: CalibrationFit = { ...IDENTITY_FIT, method: "platt", a: 1.2, b: 0.1 };
    expect(Number.isNaN(applyCalibration(NaN, platt))).toBe(true);
  });

  test("separable data yields identity instead of an infinite slope", () => {
    const allYes = Array.from({ length: MIN_FIT_SAMPLES + 50 }, (_, i) => ({
      id: `y${i}`,
      forecast: 0.6,
      outcome: true,
    }));
    const allNo = allYes.map((r, i) => ({ ...r, id: `n${i}`, outcome: false }));

    for (const set of [allYes, allNo]) {
      const fit = fitCalibration(set);
      expect(fit.method).toBe("identity");
      expect(Number.isFinite(fit.a)).toBe(true);
      expect(Number.isFinite(fit.b)).toBe(true);
    }
  });

  test("a near-separable minority class is refused too", () => {
    const n = MIN_FIT_SAMPLES + 20;
    const set = Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      forecast: 0.5,
      outcome: i < MIN_PER_CLASS - 1,
    }));
    const fit = fitCalibration(set);
    expect(fit.method).toBe("identity");
    expect(fit.rationale).toContain("YES");
  });

  test("an empty set is identity, not a crash", () => {
    expect(fitCalibration([]).method).toBe("identity");
  });
});

describe("bounds", () => {
  test("the slope can never invert or exceed its clip", () => {
    // Sweeping many shapes: whatever the data asks for, the mapping stays
    // within bounds. Out-of-range parameters are a safety property of the
    // system, not merely of one code path.
    for (const overclaim of [-0.9, -0.5, 0, 0.5, 0.9]) {
      const fit = fitCalibration(records(400, overclaim, overclaim * 100 + 7));
      expect(fit.a).toBeGreaterThanOrEqual(1 - MAX_SLOPE_DEVIATION - 1e-9);
      expect(fit.a).toBeLessThanOrEqual(1 + MAX_SLOPE_DEVIATION + 1e-9);
      expect(Math.abs(fit.b)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  test("a fitted mapping keeps probabilities inside [0,1]", () => {
    const fit = fitCalibration(records(400, 0.8, 3));
    for (let i = 0; i <= 100; i++) {
      const out = applyCalibration(i / 100, fit);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });

  test("shrink scales with sample size and saturates at full strength", () => {
    const small = fitCalibration(records(FULL_STRENGTH_SAMPLES / 2, 0.8, 11));
    const large = fitCalibration(records(FULL_STRENGTH_SAMPLES * 2, 0.8, 11));
    if (small.method !== "identity") expect(small.shrink).toBeCloseTo(0.5, 6);
    if (large.method !== "identity") expect(large.shrink).toBe(1);
  });

  test("monotonic: a fitted mapping never reorders two probabilities", () => {
    const fit = fitCalibration(records(400, 0.8, 5));
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const out = applyCalibration(i / 100, fit);
      expect(out).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = out;
    }
  });
});

describe("the acceptance gate is out-of-sample", () => {
  test("a fit that cannot help held-out records is rejected", () => {
    // An in-sample gate passes exactly the fits that overfit, which is what
    // happened on the real 82-record set: in-sample ECE improved while
    // held-out ECE degraded. Pure noise must therefore come back as identity.
    // Already perfectly calibrated: the stated probability IS the generating
    // one, so there is no bias to recover and any apparent gap is sampling
    // noise. A fitter that "finds" something here is fitting the sample.
    const calibrated = records(300, 0, 99);
    expect(fitCalibration(calibrated).method).toBe("identity");
  });

  test("a real, consistent bias IS corrected once there is enough of it", () => {
    // The counterpart to the test above: the guards must not be so strict that
    // no evidence could ever move the mapping.
    const biased = records(ISOTONIC_MIN_SAMPLES - 10, 0.9, 21);
    const fit = fitCalibration(biased);
    expect(fit.method).toBe("platt");

    const before = scoreForecasts(biased).expectedCalibrationError;
    const after = scoreForecasts(
      biased.map((r) => ({ ...r, forecast: applyCalibration(r.forecast, fit) })),
    ).expectedCalibrationError;
    expect(after).toBeLessThan(before);
  });

  test(`isotonic only engages at ${ISOTONIC_MIN_SAMPLES}+ records`, () => {
    // Below the threshold a 10-bin isotonic fit would be reading ~9 coin flips
    // per bin as if they were a curve.
    expect(fitCalibration(records(ISOTONIC_MIN_SAMPLES - 10, 0.9, 31)).method).not.toBe("isotonic");

    const big = fitCalibration(records(ISOTONIC_MIN_SAMPLES * 3, 0.9, 31));
    expect(big.method).toBe("isotonic");
    expect(big.knots!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("round-trip through the page", () => {
  test("WRITE/READ: the fit survives being rendered and parsed back", () => {
    // This is the test that would have caught the original breakage. The page
    // was written by slug and read by fuzzy semantic search, so the two ends
    // were never proven to be the same document.
    const fit = fitCalibration(records(ISOTONIC_MIN_SAMPLES - 10, 0.9, 41));
    expect(fit.method).toBe("platt");

    const page = renderFactualCalibrationPage({
      fit,
      scorecard: scoreForecasts(records(50, 0.5, 9)),
      byGroup: new Map(),
      byHorizon: new Map(),
      worstMisses: [],
      autoScorecard: null,
      sources: { live: 3, backtest: 597 },
      pricedCount: 600,
    });

    const parsed = parseFit(page);
    expect(parsed).not.toBeNull();
    expect(parsed!.method).toBe(fit.method);
    expect(parsed!.a).toBeCloseTo(fit.a, 12);
    expect(parsed!.b).toBeCloseTo(fit.b, 12);
    expect(parsed!.n).toBe(fit.n);
  });

  test("an identity fit round-trips as identity", () => {
    const parsed = parseFit(serializeFit(IDENTITY_FIT));
    expect(parsed!.method).toBe("identity");
    expect(applyCalibration(0.73, parsed!)).toBe(0.73);
  });

  test("a page with no fit block yields null, and callers fall back to identity", () => {
    expect(parseFit("# Just a page\n\nNo JSON here.")).toBeNull();
    expect(parseFit("")).toBeNull();
  });

  test("a hand-edited out-of-range slope is refused on read", () => {
    // The bounds must hold even against a page someone edited by hand: a
    // mangled document must never be able to move a live probability.
    const evil = serializeFit({ ...IDENTITY_FIT, method: "platt", a: 9, b: 0 });
    expect(parseFit(evil)).toBeNull();
  });

  test("malformed JSON does not throw", () => {
    expect(parseFit("```json\n{not json}\n```")).toBeNull();
  });
});

describe("the page states the commercial verdict, not the flattering one", () => {
  test("losing to the venue price is said in those words", () => {
    const losing: ForecastRecord[] = Array.from({ length: 40 }, (_, i) => ({
      id: `r${i}`,
      forecast: i % 2 === 0 ? 0.6 : 0.4,
      outcome: i % 4 === 0,
      marketPrice: i % 4 === 0 ? 0.9 : 0.1,
    }));

    const page = renderFactualCalibrationPage({
      fit: IDENTITY_FIT,
      scorecard: scoreForecasts(losing),
      byGroup: new Map(),
      byHorizon: new Map(),
      worstMisses: [],
      autoScorecard: null,
      sources: { live: 40, backtest: 0 },
      pricedCount: 40,
    });

    expect(page).toContain("does NOT beat the venue quote");
  });

  test("a near-certain venue price does not print an explosive skill ratio", () => {
    // Real data produced per-group skill of -8065 and -11393 because a venue
    // price of 0.99 on a YES scores a Brier of 1e-4 and the ratio blows up.
    // Such a number carries no information the Brier column does not already
    // give, and reads as a catastrophic finding.
    const nearCertain: ForecastRecord[] = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      forecast: 0.01,
      outcome: true,
      marketPrice: 0.99,
      group: "g",
    }));

    const page = renderFactualCalibrationPage({
      fit: IDENTITY_FIT,
      scorecard: scoreForecasts(nearCertain),
      byGroup: new Map([["g", scoreForecasts(nearCertain)]]),
      byHorizon: new Map(),
      worstMisses: [],
      autoScorecard: null,
      sources: { live: 12, backtest: 0 },
      pricedCount: 12,
    });

    expect(page).not.toMatch(/-\d{3,}\.\d/);
  });

  test("a group with too few priced records says so instead of guessing", () => {
    const thin: ForecastRecord[] = Array.from({ length: 3 }, (_, i) => ({
      id: `t${i}`,
      forecast: 0.4,
      outcome: i === 0,
      marketPrice: 0.2,
      group: "thin",
    }));

    const page = renderFactualCalibrationPage({
      fit: IDENTITY_FIT,
      scorecard: scoreForecasts(thin),
      byGroup: new Map([["thin", scoreForecasts(thin)]]),
      byHorizon: new Map(),
      worstMisses: [],
      autoScorecard: null,
      sources: { live: 3, backtest: 0 },
      pricedCount: 3,
    });

    expect(page).toContain("too few to say");
  });

  test("excluded auto records are labelled as never fitted", () => {
    const auto = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      forecast: 0.95,
      outcome: i < 5,
    }));

    const page = renderFactualCalibrationPage({
      fit: IDENTITY_FIT,
      scorecard: scoreForecasts(records(50, 0.3, 77)),
      byGroup: new Map(),
      byHorizon: new Map(),
      worstMisses: [],
      autoScorecard: scoreForecasts(auto),
      sources: { live: 50, backtest: 0 },
      pricedCount: 50,
    });

    expect(page).toContain("NEVER fitted");
  });
});
