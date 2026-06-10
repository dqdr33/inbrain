/**
 * Dream Cycle — nightly self-evolution engine.
 *
 * Runs automatically during off-peak hours to:
 * 1. Review all markets and prediction accuracy
 * 2. Generate tomorrow's high-potential forecasts
 * 3. Discover knowledge gaps and auto-fill them
 * 4. Update the meta-prediction model
 * 5. Publish AI intelligence reports to the community
 */

import type {
  PredictionMarket,
  DreamCycleReport,
  PredictionForecast,
  TrendInsight,
  MetaModelUpdate,
} from "./types.js";

export interface DreamCycleOptions {
  brainQuery?: (query: string) => Promise<string>;
  brainWrite?: (slug: string, content: string) => Promise<void>;
  llmCall?: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;
  getActiveMarkets?: () => PredictionMarket[];
  getResolvedMarkets?: () => PredictionMarket[];
  maxRunTimeMinutes?: number;
}

export class DreamCycle {
  private brainQuery: (query: string) => Promise<string>;
  private brainWrite: (slug: string, content: string) => Promise<void>;
  private llmCall: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;
  private getActiveMarkets: () => PredictionMarket[];
  private getResolvedMarkets: () => PredictionMarket[];
  private maxRunTimeMs: number;

  constructor(opts: DreamCycleOptions = {}) {
    this.brainQuery =
      opts.brainQuery ?? (async () => "No brain connection.");
    this.brainWrite = opts.brainWrite ?? (async () => {});
    this.llmCall = opts.llmCall ?? (async () => "LLM not configured.");
    this.getActiveMarkets = opts.getActiveMarkets ?? (() => []);
    this.getResolvedMarkets = opts.getResolvedMarkets ?? (() => []);
    this.maxRunTimeMs = (opts.maxRunTimeMinutes ?? 60) * 60_000;
  }

  async run(): Promise<DreamCycleReport> {
    const startTime = Date.now();
    console.log("[dream-cycle] 🌙 Starting nightly self-evolution...");

    const active = this.getActiveMarkets();
    const resolved = this.getResolvedMarkets();
    const all = [...active, ...resolved];

    // Phase 1: Full review
    console.log("[dream-cycle] Phase 1/5: Full market review...");
    const accuracy = await this.reviewAccuracy(resolved);

    // Phase 2: Generate forecasts
    console.log("[dream-cycle] Phase 2/5: Generating tomorrow's forecasts...");
    const forecasts = await this.generateForecasts(all);

    // Phase 3: Find and fill knowledge gaps
    console.log("[dream-cycle] Phase 3/5: Discovering knowledge gaps...");
    const { gapsFound, gapsFilled } = await this.discoverAndFillGaps(all);

    // Phase 4: Update meta-model
    console.log("[dream-cycle] Phase 4/5: Updating meta-prediction model...");
    const metaUpdates = await this.updateMetaModel(resolved);

    // Phase 5: Trend analysis
    console.log("[dream-cycle] Phase 5/5: Analyzing trends...");
    const trends = await this.analyzeTrends(all);

    const duration = Date.now() - startTime;

    const report: DreamCycleReport = {
      id: `dream_${Date.now()}`,
      runAt: new Date(),
      duration,
      marketsReviewed: all.length,
      predictionsAccuracy: accuracy,
      knowledgeGapsFound: gapsFound,
      knowledgeGapsFilled: gapsFilled,
      tomorrowPredictions: forecasts,
      trendAnalysis: trends,
      metaModelUpdates: metaUpdates,
    };

    await this.saveDreamReport(report);

    console.log(
      `[dream-cycle] ✅ Complete in ${Math.round(duration / 1000)}s — ` +
        `${all.length} markets reviewed, ${forecasts.length} forecasts generated, ` +
        `${gapsFound.length} gaps found, ${gapsFilled.length} filled`,
    );

    return report;
  }

  private async reviewAccuracy(
    resolved: PredictionMarket[],
  ): Promise<number> {
    if (resolved.length === 0) return 0;

    let totalBrier = 0;
    let count = 0;

    for (const market of resolved) {
      if (!market.resolution) continue;
      const predicted = market.aiEstimate.yesProbability;
      const actual = market.resolution.outcome === "yes" ? 1 : 0;
      totalBrier += Math.pow(predicted - actual, 2);
      count++;
    }

    const avgBrier = count > 0 ? totalBrier / count : 0;
    const accuracy = 1 - avgBrier; // inverted Brier: higher = better

    await this.brainWrite(
      `predictions/meta/accuracy-log`,
      `---
type: meta-accuracy
date: ${new Date().toISOString()}
markets_reviewed: ${count}
avg_brier_score: ${avgBrier.toFixed(4)}
accuracy_score: ${accuracy.toFixed(4)}
---

# Prediction Accuracy Log — ${new Date().toLocaleDateString()}

- Markets reviewed: ${count}
- Average Brier Score: ${avgBrier.toFixed(4)}
- Accuracy Score: ${(accuracy * 100).toFixed(1)}%
- Calibration: ${avgBrier < 0.1 ? "Excellent" : avgBrier < 0.2 ? "Good" : avgBrier < 0.3 ? "Fair" : "Needs work"}
`,
    );

    return accuracy;
  }

  private async generateForecasts(
    markets: PredictionMarket[],
  ): Promise<PredictionForecast[]> {
    const brainContext = await this.brainQuery(
      "What are the most likely high-impact events for tomorrow based on current trends, scheduled events, and social signals?",
    );

    const system = `You are Inbrain's Dream Cycle forecaster. Based on current market state and trends,
predict tomorrow's highest-potential prediction market opportunities.

Respond with ONLY a valid JSON array:
[{
  "title": string,
  "category": string,
  "estimatedProbability": number (0-1),
  "reasoning": string,
  "potentialSignals": [string]
}]`;

    const prompt = `Current active markets (${markets.filter((m) => m.status === "active").length}):
${markets
  .filter((m) => m.status === "active")
  .slice(0, 15)
  .map(
    (m) =>
      `- ${m.title.slice(0, 80)} (${m.category}, YES: ${Math.round(m.aiEstimate.yesProbability * 100)}%)`,
  )
  .join("\n")}

Brain's trend analysis:
${brainContext}

Generate 5-10 predictions for tomorrow's high-potential markets.`;

    const response = await this.llmCall(system, prompt);

    try {
      return JSON.parse(response) as PredictionForecast[];
    } catch {
      return [];
    }
  }

  private async discoverAndFillGaps(
    markets: PredictionMarket[],
  ): Promise<{ gapsFound: string[]; gapsFilled: string[] }> {
    const system = `You are Inbrain's Knowledge Gap Analyzer. Review the prediction brain's coverage 
and identify missing data that would improve prediction accuracy.

Respond with ONLY valid JSON:
{
  "gaps": [{"topic": string, "importance": "critical"|"high"|"medium", "searchQuery": string}]
}`;

    const categories = [
      ...new Set(markets.map((m) => m.category)),
    ];
    const prompt = `Active categories: ${categories.join(", ")}
Market count: ${markets.length}

Recent market topics:
${markets
  .slice(0, 20)
  .map((m) => `- ${m.title.slice(0, 80)}`)
  .join("\n")}

What knowledge gaps exist that would improve prediction accuracy?`;

    const response = await this.llmCall(system, prompt);
    const gapsFound: string[] = [];
    const gapsFilled: string[] = [];

    try {
      const parsed = JSON.parse(response);
      const gaps = parsed.gaps ?? [];

      for (const gap of gaps.slice(0, 10)) {
        gapsFound.push(gap.topic);

        if (gap.importance === "critical" || gap.importance === "high") {
          try {
            const fillResult = await this.brainQuery(gap.searchQuery);
            if (
              fillResult &&
              !fillResult.includes("No brain connection") &&
              fillResult.length > 100
            ) {
              gapsFilled.push(gap.topic);
              await this.brainWrite(
                `predictions/knowledge/${gap.topic.toLowerCase().replace(/\s+/g, "-")}`,
                `---
type: knowledge-gap-fill
topic: ${gap.topic}
importance: ${gap.importance}
filled_at: ${new Date().toISOString()}
---

# ${gap.topic}

${fillResult}
`,
              );
            }
          } catch {
            // gap fill failed — non-critical
          }
        }
      }
    } catch {
      // parse failed
    }

    return { gapsFound, gapsFilled };
  }

  private async updateMetaModel(
    resolved: PredictionMarket[],
  ): Promise<MetaModelUpdate[]> {
    if (resolved.length < 5) return [];

    const system = `You are Inbrain's Meta-Model updater. Analyze resolved predictions to discover
calibration patterns. Example findings:
- "KOL tweets during bull market have 23% higher accuracy"
- "Crypto regulation predictions are consistently overconfident by 15%"

Respond with ONLY a valid JSON array:
[{
  "rule": string,
  "previousValue": number,
  "newValue": number,
  "evidence": string
}]`;

    const prompt = `Resolved markets for meta-model analysis:
${resolved
  .slice(0, 30)
  .map((m) => {
    const predicted = Math.round(m.aiEstimate.yesProbability * 100);
    const actual = m.resolution?.outcome === "yes" ? "YES" : "NO";
    return `- [${m.category}] ${m.title.slice(0, 60)} | Predicted: ${predicted}% YES | Actual: ${actual}`;
  })
  .join("\n")}

Discover calibration patterns and biases.`;

    const response = await this.llmCall(system, prompt);

    try {
      return JSON.parse(response) as MetaModelUpdate[];
    } catch {
      return [];
    }
  }

  private async analyzeTrends(
    markets: PredictionMarket[],
  ): Promise<TrendInsight[]> {
    const brainContext = await this.brainQuery(
      "What are the major prediction market trends this week? Which categories are gaining momentum?",
    );

    const system = `You are Inbrain's trend analyzer. Identify significant trends.

Respond with ONLY a valid JSON array:
[{
  "topic": string,
  "direction": "rising" | "falling" | "stable",
  "confidence": number (0-1),
  "relatedEvents": [string],
  "prediction": string
}]`;

    const prompt = `Market distribution:
${Object.entries(
  markets.reduce(
    (acc, m) => {
      acc[m.category] = (acc[m.category] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  ),
)
  .map(([cat, count]) => `- ${cat}: ${count} markets`)
  .join("\n")}

Brain's weekly analysis:
${brainContext}

Identify top trends.`;

    const response = await this.llmCall(system, prompt);

    try {
      return JSON.parse(response) as TrendInsight[];
    } catch {
      return [];
    }
  }

  private async saveDreamReport(report: DreamCycleReport): Promise<void> {
    const date = new Date().toISOString().split("T")[0];
    const slug = `predictions/dreams/${date}`;

    const content = `---
type: dream-cycle-report
date: ${date}
duration_seconds: ${Math.round(report.duration / 1000)}
markets_reviewed: ${report.marketsReviewed}
accuracy: ${report.predictionsAccuracy.toFixed(4)}
gaps_found: ${report.knowledgeGapsFound.length}
gaps_filled: ${report.knowledgeGapsFilled.length}
forecasts: ${report.tomorrowPredictions.length}
---

# 🌙 Dream Cycle Report — ${date}

## Performance Summary
- Markets Reviewed: ${report.marketsReviewed}
- Prediction Accuracy: ${(report.predictionsAccuracy * 100).toFixed(1)}%
- Duration: ${Math.round(report.duration / 1000)}s

## Tomorrow's Forecasts
${report.tomorrowPredictions.map((f) => `### ${f.title}\n- Category: ${f.category}\n- Estimated Probability: ${Math.round(f.estimatedProbability * 100)}%\n- Reasoning: ${f.reasoning}\n`).join("\n")}

## Trend Analysis
${report.trendAnalysis.map((t) => `- **${t.topic}** (${t.direction}): ${t.prediction}`).join("\n")}

## Knowledge Gaps
### Found (${report.knowledgeGapsFound.length})
${report.knowledgeGapsFound.map((g) => `- ${g}`).join("\n")}

### Filled (${report.knowledgeGapsFilled.length})
${report.knowledgeGapsFilled.map((g) => `- ✅ ${g}`).join("\n")}

## Meta-Model Updates
${report.metaModelUpdates.map((u) => `- **${u.rule}**: ${u.previousValue.toFixed(2)} → ${u.newValue.toFixed(2)} (${u.evidence})`).join("\n")}
`;

    await this.brainWrite(slug, content);
  }
}
