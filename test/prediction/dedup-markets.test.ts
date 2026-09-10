import { describe, it, expect } from "bun:test";
import { deduplicateMarkets } from "../../scripts/lib/market-store.ts";
import type { PredictionMarket } from "../../src/prediction/types.ts";

function fakeMarket(overrides: Partial<PredictionMarket> & { id: string }): PredictionMarket {
  return {
    title: "Test market",
    description: "",
    category: "finance",
    status: "active",
    createdAt: new Date("2026-08-01"),
    expiresAt: new Date("2026-09-01"),
    aiEstimate: {
      yesProbability: 0.5,
      confidence: 0.7,
      reasoning: "",
      sources: [],
      modelVersion: "test",
      updatedAt: new Date("2026-08-10T10:00:00Z"),
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
    metadata: {},
    ...overrides,
  };
}

describe("deduplicateMarkets", () => {
  it("removes markets with the same venueMarketId, keeping the most recent", () => {
    const older = fakeMarket({
      id: "mkt_1_aaa",
      metadata: { venueMarketId: "POLY-123" },
      aiEstimate: {
        yesProbability: 0.01,
        confidence: 0.7,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date("2026-08-10T10:00:00Z"),
      },
    });
    const newer = fakeMarket({
      id: "mkt_2_bbb",
      metadata: { venueMarketId: "POLY-123" },
      aiEstimate: {
        yesProbability: 0.015,
        confidence: 0.7,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date("2026-08-13T10:00:00Z"),
      },
    });

    const result = deduplicateMarkets([older, newer]);
    expect(result).toHaveLength(1);
    expect(result[0]!.aiEstimate.yesProbability).toBe(0.015);
  });

  it("keeps markets without venueMarketId untouched", () => {
    const a = fakeMarket({ id: "mkt_1", metadata: {} });
    const b = fakeMarket({ id: "mkt_2", metadata: {} });
    expect(deduplicateMarkets([a, b])).toHaveLength(2);
  });

  it("keeps markets with different venueMarketIds", () => {
    const a = fakeMarket({ id: "mkt_1", metadata: { venueMarketId: "POLY-1" } });
    const b = fakeMarket({ id: "mkt_2", metadata: { venueMarketId: "POLY-2" } });
    expect(deduplicateMarkets([a, b])).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(deduplicateMarkets([])).toEqual([]);
  });

  it("handles three-way duplicates", () => {
    const markets = [
      fakeMarket({
        id: "mkt_1",
        metadata: { venueMarketId: "K-ABC" },
        aiEstimate: {
          yesProbability: 0.3,
          confidence: 0.7,
          reasoning: "",
          sources: [],
          modelVersion: "test",
          updatedAt: new Date("2026-08-01"),
        },
      }),
      fakeMarket({
        id: "mkt_2",
        metadata: { venueMarketId: "K-ABC" },
        aiEstimate: {
          yesProbability: 0.35,
          confidence: 0.7,
          reasoning: "",
          sources: [],
          modelVersion: "test",
          updatedAt: new Date("2026-08-05"),
        },
      }),
      fakeMarket({
        id: "mkt_3",
        metadata: { venueMarketId: "K-ABC" },
        aiEstimate: {
          yesProbability: 0.4,
          confidence: 0.7,
          reasoning: "",
          sources: [],
          modelVersion: "test",
          updatedAt: new Date("2026-08-10"),
        },
      }),
    ];
    const result = deduplicateMarkets(markets);
    expect(result).toHaveLength(1);
    expect(result[0]!.aiEstimate.yesProbability).toBe(0.4);
  });

  it("mixes venue and non-venue markets correctly", () => {
    const markets = [
      fakeMarket({ id: "mkt_1", title: "Alpha question one?", metadata: { venueMarketId: "POLY-1" } }),
      fakeMarket({ id: "mkt_2", title: "Beta question two?", metadata: {} }), // no venue id
      fakeMarket({ id: "mkt_3", title: "Gamma question three?", metadata: { venueMarketId: "POLY-1" } }), // dupe
      fakeMarket({ id: "mkt_4", title: "Delta question four?", metadata: { venueMarketId: "POLY-2" } }),
    ];
    const result = deduplicateMarkets(markets);
    // mkt_2 (no venue) + POLY-1 (deduped to 1) + POLY-2 = 3
    expect(result).toHaveLength(3);
  });
});

describe("deduplicateMarkets: one question listed twice", () => {
  function listing(
    id: string,
    title: string,
    opts: { venueId?: string; signal?: string; spread?: number; volume?: number; price?: number },
  ): PredictionMarket {
    return fakeMarket({
      id,
      title,
      category: "politics",
      sourceSignals: opts.signal ? [opts.signal] : [],
      metadata: {
        ...(opts.venueId ? { venueMarketId: opts.venueId } : {}),
        ...(opts.volume !== undefined ? { volume24hr: opts.volume } : {}),
        ...(opts.price !== undefined ? { crowdProbability: opts.price } : {}),
        ...(opts.spread !== undefined || opts.price !== undefined
          ? {
              crowdQuote: {
                probability: opts.price ?? 0.5,
                basis: "orderbook_mid",
                venue: "polymarket",
                spread: opts.spread,
                asOf: new Date("2026-09-10T13:42:56Z"),
              },
            }
          : {}),
      },
    });
  }

  it("merges win/gain phrasings of the same outcome", () => {
    // Polymarket listed the same party's outcome under two ids, so neither the
    // venue id nor the source signal can join them. They still ask one
    // question, and normalize.ts then grouped a party against itself.
    const markets = [
      listing("a", "Will party-b-example gain the most seats in the next Russian parliamentary election?", {
        venueId: "1130012",
        spread: 0.01,
        volume: 243_578,
        price: 0.745,
      }),
      listing("b", "Will party-b-example win the most seats in the next Russian parliamentary election?", {
        venueId: "1129894",
        spread: 0.002,
        volume: 223_726,
        price: 0.99,
      }),
    ];
    const result = deduplicateMarkets(markets);
    expect(result).toHaveLength(1);
    // Spread decides: 0.2% is the tighter book, even though its 24h volume is
    // 9% lower. Volume would have kept the 74.5% listing instead.
    expect(result[0]!.id).toBe("b");
  });

  it("merges listings that lost their venue id but share a signal", () => {
    const markets = [
      listing("a", "Will the central bank raise rates after the September meeting?", {
        signal: "poly_2252246",
      }),
      listing("b", "Will the central bank raise rates after the September meeting?", {
        signal: "poly_2252246",
      }),
    ];
    expect(deduplicateMarkets(markets)).toHaveLength(1);
  });

  it("keeps opposite questions apart", () => {
    // "increase" vs "decrease" differ by one word and must never merge.
    const markets = [
      listing("a", "Will the central bank increase rates by 50+ bps after the September meeting?", {
        venueId: "P-1",
      }),
      listing("b", "Will the central bank decrease rates by 50+ bps after the September meeting?", {
        venueId: "P-2",
      }),
    ];
    expect(deduplicateMarkets(markets)).toHaveLength(2);
  });

  it("keeps different thresholds of one quantity apart", () => {
    const markets = [
      listing("a", "TOKEN FDV above $250M one day after launch?", { venueId: "P-1" }),
      listing("b", "TOKEN FDV above $500M one day after launch?", { venueId: "P-2" }),
    ];
    expect(deduplicateMarkets(markets)).toHaveLength(2);
  });

  it("keeps different candidates in one race apart", () => {
    const markets = [
      listing("a", "Will candidate-a-example win the 2028 mayoral election?", { venueId: "P-1" }),
      listing("b", "Will candidate-b-example win the 2028 mayoral election?", { venueId: "P-2" }),
    ];
    expect(deduplicateMarkets(markets)).toHaveLength(2);
  });

  it("does not merge on a handful of shared words", () => {
    // Below the four-word floor, two terse headlines could collide.
    const markets = [
      listing("a", "Fed hike?", { venueId: "P-1" }),
      listing("b", "Fed cut?", { venueId: "P-2" }),
    ];
    expect(deduplicateMarkets(markets)).toHaveLength(2);
  });

  it("scopes the match to one category", () => {
    const a = listing("a", "Will the champion win the final match of the season?", { venueId: "P-1" });
    const b = fakeMarket({
      ...listing("b", "Will the champion win the final match of the season?", { venueId: "P-2" }),
      id: "b",
      category: "sports",
    });
    expect(deduplicateMarkets([a, b])).toHaveLength(2);
  });

  it("prefers a quoted listing over an unquoted one", () => {
    const markets = [
      listing("a", "Will the measure pass the assembly before the deadline?", { venueId: "P-1" }),
      listing("b", "Will the measure pass the assembly before the deadline?", {
        venueId: "P-2",
        spread: 0.01,
        price: 0.4,
      }),
    ];
    const result = deduplicateMarkets(markets);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("b");
  });
});
