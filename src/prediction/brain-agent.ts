/**
 * Brain Agent — central reasoning & evaluation engine.
 *
 * Receives signals, queries the Inbrain Memory Graph for historical context,
 * performs quality evaluation via LLM-based reasoning, and decides whether
 * a signal should become a prediction market.
 */

import type {
  PredictionSignal,
  PredictionMarket,
  MarketQualityScore,
  AIEstimate,
  HistoricalCase,
  MarketCategory,
  CrowdWisdom,
} from "./types.js";

const DEFAULT_QUALITY_THRESHOLD = 65;
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

export interface BrainAgentOptions {
  qualityThreshold?: number;
  historicalLookbackDays?: number;
  modelId?: string;
  brainQuery?: (query: string) => Promise<string>;
  brainWrite?: (slug: string, content: string) => Promise<void>;
  llmCall?: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;
}

export class BrainAgent {
  private qualityThreshold: number;
  private lookbackDays: number;
  private modelId: string;
  private brainQuery: (query: string) => Promise<string>;
  private brainWrite: (slug: string, content: string) => Promise<void>;
  private llmCall: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;

  constructor(opts: BrainAgentOptions = {}) {
    this.qualityThreshold = opts.qualityThreshold ?? DEFAULT_QUALITY_THRESHOLD;
    this.lookbackDays = opts.historicalLookbackDays ?? 90;
    this.modelId = opts.modelId ?? DEFAULT_MODEL;

    this.brainQuery =
      opts.brainQuery ??
      (async () => "No brain connection configured. Using default analysis.");
    this.brainWrite = opts.brainWrite ?? (async () => {});
    this.llmCall =
      opts.llmCall ?? (async () => "LLM not configured. Cannot evaluate.");
  }

  async evaluate(
    signal: PredictionSignal,
  ): Promise<
    | { accepted: true; market: PredictionMarket }
    | { accepted: false; reason: string }
  > {
    console.log(
      `[brain-agent] evaluating signal ${signal.id}: "${signal.content.slice(0, 80)}..."`,
    );

    const [historicalContext, crowdWisdom] = await Promise.all([
      this.queryHistoricalContext(signal),
      this.queryCrowdWisdom(signal),
    ]);

    const qualityScore = await this.assessQuality(
      signal,
      historicalContext,
      crowdWisdom,
    );

    if (qualityScore.overall < this.qualityThreshold) {
      console.log(
        `[brain-agent] rejected signal ${signal.id} — quality ${qualityScore.overall}/${this.qualityThreshold}`,
      );
      return {
        accepted: false,
        reason: `Quality score ${qualityScore.overall} below threshold ${this.qualityThreshold}. ${qualityScore.reasoning}`,
      };
    }

    const estimate = await this.generateEstimate(
      signal,
      historicalContext,
      crowdWisdom,
    );

    const market = this.buildMarket(signal, qualityScore, estimate);

    await this.recordToMemory(signal, market, qualityScore);

    console.log(
      `[brain-agent] accepted signal ${signal.id} → market "${market.title}" (quality: ${qualityScore.overall}, YES: ${Math.round(estimate.yesProbability * 100)}%)`,
    );

    return { accepted: true, market };
  }

  private async queryHistoricalContext(
    signal: PredictionSignal,
  ): Promise<string> {
    const query = `Find historical prediction market events similar to: "${signal.content}". 
Include past outcomes, accuracy rates, KOL influence patterns, and market dynamics 
from the last ${this.lookbackDays} days. Focus on verifiable events with clear outcomes.`;

    return this.brainQuery(query);
  }

  private async queryCrowdWisdom(
    signal: PredictionSignal,
  ): Promise<CrowdWisdom[]> {
    const query = `Find crowd consensus data from Polymarket, Kalshi, and PredictIt 
for events related to: "${signal.content}". Include probability estimates, volume, 
and participant counts.`;

    const raw = await this.brainQuery(query);

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as CrowdWisdom[];
    } catch {
      // Brain returned prose — that's fine, crowd wisdom is optional
    }
    return [];
  }

  private async assessQuality(
    signal: PredictionSignal,
    historicalContext: string,
    crowdWisdom: CrowdWisdom[],
  ): Promise<MarketQualityScore> {
    const system = `You are Inbrain's Market Quality Engine. You evaluate whether a social signal 
should become a prediction market. Score each dimension 0-100. Be strict about verifiability.

Respond with ONLY valid JSON matching this schema:
{
  "overall": number,
  "verifiability": number,
  "historicalSimilarity": number,
  "communityPotential": number,
  "liquidityPotential": number,
  "timelineFeasibility": number,
  "reasoning": string,
  "historicalCases": [{"slug": string, "title": string, "outcome": "yes"|"no"|"unresolved", "similarity": number}],
  "risks": [string]
}`;

    const prompt = `Signal: ${JSON.stringify(signal, null, 2)}

Historical Context from Brain Memory:
${historicalContext}

Cross-Platform Crowd Wisdom:
${JSON.stringify(crowdWisdom, null, 2)}

Evaluate this signal for prediction market creation. Consider:
1. VERIFIABILITY: Can the outcome be objectively determined? Is there a clear deadline?
2. HISTORICAL SIMILARITY: Have similar events been predicted before? What was the accuracy?
3. COMMUNITY POTENTIAL: Will people engage? Is there KOL backing?
4. LIQUIDITY POTENTIAL: Will this attract volume?
5. TIMELINE FEASIBILITY: Is the resolution timeframe realistic?`;

    const response = await this.llmCall(system, prompt, {
      model: this.modelId,
    });

    try {
      return JSON.parse(response) as MarketQualityScore;
    } catch {
      return {
        overall: 0,
        verifiability: 0,
        historicalSimilarity: 0,
        communityPotential: 0,
        liquidityPotential: 0,
        timelineFeasibility: 0,
        reasoning: "Failed to parse quality assessment",
        historicalCases: [],
        risks: ["Assessment parsing failed"],
      };
    }
  }

  private async generateEstimate(
    signal: PredictionSignal,
    historicalContext: string,
    crowdWisdom: CrowdWisdom[],
  ): Promise<AIEstimate> {
    const system = `You are Inbrain's AI probability estimator. Given a prediction signal and 
historical context, estimate the YES probability. Be calibrated — don't default to 50%.

Respond with ONLY valid JSON:
{
  "yesProbability": number (0-1),
  "confidence": number (0-1),
  "reasoning": string,
  "sources": [string]
}`;

    const prompt = `Signal: ${signal.content}

Historical Brain Context:
${historicalContext}

Cross-Platform Consensus:
${crowdWisdom.map((cw) => `${cw.platform}: ${Math.round(cw.consensusProbability * 100)}% YES (${cw.participants} participants)`).join("\n")}

Estimate the probability that this event resolves YES.`;

    const response = await this.llmCall(system, prompt, {
      model: this.modelId,
    });

    try {
      const parsed = JSON.parse(response);
      return {
        ...parsed,
        modelVersion: this.modelId,
        updatedAt: new Date(),
      };
    } catch {
      return {
        yesProbability: 0.5,
        confidence: 0.1,
        reasoning: "Unable to generate estimate — using base rate",
        sources: [],
        modelVersion: this.modelId,
        updatedAt: new Date(),
      };
    }
  }

  private buildMarket(
    signal: PredictionSignal,
    quality: MarketQualityScore,
    estimate: AIEstimate,
  ): PredictionMarket {
    const category = this.inferCategory(signal);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    return {
      id: `mkt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: signal.content.slice(0, 200),
      description: `AI-generated prediction market based on ${signal.source} signal.\n\n${estimate.reasoning}`,
      category,
      status: "active",
      createdAt: new Date(),
      expiresAt,
      aiEstimate: estimate,
      qualityScore: quality,
      sourceSignals: [signal.id],
      relatedMarkets: [],
      metadata: {
        signalSource: signal.source,
        author: signal.author,
        authorInfluence: signal.authorInfluence,
      },
    };
  }

  private inferCategory(signal: PredictionSignal): MarketCategory {
    const text = signal.content.toLowerCase();
    if (
      text.includes("bitcoin") ||
      text.includes("ethereum") ||
      text.includes("crypto") ||
      text.includes("token")
    )
      return "crypto";
    if (
      text.includes("election") ||
      text.includes("president") ||
      text.includes("congress") ||
      text.includes("vote")
    )
      return "politics";
    if (text.includes("ai") || text.includes("tech") || text.includes("model"))
      return "technology";
    if (text.includes("stock") || text.includes("fed") || text.includes("rate"))
      return "finance";
    if (
      text.includes("regulation") ||
      text.includes("sec") ||
      text.includes("ban")
    )
      return "regulation";
    return "other";
  }

  private async recordToMemory(
    signal: PredictionSignal,
    market: PredictionMarket,
    quality: MarketQualityScore,
  ): Promise<void> {
    const slug = `predictions/markets/${market.id}`;
    const content = `---
type: prediction-market
status: ${market.status}
category: ${market.category}
quality_score: ${quality.overall}
yes_probability: ${market.aiEstimate.yesProbability}
confidence: ${market.aiEstimate.confidence}
source: ${signal.source}
created: ${market.createdAt.toISOString()}
expires: ${market.expiresAt.toISOString()}
---

# ${market.title}

## AI Estimate
- YES Probability: ${Math.round(market.aiEstimate.yesProbability * 100)}%
- Confidence: ${Math.round(market.aiEstimate.confidence * 100)}%
- Reasoning: ${market.aiEstimate.reasoning}

## Quality Assessment
- Overall: ${quality.overall}/100
- Verifiability: ${quality.verifiability}/100
- Historical Similarity: ${quality.historicalSimilarity}/100
- Community Potential: ${quality.communityPotential}/100

## Historical Cases
${quality.historicalCases.map((c) => `- [[${c.slug}]] ${c.title} (${c.outcome}, similarity: ${c.similarity}%)`).join("\n")}

## Risks
${quality.risks.map((r) => `- ${r}`).join("\n")}

## Source Signal
- Source: ${signal.source}
- Author: ${signal.author ?? "unknown"}
- URL: ${signal.url ?? "n/a"}
`;

    await this.brainWrite(slug, content);
  }
}
