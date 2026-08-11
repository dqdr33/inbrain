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
import { parseLlmJson, logValidationFailure, optionalStringArray } from "./llm-json.js";
import { CALIBRATION_SLUG, renderCalibrationPage, type CalibrationRule } from "./calibration.js";
import { formatPercent } from "./format.js";

/** Brain slugs are filesystem-ish paths. Topic text comes straight from an LLM,
 *  so it must never be able to steer the write target. */
function safeSlugSegment(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80) || "untitled"
  );
}

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

  /** A brainQuery that failed returns a marker string rather than throwing, so
   *  callers must be able to recognise it before treating it as knowledge. */
  private looksLikeBrainFailure(text: string): boolean {
    return /^\s*Brain query failed|^\s*No brain connection/i.test(text);
  }

  /** Throws once the cycle has outlived maxRunTimeMinutes. The budget was
   *  computed in the constructor and then never consulted, so a stuck phase
   *  could run indefinitely. */
  private checkDeadline(startedAt: number, phase: string): void {
    const elapsed = Date.now() - startedAt;
    if (elapsed > this.maxRunTimeMs) {
      throw new Error(
        `dream cycle exceeded its ${Math.round(this.maxRunTimeMs / 60_000)} minute budget before ${phase} (elapsed ${Math.round(elapsed / 1000)}s)`,
      );
    }
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
    this.checkDeadline(startTime, "phase 2");
    console.log("[dream-cycle] Phase 2/5: Generating tomorrow's forecasts...");
    const forecasts = await this.generateForecasts(all);

    // Phase 3: Find and fill knowledge gaps
    this.checkDeadline(startTime, "phase 3");
    console.log("[dream-cycle] Phase 3/5: Discovering knowledge gaps...");
    const { gapsFound, gapsFilled } = await this.discoverAndFillGaps(all);

    // Phase 4: Update meta-model
    this.checkDeadline(startTime, "phase 4");
    console.log("[dream-cycle] Phase 4/5: Updating meta-prediction model...");
    const metaUpdates = await this.updateMetaModel(resolved);

    // Phase 5: Trend analysis
    this.checkDeadline(startTime, "phase 5");
    console.log("[dream-cycle] Phase 5/5: Analyzing trends...");
    const trends = await this.analyzeTrends(all);

    // Persist the meta-model as the page BrainAgent actually reads. Without
    // this the loop is open: findings only ever reached the human-readable
    // dream report, so every evaluation queried an address nothing wrote.
    await this.publishCalibration(metaUpdates, resolved, accuracy);

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

  /** Write the calibration rules page BrainAgent reads before every evaluation.
   *  Always written, even with zero rules, so the read side gets an honest
   *  "not enough history yet" instead of an empty search result. */
  private async publishCalibration(
    updates: MetaModelUpdate[],
    resolved: PredictionMarket[],
    accuracy: number | null,
  ): Promise<void> {
    const rules: CalibrationRule[] = updates.map((u) => ({
      rule: u.rule,
      previousValue: u.previousValue,
      newValue: u.newValue,
      evidence: u.evidence,
    }));

    const avgBrierScore = accuracy === null ? null : 1 - accuracy;

    try {
      await this.brainWrite(
        CALIBRATION_SLUG,
        renderCalibrationPage(rules, {
          marketsReviewed: resolved.length,
          avgBrierScore,
        }),
      );
      console.log(
        `[dream-cycle] calibration page updated (${rules.length} rule(s), ${resolved.length} resolved market(s))`,
      );
    } catch (err) {
      console.error(`[dream-cycle] failed to publish calibration: ${(err as Error).message}`);
    }
  }

  /** Mean-Brier-derived accuracy, or null when nothing has resolved yet.
   *  Returning 0 for "no data" printed "Accuracy 0.0%" — indistinguishable
   *  from catastrophically bad calibration. */
  private async reviewAccuracy(
    resolved: PredictionMarket[],
  ): Promise<number | null> {
    if (resolved.length === 0) return null;

    let totalBrier = 0;
    let count = 0;

    for (const market of resolved) {
      if (!market.resolution) continue;
      const predicted = market.aiEstimate.yesProbability;
      const actual = market.resolution.outcome === "yes" ? 1 : 0;
      totalBrier += Math.pow(predicted - actual, 2);
      count++;
    }

    if (count === 0) return null;

    const avgBrier = totalBrier / count;
    const accuracy = 1 - avgBrier; // inverted Brier: higher = better

    // Dated slug: the old fixed `accuracy-log` slug overwrote itself every
    // night, so the accuracy history the meta-model is supposed to learn from
    // never accumulated.
    await this.brainWrite(
      `predictions/meta/accuracy/${new Date().toISOString().slice(0, 10)}`,
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
      `- ${m.title.slice(0, 80)} (${m.category}, YES: ${formatPercent(m.aiEstimate.yesProbability)})`,
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

    const context = "discoverAndFillGaps";
    try {
      const parsed = parseLlmJson<{ gaps?: unknown }>(response, context);
      const gaps = Array.isArray(parsed.gaps) ? parsed.gaps : [];

      for (const item of gaps.slice(0, 10)) {
        if (!item || typeof item !== "object") continue;
        const gap = item as Record<string, unknown>;
        if (typeof gap.topic !== "string" || !gap.topic.trim()) continue;
        gapsFound.push(gap.topic);

        if (gap.importance !== "critical" && gap.importance !== "high") continue;
        if (typeof gap.searchQuery !== "string" || !gap.searchQuery.trim()) continue;

        try {
          const fillResult = await this.brainQuery(gap.searchQuery);
          // The old guard tested for the literal "No brain connection", which
          // the production runner never emits — so a brain ERROR MESSAGE was
          // written back into the brain as filled knowledge.
          if (
            fillResult &&
            !this.looksLikeBrainFailure(fillResult) &&
            fillResult.length > 100
          ) {
            gapsFilled.push(gap.topic);
            await this.brainWrite(
              // Topic text is model output; without sanitising it, the model
              // controls the write path.
              `predictions/knowledge/${safeSlugSegment(gap.topic)}`,
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
        } catch (err) {
          console.error(`[dream-cycle] gap fill failed for "${gap.topic}": ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logValidationFailure(context, err);
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
    // Display only — the Brier arithmetic downstream uses the raw probability,
    // never this string. A long shot that resolved YES is the single most
    // informative row here, so it must not arrive as "0%".
    const predicted = formatPercent(m.aiEstimate.yesProbability);
    const actual = m.resolution?.outcome === "yes" ? "YES" : "NO";
    return `- [${m.category}] ${m.title.slice(0, 60)} | Predicted: ${predicted} YES | Actual: ${actual}`;
  })
  .join("\n")}

Discover calibration patterns and biases.`;

    const response = await this.llmCall(system, prompt);

    const context = "updateMetaModel";
    try {
      const parsed = parseLlmJson<unknown>(response, context);
      if (!Array.isArray(parsed)) return [];
      // Validate here rather than at render time: saveDreamReport calls
      // previousValue.toFixed(2), which threw out of run() after every LLM
      // call had already been paid for.
      return parsed.flatMap((item): MetaModelUpdate[] => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        const prev = Number(row.previousValue);
        const next = Number(row.newValue);
        if (typeof row.rule !== "string" || !Number.isFinite(prev) || !Number.isFinite(next)) {
          return [];
        }
        return [{
          rule: row.rule,
          previousValue: prev,
          newValue: next,
          evidence: typeof row.evidence === "string" ? row.evidence : "",
        }];
      });
    } catch (err) {
      logValidationFailure(context, err);
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

    const context = "analyzeTrends";
    try {
      const parsed = parseLlmJson<unknown>(response, context);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item): TrendInsight[] => {
        if (!item || typeof item !== "object") return [];
        const row = item as Record<string, unknown>;
        if (typeof row.topic !== "string") return [];
        const direction =
          row.direction === "rising" || row.direction === "falling" ? row.direction : "stable";
        const confidence = Number(row.confidence);
        return [{
          topic: row.topic,
          direction,
          confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
          relatedEvents: optionalStringArray(row.relatedEvents),
          prediction: typeof row.prediction === "string" ? row.prediction : "",
        }];
      });
    } catch (err) {
      logValidationFailure(context, err);
      return [];
    }
  }

  private async saveDreamReport(report: DreamCycleReport): Promise<void> {
    const date = new Date().toISOString().split("T")[0];
    const slug = `predictions/dreams/${date}`;

    const accuracyValue =
      report.predictionsAccuracy === null ? "n/a" : report.predictionsAccuracy.toFixed(4);
    const accuracyText =
      report.predictionsAccuracy === null
        ? "no resolved markets yet"
        : `${(report.predictionsAccuracy * 100).toFixed(1)}%`;

    const content = `---
type: dream-cycle-report
date: ${date}
duration_seconds: ${Math.round(report.duration / 1000)}
markets_reviewed: ${report.marketsReviewed}
accuracy: ${accuracyValue}
gaps_found: ${report.knowledgeGapsFound.length}
gaps_filled: ${report.knowledgeGapsFilled.length}
forecasts: ${report.tomorrowPredictions.length}
---

# 🌙 Dream Cycle Report — ${date}

## Performance Summary
- Markets Reviewed: ${report.marketsReviewed}
- Prediction Accuracy: ${accuracyText}
- Duration: ${Math.round(report.duration / 1000)}s

## Tomorrow's Forecasts
${report.tomorrowPredictions.map((f) => `### ${f.title}\n- Category: ${f.category}\n- Estimated Probability: ${formatPercent(f.estimatedProbability)}\n- Reasoning: ${f.reasoning}\n`).join("\n")}

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
