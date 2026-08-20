/**
 * Blind-mode guards — the control run's integrity.
 *
 * The blind run is the only thing that distinguishes forecasting from recall.
 * If any path leaks the market price into a blind evaluation, the control
 * agrees with the priced run, the leak looks like a null result, and the whole
 * backtest silently loses its ability to detect memorisation.
 */
import { describe, test, expect } from "bun:test";
import { replayOne } from "../../src/prediction/backtest/replay.ts";
import type { MarketSnapshot } from "../../src/prediction/backtest/snapshot.ts";

const DAY = 86_400;
const T0 = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);

function snap(): MarketSnapshot {
  return {
    id: "m-blind",
    venue: "polymarket",
    question: "Will X happen by the deadline?",
    createdAt: new Date(T0 * 1000).toISOString(),
    endDate: new Date((T0 + 100 * DAY) * 1000).toISOString(),
    outcome: true,
    volume: 5_000_000,
    history: [
      { t: T0, p: 0.2 },
      { t: T0 + 10 * DAY, p: 0.37 },
      { t: T0 + 90 * DAY, p: 0.99 },
    ],
  };
}

const QUALITY = JSON.stringify({
  verifiability: 90,
  historicalSimilarity: 70,
  communityPotential: 70,
  liquidityPotential: 80,
  timelineFeasibility: 85,
  reasoning: "ok",
  historicalCases: [],
  risks: [],
});
const ESTIMATE = JSON.stringify({
  yesProbability: 0.4,
  confidence: 0.6,
  reasoning: "reasoned",
  sources: [],
  estimatedResolutionDays: 60,
});

/** Capture every prompt and system message the agent builds. */
function capturing() {
  const seen: string[] = [];
  let i = 0;
  const responses = [QUALITY, ESTIMATE];
  const llmCall = async (system: string, prompt: string) => {
    seen.push(system, prompt);
    return responses[Math.min(i++, responses.length - 1)]!;
  };
  return { llmCall, seen };
}

const AS_OF = new Date((T0 + 20 * DAY) * 1000);

describe("blind mode", () => {
  test("the price appears in a priced run", async () => {
    // Control for the test below: prove the price IS visible normally, so a
    // blind pass cannot be an artifact of looking in the wrong place.
    const { llmCall, seen } = capturing();
    await replayOne(snap(), AS_OF, { llmCall });
    const all = seen.join("\n");
    expect(all).toContain("LIVE MARKET PRICE");
    expect(all).toContain("37");
  });

  test("no prompt carries the market price in blind mode", async () => {
    const { llmCall, seen } = capturing();
    await replayOne(snap(), AS_OF, { llmCall, blind: true });
    const all = seen.join("\n");
    expect(all).not.toContain("LIVE MARKET PRICE (your starting point)");
    // 0.37 was the as-of price; it must appear nowhere, in any formatting.
    expect(all).not.toContain("0.37");
    expect(all).not.toContain("37%");
  });

  test("blind mode strips outcomePrices from rawData, not just the prompt", async () => {
    // crowd.ts recovers the quote from rawData. A leftover field there would
    // silently re-anchor the control run even with the prompt block gone.
    const { llmCall, seen } = capturing();
    await replayOne(snap(), AS_OF, { llmCall, blind: true });
    const all = seen.join("\n");
    expect(all).not.toContain("outcomePrices");
  });

  test("blind mode still tells the model the correct as-of date", async () => {
    // Withholding the price must not also withhold the clock, or the control
    // run stops being comparable to the priced run.
    const { llmCall, seen } = capturing();
    await replayOne(snap(), AS_OF, { llmCall, blind: true });
    expect(seen.join("\n")).toContain("TODAY IS 2026-01-21");
  });

  test("blind mode instructs the model to fall back to base rates", async () => {
    const { llmCall, seen } = capturing();
    await replayOne(snap(), AS_OF, { llmCall, blind: true });
    expect(seen.join("\n")).toContain("LIVE MARKET PRICE: none available");
  });

  test("the scored record keeps the true market price for baseline comparison", async () => {
    // The AGENT must not see the price; the SCORER must, or the market baseline
    // cannot be computed for the blind cohort.
    const { llmCall } = capturing();
    const r = (await replayOne(snap(), AS_OF, { llmCall, blind: true }))!;
    expect(r.record.marketPrice).toBeCloseTo(0.37, 6);
    expect(r.marketPrice).toBeCloseTo(0.37, 6);
  });

  test("neither mode leaks the post-as-of price path to the model", async () => {
    // The market later ran to 0.99 and settled YES. Only the 0.37 point at the
    // as-of date may be visible; the later prices are the future.
    //
    // Checked as explicit numbers, NOT by searching for words like "resolved" —
    // that appears innocently in the prompt's own vocabulary
    // ("estimatedResolutionDays", "resolves YES") and would fail for no reason.
    for (const blind of [false, true]) {
      const { llmCall, seen } = capturing();
      await replayOne(snap(), AS_OF, { llmCall, blind });
      const all = seen.join("\n");
      expect(all).not.toContain("0.99");
      expect(all).not.toContain("99%");
    }
  });

  test("the ground-truth outcome never reaches the model in either mode", async () => {
    // The signal is serialised wholesale into the quality prompt, so a stray
    // field on the signal object leaks straight through. Assert on the SIGNAL
    // payload rather than the whole prompt: the prompt legitimately contains
    // the word "outcome" in the response schema it asks the model to fill in
    // (historicalCases[].outcome), which is the model's output, not our truth.
    for (const blind of [false, true]) {
      const { llmCall, seen } = capturing();
      await replayOne(snap(), AS_OF, { llmCall, blind });
      const qualityPrompt = seen[1]!;
      const signalJson = qualityPrompt.slice(
        qualityPrompt.indexOf("Signal: ") + "Signal: ".length,
        qualityPrompt.indexOf("TODAY IS"),
      );
      const parsed = JSON.parse(signalJson) as Record<string, unknown>;
      const raw = (parsed.rawData ?? {}) as Record<string, unknown>;

      // Parsed rather than substring-matched: the priced signal legitimately
      // carries `outcomes` (the ["Yes","No"] labels) and `outcomePrices` (the
      // as-of quote), and a naive search for "outcome" hits both.
      expect(Object.keys(parsed)).not.toContain("outcome");
      expect(Object.keys(raw)).not.toContain("outcome");
      expect(Object.keys(raw)).not.toContain("resolution");
      expect(Object.keys(raw)).not.toContain("closedTime");
    }
  });

  test("the forecast is recorded against the true outcome", async () => {
    const { llmCall } = capturing();
    const r = (await replayOne(snap(), AS_OF, { llmCall }))!;
    expect(r.record.outcome).toBe(true);
    expect(r.record.forecast).toBeCloseTo(0.4, 6);
    expect(r.record.horizonDays).toBeCloseTo(80, 6);
  });
});

describe("parse-failure fallbacks are not forecasts", () => {
  /** BrainAgent's validation-failure path answers 0.5 at confidence 0.1. */
  function brokenEstimate() {
    let i = 0;
    return async () => {
      i++;
      return i === 1 ? QUALITY : "I cannot answer that in JSON.";
    };
  }

  test("a 0.5/0.1 fallback is recorded as NaN, not as a real 50% call", async () => {
    // Scoring it as a genuine 50% both inflates Brier against the usual NO
    // outcome and fabricates a maximum-divergence-from-market row no model
    // actually expressed.
    const r = (await replayOne(snap(), AS_OF, { llmCall: brokenEstimate() }))!;
    expect(Number.isNaN(r.record.forecast)).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain("could not be parsed");
  });

  test("a genuine 50% forecast at real confidence is kept", async () => {
    // The guard keys on confidence, so a model that honestly says "coin flip,
    // and I mean it" must still be scored.
    const genuine = JSON.stringify({
      yesProbability: 0.5,
      confidence: 0.8,
      reasoning: "genuinely balanced",
      sources: [],
      estimatedResolutionDays: 60,
    });
    let i = 0;
    const llmCall = async () => (++i === 1 ? QUALITY : genuine);
    const r = (await replayOne(snap(), AS_OF, { llmCall }))!;
    expect(r.record.forecast).toBeCloseTo(0.5, 6);
    expect(r.skipped).toBe(false);
  });
});
