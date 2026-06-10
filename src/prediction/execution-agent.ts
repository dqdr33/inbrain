/**
 * Execution Agent — market lifecycle management & auto-resolution.
 *
 * Monitors active markets, tracks real-time developments, updates odds,
 * and automatically resolves markets when sufficient evidence is found.
 */

import type {
  PredictionMarket,
  MarketResolution,
  AIEstimate,
} from "./types.js";

const DEFAULT_MONITOR_INTERVAL_MS = 300_000; // 5 minutes
const DEFAULT_RESOLUTION_CONFIDENCE = 0.9;

export interface ExecutionAgentOptions {
  monitorIntervalMs?: number;
  autoResolutionEnabled?: boolean;
  resolutionConfidenceThreshold?: number;
  brainQuery?: (query: string) => Promise<string>;
  brainWrite?: (slug: string, content: string) => Promise<void>;
  llmCall?: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;
  onMarketUpdate?: (market: PredictionMarket) => void | Promise<void>;
  onMarketResolved?: (
    market: PredictionMarket,
    resolution: MarketResolution,
  ) => void | Promise<void>;
}

export class ExecutionAgent {
  private monitorIntervalMs: number;
  private autoResolution: boolean;
  private resolutionThreshold: number;
  private brainQuery: (query: string) => Promise<string>;
  private brainWrite: (slug: string, content: string) => Promise<void>;
  private llmCall: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;
  private onMarketUpdate?: (market: PredictionMarket) => void | Promise<void>;
  private onMarketResolved?: (
    market: PredictionMarket,
    resolution: MarketResolution,
  ) => void | Promise<void>;

  private activeMarkets: Map<string, PredictionMarket> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: ExecutionAgentOptions = {}) {
    this.monitorIntervalMs =
      opts.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
    this.autoResolution = opts.autoResolutionEnabled ?? true;
    this.resolutionThreshold =
      opts.resolutionConfidenceThreshold ?? DEFAULT_RESOLUTION_CONFIDENCE;

    this.brainQuery =
      opts.brainQuery ?? (async () => "No brain connection configured.");
    this.brainWrite = opts.brainWrite ?? (async () => {});
    this.llmCall = opts.llmCall ?? (async () => "LLM not configured.");
    this.onMarketUpdate = opts.onMarketUpdate;
    this.onMarketResolved = opts.onMarketResolved;
  }

  addMarket(market: PredictionMarket): void {
    this.activeMarkets.set(market.id, market);
    console.log(
      `[execution-agent] tracking market "${market.title.slice(0, 60)}" (${this.activeMarkets.size} active)`,
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log(
      `[execution-agent] started — monitoring ${this.activeMarkets.size} markets`,
    );
    this.timer = setInterval(() => this.monitorCycle(), this.monitorIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[execution-agent] stopped");
  }

  private async monitorCycle(): Promise<void> {
    for (const [id, market] of this.activeMarkets) {
      if (market.status === "resolved" || market.status === "cancelled")
        continue;

      try {
        if (new Date() >= market.expiresAt) {
          await this.attemptResolution(market);
          continue;
        }

        const updatedEstimate = await this.refreshEstimate(market);
        if (updatedEstimate) {
          market.aiEstimate = updatedEstimate;
          this.activeMarkets.set(id, market);
          await this.onMarketUpdate?.(market);
        }

        if (this.autoResolution) {
          const resolutionCheck = await this.checkForEarlyResolution(market);
          if (resolutionCheck) {
            await this.resolveMarket(market, resolutionCheck);
          }
        }
      } catch (err) {
        console.error(
          `[execution-agent] error monitoring market ${id}:`,
          err,
        );
      }
    }
  }

  private async refreshEstimate(
    market: PredictionMarket,
  ): Promise<AIEstimate | null> {
    const context = await this.brainQuery(
      `Latest developments for prediction market: "${market.title}". Include recent news, social media activity, and on-chain data.`,
    );

    const system = `You are Inbrain's real-time probability updater. Given a market and new context, 
decide if the probability should change. If no meaningful new info, respond with null.

Respond with ONLY valid JSON (or the word "null"):
{
  "yesProbability": number (0-1),
  "confidence": number (0-1),
  "reasoning": string,
  "sources": [string]
}`;

    const prompt = `Market: ${market.title}
Current YES: ${Math.round(market.aiEstimate.yesProbability * 100)}%
Current Confidence: ${Math.round(market.aiEstimate.confidence * 100)}%

New Context:
${context}

Should the probability be updated? Only update if there's meaningful new evidence.`;

    const response = await this.llmCall(system, prompt);

    if (response.trim() === "null" || response.trim() === '"null"')
      return null;

    try {
      const parsed = JSON.parse(response);
      const delta = Math.abs(
        parsed.yesProbability - market.aiEstimate.yesProbability,
      );
      if (delta < 0.02) return null; // skip trivial changes

      return {
        ...parsed,
        modelVersion: market.aiEstimate.modelVersion,
        updatedAt: new Date(),
      };
    } catch {
      return null;
    }
  }

  private async checkForEarlyResolution(
    market: PredictionMarket,
  ): Promise<MarketResolution | null> {
    const system = `You are Inbrain's Auto-Resolution Engine. Determine if a prediction market 
can be definitively resolved based on publicly verifiable information.

Only resolve if confidence >= ${this.resolutionThreshold * 100}%.

Respond with ONLY valid JSON (or "null" if not resolvable yet):
{
  "outcome": "yes" | "no",
  "confidence": number (0-1),
  "evidence": [string],
  "verificationSources": [string]
}`;

    const evidence = await this.brainQuery(
      `Has the event "${market.title}" been definitively resolved? Find verifiable public sources confirming the outcome.`,
    );

    const prompt = `Market: ${market.title}
Category: ${market.category}
Created: ${market.createdAt.toISOString()}
Expires: ${market.expiresAt.toISOString()}

Evidence from Brain:
${evidence}

Can this market be resolved now with high confidence?`;

    const response = await this.llmCall(system, prompt);

    if (response.trim() === "null" || response.trim() === '"null"')
      return null;

    try {
      const parsed = JSON.parse(response);
      if (parsed.confidence < this.resolutionThreshold) return null;

      return {
        outcome: parsed.outcome,
        resolvedBy: "auto",
        evidence: parsed.evidence ?? [],
        verificationSources: parsed.verificationSources ?? [],
        resolvedAt: new Date(),
      };
    } catch {
      return null;
    }
  }

  private async attemptResolution(market: PredictionMarket): Promise<void> {
    const resolution = await this.checkForEarlyResolution(market);
    if (resolution) {
      await this.resolveMarket(market, resolution);
    } else {
      market.status = "pending_resolution";
      console.log(
        `[execution-agent] market "${market.title.slice(0, 60)}" expired — awaiting manual resolution`,
      );
    }
  }

  private async resolveMarket(
    market: PredictionMarket,
    resolution: MarketResolution,
  ): Promise<void> {
    market.status = "resolved";
    market.resolution = resolution;
    market.resolvedAt = resolution.resolvedAt;
    this.activeMarkets.set(market.id, market);

    await this.recordResolution(market, resolution);
    await this.onMarketResolved?.(market, resolution);

    console.log(
      `[execution-agent] resolved market "${market.title.slice(0, 60)}" → ${resolution.outcome.toUpperCase()} (by: ${resolution.resolvedBy})`,
    );
  }

  private async recordResolution(
    market: PredictionMarket,
    resolution: MarketResolution,
  ): Promise<void> {
    const slug = `predictions/resolutions/${market.id}`;
    const aiPrediction = market.aiEstimate.yesProbability;
    const actualOutcome = resolution.outcome === "yes" ? 1 : 0;
    const brierScore = Math.pow(aiPrediction - actualOutcome, 2);

    const content = `---
type: prediction-resolution
market_id: ${market.id}
outcome: ${resolution.outcome}
resolved_by: ${resolution.resolvedBy}
brier_score: ${brierScore.toFixed(4)}
ai_prediction: ${aiPrediction.toFixed(4)}
resolved_at: ${resolution.resolvedAt.toISOString()}
---

# Resolution: ${market.title}

## Outcome
**${resolution.outcome.toUpperCase()}** (resolved by: ${resolution.resolvedBy})

## AI Performance
- AI Prediction: ${Math.round(aiPrediction * 100)}% YES
- Actual: ${resolution.outcome.toUpperCase()}
- Brier Score: ${brierScore.toFixed(4)} (lower is better)
- ${brierScore < 0.1 ? "Excellent calibration" : brierScore < 0.25 ? "Good calibration" : "Needs improvement"}

## Evidence
${resolution.evidence.map((e) => `- ${e}`).join("\n")}

## Verification Sources
${resolution.verificationSources.map((s) => `- ${s}`).join("\n")}
`;

    await this.brainWrite(slug, content);
  }

  getActiveMarkets(): PredictionMarket[] {
    return [...this.activeMarkets.values()].filter(
      (m) => m.status !== "resolved" && m.status !== "cancelled",
    );
  }

  getMarket(id: string): PredictionMarket | undefined {
    return this.activeMarkets.get(id);
  }
}
