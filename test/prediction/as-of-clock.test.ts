/**
 * The `now` injection that makes retrodiction possible.
 *
 * A backtest evaluates a past signal as of a past date. If ANY date the agent
 * reasons about still reads the system clock, the model is told today's date
 * while being asked about a question that closed months ago — it then reasons
 * about a horizon that has already elapsed, and the resulting score is
 * meaningless in a way no downstream check can detect.
 *
 * These tests pin the seam shut.
 */
import { describe, test, expect } from "bun:test";
import { BrainAgent } from "../../src/prediction/brain-agent.ts";
import type { PredictionSignal } from "../../src/prediction/types.ts";

const AS_OF = new Date("2026-02-15T00:00:00.000Z");

function signal(overrides: Partial<PredictionSignal> = {}): PredictionSignal {
  return {
    id: "poly_asof",
    source: "polymarket",
    content: "Will BTC close above 100k?",
    timestamp: AS_OF,
    entities: [],
    engagement: { likes: 500, reposts: 0, replies: 0 },
    rawData: { outcomes: '["Yes","No"]', outcomePrices: '["0.30","0.70"]' },
    ...overrides,
  };
}

const GOOD_QUALITY = JSON.stringify({
  verifiability: 90,
  historicalSimilarity: 80,
  communityPotential: 80,
  liquidityPotential: 70,
  timelineFeasibility: 90,
  reasoning: "clear deadline",
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

/** A BrainAgent frozen at `AS_OF`, capturing every prompt it builds. */
function asOfAgent(now: Date = AS_OF) {
  const prompts: string[] = [];
  let i = 0;
  const responses = [GOOD_QUALITY, GOOD_ESTIMATE];
  const agent = new BrainAgent({
    qualityThreshold: 55,
    brainQuery: async () => "",
    brainWrite: async () => {},
    now: () => now,
    llmCall: async (_system, prompt) => {
      prompts.push(prompt);
      return responses[Math.min(i++, responses.length - 1)]!;
    },
  });
  return { agent, prompts };
}

describe("as-of clock injection", () => {
  test("both prompts state the injected date, not today", () => {
    // Guard against the test passing by coincidence if someone runs it on AS_OF.
    expect(new Date().toISOString().slice(0, 10)).not.toBe("2026-02-15");
  });

  test("the quality prompt says TODAY IS <as-of>", async () => {
    const { agent, prompts } = asOfAgent();
    await agent.evaluate(signal());
    expect(prompts[0]).toContain("TODAY IS 2026-02-15");
  });

  test("the estimate prompt says TODAY IS <as-of>", async () => {
    const { agent, prompts } = asOfAgent();
    await agent.evaluate(signal());
    expect(prompts[1]).toContain("TODAY IS 2026-02-15");
  });

  test("no prompt leaks the real current date", async () => {
    const { agent, prompts } = asOfAgent();
    await agent.evaluate(signal());
    const today = new Date().toISOString().slice(0, 10);
    for (const p of prompts) expect(p).not.toContain(`TODAY IS ${today}`);
  });

  test("the horizon is measured from the as-of date, not from today", async () => {
    // 30 days after AS_OF. Measured from the real clock this would be a large
    // negative number, and the model would be reasoning about a dead question.
    const deadline = new Date("2026-03-17T00:00:00.000Z");
    const { agent, prompts } = asOfAgent();
    await agent.evaluate(signal({ deadline }));
    expect(prompts[1]).toContain("closes 2026-03-17");
    expect(prompts[1]).toContain("30 days from now");
  });

  test("createdAt and estimate.updatedAt carry the as-of date", async () => {
    const { agent } = asOfAgent();
    const result = await agent.evaluate(signal());
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.createdAt.toISOString()).toBe(AS_OF.toISOString());
    expect(result.market.aiEstimate.updatedAt.toISOString()).toBe(AS_OF.toISOString());
  });

  test("the LLM expiry fallback is measured from the as-of date", async () => {
    // No venue deadline and no date in the title, so expiry falls back to
    // as-of + estimatedResolutionDays (45). Off the real clock this lands in
    // the wrong year entirely.
    const { agent } = asOfAgent();
    const result = await agent.evaluate(signal({ deadline: undefined }));
    if (!result.accepted) throw new Error("expected acceptance");
    expect(result.market.metadata.expirySource).toBe("llm");
    const expected = new Date(AS_OF.getTime() + 45 * 86_400_000);
    expect(result.market.expiresAt.toISOString()).toBe(expected.toISOString());
  });

  test("a different as-of date moves every date with it", async () => {
    const other = new Date("2025-08-01T00:00:00.000Z");
    const { agent, prompts } = asOfAgent(other);
    const result = await agent.evaluate(signal({ deadline: undefined }));
    if (!result.accepted) throw new Error("expected acceptance");
    expect(prompts[0]).toContain("TODAY IS 2025-08-01");
    expect(prompts[1]).toContain("TODAY IS 2025-08-01");
    expect(result.market.createdAt.toISOString()).toBe(other.toISOString());
  });

  test("defaults to the system clock when no `now` is supplied", async () => {
    // The live pipeline passes nothing; it must keep behaving exactly as before.
    const prompts: string[] = [];
    let i = 0;
    const responses = [GOOD_QUALITY, GOOD_ESTIMATE];
    const agent = new BrainAgent({
      qualityThreshold: 55,
      brainQuery: async () => "",
      brainWrite: async () => {},
      llmCall: async (_s, prompt) => {
        prompts.push(prompt);
        return responses[Math.min(i++, responses.length - 1)]!;
      },
    });
    await agent.evaluate(signal());
    const today = new Date().toISOString().slice(0, 10);
    expect(prompts[0]).toContain(`TODAY IS ${today}`);
  });
});
