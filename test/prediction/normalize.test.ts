import { describe, it, expect } from "bun:test";
import {
  normalizeRelatedMarkets,
  validateNormalizedProbabilities,
  extractPolicyDecisionKey,
  extractBandKey,
  extractThresholdKey,
  parseThresholdMagnitude,
  thresholdDirection,
} from "../../src/prediction/normalize.ts";
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

describe("multi-candidate elections (the eventKey shadowing bug)", () => {
  /** One candidate's contract, exactly as the venue delivers it: a per-candidate
   *  slug naming that candidate. */
  function candidate(name: string, p: number): PredictionMarket {
    const slug = `will-${name.toLowerCase().replace(/[^a-z]+/g, "-")}-win-the-2026-brazilian-presidential-election`;
    return fakeMarket({
      id: slug,
      title: `Will ${name} win the 2026 Brazilian presidential election?`,
      category: "politics",
      metadata: { eventKey: slug },
      aiEstimate: {
        yesProbability: p,
        confidence: 0.7,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date("2026-08-10T10:00:00Z"),
      },
    });
  }

  // Production, 2026-09-01: Zema 75%, Lula 57%, Bolsonaro 39% and six others —
  // 177% across nine mutually exclusive outcomes. extractContestKey matched
  // every title correctly, but groupKeyOf consulted metadata.eventKey first,
  // and each candidate's slug names that candidate. Nine groups of one, each
  // skipped by `group.length < 2`, so nothing was ever normalized.
  it("groups candidates by contest, not by their per-candidate venue slugs", () => {
    const markets = [
      candidate("Romeu Zema", 0.75),
      candidate("Lula da Silva", 0.57),
      candidate("Flavio Bolsonaro", 0.39),
      candidate("Renan Santos", 0.02),
      candidate("Pablo Marcal", 0.015),
      candidate("Geraldo Alckmin", 0.01),
    ];
    const before = markets.reduce((s, m) => s + m.aiEstimate.yesProbability, 0);
    expect(before).toBeGreaterThan(1.7);

    const res = normalizeRelatedMarkets(markets);

    expect(res.groupCount).toBe(1);
    expect(res.adjustedCount).toBe(6);
    const after = markets.reduce((s, m) => s + m.aiEstimate.yesProbability, 0);
    expect(after).toBeCloseTo(1.0, 10);
  });

  it("preserves the ranking between candidates", () => {
    // Proportional rescaling, not softmax: a candidate twice as likely as
    // another stays twice as likely. Softmax would distort those ratios.
    const markets = [candidate("A", 0.60), candidate("B", 0.30), candidate("C", 0.30)];
    normalizeRelatedMarkets(markets);
    const [a, b, c] = markets.map((m) => m.aiEstimate.yesProbability);
    expect(a! / b!).toBeCloseTo(2.0, 10);
    expect(b!).toBeCloseTo(c!, 10);
  });

  it("keeps a lone candidate untouched — one contract is not a contest", () => {
    const markets = [candidate("Solo Runner", 0.75)];
    normalizeRelatedMarkets(markets);
    expect(markets[0]!.aiEstimate.yesProbability).toBe(0.75);
  });

  it("does not merge two different elections", () => {
    const brazil = candidate("Romeu Zema", 0.75);
    const other = fakeMarket({
      id: "us",
      title: "Will Jane Doe win the 2028 American presidential election?",
      category: "politics",
      metadata: { eventKey: "will-jane-doe-win-the-2028-american-presidential-election" },
      aiEstimate: {
        yesProbability: 0.75,
        confidence: 0.7,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date("2026-08-10T10:00:00Z"),
      },
    });
    const res = normalizeRelatedMarkets([brazil, other]);
    expect(res.groupCount).toBe(0);
    expect(brazil.aiEstimate.yesProbability).toBe(0.75);
    expect(other.aiEstimate.yesProbability).toBe(0.75);
  });
});

describe("normalizeRelatedMarkets", () => {
  it("normalizes probabilities summing to > 100% proportionally to exactly 100%", () => {
    // FOMC September scenario: No change (86%), Cut 25bp (38%), Hike 25bp (25%) -> sum 149%
    const m1 = fakeMarket({
      id: "mkt_1",
      title: "FOMC September 2026: No change in interest rate",
      metadata: { eventKey: "fomc-sep-2026" },
      aiEstimate: {
        yesProbability: 0.86,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    const m2 = fakeMarket({
      id: "mkt_2",
      title: "FOMC September 2026: 25 bps rate cut",
      metadata: { eventKey: "fomc-sep-2026" },
      aiEstimate: {
        yesProbability: 0.38,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    const m3 = fakeMarket({
      id: "mkt_3",
      title: "FOMC September 2026: 25 bps rate hike",
      metadata: { eventKey: "fomc-sep-2026" },
      aiEstimate: {
        yesProbability: 0.25,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });

    const res = normalizeRelatedMarkets([m1, m2, m3]);
    expect(res.groupCount).toBe(1);
    expect(res.adjustedCount).toBe(3);

    const sum =
      m1.aiEstimate.yesProbability +
      m2.aiEstimate.yesProbability +
      m3.aiEstimate.yesProbability;
    expect(sum).toBeCloseTo(1.0, 5);

    // 0.86 / 1.49 ≈ 0.5772
    expect(m1.aiEstimate.yesProbability).toBeCloseTo(0.86 / 1.49, 4);
    // 0.38 / 1.49 ≈ 0.2550
    expect(m2.aiEstimate.yesProbability).toBeCloseTo(0.38 / 1.49, 4);
    // 0.25 / 1.49 ≈ 0.1678
    expect(m3.aiEstimate.yesProbability).toBeCloseTo(0.25 / 1.49, 4);

    // Raw probabilities preserved
    expect(m1.metadata.rawAiProbability).toBe(0.86);
    expect(m2.metadata.rawAiProbability).toBe(0.38);
    expect(m3.metadata.rawAiProbability).toBe(0.25);
  });

  it("leaves standalone markets untouched", () => {
    const m1 = fakeMarket({
      id: "mkt_single",
      title: "Will Bitcoin reach $150k in 2026?",
      category: "crypto",
      metadata: {},
      aiEstimate: {
        yesProbability: 0.65,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });

    const res = normalizeRelatedMarkets([m1]);
    expect(res.groupCount).toBe(0);
    expect(res.adjustedCount).toBe(0);
    expect(m1.aiEstimate.yesProbability).toBe(0.65);
    expect(m1.metadata.rawAiProbability).toBeUndefined();
  });

  it("does not adjust groups that already sum to 100%", () => {
    const m1 = fakeMarket({
      id: "mkt_1",
      title: "Candidate A wins election",
      category: "politics",
      metadata: { eventKey: "presidential-election-2026" },
      aiEstimate: {
        yesProbability: 0.6,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    const m2 = fakeMarket({
      id: "mkt_2",
      title: "Candidate B wins election",
      category: "politics",
      metadata: { eventKey: "presidential-election-2026" },
      aiEstimate: {
        yesProbability: 0.4,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });

    const res = normalizeRelatedMarkets([m1, m2]);
    expect(res.groupCount).toBe(0);
    expect(res.adjustedCount).toBe(0);
    expect(m1.aiEstimate.yesProbability).toBe(0.6);
    expect(m2.aiEstimate.yesProbability).toBe(0.4);
  });

  it("normalizes fuzzy clustered markets in the same category", () => {
    const m1 = fakeMarket({
      id: "mkt_1",
      title: "Fed rate decision September 2026 hike",
      category: "finance",
      metadata: {}, // no eventKey
      aiEstimate: {
        yesProbability: 0.4,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    const m2 = fakeMarket({
      id: "mkt_2",
      title: "Fed rate decision September 2026 cut",
      category: "finance",
      metadata: {}, // no eventKey
      aiEstimate: {
        yesProbability: 0.8,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });

    const res = normalizeRelatedMarkets([m1, m2]);
    expect(res.groupCount).toBe(1);
    expect(res.adjustedCount).toBe(2);

    const sum = m1.aiEstimate.yesProbability + m2.aiEstimate.yesProbability;
    expect(sum).toBeCloseTo(1.0, 5);
    expect(m1.aiEstimate.yesProbability).toBeCloseTo(0.4 / 1.2, 4);
    expect(m2.aiEstimate.yesProbability).toBeCloseTo(0.8 / 1.2, 4);
  });
});

describe("validateNormalizedProbabilities", () => {
  it("forces normalization on unnormalized groups with sum > 1.01", () => {
    const m1 = fakeMarket({
      id: "mkt_1",
      title: "FOMC: No change",
      metadata: { eventKey: "fomc-validate" },
      aiEstimate: {
        yesProbability: 0.8,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    const m2 = fakeMarket({
      id: "mkt_2",
      title: "FOMC: Cut 25 bps",
      metadata: { eventKey: "fomc-validate" },
      aiEstimate: {
        yesProbability: 0.5,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });

    // Sum is 1.30 > 1.01
    validateNormalizedProbabilities([m1, m2]);
    const sum = m1.aiEstimate.yesProbability + m2.aiEstimate.yesProbability;
    expect(sum).toBeCloseTo(1.0, 5);
    expect(m1.aiEstimate.yesProbability).toBeCloseTo(0.8 / 1.3, 4);
    expect(m2.aiEstimate.yesProbability).toBeCloseTo(0.5 / 1.3, 4);
  });

  it("leaves already normalized groups untouched", () => {
    const m1 = fakeMarket({
      id: "mkt_1",
      title: "Candidate A wins",
      metadata: { eventKey: "election-val" },
      aiEstimate: {
        yesProbability: 0.6,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    const m2 = fakeMarket({
      id: "mkt_2",
      title: "Candidate B wins",
      metadata: { eventKey: "election-val" },
      aiEstimate: {
        yesProbability: 0.4,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });

    validateNormalizedProbabilities([m1, m2]);
    expect(m1.aiEstimate.yesProbability).toBe(0.6);
    expect(m2.aiEstimate.yesProbability).toBe(0.4);
  });

  it("automatically groups and normalizes multi-candidate elections by contest key", () => {
    const zema = fakeMarket({
      id: "mkt_zema",
      title: "Will Romeu Zema win the 2026 Brazilian presidential election?",
      category: "politics",
      aiEstimate: {
        yesProbability: 0.75,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    const lula = fakeMarket({
      id: "mkt_lula",
      title: "Will Luiz Inácio Lula da Silva win the 2026 Brazilian presidential election?",
      category: "politics",
      aiEstimate: {
        yesProbability: 0.65,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    const caiado = fakeMarket({
      id: "mkt_caiado",
      title: "Will Ronaldo Caiado win the 2026 Brazilian presidential election?",
      category: "politics",
      aiEstimate: {
        yesProbability: 0.10,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });

    // Sum is 0.75 + 0.65 + 0.10 = 1.50 -> must normalize to sum = 1.0
    const res = normalizeRelatedMarkets([zema, lula, caiado]);
    expect(res.groupCount).toBe(1);
    expect(res.adjustedCount).toBe(3);

    const totalSum =
      zema.aiEstimate.yesProbability +
      lula.aiEstimate.yesProbability +
      caiado.aiEstimate.yesProbability;
    expect(totalSum).toBeCloseTo(1.0, 5);
    expect(zema.aiEstimate.yesProbability).toBeCloseTo(0.75 / 1.5, 4);
    expect(lula.aiEstimate.yesProbability).toBeCloseTo(0.65 / 1.5, 4);
    expect(caiado.aiEstimate.yesProbability).toBeCloseTo(0.10 / 1.5, 4);
  });
});

describe("extractPolicyDecisionKey", () => {
  it("groups differently-worded outcomes of the same meeting under one key", () => {
    const hold = extractPolicyDecisionKey("Will the Fed hold rates steady in September 2026?");
    const cut = extractPolicyDecisionKey("Will the Fed cut rates by 25 bps in September 2026?");
    expect(hold).toBeDefined();
    expect(hold).toBe(cut!);
  });

  it("separates different meetings of the same authority", () => {
    const sep = extractPolicyDecisionKey("Will the Fed cut rates in September 2026?");
    const dec = extractPolicyDecisionKey("Will the Fed cut rates in December 2026?");
    expect(sep).not.toBe(dec);
  });

  it("separates different authorities", () => {
    const fed = extractPolicyDecisionKey("Will the Fed cut rates in September 2026?");
    const ecb = extractPolicyDecisionKey("Will the ECB cut rates in September 2026?");
    expect(fed).not.toBe(ecb);
  });

  it("returns undefined without a period, rather than merging across meetings", () => {
    expect(extractPolicyDecisionKey("Will the Fed cut rates?")).toBeUndefined();
  });

  it("ignores non-rate commentary about the same authority", () => {
    expect(
      extractPolicyDecisionKey("Will Powell resign as Fed chair in September 2026?"),
    ).toBeUndefined();
  });
});

describe("normalizeRelatedMarkets — FOMC 138% regression", () => {
  /** The August 19 report: "no change (86%) ... with a slight tilt toward a
   *  25bp cut (52%)" — 138% across two outcomes of one September meeting.
   *  Neither carries an eventKey, and their Jaccard is far under 0.7, so the
   *  pre-fix grouper never paired them. */
  function fomcPair() {
    const hold = fakeMarket({
      id: "mkt_hold",
      title: "Will the Fed leave interest rates unchanged at the September 2026 meeting?",
      category: "finance",
      metadata: {},
      aiEstimate: {
        yesProbability: 0.86,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    const cut = fakeMarket({
      id: "mkt_cut",
      title: "Will the Fed lower rates by 25 basis points in September 2026?",
      category: "finance",
      metadata: {},
      aiEstimate: {
        yesProbability: 0.52,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date(),
      },
    });
    return { hold, cut };
  }

  it("pairs the two contracts and rescales them to 100%", () => {
    const { hold, cut } = fomcPair();
    const res = normalizeRelatedMarkets([hold, cut]);

    expect(res.groupCount).toBe(1);
    expect(hold.aiEstimate.yesProbability + cut.aiEstimate.yesProbability).toBeCloseTo(1.0, 5);
    expect(hold.aiEstimate.yesProbability).toBeCloseTo(0.86 / 1.38, 4);
    expect(cut.aiEstimate.yesProbability).toBeCloseTo(0.52 / 1.38, 4);
  });

  it("reports the conflict instead of silently correcting it", () => {
    const { hold, cut } = fomcPair();
    const res = normalizeRelatedMarkets([hold, cut]);

    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts[0]!.rawSum).toBeCloseTo(1.38, 5);
    expect(res.conflicts[0]!.marketIds.sort()).toEqual(["mkt_cut", "mkt_hold"]);
  });

  it("tags both markets with the shared group so the prompt can link them", () => {
    const { hold, cut } = fomcPair();
    normalizeRelatedMarkets([hold, cut]);

    expect(hold.metadata.normalizationGroup).toBeDefined();
    expect(hold.metadata.normalizationGroup).toBe(cut.metadata.normalizationGroup);
  });

  it("keeps one group when the same meeting arrives from two venues", () => {
    const { hold, cut } = fomcPair();
    // Venue-scoped keys would otherwise split the meeting into two groups that
    // each normalize to 100%, summing to 200% across the decision.
    hold.metadata.eventKey = "polymarket-fed-sept";
    cut.metadata.eventKey = "kalshi-FEDDECISION-26SEP";

    const res = normalizeRelatedMarkets([hold, cut]);
    expect(res.groupCount).toBe(1);
    expect(hold.aiEstimate.yesProbability + cut.aiEstimate.yesProbability).toBeCloseTo(1.0, 5);
  });

  it("is idempotent: a second pass does not rescale an already-scaled value", () => {
    const { hold, cut } = fomcPair();

    normalizeRelatedMarkets([hold, cut]);
    const afterFirst = [hold.aiEstimate.yesProbability, cut.aiEstimate.yesProbability];

    // The pipeline persists the normalized value and reloads it next run, so
    // normalize runs again over its own output. Compounding here is what drove
    // a real FOMC group to a stored sum of 200%.
    normalizeRelatedMarkets([hold, cut]);
    normalizeRelatedMarkets([hold, cut]);

    expect(hold.aiEstimate.yesProbability).toBeCloseTo(afterFirst[0]!, 10);
    expect(cut.aiEstimate.yesProbability).toBeCloseTo(afterFirst[1]!, 10);
    expect(hold.aiEstimate.yesProbability + cut.aiEstimate.yesProbability).toBeCloseTo(1.0, 10);
  });

  it("keeps the original model output across repeated passes", () => {
    const { hold, cut } = fomcPair();

    normalizeRelatedMarkets([hold, cut]);
    normalizeRelatedMarkets([hold, cut]);

    // Not the previous pass's normalized number.
    expect(hold.metadata.rawAiProbability).toBe(0.86);
    expect(cut.metadata.rawAiProbability).toBe(0.52);
  });

  it("restores the raw estimate when a group stops overshooting", () => {
    const { hold, cut } = fomcPair();
    normalizeRelatedMarkets([hold, cut]);
    expect(hold.aiEstimate.yesProbability).not.toBeCloseTo(0.86, 5);

    // A later run re-estimates: the group no longer sums above 100%, so the
    // earlier correction is no longer justified and must be undone.
    hold.metadata.rawAiProbability = 0.30;
    cut.metadata.rawAiProbability = 0.25;
    normalizeRelatedMarkets([hold, cut]);

    expect(hold.aiEstimate.yesProbability).toBeCloseTo(0.30, 10);
    expect(cut.aiEstimate.yesProbability).toBeCloseTo(0.25, 10);
    expect(hold.metadata.rawAiProbability).toBeUndefined();
  });

  it("leaves an under-100% group alone — that is missing coverage, not a conflict", () => {
    const { hold, cut } = fomcPair();
    hold.aiEstimate.yesProbability = 0.35;
    cut.aiEstimate.yesProbability = 0.25;

    const res = normalizeRelatedMarkets([hold, cut]);
    expect(res.groupCount).toBe(0);
    expect(res.conflicts).toHaveLength(0);
    expect(hold.aiEstimate.yesProbability).toBe(0.35);
    expect(cut.aiEstimate.yesProbability).toBe(0.25);
  });
});

describe("band ladders", () => {
  // One vote share carved into three mutually exclusive slices. Each band
  // arrives from the venue under its own per-contract slug, so eventKey
  // isolates them; their titles differ only in numbers, which tokenise away,
  // so Jaccard never sees them either. Reported as 95% / 20% / 3% = 118%.
  function band(id: string, title: string, p: number, eventKey: string): PredictionMarket {
    return fakeMarket({
      id,
      title,
      category: "politics",
      metadata: { eventKey },
      aiEstimate: {
        yesProbability: p,
        confidence: 0.8,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date("2026-08-10T10:00:00Z"),
      },
    });
  }

  const clacton = () => [
    band("b1", "Will Nigel Farage win 60–70% of votes in the Clacton parliamentary by-election?", 0.95, "slug-6070"),
    band("b2", "Will Nigel Farage win 70–80% of votes in the Clacton parliamentary by-election?", 0.2, "slug-7080"),
    band("b3", "Will Nigel Farage win at least 80% of votes in the Clacton parliamentary by-election?", 0.03, "slug-80"),
  ];

  it("groups every slice of one quantity despite per-contract event keys", () => {
    const keys = new Set(clacton().map((m) => extractBandKey(m.title)));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBeDefined();
  });

  it("rescales a 118% ladder to exactly 100%", () => {
    const markets = clacton();
    const res = normalizeRelatedMarkets(markets);

    expect(res.groupCount).toBe(1);
    const sum = markets.reduce((a, m) => a + m.aiEstimate.yesProbability, 0);
    expect(sum).toBeCloseTo(1.0, 9);
    // Proportional: the 95% band stays the leader, it just stops claiming
    // near-certainty while its neighbours also claim probability mass.
    expect(markets[0]!.aiEstimate.yesProbability).toBeCloseTo(0.95 / 1.18, 9);
    expect(markets[0]!.metadata.rawAiProbability).toBe(0.95);
  });

  it("keeps bands of different quantities apart", () => {
    const a = extractBandKey("Will Nigel Farage win 60–70% of votes in the Clacton parliamentary by-election?");
    const b = extractBandKey("Will Keir Starmer win 60–70% of votes in the Clacton parliamentary by-election?");
    expect(a).not.toBe(b);
  });

  it("a shared date window is not a band", () => {
    // "August 14 to August 21" is the window both contracts measure over, not a
    // slice of the measured quantity. The tweet count is the band.
    const key = extractBandKey("Will Elon Musk post 160-179 tweets from August 14 to August 21, 2026?");
    const other = extractBandKey("Will Elon Musk post 280-299 tweets from August 14 to August 21, 2026?");
    expect(key).toBe(other);
  });

  it("a title with no band at all is left ungrouped", () => {
    expect(extractBandKey("Will the Fed hold rates in September?")).toBeUndefined();
  });

  it("leaves a ladder that already sums under 100% untouched", () => {
    const markets = [
      band("t1", "Will Elon Musk post 160-179 tweets from August 14 to August 21, 2026?", 0.003, "s1"),
      band("t2", "Will Elon Musk post 280-299 tweets from August 14 to August 21, 2026?", 0.13, "s2"),
    ];
    normalizeRelatedMarkets(markets);
    expect(markets[0]!.aiEstimate.yesProbability).toBe(0.003);
    expect(markets[1]!.aiEstimate.yesProbability).toBe(0.13);
  });
});

describe("nested threshold ladders are not a distribution (the LAPTOP 0.1% bug)", () => {
  /** One rung of the LAPTOP FDV ladder, as production held it on 2026-09-10. */
  function rung(id: string, threshold: string, p: number, venue: number): PredictionMarket {
    const slug = `laptop-fdv-above-${threshold.toLowerCase()}-one-day-after-launch`;
    return fakeMarket({
      id,
      title: `LAPTOP FDV above $${threshold} one day after launch?`,
      category: "science",
      metadata: {
        eventKey: slug,
        crowdProbability: venue,
        crowdQuote: {
          probability: venue,
          basis: "orderbook_mid",
          venue: "polymarket",
          spread: 0.01,
          asOf: new Date("2026-09-10T08:13:15.328Z"),
        },
      },
      aiEstimate: {
        yesProbability: p,
        confidence: 0.7,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date("2026-09-10T07:41:41.779Z"),
      },
    });
  }

  const laptop = () => [
    rung("m100", "100M", 0.8, 0.964),
    rung("m250", "250M", 0.55, 0.905),
    rung("m500", "500M", 0.2775, 0.795),
  ];

  it("recognises a one-sided threshold", () => {
    // extractBandKey still matches this title — deliberately. Whether a
    // threshold is nested or is the closing slice of a partition cannot be
    // decided from one title alone ("at least 80%" beside real 60–70% bands IS
    // exclusive), so the verdict is made per GROUP in groupMarkets, not here.
    expect(extractThresholdKey("LAPTOP FDV above $500M one day after launch?")).toBeDefined();
  });

  it("collapses every rung of one quantity onto the same key", () => {
    const keys = new Set(laptop().map((m) => extractThresholdKey(m.title)));
    expect(keys.size).toBe(1);
  });

  it("parses magnitudes including the B suffix that $1B rungs need", () => {
    expect(parseThresholdMagnitude("LAPTOP FDV above $500M one day after launch?")).toBe(5e8);
    expect(parseThresholdMagnitude("LAPTOP FDV above $1B one day after launch?")).toBe(1e9);
    expect(parseThresholdMagnitude("LAPTOP FDV above $250M one day after launch?")).toBe(2.5e8);
  });

  it("reads the comparator direction", () => {
    expect(thresholdDirection("LAPTOP FDV above $500M one day after launch?")).toBe("up");
    expect(thresholdDirection("Will inflation come in below 3% in September?")).toBe("down");
  });

  it("does NOT rescale a nested ladder to 100%", () => {
    // The whole defect in one assertion. 80 + 55 + 27.75 = 162.75%, which is
    // perfectly coherent for nested thresholds: an FDV of $600M satisfies all
    // three at once. Forcing the sum to 1.0 is what drove the $500M rung to the
    // floor and published 0.1% against a venue price of 79.5%.
    const markets = laptop();
    const res = normalizeRelatedMarkets(markets);

    expect(res.groupCount).toBe(0);
    expect(res.adjustedCount).toBe(0);
    expect(markets[0]!.aiEstimate.yesProbability).toBe(0.8);
    expect(markets[1]!.aiEstimate.yesProbability).toBe(0.55);
    expect(markets[2]!.aiEstimate.yesProbability).toBe(0.2775);
  });

  it("survives the invariant validator's second pass", () => {
    // The validator recomputes group sums independently and force-normalizes
    // anything over 100%. It must share groupMarkets' verdict, or it would undo
    // the fix on the very next line of the pipeline.
    const markets = laptop();
    normalizeRelatedMarkets(markets);
    validateNormalizedProbabilities(markets);
    expect(markets[2]!.aiEstimate.yesProbability).toBe(0.2775);
  });

  it("never republishes the 0.1% clamp", () => {
    const markets = laptop();
    normalizeRelatedMarkets(markets);
    for (const m of markets) {
      expect(m.aiEstimate.yesProbability).toBeGreaterThan(0.01);
    }
  });

  it("keeps threshold rungs out of the fuzzy pass too", () => {
    // The tokeniser drops digits, so these two titles score a Jaccard of 1.0.
    // Skipping them in groupKeyOf alone would drop them into the fuzzy pass and
    // re-form the same group by another route.
    const markets = [rung("a", "100M", 0.8, 0.964), rung("b", "500M", 0.2775, 0.795)];
    for (const m of markets) delete (m.metadata as Record<string, unknown>).eventKey;
    const res = normalizeRelatedMarkets(markets);
    expect(res.adjustedCount).toBe(0);
    expect(markets[1]!.aiEstimate.yesProbability).toBe(0.2775);
  });

  it("keeps a closing threshold that sits among real bands", () => {
    // "at least 80%" is one-sided, but beside genuine 60–70% and 70–80% bands it
    // is the last slice of a partition, not a nested ladder. One real range in
    // the group is enough to keep the whole group in the rescale.
    const markets = [
      ...clactonLadder().slice(0, 2),
      fakeMarket({
        id: "c3",
        title: "Will Nigel Farage win at least 80% of votes in the Clacton parliamentary by-election?",
        category: "politics",
        metadata: { eventKey: "c3" },
        aiEstimate: {
          yesProbability: 0.03,
          confidence: 0.8,
          reasoning: "",
          sources: [],
          modelVersion: "test",
          updatedAt: new Date("2026-08-10T10:00:00Z"),
        },
      }),
    ];
    const res = normalizeRelatedMarkets(markets);
    expect(res.groupCount).toBe(1);
    const sum = markets.reduce((a, m) => a + m.aiEstimate.yesProbability, 0);
    expect(sum).toBeCloseTo(1.0, 9);
  });

  it("still rescales a genuine exclusive ladder", () => {
    // Guard against over-correcting: real disjoint bands must keep summing to 1.
    const markets = clactonLadder();
    const res = normalizeRelatedMarkets(markets);
    expect(res.groupCount).toBe(1);
    const sum = markets.reduce((a, m) => a + m.aiEstimate.yesProbability, 0);
    expect(sum).toBeCloseTo(1.0, 9);
  });

  function clactonLadder(): PredictionMarket[] {
    const mk = (id: string, title: string, p: number) =>
      fakeMarket({
        id,
        title,
        category: "politics",
        metadata: { eventKey: id },
        aiEstimate: {
          yesProbability: p,
          confidence: 0.8,
          reasoning: "",
          sources: [],
          modelVersion: "test",
          updatedAt: new Date("2026-08-10T10:00:00Z"),
        },
      });
    return [
      mk("c1", "Will Nigel Farage win 60–70% of votes in the Clacton parliamentary by-election?", 0.95),
      mk("c2", "Will Nigel Farage win 70–80% of votes in the Clacton parliamentary by-election?", 0.2),
      mk("c3", "Will Nigel Farage win 80–90% of votes in the Clacton parliamentary by-election?", 0.03),
    ];
  }
});

describe("anchor-weighted normalization does not clamp", () => {
  function m(id: string, p: number, venue: number, title: string): PredictionMarket {
    return fakeMarket({
      id,
      title,
      category: "politics",
      metadata: {
        eventKey: id,
        crowdQuote: {
          probability: venue,
          basis: "orderbook_mid",
          venue: "polymarket",
          spread: 0.01,
          asOf: new Date("2026-09-10T08:00:00Z"),
        },
      },
      aiEstimate: {
        yesProbability: p,
        confidence: 0.7,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: new Date("2026-09-10T07:00:00Z"),
      },
    });
  }

  it("keeps a far-from-market estimate anchored when the cut overshoots", () => {
    // The nine-candidate 2026 Brazilian field, whose raw estimates sum to 177%.
    // A single-pass distance-weighted cut drives at least one member negative
    // here, so the overshoot path runs. It must still ANCHOR: the 75% estimate
    // priced at 0.5% by the venue has to come down hard. Plain proportional
    // would lift it to 42% — further from the market than before normalizing —
    // which is exactly what anchor weighting exists to prevent.
    const field: Array<[string, number, number]> = [
      ["zema", 0.75, 0.005],
      ["caiado", 0.005, 0.003],
      ["santos", 0.02, 0.019],
      ["lula", 0.57, 0.515],
      ["marcal", 0.015, 0.001],
      ["bolsonaro", 0.39, 0.465],
      ["alckmin", 0.01, 0.002],
      ["cury", 0.01, 0.003],
      ["jair", 0.001, 0.002],
    ];
    const markets = field.map(([name, ai, venue]) =>
      m(name, ai, venue, `Will ${name}-example win the 2026 Brazilian presidential election?`),
    );
    normalizeRelatedMarkets(markets);

    const sum = markets.reduce((a, k) => a + k.aiEstimate.yesProbability, 0);
    expect(sum).toBeCloseTo(1.0, 6);

    const zema = markets[0]!.aiEstimate.yesProbability;
    // Anchored: well below the proportional result of 0.75 / 1.771 = 0.423.
    expect(zema).toBeLessThan(0.2);
    // And not driven to the floor either — it is a cut, not a clamp.
    expect(zema).toBeGreaterThan(0.001);

    // Lula sits near its venue price and must keep roughly its own number
    // rather than absorbing someone else's error.
    expect(markets[3]!.aiEstimate.yesProbability).toBeGreaterThan(0.4);
  });

  it("never leaves a member below the floor", () => {
    const markets = [
      m("x1", 0.9, 0.9, "Will candidate-a-example win the 2028 mayoral election?"),
      m("x2", 0.7, 0.7, "Will candidate-b-example win the 2028 mayoral election?"),
      m("x3", 0.1, 0.85, "Will candidate-c-example win the 2028 mayoral election?"),
    ];
    normalizeRelatedMarkets(markets);

    const sum = markets.reduce((a, k) => a + k.aiEstimate.yesProbability, 0);
    expect(sum).toBeCloseTo(1.0, 6);
    for (const k of markets) {
      expect(k.aiEstimate.yesProbability).toBeGreaterThanOrEqual(0.001);
      expect(Number.isFinite(k.aiEstimate.yesProbability)).toBe(true);
    }
  });
});

