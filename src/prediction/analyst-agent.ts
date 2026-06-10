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
  "topMarkets": [{"title": string, "probability": number, "trend": "up"|"down"|"stable"}],
  "alphaOpportunities": [{"title": string, "reasoning": string, "urgency": "high"|"medium"|"low"}],
  "trends": [{"topic": string, "direction": "rising"|"falling"|"stable", "confidence": number, "prediction": string}],
  "performanceMetrics": {
    "totalActive": number,
    "resolvedToday": number,
    "avgBrierScore": number,
    "bestPrediction": string,
    "worstPrediction": string
  }
}`;

    const prompt = `Active Markets (${activeMarkets.length}):
${activeMarkets
  .slice(0, 20)
  .map(
    (m) =>
      `- ${m.title.slice(0, 100)} (YES: ${Math.round(m.aiEstimate.yesProbability * 100)}%, category: ${m.category})`,
  )
  .join("\n")}

Resolved Today (${resolvedToday.length}):
${resolvedToday
  .map(
    (m) =>
      `- ${m.title.slice(0, 100)} → ${m.resolution?.outcome.toUpperCase()} (AI predicted: ${Math.round(m.aiEstimate.yesProbability * 100)}%)`,
  )
  .join("\n")}

Brain Context:
${brainContext}

Generate the daily intelligence report.`;

    const response = await this.llmCall(system, prompt);

    try {
      const parsed = JSON.parse(response);
      const report: DailyReport = {
        date: new Date(),
        ...parsed,
        activeMarkets: activeMarkets.length,
        resolvedMarkets: resolvedToday.length,
      };

      await this.distribute(this.formatDailyReport(report));
      return report;
    } catch {
      return {
        date: new Date(),
        summary: "Failed to generate daily report",
        topMarkets: [],
        alphaOpportunities: [],
        trends: [],
        performanceMetrics: {
          totalActive: activeMarkets.length,
          resolvedToday: resolvedToday.length,
          avgBrierScore: 0,
          bestPrediction: "",
          worstPrediction: "",
        },
        activeMarkets: activeMarkets.length,
        resolvedMarkets: resolvedToday.length,
      };
    }
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
            `  - ${m.title.slice(0, 80)} (YES: ${Math.round(m.aiEstimate.yesProbability * 100)}%)`,
        )
        .join("\n")}`,
  )
  .join("\n")}

Brain Analysis:
${brainContext}

Identify the top 5-10 weekly trends.`;

    const response = await this.llmCall(system, prompt);

    try {
      return JSON.parse(response) as TrendInsight[];
    } catch {
      return [];
    }
  }

  async discoverAlpha(markets: PredictionMarket[]): Promise<AlphaDiscovery[]> {
    const system = `You are Inbrain's Alpha Discovery Engine. Find prediction markets where the AI 
estimate significantly diverges from crowd consensus, indicating potential mispricing.

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

    const prompt = `Active markets for alpha screening:
${markets
  .filter((m) => m.status === "active")
  .slice(0, 30)
  .map(
    (m) =>
      `- [${m.id}] ${m.title.slice(0, 80)} | AI: ${Math.round(m.aiEstimate.yesProbability * 100)}% | Confidence: ${Math.round(m.aiEstimate.confidence * 100)}%`,
  )
  .join("\n")}

Find markets with significant AI-vs-crowd divergence (potential alpha).`;

    const response = await this.llmCall(system, prompt);

    try {
      return JSON.parse(response) as AlphaDiscovery[];
    } catch {
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
        lines.push(
          `  ${arrow} ${m.title} — ${Math.round(m.probability * 100)}% YES`,
        );
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

function isToday(date: Date): boolean {
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
    avgBrierScore: number;
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
