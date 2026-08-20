import { describe, test, expect } from "bun:test";
import { BrainAgent } from "../../src/prediction/brain-agent.ts";
import { CALIBRATION_SLUG } from "../../src/prediction/calibration.ts";
import {
  IDENTITY_FIT,
  type CalibrationFit,
} from "../../src/prediction/calibration-fit.ts";
import type { PredictionSignal } from "../../src/prediction/types.ts";

function signal(content = "Will BTC close above 100k on 2026-12-31?"): PredictionSignal {
  return {
    id: "poly_test",
    source: "polymarket",
    content,
    timestamp: new Date(),
    entities: [],
    engagement: { likes: 500, reposts: 0, replies: 0 },
    rawData: { outcomes: '["Yes","No"]', outcomePrices: '["0.30","0.70"]' },
  };
}

/** A BrainAgent whose LLM returns canned responses in order. */
function agentWith(responses: string[], qualityThreshold = 55) {
  let i = 0;
  const calls: Array<{ system: string; prompt: string }> = [];
  const writes: Array<{ slug: string; content: string }> = [];
  const agent = new BrainAgent({
    qualityThreshold,
    brainQuery: async () => "",
    brainWrite: async (slug, content) => {
      writes.push({ slug, content });
    },
    llmCall: async (system, prompt) => {
      calls.push({ system, prompt });
      return responses[Math.min(i++, responses.length - 1)];
    },
  });
  return { agent, calls, writes };
}

const GOOD_QUALITY = JSON.stringify({
  verifiability: 90,
  historicalSimilarity: 80,
  communityPotential: 80,
  liquidityPotential: 70,
  timelineFeasibility: 90,
  reasoning: "clear deadline, objective resolution",
  historicalCases: [],
  risks: [],
});

const GOOD_ESTIMATE = JSON.stringify({
  yesProbability: 0.32,
  confidence: 0.7,
  reasoning: "crowd sits near 30%",
  sources: [],
  estimatedResolutionDays: 45,
});

describe("quality gate", () => {
  test("accepts a well-formed high-quality signal", async () => {
    const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
    const result = await agent.evaluate(signal());
    expect(result.accepted).toBe(true);
  });

  test("computes the weighted score from the five dimensions", async () => {
    const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
    const result = await agent.evaluate(signal());
    // 0.30*90 + 0.20*80 + 0.20*80 + 0.15*70 + 0.15*90
    // = 27 + 16 + 16 + 10.5 + 13.5 = 83
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.qualityScore.overall).toBe(83);
  });

  test("rejects when the score is below the threshold", async () => {
    const low = JSON.stringify({
      verifiability: 10,
      historicalSimilarity: 10,
      communityPotential: 10,
      liquidityPotential: 10,
      timelineFeasibility: 10,
      reasoning: "vague",
      historicalCases: [],
      risks: [],
    });
    const { agent } = agentWith([low]);
    const result = await agent.evaluate(signal());
    expect(result.accepted).toBe(false);
  });

  // The headline regression: 0.30 * undefined === NaN, and NaN < threshold is
  // false, so an incomplete assessment used to be ACCEPTED.
  test("a missing dimension is a rejection, not an acceptance", async () => {
    const incomplete = JSON.stringify({
      verifiability: 95,
      // historicalSimilarity missing
      communityPotential: 90,
      liquidityPotential: 90,
      timelineFeasibility: 95,
      reasoning: "looks fine",
    });
    const { agent } = agentWith([incomplete]);
    const result = await agent.evaluate(signal());
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    expect(result.reason).toContain("0");
  });

  test("prose instead of JSON is a rejection", async () => {
    const { agent } = agentWith(["I'm not able to score this."]);
    const result = await agent.evaluate(signal());
    expect(result.accepted).toBe(false);
  });

  test("handles a fenced JSON response", async () => {
    const { agent } = agentWith(["```json\n" + GOOD_QUALITY + "\n```", GOOD_ESTIMATE]);
    const result = await agent.evaluate(signal());
    expect(result.accepted).toBe(true);
  });
});

describe("estimate validation", () => {
  test("clamps the resolution horizon into 1-365 days", async () => {
    const wild = JSON.stringify({
      yesProbability: 0.4,
      confidence: 0.6,
      reasoning: "x",
      sources: [],
      estimatedResolutionDays: 99999,
    });
    const { agent } = agentWith([GOOD_QUALITY, wild]);
    // A question with no date of its own, so the LLM horizon is what drives the
    // expiry and the clamp is actually exercised. It has to be a genuine
    // question: "Binance delists BTTC and POWR" is an announcement about an
    // event that already happened, and reportsSettledFact now rejects those
    // before any estimate is made.
    const result = await agent.evaluate(signal("Will BTTC be relisted on a major exchange?"));
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.aiEstimate.estimatedResolutionDays).toBe(365);
    const days = (result.market.expiresAt.getTime() - result.market.createdAt.getTime()) / 86_400_000;
    expect(days).toBeLessThanOrEqual(366);
    expect(result.market.metadata.expirySource).toBe("llm");
  });

  test("falls back to the base rate when the estimate is unusable", async () => {
    const { agent } = agentWith([GOOD_QUALITY, "no idea"]);
    const result = await agent.evaluate(signal());
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.aiEstimate.yesProbability).toBe(0.5);
    expect(result.market.aiEstimate.confidence).toBe(0.1);
  });

  test("never stores an undefined probability", async () => {
    const noProb = JSON.stringify({ confidence: 0.8, reasoning: "x", sources: [] });
    const { agent } = agentWith([GOOD_QUALITY, noProb]);
    const result = await agent.evaluate(signal());
    if (!result.accepted) throw new Error("expected acceptance");
    expect(Number.isFinite(result.market.aiEstimate.yesProbability)).toBe(true);
  });
});

describe("crowd probability", () => {
  // AnalystAgent.discoverAlpha reads metadata.crowdProbability; nothing wrote it.
  test("is carried into market metadata", async () => {
    const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
    const result = await agent.evaluate(signal());
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.metadata.crowdProbability).toBeCloseTo(0.3, 6);
  });

  test("the full quote travels with it, so the report can name its source", async () => {
    const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
    const result = await agent.evaluate(signal());
    if (!result.accepted) throw new Error("expected acceptance");
    const quote = result.market.metadata.crowdQuote as { venue: string; basis: string };
    expect(quote.venue).toBe("polymarket");
    expect(quote.basis).toBe("venue_mid");
    expect(result.market.metadata.venue).toBe("polymarket");
  });
});

describe("expiry", () => {
  // expiresAt was Date.now() + the model's guess, unconditionally. A market
  // asking about August 9 therefore stayed "live" a month past its deadline.
  test("the venue's close date wins over the model's horizon", async () => {
    const s = signal("Israel x Iran ceasefire continues through August 9?");
    s.deadline = new Date("2026-08-09T23:59:00Z");
    const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
    const result = await agent.evaluate(s);
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.expiresAt.toISOString()).toBe("2026-08-09T23:59:00.000Z");
    expect(result.market.metadata.expirySource).toBe("venue");
  });

  test("a deadline stated in the title is used when the venue has none", async () => {
    const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
    const result = await agent.evaluate(
      signal("Will the Fed hold rates through December 31, 2026?"),
    );
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.expiresAt.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(result.market.metadata.expirySource).toBe("title");
    expect(result.market.metadata.deadlineFraming).toBe("cumulative");
  });

  test("a market whose venue deadline has already passed is built expired, not extended", async () => {
    const s = signal("US x Iran effective ceasefire by July 31?");
    s.deadline = new Date("2026-07-31T12:00:00Z");
    const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
    const result = await agent.evaluate(s);
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.expiresAt.getTime()).toBeLessThan(result.market.createdAt.getTime());
  });
});

describe("calibration lookup", () => {
  test("is fetched once per agent, not once per signal", async () => {
    let queries = 0;
    const agent = new BrainAgent({
      brainQuery: async () => {
        queries++;
        return "";
      },
      brainWrite: async () => {},
      llmCall: async () => GOOD_QUALITY,
    });
    // Real questions: a bare token is rejected by reportsSettledFact before any
    // brain query is made, so the counter would never move.
    await agent.evaluate(signal("Will A happen by December 2026?"));
    await agent.evaluate(signal("Will B happen by December 2026?"));
    // Two historical-context lookups (one per signal) + exactly one calibration.
    expect(queries).toBe(3);
  });

  test("prefers an exact-slug fetch over the fuzzy search", async () => {
    // The original bug: a page whose address is known was retrieved by a top-5
    // semantic search over the whole brain, which could silently lose and hand
    // back "" with nothing able to tell.
    const slugs: string[] = [];
    let fuzzyQueries = 0;
    const agent = new BrainAgent({
      brainQuery: async () => {
        fuzzyQueries++;
        return "";
      },
      brainGet: async (slug) => {
        slugs.push(slug);
        return "# page";
      },
      brainWrite: async () => {},
      llmCall: async () => GOOD_QUALITY,
    });

    await agent.evaluate(signal("Will A happen by December 2026?"));
    expect(slugs).toEqual([CALIBRATION_SLUG]);
    // The one remaining fuzzy query is the historical context, not calibration.
    expect(fuzzyQueries).toBe(1);
  });

  test("the calibration page actually reaches the estimator's prompt", async () => {
    // The existing test above counts calls; it cannot tell whether the text is
    // used. Nothing previously proved the retrieved page influenced anything.
    const MARKER = "ZZ_CALIBRATION_MARKER_ZZ";
    const withPage = await captureSystemPrompts(async () => MARKER);
    const withoutPage = await captureSystemPrompts(async () => "");

    expect(withPage.some((s) => s.includes(MARKER))).toBe(true);
    expect(withoutPage.some((s) => s.includes(MARKER))).toBe(false);
    expect(withPage.join("|")).not.toBe(withoutPage.join("|"));
  });

  async function captureSystemPrompts(
    brainGet: (slug: string) => Promise<string>,
  ): Promise<string[]> {
    const systems: string[] = [];
    let i = 0;
    const responses = [GOOD_QUALITY, GOOD_ESTIMATE];
    const agent = new BrainAgent({
      brainQuery: async () => "",
      brainGet,
      brainWrite: async () => {},
      llmCall: async (system) => {
        systems.push(system);
        return responses[Math.min(i++, responses.length - 1)]!;
      },
    });
    await agent.evaluate(signal("Will A happen by December 2026?"));
    return systems;
  }
});

describe("calibration is applied to the live estimate", () => {
  const nonIdentity: CalibrationFit = {
    ...IDENTITY_FIT,
    method: "platt",
    a: 1.3,
    b: -0.4,
    n: 500,
    shrink: 1,
  };

  test("the raw belief is preserved alongside the adjusted one", async () => {
    // rawYesProbability is the ONLY field a future fit may train on. Without it
    // the correction compounds nightly until every forecast is the base rate.
    let i = 0;
    const responses = [GOOD_QUALITY, GOOD_ESTIMATE];
    const agent = new BrainAgent({
      brainQuery: async () => "",
      brainWrite: async () => {},
      llmCall: async () => responses[Math.min(i++, responses.length - 1)]!,
      calibrationFit: nonIdentity,
    });

    const result = await agent.evaluate(signal());
    if (!result.accepted) throw new Error("expected acceptance");
    const est = result.market.aiEstimate;

    expect(est.rawYesProbability).toBe(0.32);
    expect(est.calibration?.method).toBe("platt");
    // The audit trail records both stages. This fit (a=1.3, b=-0.4) pushes 0.32
    // down to ~0.20, well below the 0.30 price, and the shrink then pulls it
    // back up toward the market — both steps stay visible and checkable.
    expect(est.calibration!.afterCalibration).toBeLessThan(0.25);
    expect(est.calibration?.priceShrinkApplied).toBe(true);
    expect(est.yesProbability).toBeGreaterThan(est.calibration!.afterCalibration);
    expect(est.yesProbability).toBeLessThan(0.3);
  });

  test("a large departure from the price IS shrunk toward it", async () => {
    const farOff = JSON.stringify({
      yesProbability: 0.8,
      confidence: 0.7,
      reasoning: "",
      sources: [],
      estimatedResolutionDays: 45,
    });
    let i = 0;
    const responses = [GOOD_QUALITY, farOff];
    const agent = new BrainAgent({
      brainQuery: async () => "",
      brainWrite: async () => {},
      llmCall: async () => responses[Math.min(i++, responses.length - 1)]!,
    });

    // Signal price is 0.30 and the model says 0.80 — the departure class the
    // backtest showed to be value-destroying.
    const result = await agent.evaluate(signal());
    if (!result.accepted) throw new Error("expected acceptance");
    const est = result.market.aiEstimate;

    expect(est.rawYesProbability).toBe(0.8);
    expect(est.calibration?.priceShrinkApplied).toBe(true);
    expect(est.yesProbability).toBeLessThan(0.8);
    expect(est.yesProbability).toBeGreaterThan(0.3);
  });

  test("an identity fit and no price leave the estimate untouched", async () => {
    const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
    const noPrice = { ...signal(), rawData: {} };
    const result = await agent.evaluate(noPrice);
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.aiEstimate.yesProbability).toBe(0.32);
    expect(result.market.aiEstimate.rawYesProbability).toBe(0.32);
  });

  test("the parse-failure fallback stays exactly 0.5 at confidence 0.1", async () => {
    // The backtest and the learning set both detect this fallback by its exact
    // signature. Calibrating it would make every historical parse failure
    // invisible and re-admit it as a genuine mid-range forecast.
    let i = 0;
    const responses = [GOOD_QUALITY, "I cannot answer in JSON."];
    const agent = new BrainAgent({
      brainQuery: async () => "",
      brainWrite: async () => {},
      llmCall: async () => responses[Math.min(i++, responses.length - 1)]!,
      calibrationFit: nonIdentity,
    });

    const result = await agent.evaluate(signal());
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.aiEstimate.yesProbability).toBe(0.5);
    expect(result.market.aiEstimate.confidence).toBe(0.1);
  });

  test("the political clamp still caps a distant race under an active fit", async () => {
    // The clamp is a hard domain rule and must run BEFORE calibration, so no
    // statistical correction can lift a value back over the ceiling.
    const bullish = JSON.stringify({
      yesProbability: 0.9,
      confidence: 0.8,
      reasoning: "",
      sources: [],
      estimatedResolutionDays: 300,
    });
    let i = 0;
    const responses = [GOOD_QUALITY, bullish];
    const agent = new BrainAgent({
      brainQuery: async () => "",
      brainWrite: async () => {},
      llmCall: async () => responses[Math.min(i++, responses.length - 1)]!,
      calibrationFit: { ...IDENTITY_FIT, method: "platt", a: 1.5, b: 1, n: 500, shrink: 1 },
    });

    const s = { ...signal("Who wins the 2028 presidential election?"), rawData: {} };
    const result = await agent.evaluate(s);
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.aiEstimate.rawYesProbability).toBe(0.35);
    expect(result.market.aiEstimate.yesProbability).toBeLessThanOrEqual(0.35);
  });
});

describe("category inference", () => {
  const cases: Array<[string, string]> = [
    ["Will Bitcoin close above 100k?", "crypto"],
    ["Will the Fed cut rates in September?", "finance"],
    ["Who wins the presidential election?", "politics"],
    ["LoL: Team WE vs ThunderTalk Gaming - Game 2 Winner", "sports"],
    ["Will the SEC approve the filing?", "regulation"],
  ];

  for (const [content, expected] of cases) {
    test(`"${content.slice(0, 40)}" -> ${expected}`, async () => {
      const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
      const result = await agent.evaluate(signal(content));
      if (!result.accepted) throw new Error("expected acceptance");
      expect(result.market.category).toBe(expected as never);
    });
  }

  // Substring matching sent nearly everything to "technology": "ai" matches
  // inside said/chain/raise/available, "sec" inside second/sector.
  test("does not classify on substrings inside unrelated words", async () => {
    const { agent } = agentWith([GOOD_QUALITY, GOOD_ESTIMATE]);
    const result = await agent.evaluate(signal("The chain said it will be available in the second half"));
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.category).toBe("other");
  });
});
