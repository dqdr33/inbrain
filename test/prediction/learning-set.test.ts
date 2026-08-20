import { describe, test, expect } from "bun:test";
import {
  buildLearningSet,
  recordsFromBacktest,
  recordsFromMarkets,
  ORACLE_GRADE,
} from "../../src/prediction/learning-set.ts";
import type { MarketResolution, PredictionMarket } from "../../src/prediction/types.ts";

function market(
  id: string,
  yesProbability: number,
  outcome: MarketResolution["outcome"],
  resolvedBy: MarketResolution["resolvedBy"],
  extra: {
    rawYesProbability?: number;
    crowdProbability?: number;
    confidence?: number;
    category?: PredictionMarket["category"];
  } = {},
): PredictionMarket {
  return {
    id,
    title: `market ${id}`,
    description: "",
    category: extra.category ?? "crypto",
    status: "resolved",
    createdAt: new Date("2026-01-01"),
    expiresAt: new Date("2026-03-01"),
    resolvedAt: new Date("2026-01-31"),
    aiEstimate: {
      yesProbability,
      confidence: extra.confidence ?? 0.7,
      reasoning: "",
      sources: [],
      modelVersion: "test",
      updatedAt: new Date(),
      ...(extra.rawYesProbability !== undefined
        ? { rawYesProbability: extra.rawYesProbability }
        : {}),
    },
    qualityScore: {
      overall: 80,
      verifiability: 80,
      historicalSimilarity: 80,
      communityPotential: 80,
      liquidityPotential: 80,
      timelineFeasibility: 80,
      reasoning: "",
      historicalCases: [],
      risks: [],
    },
    sourceSignals: [],
    relatedMarkets: [],
    resolution: {
      outcome,
      resolvedBy,
      evidence: ["e"],
      verificationSources: [],
      resolvedAt: new Date("2026-01-31"),
    },
    metadata:
      extra.crowdProbability !== undefined ? { crowdProbability: extra.crowdProbability } : {},
  };
}

describe("ORACLE_GRADE", () => {
  test("auto resolutions are not oracle-grade", () => {
    // The whole design rests on this: 83 of 96 stored resolutions were an LLM
    // guessing an outcome, and fitting on them fits that guess.
    expect(ORACLE_GRADE.has("auto")).toBe(false);
    expect(ORACLE_GRADE.has("oracle")).toBe(true);
    expect(ORACLE_GRADE.has("manual")).toBe(true);
  });
});

describe("recordsFromMarkets", () => {
  test("auto resolutions are excluded from the learning set but still reported", () => {
    const markets = [
      ...Array.from({ length: 100 }, (_, i) => market(`a${i}`, 0.9, "yes", "auto")),
      ...Array.from({ length: 5 }, (_, i) => market(`o${i}`, 0.9, "yes", "oracle")),
    ];
    const { oracle, auto } = recordsFromMarkets(markets);
    expect(oracle).toHaveLength(5);
    expect(auto).toHaveLength(100);
  });

  test("CONTAMINATION GUARD: trains on the raw probability, never the calibrated one", () => {
    // The single most important assertion here. If a fit trains on the
    // post-calibration number, the correction compounds every night until every
    // forecast has collapsed into the base rate — a system that looks like it
    // is learning while destroying its own sharpness.
    const m = market("m", 0.6, "yes", "oracle", { rawYesProbability: 0.8 });
    const { oracle } = recordsFromMarkets([m]);
    expect(oracle[0]!.forecast).toBe(0.8);
  });

  test("falls back to the stored probability when nothing was calibrated", () => {
    // Every pre-existing record is in this state, and for them the stored
    // probability IS the raw one.
    const { oracle } = recordsFromMarkets([market("m", 0.42, "no", "oracle")]);
    expect(oracle[0]!.forecast).toBe(0.42);
  });

  test("cancelled markets are excluded from both sets", () => {
    const { oracle, auto } = recordsFromMarkets([
      market("c1", 0.5, "cancelled", "oracle"),
      market("c2", 0.5, "cancelled", "auto"),
    ]);
    expect(oracle).toHaveLength(0);
    expect(auto).toHaveLength(0);
  });

  test("the 0.5-at-low-confidence parse failure is not admitted as a forecast", () => {
    const { oracle } = recordsFromMarkets([
      market("f", 0.5, "no", "oracle", { confidence: 0.1 }),
    ]);
    expect(oracle).toHaveLength(0);
  });

  test("a genuine 50% call at real confidence is kept", () => {
    const { oracle } = recordsFromMarkets([
      market("g", 0.5, "no", "oracle", { confidence: 0.8 }),
    ]);
    expect(oracle).toHaveLength(1);
  });

  test("crowdProbability becomes marketPrice; absent stays undefined", () => {
    // Never 0.5: inventing a market price corrupts the one baseline that
    // decides whether any of this is commercially worth acting on.
    const { oracle } = recordsFromMarkets([
      market("p", 0.7, "yes", "oracle", { crowdProbability: 0.31 }),
      market("q", 0.7, "yes", "oracle"),
    ]);
    expect(oracle[0]!.marketPrice).toBe(0.31);
    expect(oracle[1]!.marketPrice).toBeUndefined();
  });

  test("outcome and horizon are derived from the resolution", () => {
    const { oracle } = recordsFromMarkets([market("h", 0.7, "yes", "oracle")]);
    expect(oracle[0]!.outcome).toBe(true);
    expect(oracle[0]!.horizonDays).toBeCloseTo(30, 6);
    expect(oracle[0]!.group).toBe("crypto");
  });
});

describe("recordsFromBacktest", () => {
  const row = (forecast: number, confidence: number, skipped = false) => ({
    record: { id: `b${forecast}`, forecast, outcome: false, marketPrice: 0.1 },
    forecast,
    confidence,
    skipped,
  });

  test("skipped and fallback rows are dropped, matching backtest-score", () => {
    const recs = recordsFromBacktest({
      results: [row(0.2, 0.8), row(0.5, 0.1), row(0.3, 0.9, true), row(NaN, 0.9)],
    });
    expect(recs).toHaveLength(1);
    expect(recs[0]!.forecast).toBe(0.2);
  });

  test("a missing run yields no records rather than throwing", () => {
    expect(recordsFromBacktest(null)).toEqual([]);
    expect(recordsFromBacktest(undefined)).toEqual([]);
  });
});

describe("buildLearningSet", () => {
  test("combines oracle markets with backtest records and counts priced ones", () => {
    const set = buildLearningSet({
      markets: [
        market("o", 0.7, "yes", "oracle", { crowdProbability: 0.5 }),
        market("a", 0.7, "yes", "auto"),
      ],
      backtest: {
        results: [
          {
            record: { id: "b1", forecast: 0.2, outcome: false, marketPrice: 0.15 },
            forecast: 0.2,
            confidence: 0.8,
            skipped: false,
          },
        ],
      },
    });

    expect(set.records).toHaveLength(2);
    expect(set.excludedAuto).toHaveLength(1);
    expect(set.pricedCount).toBe(2);
    expect(set.sources).toEqual({ live: 1, backtest: 1 });
  });
});
