import { describe, test, expect } from "bun:test";
import {
  formatReportMarkdown,
  formatTopMarkets,
  formatCrowdComparison,
  crowdQuoteOf,
} from "../../scripts/lib/report-format.ts";
import type { DailyReport } from "../../src/prediction/analyst-agent.ts";
import type { PredictionMarket } from "../../src/prediction/types.ts";
import type { CrowdQuote } from "../../src/prediction/crowd.ts";

const NOW = new Date("2026-08-12T10:00:00Z");

function market(
  id: string,
  title: string,
  opts: { ai: number; expiresAt: string; quote?: Partial<CrowdQuote>; volume?: number },
): PredictionMarket {
  return {
    id,
    title,
    description: "",
    category: "politics",
    status: "active",
    createdAt: NOW,
    expiresAt: new Date(opts.expiresAt),
    aiEstimate: {
      yesProbability: opts.ai,
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
      volume24hr: opts.volume ?? 0,
      crowdQuote: opts.quote
        ? {
            probability: 0.5,
            basis: "orderbook_mid",
            venue: "polymarket",
            asOf: NOW.toISOString(),
            ...opts.quote,
          }
        : undefined,
    },
  };
}

function report(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    date: NOW,
    summary: "Summary.",
    alphaOpportunities: [],
    trends: [],
    desyncs: [],
    normalizationConflicts: [],
    monotonicAdjustments: [],
    performanceMetrics: {
      totalActive: 2,
      resolvedToday: 0,
      expiredPending: 0,
      avgBrierScore: null,
      brierSampleSize: 0,
      bestPrediction: "",
      worstPrediction: "",
    },
    activeMarkets: 2,
    resolvedMarkets: 0,
    ...overrides,
  };
}

describe("expiry gate", () => {
  test("a market past its deadline appears in no section", () => {
    const expired = market("a", "Israel x Iran ceasefire continues through August 9?", {
      ai: 0.9,
      expiresAt: "2026-08-09T23:59:59Z",
      quote: { probability: 0.01 },
    });
    const live = market("b", "Fed holds rates by September 16?", {
      ai: 0.86,
      expiresAt: "2026-09-16T23:59:59Z",
      quote: { probability: 0.57 },
    });
    const md = formatReportMarkdown(report(), [expired, live], NOW);
    expect(md).not.toContain("August 9");
    expect(md).toContain("Fed holds rates");
  });

  test("expired-but-unresolved markets are counted out loud, not silently dropped", () => {
    const md = formatReportMarkdown(
      report({ performanceMetrics: { ...report().performanceMetrics, expiredPending: 3 } }),
      [],
      NOW,
    );
    expect(md).toContain("Срок вышел, итог ещё не подведён: 3");
  });

  test("nothing is said when nothing expired", () => {
    expect(formatReportMarkdown(report(), [], NOW)).not.toContain("Срок вышел, итог ещё не подведён");
  });
});

describe("provenance", () => {
  const live = market("b", "Fed holds rates by September 16?", {
    ai: 0.86,
    expiresAt: "2026-09-16T23:59:59Z",
    quote: { probability: 0.57, basis: "orderbook_mid", venue: "polymarket" },
  });

  // The defect this section exists to prevent: an AI estimate printed under a
  // heading a reader takes for market prices.
  test("Top Markets names both numbers and their sources", () => {
    const lines = formatTopMarkets([live], NOW).join("\n");
    expect(lines).toContain("наша оценка 86");
    expect(lines).toContain("57");
    expect(lines).toContain("Polymarket, живые заявки");
  });

  test("Top Markets carries the real close date", () => {
    expect(formatTopMarkets([live], NOW).join("\n")).toContain("срок до 2026-09-16");
  });

  test("Top Markets uses the market's own title verbatim", () => {
    expect(formatTopMarkets([live], NOW).join("\n")).toContain("Fed holds rates by September 16?");
  });

  test("a market with no crowd price shows only the AI estimate, still labelled", () => {
    const noQuote = market("c", "Telegram rumour resolves by September 1?", {
      ai: 0.4,
      expiresAt: "2026-09-01T00:00:00Z",
    });
    const lines = formatTopMarkets([noQuote], NOW).join("\n");
    expect(lines).toContain("наша оценка 40");
    expect(lines).not.toContain("venue");
  });

  test("AI vs Crowd says a gap is a disagreement, not an arbitrage", () => {
    const lines = formatCrowdComparison([live], NOW).join("\n");
    expect(lines).toContain("не найденная ошибка рынка");
  });

  test("a market with no crowd price is left out of AI vs Crowd entirely", () => {
    const noQuote = market("c", "Telegram rumour resolves by September 1?", {
      ai: 0.4,
      expiresAt: "2026-09-01T00:00:00Z",
    });
    expect(formatCrowdComparison([noQuote], NOW)).toEqual([]);
  });

  test("a market with an age-unknown phantom quote is left out of AI vs Crowd", () => {
    const phantomQuote = market("p", "Phantom venue quote resolves by September 1?", {
      ai: 0.75,
      expiresAt: "2026-09-01T00:00:00Z",
      quote: { probability: 0.004, asOf: "" }, // age unknown
    });
    expect(formatCrowdComparison([phantomQuote], NOW)).toEqual([]);
  });

  test("a divergence past the threshold is flagged", () => {
    const wide = market("d", "Hormuz traffic normal by September 30?", {
      ai: 0.95,
      expiresAt: "2026-09-30T00:00:00Z",
      quote: { probability: 0.165 },
    });
    expect(formatCrowdComparison([wide], NOW).join("\n")).toContain("расхождение стоит проверить");
  });

  test("a wide spread is called out", () => {
    const illiquid = market("e", "Thin market resolves by September 30?", {
      ai: 0.5,
      expiresAt: "2026-09-30T00:00:00Z",
      quote: { probability: 0.5, spread: 0.4 },
    });
    expect(formatTopMarkets([illiquid], NOW).join("\n")).toContain("между покупкой и продажей большой разрыв");
  });

  // Prices were rendered in the shortest honest form, so a 61.5% market printed
  // as "62%" beside an AI estimate of "61.5%" — two identical numbers reading as
  // a disagreement, with "(+0.0pp)" between them.
  test("identical AI and crowd numbers render identically", () => {
    const m = market("g", "Fed holds by September 16?", {
      ai: 0.615,
      expiresAt: "2026-09-16T00:00:00Z",
      quote: { probability: 0.615 },
    });
    const line = formatCrowdComparison([m], NOW).join("\n");
    expect(line).toContain("мы 61.5%");
    expect(line).toContain("61.5% (Polymarket, живые заявки)");
    expect(line).toContain("разница +0.0 п.п.");
  });

  test("half-point price differences survive rendering", () => {
    const m = market("h", "Hormuz normal by August 31?", {
      ai: 0.95,
      expiresAt: "2026-08-31T00:00:00Z",
      quote: { probability: 0.039 },
    });
    expect(formatCrowdComparison([m], NOW).join("\n")).toContain("3.9%");
  });

  // A long shot is exactly where the alpha section earns its keep; one decimal
  // must not collapse it to 0.0%.
  test("a long shot keeps a non-zero number", () => {
    const m = market("i", "Shakhtar win by June 30?", {
      ai: 0.001,
      expiresAt: "2027-06-30T00:00:00Z",
      quote: { probability: 0.0004 },
    });
    const line = formatCrowdComparison([m], NOW).join("\n");
    expect(line).toContain("мы 0.1%");
    expect(line).not.toContain("0.0%");
  });

  test("a stale quote (>300s) is omitted from venue display in Top Markets", () => {
    const stale = market("f", "Old quote by September 30?", {
      ai: 0.5,
      expiresAt: "2026-09-30T00:00:00Z",
      quote: { probability: 0.5, asOf: "2026-08-11T10:00:00Z" },
    });
    const rendered = formatTopMarkets([stale], NOW).join("\n");
    expect(rendered).toContain("наша оценка 50.0%");
    expect(rendered).not.toContain("venue ");
  });

  test("a fresh quote (<=300s) includes venue details", () => {
    const fresh = market("g", "Fresh quote by September 30?", {
      ai: 0.5,
      expiresAt: "2026-09-30T00:00:00Z",
      quote: { probability: 0.45, asOf: new Date(NOW.getTime() - 60_000).toISOString() },
    });
    const rendered = formatTopMarkets([fresh], NOW).join("\n");
    expect(rendered).toContain("рынок 45.0% (Polymarket, живые заявки)");
    expect(rendered).toContain("наша оценка 50.0%");
  });
});

describe("Top Markets ranking", () => {
  // The section led with five near-settled long shots (1.5%, 2%, 3%, 5%) — all
  // true, all dull. No-quote markets scored -1, which sorted ABOVE a real 0pp
  // agreement, so the top five were effectively arbitrary.
  test("an undecided market outranks a near-settled long shot", () => {
    const longShot = market("a", "Will a 2% long shot happen by September 30?", {
      ai: 0.02,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    const tossUp = market("b", "Will a genuine coin-flip happen by September 30?", {
      ai: 0.48,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    const lines = formatTopMarkets([longShot, tossUp], NOW);
    expect(lines[2]).toContain("coin-flip");
  });

  test("a verified disagreement outranks a mere toss-up", () => {
    const tossUp = market("b", "Will a genuine coin-flip happen by September 30?", {
      ai: 0.5,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    const disagreement = market("c", "Will we disagree with the venue by September 30?", {
      ai: 0.9,
      expiresAt: "2026-09-30T00:00:00Z",
      quote: { probability: 0.1, asOf: new Date(NOW.getTime() - 60_000).toISOString() },
    });
    const lines = formatTopMarkets([tossUp, disagreement], NOW);
    expect(lines[2]).toContain("disagree with the venue");
  });

  // The parse-failure sentinel is exactly 0.5 at confidence 0.1, and the
  // ranking's uncertainty bonus peaks at exactly 0.5 — so a Bybit giveaway
  // post whose LLM call returned unparseable JSON scored maximum interest and
  // led "Главное на сегодня" over real markets.
  test("a failed-estimate placeholder does not lead the section", () => {
    const placeholder = market("f", "Telegram Insider [bybit]: Grab your share of 100,000 USDC!", {
      ai: 0.5,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    placeholder.aiEstimate.confidence = 0.1;
    const real = market("g", "Will the Fed cut rates by September 30?", {
      ai: 0.2,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    const lines = formatTopMarkets([placeholder, real], NOW);
    expect(lines[2]).toContain("Fed cut rates");
  });

  // A genuine 50% is a real forecast — the guard above must not swallow it.
  test("a real coin-flip estimate still earns the uncertainty bonus", () => {
    const tossUp = market("h", "Will a genuine coin-flip happen by September 30?", {
      ai: 0.5,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    const longShot = market("i", "Will a 2% long shot happen by September 30?", {
      ai: 0.02,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    const lines = formatTopMarkets([longShot, tossUp], NOW);
    expect(lines[2]).toContain("coin-flip");
  });

  test("a sports fixture stays below analytical markets even when undecided", () => {
    const fixture = market("d", "Detroit Tigers vs. Pittsburgh Pirates", {
      ai: 0.5,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    const analytical = market("e", "Will the Fed cut rates by September 30?", {
      ai: 0.2,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    const lines = formatTopMarkets([fixture, analytical], NOW);
    expect(lines[2]).toContain("Fed cut rates");
  });
});

describe("crowdQuoteOf", () => {
  test("prefers the stored quote", () => {
    const m = market("a", "t by September 30?", {
      ai: 0.5,
      expiresAt: "2026-09-30T00:00:00Z",
      quote: { probability: 0.42, venue: "kalshi" },
    });
    expect(crowdQuoteOf(m)?.probability).toBeCloseTo(0.42, 6);
    expect(crowdQuoteOf(m)?.venue).toBe("kalshi");
  });

  // State files written before quotes carried provenance.
  test("falls back to a bare crowdProbability with an unknown age and is excluded from venue display", () => {
    const m = market("a", "t by September 30?", { ai: 0.5, expiresAt: "2026-09-30T00:00:00Z" });
    m.metadata.crowdProbability = 0.33;
    m.metadata.venue = "kalshi";
    const q = crowdQuoteOf(m);
    expect(q?.probability).toBeCloseTo(0.33, 6);
    expect(q?.venue).toBe("kalshi");
    // Since age is unknown (asOf: ""), Top Markets omits venue info to avoid phantom prices
    expect(formatTopMarkets([m], NOW).join("\n")).not.toContain("давность неизвестна");
    expect(formatTopMarkets([m], NOW).join("\n")).toContain("наша оценка 50.0%");
  });

  test("no crowd data at all is undefined", () => {
    const m = market("a", "t by September 30?", { ai: 0.5, expiresAt: "2026-09-30T00:00:00Z" });
    expect(crowdQuoteOf(m)).toBeUndefined();
  });
});

describe("structural desync section", () => {
  test("renders both label kinds", () => {
    const early = market("a", "Traffic normal by August 15?", {
      ai: 0.9,
      expiresAt: "2026-08-15T00:00:00Z",
    });
    const late = market("b", "Traffic normal by September 30?", {
      ai: 0.3,
      expiresAt: "2026-09-30T00:00:00Z",
    });
    const md = formatReportMarkdown(
      report({
        desyncs: [
          {
            key: "traffic normal",
            series: "crowd",
            earlier: { market: early, deadline: new Date("2026-08-15"), probability: 0.93 },
            later: { market: late, deadline: new Date("2026-09-30"), probability: 0.165 },
            gapPp: 76.5,
          },
          {
            key: "traffic normal",
            series: "ai",
            earlier: { market: early, deadline: new Date("2026-08-15"), probability: 0.9 },
            later: { market: late, deadline: new Date("2026-09-30"), probability: 0.3 },
            gapPp: 60,
          },
        ],
      }),
      [early, late],
      NOW,
    );
    expect(md).toContain("## Противоречия, которые мы не смогли выправить");
    expect(md).toContain("РЫНОК ПРОТИВОРЕЧИТ СЕБЕ");
    expect(md).toContain("МЫ ПРОТИВОРЕЧИМ СЕБЕ");
  });

  test("the section is absent when there is nothing to report", () => {
    expect(formatReportMarkdown(report(), [], NOW)).not.toContain("Противоречия, которые мы не смогли выправить");
  });
});

describe("an unstated urgency is not a low urgency", () => {
  test("a model-stated low urgency reads as the bottom rung", () => {
    const md = formatReportMarkdown(
      report({
        alphaOpportunities: [
          { title: "Some divergence", reasoning: "why", urgency: "low" },
        ],
      }),
      [],
      NOW,
    );
    expect(md).toContain("[на заметку] Some divergence");
  });

  test("a dropped urgency field is labelled as unrated, not as a verdict", () => {
    // Both render as "low" internally. If they also rendered identically, a
    // batch of malformed model rows would read as a deliberate de-escalation —
    // which is exactly how the 2026-09-10 report looked when five positions
    // changed label on the same day.
    const md = formatReportMarkdown(
      report({
        alphaOpportunities: [
          { title: "Some divergence", reasoning: "why", urgency: "low", urgencyUnstated: true },
        ],
      }),
      [],
      NOW,
    );
    expect(md).toContain("[не оценено] Some divergence");
    expect(md).not.toContain("[на заметку] Some divergence");
  });
});
