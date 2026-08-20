import { describe, test, expect } from "bun:test";
import {
  brierScore,
  logLoss,
  reliabilityBins,
  expectedCalibrationError,
  skillScore,
  scoreForecasts,
  scoreByGroup,
  horizonBucket,
  formatScorecard,
  type ForecastRecord,
} from "../../src/prediction/scoring.ts";

function rec(
  forecast: number,
  outcome: boolean,
  extra: Partial<ForecastRecord> = {},
): ForecastRecord {
  return { id: `r${Math.random()}`, forecast, outcome, ...extra };
}

describe("brierScore", () => {
  test("perfect forecasts score 0", () => {
    expect(brierScore(1, true)).toBeCloseTo(0, 9);
    expect(brierScore(0, false)).toBeCloseTo(0, 9);
  });

  test("maximally wrong forecasts score ~1", () => {
    expect(brierScore(0, true)).toBeCloseTo(1, 4);
    expect(brierScore(1, false)).toBeCloseTo(1, 4);
  });

  test("a 50% forecast always scores 0.25", () => {
    expect(brierScore(0.5, true)).toBeCloseTo(0.25, 9);
    expect(brierScore(0.5, false)).toBeCloseTo(0.25, 9);
  });

  test("squared error, not absolute", () => {
    // 0.7 forecast on a NO: (0.7 - 0)^2 = 0.49, not 0.7
    expect(brierScore(0.7, false)).toBeCloseTo(0.49, 9);
  });
});

describe("logLoss", () => {
  test("a confident correct call is near zero", () => {
    expect(logLoss(0.99, true)).toBeLessThan(0.02);
  });

  test("punishes confident mistakes far harder than Brier", () => {
    // This is the whole reason log loss is reported alongside Brier.
    const brierPenalty = brierScore(0.99, false) / brierScore(0.6, false);
    const logPenalty = logLoss(0.99, false) / logLoss(0.6, false);
    expect(logPenalty).toBeGreaterThan(brierPenalty);
  });

  test("stays finite at the 0/1 extremes", () => {
    // Unclamped this is Infinity, and one such record would swallow the mean.
    expect(Number.isFinite(logLoss(0, true))).toBe(true);
    expect(Number.isFinite(logLoss(1, false))).toBe(true);
  });
});

describe("reliabilityBins", () => {
  test("assigns forecasts to the right decile", () => {
    const bins = reliabilityBins([rec(0.05, false), rec(0.95, true)], 10);
    expect(bins[0]!.count).toBe(1);
    expect(bins[9]!.count).toBe(1);
    expect(bins[4]!.count).toBe(0);
  });

  test("a forecast of exactly 1.0 lands in the last bin, not out of range", () => {
    const bins = reliabilityBins([rec(1, true)], 10);
    expect(bins[9]!.count).toBe(1);
    expect(bins).toHaveLength(10);
  });

  test("gap is negative when the model is overconfident", () => {
    // Claimed ~90%, only half happened.
    const records = [
      rec(0.9, true),
      rec(0.9, true),
      rec(0.9, false),
      rec(0.9, false),
    ];
    // 0.9 * 10 = 9, so this is the 90-100% bin.
    const bins = reliabilityBins(records, 10);
    const bin = bins[9]!;
    expect(bin.count).toBe(4);
    expect(bin.meanForecast).toBeCloseTo(0.9, 6);
    expect(bin.observedFrequency).toBeCloseTo(0.5, 6);
    expect(bin.gap).toBeLessThan(0);
  });

  test("empty bins report NaN rather than a misleading zero", () => {
    const bins = reliabilityBins([rec(0.5, true)], 10);
    expect(bins[0]!.count).toBe(0);
    expect(Number.isNaN(bins[0]!.observedFrequency)).toBe(true);
    expect(Number.isNaN(bins[0]!.gap)).toBe(true);
  });

  test("rejects a nonsensical bin count", () => {
    expect(() => reliabilityBins([], 0)).toThrow();
  });
});

describe("expectedCalibrationError", () => {
  test("a perfectly calibrated set scores ~0", () => {
    // In the 70% bin, exactly 7 of 10 resolve YES.
    const records = [
      ...Array.from({ length: 7 }, () => rec(0.7, true)),
      ...Array.from({ length: 3 }, () => rec(0.7, false)),
    ];
    expect(expectedCalibrationError(records, 10)).toBeCloseTo(0, 6);
  });

  test("catches systematic overconfidence", () => {
    // Claims 90%, delivers 50%.
    const records = [
      ...Array.from({ length: 5 }, () => rec(0.9, true)),
      ...Array.from({ length: 5 }, () => rec(0.9, false)),
    ];
    expect(expectedCalibrationError(records, 10)).toBeCloseTo(0.4, 2);
  });

  test("weights bins by population", () => {
    // 90 well-calibrated records plus 10 badly-calibrated ones should land
    // near 0.1 * 0.4, not near 0.4.
    const good = [
      ...Array.from({ length: 63 }, () => rec(0.7, true)),
      ...Array.from({ length: 27 }, () => rec(0.7, false)),
    ];
    const bad = [
      ...Array.from({ length: 5 }, () => rec(0.9, true)),
      ...Array.from({ length: 5 }, () => rec(0.9, false)),
    ];
    const ece = expectedCalibrationError([...good, ...bad], 10);
    expect(ece).toBeGreaterThan(0.02);
    expect(ece).toBeLessThan(0.06);
  });
});

describe("skillScore", () => {
  test("0 when the model matches the reference", () => {
    expect(skillScore(0.2, 0.2)).toBeCloseTo(0, 9);
  });

  test("positive when better, negative when worse", () => {
    expect(skillScore(0.1, 0.2)).toBeCloseTo(0.5, 9);
    expect(skillScore(0.4, 0.2)).toBeCloseTo(-1, 9);
  });

  test("a degenerate reference yields NaN, not a giant negative artifact", () => {
    // An all-one-way sample makes the base-rate constant right by construction,
    // so its Brier collapses to ~0 and the ratio explodes. A -3.2e9 in a report
    // reads as a catastrophic finding; it is pure artifact.
    expect(Number.isNaN(skillScore(0.0032, 0))).toBe(true);
    expect(Number.isNaN(skillScore(0.0032, 1e-12))).toBe(true);
  });
});

describe("degenerate samples", () => {
  test("an all-NO sample reports NaN base-rate skill rather than a huge number", () => {
    const records = [rec(0.02, false), rec(0.06, false)];
    const card = scoreForecasts(records);
    expect(card.baseRate).toBe(0);
    expect(Number.isNaN(card.skill.vsBaseRate)).toBe(true);
    // The market comparison is still meaningful when prices differ.
    expect(Number.isFinite(card.skill.vsAlwaysFifty)).toBe(true);
  });

  test("the formatted card flags the degenerate sample explicitly", () => {
    const out = formatScorecard(scoreForecasts([rec(0.02, false), rec(0.06, false)]));
    expect(out).toContain("degenerate");
    expect(out).toContain("n/a");
  });

  test("a healthy mixed sample is not flagged", () => {
    const out = formatScorecard(scoreForecasts([rec(0.2, false), rec(0.8, true)]));
    expect(out).not.toContain("degenerate");
  });
});

describe("scoreForecasts", () => {
  test("reports the base rate that makes raw Brier flattering", () => {
    // 9 of 10 resolve NO — the skew typical of prediction venues.
    const records = [
      ...Array.from({ length: 9 }, () => rec(0.1, false)),
      rec(0.1, true),
    ];
    const card = scoreForecasts(records);
    expect(card.count).toBe(10);
    expect(card.baseRate).toBeCloseTo(0.1, 6);
  });

  test("a model that only echoes the base rate shows ~0 skill against it", () => {
    const records = [
      ...Array.from({ length: 9 }, () => rec(0.1, false)),
      rec(0.1, true),
    ];
    const card = scoreForecasts(records);
    // This is the trap the module exists to expose: Brier looks good...
    expect(card.meanBrier).toBeLessThan(0.1);
    // ...but there is no edge over the constant.
    expect(card.skill.vsBaseRate).toBeCloseTo(0, 6);
  });

  test("negative market skill when the model is worse than the venue price", () => {
    // Market nails it every time; the model fights it and loses.
    const records = [
      rec(0.8, false, { marketPrice: 0.1 }),
      rec(0.8, false, { marketPrice: 0.1 }),
      rec(0.2, true, { marketPrice: 0.9 }),
      rec(0.2, true, { marketPrice: 0.9 }),
    ];
    const card = scoreForecasts(records);
    expect(card.skill.vsMarketPrice).toBeLessThan(0);
    expect(card.baselines.marketPriceSampleSize).toBe(4);
  });

  test("positive market skill when the model beats the venue price", () => {
    const records = [
      rec(0.9, true, { marketPrice: 0.5 }),
      rec(0.9, true, { marketPrice: 0.5 }),
      rec(0.1, false, { marketPrice: 0.5 }),
      rec(0.1, false, { marketPrice: 0.5 }),
    ];
    const card = scoreForecasts(records);
    expect(card.skill.vsMarketPrice).toBeGreaterThan(0.5);
  });

  test("market skill compares model and market on the SAME subset", () => {
    // Two records carry a price; the model is perfect on those and terrible on
    // the unpriced one. Scoring the model over all three against a market
    // scored over two would understate the model's skill on a different sample.
    const records = [
      rec(1, true, { marketPrice: 0.5 }),
      rec(0, false, { marketPrice: 0.5 }),
      rec(0.99, false), // no price — must not enter the market comparison
    ];
    const card = scoreForecasts(records);
    expect(card.baselines.marketPriceSampleSize).toBe(2);
    // Model is perfect on the priced subset, market scored 0.25 → skill 1.
    expect(card.skill.vsMarketPrice).toBeCloseTo(1, 6);
    // The pooled Brier still carries the bad unpriced record.
    expect(card.meanBrier).toBeGreaterThan(0.3);
  });

  test("market skill is NaN when nothing carried a price", () => {
    const card = scoreForecasts([rec(0.6, true), rec(0.4, false)]);
    expect(card.baselines.marketPriceSampleSize).toBe(0);
    expect(Number.isNaN(card.skill.vsMarketPrice)).toBe(true);
  });

  test("drops non-finite forecasts instead of coercing them to 0.5", () => {
    // A NaN estimate is an upstream failure. Treating it as 50% would let a
    // broken pipeline read as mediocre-but-working.
    const card = scoreForecasts([rec(0.9, true), rec(NaN, false)]);
    expect(card.count).toBe(1);
    expect(card.meanBrier).toBeCloseTo(brierScore(0.9, true), 9);
  });

  test("an empty set returns NaN rather than throwing or reporting 0", () => {
    const card = scoreForecasts([]);
    expect(card.count).toBe(0);
    expect(Number.isNaN(card.meanBrier)).toBe(true);
    expect(Number.isNaN(card.baseRate)).toBe(true);
  });

  test("always-50% baseline scores 0.25 regardless of skew", () => {
    const records = [
      ...Array.from({ length: 8 }, () => rec(0.3, false)),
      ...Array.from({ length: 2 }, () => rec(0.3, true)),
    ];
    const card = scoreForecasts(records);
    expect(card.baselines.alwaysFifty).toBeCloseTo(0.25, 9);
  });
});

describe("scoreByGroup / horizonBucket", () => {
  test("splits a strong short horizon from a worthless long one", () => {
    const records = [
      rec(0.95, true, { horizonDays: 5 }),
      rec(0.95, true, { horizonDays: 6 }),
      rec(0.9, false, { horizonDays: 300 }),
      rec(0.9, false, { horizonDays: 320 }),
    ];
    const groups = scoreByGroup(records, horizonBucket);
    expect(groups.get("0-7d")!.meanBrier).toBeLessThan(0.02);
    expect(groups.get("181-365d")!.meanBrier).toBeGreaterThan(0.7);
  });

  test("a missing horizon groups as unknown rather than being silently binned", () => {
    const groups = scoreByGroup([rec(0.5, true)], horizonBucket);
    expect(groups.has("unknown")).toBe(true);
  });

  test("bucket boundaries are inclusive of their upper edge", () => {
    expect(horizonBucket(rec(0.5, true, { horizonDays: 7 }))).toBe("0-7d");
    expect(horizonBucket(rec(0.5, true, { horizonDays: 8 }))).toBe("8-30d");
    expect(horizonBucket(rec(0.5, true, { horizonDays: 365 }))).toBe("181-365d");
    expect(horizonBucket(rec(0.5, true, { horizonDays: 366 }))).toBe("365d+");
  });
});

describe("formatScorecard", () => {
  test("leads with skill, and flags thin bins", () => {
    const records = [
      ...Array.from({ length: 20 }, (_, i) => rec(0.3, i < 6, { marketPrice: 0.3 })),
      rec(0.95, false, { marketPrice: 0.9 }), // alone in its bin
    ];
    const out = formatScorecard(scoreForecasts(records), "Backtest");
    expect(out).toContain("Backtest");
    expect(out).toContain("vs market price");
    expect(out).toContain("(thin)");
    // Skill must appear before the raw Brier block, so a reader cannot mistake
    // a flattering Brier for success.
    expect(out.indexOf("Skill")).toBeLessThan(out.indexOf("Raw scores"));
  });

  test("says so plainly when there is nothing to score", () => {
    expect(formatScorecard(scoreForecasts([]))).toContain("no scorable forecasts");
  });
});
