/**
 * Analyst Agent — intelligence output & reporting layer.
 *
 * Generates daily AI reports, weekly trend summaries, alpha market discoveries,
 * and data insights.  Publishes to Discord, X, and the Inbrain community.
 */

import type {
  PredictionMarket,
  TrendInsight,
  MarketCategory,
} from "./types.js";
import {
  parseLlmJson,
  requireProbability,
  optionalStringArray,
  logValidationFailure,
} from "./llm-json.js";
import { formatPercent } from "./format.js";

/**
 * Mean Brier score over markets that actually resolved, or null when there is
 * nothing to score.
 *
 * This used to be a field in the LLM's JSON schema — the model was asked to
 * report `avgBrierScore` despite the prompt containing no resolved-market data
 * at all, so the number was invented. Calibration is arithmetic; compute it.
 */
export function computeAvgBrierScore(markets: PredictionMarket[]): number | null {
  const scored = markets.filter((m) => m.resolution && m.resolution.outcome !== "cancelled");
  if (scored.length === 0) return null;
  const total = scored.reduce((sum, m) => {
    const actual = m.resolution!.outcome === "yes" ? 1 : 0;
    return sum + Math.pow(m.aiEstimate.yesProbability - actual, 2);
  }, 0);
  return total / scored.length;
}

export interface AnalystAgentOptions {
  brainQuery?: (query: string) => Promise<string>;
  llmCall?: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;
  publishDiscord?: (content: string) => Promise<void>;
  publishX?: (content: string) => Promise<void>;
}

export class AnalystAgent {
  private brainQuery: (query: string) => Promise<string>;
  private llmCall: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;
  private publishDiscord?: (content: string) => Promise<void>;
  private publishX?: (content: string) => Promise<void>;

  constructor(opts: AnalystAgentOptions = {}) {
    this.brainQuery =
      opts.brainQuery ?? (async () => "No brain connection configured.");
    this.llmCall = opts.llmCall ?? (async () => "LLM not configured.");
    this.publishDiscord = opts.publishDiscord;
    this.publishX = opts.publishX;
  }

  async generateDailyReport(
    markets: PredictionMarket[],
  ): Promise<DailyReport> {
    const activeMarkets = markets.filter((m) => m.status === "active");
    const resolvedToday = markets.filter(
      (m) =>
        m.status === "resolved" &&
        m.resolvedAt &&
        isToday(m.resolvedAt),
    );

    const brainContext = await this.brainQuery(
      "Summarize today's prediction market activity, notable outcomes, and emerging trends.",
    );

    const system = `You are Inbrain's Analyst Agent. Generate a concise daily intelligence report
covering prediction market performance, notable outcomes, and emerging opportunities.

Respond with ONLY valid JSON:
{
  "summary": string,
  "topMarkets": [{"title": string, "probability": number (0.0–1.0 scale, NOT a percentage — e.g. 0.04 means 4%), "trend": "up"|"down"|"stable"}],
  "alphaOpportunities": [{"title": string, "reasoning": string, "urgency": "high"|"medium"|"low"}],
  "trends": [{"topic": string, "direction": "rising"|"falling"|"stable", "confidence": number (0.0–1.0), "prediction": string}],
  "bestPrediction": string,
  "worstPrediction": string
}`;

    const prompt = `Active Markets (${activeMarkets.length}):
${activeMarkets
  .slice(0, 20)
  .map(
    (m) =>
      `- ${m.title.slice(0, 100)} (YES: ${formatPercent(m.aiEstimate.yesProbability)}, category: ${m.category})`,
  )
  .join("\n")}

Resolved Today (${resolvedToday.length}):
${resolvedToday
  .map(
    (m) =>
      `- ${m.title.slice(0, 100)} → ${m.resolution?.outcome.toUpperCase()} (AI predicted: ${formatPercent(m.aiEstimate.yesProbability)})`,
  )
  .join("\n")}

Brain Context:
${brainContext}

Generate the daily intelligence report.`;

    const response = await this.llmCall(system, prompt);

    // Computed here, never asked of the model.
    const avgBrierScore = computeAvgBrierScore(markets);

    const metrics = {
      totalActive: activeMarkets.length,
      resolvedToday: resolvedToday.length,
      avgBrierScore,
      bestPrediction: "",
      worstPrediction: "",
    };

    const context = "generateDailyReport";
    let report: DailyReport;
    try {
      const parsed = parseLlmJson<Record<string, unknown>>(response, context);
      // Field-by-field instead of `...parsed`: spreading let the model overwrite
      // `date` with a string (breaking date.toISOString() downstream) and let a
      // missing topMarkets/trends array through as undefined, which then threw
      // inside formatDailyReport and was swallowed as "report generation failed".
      report = {
        date: new Date(),
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        topMarkets: normaliseTopMarkets(parsed.topMarkets, context),
        alphaOpportunities: normaliseAlpha(parsed.alphaOpportunities),
        trends: normaliseTrends(parsed.trends),
        performanceMetrics: {
          ...metrics,
          bestPrediction: typeof parsed.bestPrediction === "string" ? parsed.bestPrediction : "",
          worstPrediction: typeof parsed.worstPrediction === "string" ? parsed.worstPrediction : "",
        },
        activeMarkets: activeMarkets.length,
        resolvedMarkets: resolvedToday.length,
      };
    } catch (err) {
      logValidationFailure(context, err);
      report = {
        date: new Date(),
        summary: `Report generation failed: ${(err as Error).message}`,
        topMarkets: [],
        alphaOpportunities: [],
        trends: [],
        performanceMetrics: metrics,
        activeMarkets: activeMarkets.length,
        resolvedMarkets: resolvedToday.length,
      };
    }

    // Distribution is outside the try: a Telegram/Discord failure must not be
    // reported as "the model produced a bad report".
    try {
      await this.distribute(this.formatDailyReport(report));
    } catch (err) {
      console.error(`[analyst-agent] distribution failed: ${(err as Error).message}`);
    }
    return report;
  }

  async generateWeeklyTrends(
    markets: PredictionMarket[],
  ): Promise<TrendInsight[]> {
    const brainContext = await this.brainQuery(
      "Analyze weekly prediction market trends. What topics are gaining or losing momentum? What patterns are emerging across categories?",
    );

    const system = `You are Inbrain's trend analyst. Identify the top weekly trends across prediction markets.

Respond with ONLY a valid JSON array:
[{
  "topic": string,
  "direction": "rising" | "falling" | "stable",
  "confidence": number (0-1),
  "relatedEvents": [string],
  "prediction": string
}]`;

    const categoryGroups = groupByCategory(markets);
    const prompt = `Markets by Category:
${Object.entries(categoryGroups)
  .map(
    ([cat, ms]) =>
      `\n${cat.toUpperCase()} (${ms.length}):\n${ms
        .slice(0, 5)
        .map(
          (m) =>
            `  - ${m.title.slice(0, 80)} (YES: ${formatPercent(m.aiEstimate.yesProbability)})`,
        )
        .join("\n")}`,
  )
  .join("\n")}

Brain Analysis:
${brainContext}

Identify the top 5-10 weekly trends.`;

    const response = await this.llmCall(system, prompt);

    try {
      return normaliseTrends(parseLlmJson(response, "generateWeeklyTrends"));
    } catch (err) {
      logValidationFailure("generateWeeklyTrends", err);
      return [];
    }
  }

  async discoverAlpha(markets: PredictionMarket[]): Promise<AlphaDiscovery[]> {
    const system = `You are Inbrain's Alpha Discovery Engine. Find prediction markets where the AI 
estimate significantly diverges from crowd consensus, indicating potential mispricing. Both AI and crowd estimates are provided.

Respond with ONLY a valid JSON array:
[{
  "marketId": string,
  "title": string,
  "aiEstimate": number,
  "crowdEstimate": number,
  "divergence": number,
  "direction": "ai_higher" | "ai_lower",
  "reasoning": string,
  "confidence": number
}]`;

    // Only markets that actually carry a crowd number can be screened. Rows
    // without one used to be shown as "Crowd: 0%", which made every single
    // market look like a maximum-divergence opportunity.
    const screenable = markets
      .filter((m) => m.status === "active")
      .filter((m) => typeof m.metadata?.crowdProbability === "number")
      .slice(0, 30);

    if (screenable.length === 0) {
      console.error("[analyst-agent] discoverAlpha: no markets carry a crowd probability — skipping");
      return [];
    }

    const prompt = `Active markets for alpha screening:
${screenable
  .map((m) => {
    const crowdProb = m.metadata.crowdProbability as number;
    return `- [${m.id}] ${m.title.slice(0, 80)} | AI: ${formatPercent(m.aiEstimate.yesProbability)} | Crowd: ${formatPercent(crowdProb)} | Confidence: ${formatPercent(m.aiEstimate.confidence)}`;
  })
  .join("\n")}

Find markets with significant AI-vs-crowd divergence (potential alpha).`;

    const response = await this.llmCall(system, prompt);

    try {
      const parsed = parseLlmJson<unknown>(response, "discoverAlpha");
      return Array.isArray(parsed) ? (parsed as AlphaDiscovery[]) : [];
    } catch (err) {
      logValidationFailure("discoverAlpha", err);
      return [];
    }
  }

  private formatDailyReport(report: DailyReport): string {
    const lines = [
      `📊 **Inbrain Daily Intelligence — ${report.date.toLocaleDateString()}**`,
      "",
      report.summary,
      "",
      `📈 **Active Markets:** ${report.activeMarkets}`,
      `✅ **Resolved Today:** ${report.resolvedMarkets}`,
      "",
    ];

    if (report.topMarkets.length > 0) {
      lines.push("**🔥 Top Markets:**");
      for (const m of report.topMarkets.slice(0, 5)) {
        const arrow =
          m.trend === "up" ? "↑" : m.trend === "down" ? "↓" : "→";
        // probability is already normalised to 0-1 by normaliseTopMarkets, so
        // no >= 2 "is this a percentage?" guesswork is needed here any more.
        lines.push(`  ${arrow} ${m.title} — ${formatPercent(m.probability)} YES`);
      }
      lines.push("");
    }

    if (report.alphaOpportunities.length > 0) {
      lines.push("**💎 Alpha Opportunities:**");
      for (const a of report.alphaOpportunities.slice(0, 3)) {
        lines.push(`  [${a.urgency.toUpperCase()}] ${a.title}`);
        lines.push(`    → ${a.reasoning}`);
      }
      lines.push("");
    }

    if (report.trends.length > 0) {
      lines.push("**📉 Trends:**");
      for (const t of report.trends.slice(0, 5)) {
        const dir =
          t.direction === "rising"
            ? "🟢"
            : t.direction === "falling"
              ? "🔴"
              : "⚪";
        lines.push(`  ${dir} ${t.topic}: ${t.prediction}`);
      }
    }

    return lines.join("\n");
  }

  private async distribute(content: string): Promise<void> {
    const tasks: Promise<void>[] = [];

    if (this.publishDiscord) {
      tasks.push(
        this.publishDiscord(content).catch((err) =>
          console.error("[analyst-agent] Discord publish failed:", err),
        ),
      );
    }

    if (this.publishX) {
      const tweet = content.slice(0, 280);
      tasks.push(
        this.publishX(tweet).catch((err) =>
          console.error("[analyst-agent] X publish failed:", err),
        ),
      );
    }

    await Promise.all(tasks);
  }
}

/** Probability fields arrive on either a 0-1 or a 0-100 scale depending on the
 *  model's mood. Normalise once, here, so the renderer never has to guess. */
function normaliseTopMarkets(value: unknown, context: string): DailyReport["topMarkets"] {
  if (!Array.isArray(value)) return [];
  const out: DailyReport["topMarkets"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.title !== "string") continue;
    let probability: number;
    try {
      probability = requireProbability(row.probability, "topMarkets[].probability", context);
    } catch (err) {
      logValidationFailure(context, err);
      continue;
    }
    const trend = row.trend === "up" || row.trend === "down" ? row.trend : "stable";
    out.push({ title: row.title, probability, trend });
  }
  return out;
}

function normaliseAlpha(value: unknown): DailyReport["alphaOpportunities"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.title !== "string") return [];
    const urgency =
      row.urgency === "high" || row.urgency === "medium" || row.urgency === "low"
        ? row.urgency
        : "low";
    return [{
      title: row.title,
      reasoning: typeof row.reasoning === "string" ? row.reasoning : "",
      urgency,
    }];
  });
}

function normaliseTrends(value: unknown): TrendInsight[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.topic !== "string") return [];
    const direction =
      row.direction === "rising" || row.direction === "falling" ? row.direction : "stable";
    const confidence = Number(row.confidence);
    return [{
      topic: row.topic,
      direction,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence > 1 ? confidence / 100 : confidence)) : 0,
      relatedEvents: optionalStringArray(row.relatedEvents),
      prediction: typeof row.prediction === "string" ? row.prediction : "",
    }];
  });
}

function isToday(dateInput: Date | string): boolean {
  const date = new Date(dateInput);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function groupByCategory(
  markets: PredictionMarket[],
): Record<string, PredictionMarket[]> {
  const groups: Record<string, PredictionMarket[]> = {};
  for (const m of markets) {
    (groups[m.category] ??= []).push(m);
  }
  return groups;
}

export interface DailyReport {
  date: Date;
  summary: string;
  topMarkets: Array<{
    title: string;
    probability: number;
    trend: "up" | "down" | "stable";
  }>;
  alphaOpportunities: Array<{
    title: string;
    reasoning: string;
    urgency: "high" | "medium" | "low";
  }>;
  trends: TrendInsight[];
  performanceMetrics: {
    totalActive: number;
    resolvedToday: number;
    /** null means "no resolved markets to score yet" — distinct from a genuine
     *  0.0, which would be perfect calibration. */
    avgBrierScore: number | null;
    bestPrediction: string;
    worstPrediction: string;
  };
  activeMarkets: number;
  resolvedMarkets: number;
}

export interface AlphaDiscovery {
  marketId: string;
  title: string;
  aiEstimate: number;
  crowdEstimate: number;
  divergence: number;
  direction: "ai_higher" | "ai_lower";
  reasoning: string;
  confidence: number;
}
