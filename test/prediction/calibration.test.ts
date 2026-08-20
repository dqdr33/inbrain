import { describe, test, expect } from "bun:test";
import { computeAvgBrierScore } from "../../src/prediction/analyst-agent.ts";
import {
  CALIBRATION_SLUG,
  CALIBRATION_SLUG_QUERY,
  renderCalibrationPage,
} from "../../src/prediction/calibration.ts";
import { DreamCycle } from "../../src/prediction/dream-cycle.ts";
import type { PredictionMarket } from "../../src/prediction/types.ts";

function market(id: string, yesProbability: number, outcome?: "yes" | "no"): PredictionMarket {
  return {
    id,
    title: `market ${id}`,
    description: "",
    category: "crypto",
    status: outcome ? "resolved" : "active",
    createdAt: new Date("2026-01-01"),
    expiresAt: new Date("2026-02-01"),
    resolvedAt: outcome ? new Date("2026-01-15") : undefined,
    aiEstimate: {
      yesProbability,
      confidence: 0.7,
      reasoning: "",
      sources: [],
      modelVersion: "test",
      updatedAt: new Date(),
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
    resolution: outcome
      ? {
          // "oracle" = the venue settled it. `resolvedBy: "auto"` is the retired
          // LLM-guess path and is deliberately excluded from scoring, so a
          // fixture using it would score nothing.
          outcome,
          resolvedBy: "oracle",
          evidence: ["e"],
          verificationSources: ["https://example.com"],
          resolvedAt: new Date("2026-01-15"),
        }
      : undefined,
    metadata: {},
  };
}

describe("computeAvgBrierScore", () => {
  test("returns null when nothing has resolved", () => {
    expect(computeAvgBrierScore([market("a", 0.5)])).toBeNull();
  });

  test("a perfect prediction scores 0", () => {
    expect(computeAvgBrierScore([market("a", 1, "yes")])).toBe(0);
  });

  test("LLM-guessed outcomes are excluded from the score", () => {
    // The retired auto-resolution path guessed outcomes from a brain holding no
    // news and was right 56% of the time while claiming 90%+ confidence. 83 of
    // the 96 stored resolutions came from it; scoring against them measures this
    // system against coin flips, so the score could neither improve nor be
    // trusted when it moved.
    const guessed = market("a", 1, "no");
    guessed.resolution!.resolvedBy = "auto";
    expect(computeAvgBrierScore([guessed])).toBeNull();
  });

  test("a venue-settled outcome next to a guessed one scores only the settled one", () => {
    const settled = market("a", 1, "yes"); // perfect, resolvedBy "oracle"
    const guessed = market("b", 1, "no"); // maximally wrong, but not evidence
    guessed.resolution!.resolvedBy = "auto";
    expect(computeAvgBrierScore([settled, guessed])).toBe(0);
  });

  test("a maximally wrong prediction scores 1", () => {
    expect(computeAvgBrierScore([market("a", 1, "no")])).toBe(1);
  });

  test("averages across resolved markets", () => {
    const score = computeAvgBrierScore([
      market("a", 0.8, "yes"), // (0.8-1)^2 = 0.04
      market("b", 0.3, "no"), // (0.3-0)^2 = 0.09
    ]);
    expect(score).toBeCloseTo(0.065, 6);
  });

  test("ignores unresolved markets in the denominator", () => {
    const score = computeAvgBrierScore([market("a", 1, "yes"), market("b", 0.5)]);
    expect(score).toBe(0);
  });
});

describe("calibration page", () => {
  test("the query the Brain Agent runs targets the slug the Dream Cycle writes", () => {
    expect(CALIBRATION_SLUG_QUERY.startsWith(CALIBRATION_SLUG)).toBe(true);
  });

  test("renders an honest placeholder when there are no rules yet", () => {
    const page = renderCalibrationPage([], { marketsReviewed: 0, avgBrierScore: null });
    expect(page).toContain("n/a (no resolved markets yet)");
    expect(page).toContain("No calibration rules derived yet");
  });

  test("renders rules with their evidence", () => {
    const page = renderCalibrationPage(
      [{ rule: "crypto is overconfident", previousValue: 0.5, newValue: 0.35, evidence: "12 markets" }],
      { marketsReviewed: 12, avgBrierScore: 0.21 },
    );
    expect(page).toContain("crypto is overconfident");
    expect(page).toContain("0.50 → 0.35");
    expect(page).toContain("0.2100");
  });
});

describe("DreamCycle closes the loop", () => {
  test("writes the calibration page the Brain Agent reads", async () => {
    const writes: string[] = [];
    const cycle = new DreamCycle({
      brainQuery: async () => "",
      brainWrite: async (slug) => {
        writes.push(slug);
      },
      llmCall: async () => "[]",
      getActiveMarkets: () => [],
      getResolvedMarkets: () => [],
    });

    await cycle.run();
    expect(writes).toContain(CALIBRATION_SLUG);
  });

  test("publishes calibration even when a later phase throws", async () => {
    // The regression that cost 41 of 61 runs. Publication used to sit after all
    // five phases, so an LLM quota error in phase 2 discarded calibration that
    // phase 1 had already finished computing. The fit is pure arithmetic and
    // must be banked before anything fragile runs.
    const writes: string[] = [];
    const cycle = new DreamCycle({
      brainQuery: async () => "",
      brainWrite: async (slug) => {
        writes.push(slug);
      },
      llmCall: async () => {
        throw new Error("quota exhausted");
      },
      getActiveMarkets: () => [],
      getResolvedMarkets: () => [market("a", 0.9, "yes")],
    });

    await cycle.run().catch(() => {});
    expect(writes).toContain(CALIBRATION_SLUG);
  });

  test("publishes calibration even when the run budget is already blown", async () => {
    const writes: string[] = [];
    const cycle = new DreamCycle({
      brainQuery: async () => "",
      brainWrite: async (slug) => {
        writes.push(slug);
      },
      llmCall: async () => "[]",
      getActiveMarkets: () => [],
      getResolvedMarkets: () => [market("a", 0.9, "yes")],
      maxRunTimeMinutes: 0,
    });

    await expect(cycle.run()).rejects.toThrow();
    expect(writes).toContain(CALIBRATION_SLUG);
  });

  test("the published page reports the fit and excludes auto resolutions", async () => {
    const writes = new Map<string, string>();
    const cycle = new DreamCycle({
      brainQuery: async () => "",
      brainWrite: async (slug, content) => {
        writes.set(slug, content);
      },
      llmCall: async () => "[]",
      getActiveMarkets: () => [],
      getResolvedMarkets: () => [market("a", 0.9, "yes")],
    });

    await cycle.run();
    const page = writes.get(CALIBRATION_SLUG)!;
    // Thin history must produce an honest "no adjustment", not a confident one.
    expect(page).toContain("fit_method: identity");
    expect(page).toContain("no numeric adjustment is being applied");
  });

  test("reports null accuracy rather than 0% when nothing has resolved", async () => {
    const cycle = new DreamCycle({
      brainQuery: async () => "",
      brainWrite: async () => {},
      llmCall: async () => "[]",
      getActiveMarkets: () => [market("a", 0.5)],
      getResolvedMarkets: () => [],
    });

    const report = await cycle.run();
    expect(report.predictionsAccuracy).toBeNull();
  });

  test("scores resolved markets and does not crash rendering the report", async () => {
    const writes: Array<{ slug: string; content: string }> = [];
    const cycle = new DreamCycle({
      brainQuery: async () => "",
      brainWrite: async (slug, content) => {
        writes.push({ slug, content });
      },
      // Meta-model rows missing previousValue used to throw out of
      // saveDreamReport via .toFixed(2), after all LLM spend.
      llmCall: async () => JSON.stringify([{ rule: "r", evidence: "e" }]),
      getActiveMarkets: () => [],
      getResolvedMarkets: () => [
        market("a", 0.9, "yes"),
        market("b", 0.9, "yes"),
        market("c", 0.9, "yes"),
        market("d", 0.9, "yes"),
        market("e", 0.9, "yes"),
      ],
    });

    const report = await cycle.run();
    expect(report.predictionsAccuracy).toBeCloseTo(0.99, 6);
    expect(writes.some((w) => w.slug === CALIBRATION_SLUG)).toBe(true);
    expect(writes.some((w) => w.slug.startsWith("predictions/dreams/"))).toBe(true);
  });
});
