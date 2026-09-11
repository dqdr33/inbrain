/**
 * normaliseAlpha's urgency handling.
 *
 * The pipeline asks the model for an urgency and accepts "high" | "medium" |
 * "low". Anything else — a missing field, a typo, a truncated response — used to
 * become "low" silently, and the report printed that identically to a low the
 * model actually chose. On 2026-09-10 five opportunities changed label on the
 * same day, which read as a considered de-escalation and could equally have
 * been five malformed rows. These tests keep the two distinguishable.
 */

import { describe, test, expect } from "bun:test";
import { normaliseAlpha, findAlphaCandidates } from "../../src/prediction/analyst-agent.ts";
import type { PredictionMarket } from "../../src/prediction/types.ts";

describe("normaliseAlpha urgency", () => {
  test("keeps an urgency the model actually stated", () => {
    const out = normaliseAlpha([
      { title: "A", reasoning: "r", urgency: "high" },
      { title: "B", reasoning: "r", urgency: "medium" },
      { title: "C", reasoning: "r", urgency: "low" },
    ]);
    expect(out.map((o) => o.urgency)).toEqual(["high", "medium", "low"]);
    for (const o of out) expect(o.urgencyUnstated).toBeUndefined();
  });

  test("flags a missing urgency instead of inventing a verdict", () => {
    const out = normaliseAlpha([{ title: "A", reasoning: "r" }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.urgency).toBe("low");
    expect(out[0]!.urgencyUnstated).toBe(true);
  });

  test("flags a malformed urgency the same way", () => {
    const out = normaliseAlpha([
      { title: "A", reasoning: "r", urgency: "URGENT" },
      { title: "B", reasoning: "r", urgency: 3 },
      { title: "C", reasoning: "r", urgency: null },
    ]);
    expect(out).toHaveLength(3);
    for (const o of out) {
      expect(o.urgency).toBe("low");
      expect(o.urgencyUnstated).toBe(true);
    }
  });

  test("a whole batch losing its urgency stays visible as such", () => {
    // The shape of the 2026-09-10 report: every row unrated at once. If this
    // ever collapses back to plain "low", the signal is gone again.
    const out = normaliseAlpha(
      Array.from({ length: 5 }, (_, i) => ({ title: `M${i}`, reasoning: "r" })),
    );
    expect(out.every((o) => o.urgencyUnstated === true)).toBe(true);
  });
});

describe("alpha candidates carry a closing date", () => {
  const NOW = new Date("2026-09-10T11:00:00Z");

  function market(id: string, ai: number, venue: number, expiresAt: string): PredictionMarket {
    return {
      id,
      title: `${id} question?`,
      description: "",
      category: "finance",
      status: "active",
      createdAt: new Date("2026-09-01"),
      expiresAt: new Date(expiresAt),
      aiEstimate: {
        yesProbability: ai,
        confidence: 0.7,
        reasoning: "",
        sources: [],
        modelVersion: "test",
        updatedAt: NOW,
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
      metadata: {
        crowdQuote: {
          probability: venue,
          basis: "orderbook_mid",
          venue: "polymarket",
          asOf: NOW.toISOString(),
        },
      },
    };
  }

  test("a failed estimate is never screened as an opportunity", () => {
    // The 2026-09-11 report offered "Tom Cotton, 50% vs the market's 0.1%" as an
    // opportunity. The 50% was the parse-failure placeholder, and 0.5 sits ~50
    // points from the near-zero price of exactly the long-shot questions whose
    // answers fail — so a JSON error became the day's largest disagreement, and
    // the analyst model wrote a political rationale for it.
    const broken = market("broken", 0.5, 0.0015, "2026-12-31T00:00:00Z");
    broken.aiEstimate.estimateFailed = true;
    broken.aiEstimate.confidence = 0;

    expect(findAlphaCandidates([broken], { now: NOW })).toHaveLength(0);
  });

  test("zero confidence alone is enough to exclude", () => {
    // A producer that zeroes confidence without setting the marker must still
    // be caught: no confidence means no belief, whatever the number beside it.
    const declined = market("declined", 0.5, 0.0015, "2026-12-31T00:00:00Z");
    declined.aiEstimate.confidence = 0;

    expect(findAlphaCandidates([declined], { now: NOW })).toHaveLength(0);
  });

  test("a pre-marker failure row is excluded by its legacy signature", () => {
    // Rows written before `estimateFailed` existed carry only 0.5 at confidence
    // 0.1 plus the catch block's wording. Three are live in the state today and
    // would keep surfacing until each is re-estimated.
    const legacy = market("legacy", 0.5, 0.0015, "2026-12-31T00:00:00Z");
    legacy.aiEstimate.confidence = 0.1;
    legacy.aiEstimate.reasoning =
      'Unable to generate estimate (not valid JSON (JSON Parse error: Unexpected identifier "Tom")) — using base rate';

    expect(findAlphaCandidates([legacy], { now: NOW })).toHaveLength(0);
  });

  test("a genuine coin-flip forecast at 0.5 is still screened", () => {
    // The legacy check requires the catch block's wording precisely so an
    // honest "genuinely balanced" 50% keeps reaching the report.
    const genuine = market("genuine", 0.5, 0.2, "2026-12-31T00:00:00Z");
    genuine.aiEstimate.confidence = 0.1;
    genuine.aiEstimate.reasoning = "Genuinely balanced — the evidence cuts both ways.";

    expect(findAlphaCandidates([genuine], { now: NOW })).toHaveLength(1);
  });

  test("a genuine low-confidence estimate is still screened", () => {
    // Low confidence is not zero confidence. A hesitant but real forecast must
    // keep reaching the report, or the guard would silently narrow coverage.
    const hesitant = market("hesitant", 0.2, 0.8, "2026-12-31T00:00:00Z");
    hesitant.aiEstimate.confidence = 0.1;

    expect(findAlphaCandidates([hesitant], { now: NOW })).toHaveLength(1);
  });

  test("closesAt reaches the candidate, so urgency can be judged on time", () => {
    // Without this the prompt showed only the size of the disagreement, and a
    // market closing next year looked exactly like one closing next week.
    const soon = market("soon", 0.2, 0.8, "2026-09-15T00:00:00Z");
    const distant = market("distant", 0.2, 0.8, "2026-12-31T00:00:00Z");
    const out = findAlphaCandidates([soon, distant], { now: NOW });

    expect(out).toHaveLength(2);
    const byId = new Map(out.map((c) => [c.marketId, c]));
    expect(byId.get("soon")!.closesAt?.toISOString().slice(0, 10)).toBe("2026-09-15");
    expect(byId.get("distant")!.closesAt?.toISOString().slice(0, 10)).toBe("2026-12-31");
  });
});
