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
import {
  parseLlmJson,
  isExplicitNull,
  requireProbability,
  optionalStringArray,
  logValidationFailure,
  PROBABILITY_SCALE_RULE,
} from "./llm-json.js";
import { formatPercent } from "./format.js";

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
  private cycling = false;

  constructor(opts: ExecutionAgentOptions = {}) {
    this.monitorIntervalMs =
      opts.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
    this.autoResolution = opts.autoResolutionEnabled ?? true;
    this.resolutionThreshold =
      opts.resolutionConfidenceThreshold ?? DEFAULT_RESOLUTION_CONFIDENCE;

    this.brainQuery = opts.brainQuery ?? (async () => "");
    this.brainWrite = opts.brainWrite ?? (async () => {});
    this.llmCall =
      opts.llmCall ??
      (async () => {
        throw new Error("ExecutionAgent: no llmCall configured");
      });
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
    this.timer = setInterval(() => {
      // A floating promise here becomes an unhandled rejection, which is fatal
      // under Bun.
      void this.runMonitorCycle().catch((err) =>
        console.error("[execution-agent] monitor cycle failed:", err),
      );
    }, this.monitorIntervalMs);
  }

  /**
   * Run exactly one monitor pass. Exposed so a one-shot scheduled run (the way
   * this pipeline is actually deployed on Windows Task Scheduler) can drive
   * market lifecycle without keeping a daemon alive.
   */
  async runMonitorCycle(): Promise<void> {
    if (this.cycling) {
      console.warn("[execution-agent] previous monitor cycle still running — skipping");
      return;
    }
    this.cycling = true;
    try {
      await this.monitorCycle();
    } finally {
      this.cycling = false;
    }
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

      // A market that expired without resolvable evidence is parked in
      // pending_resolution awaiting a human. Re-running auto-resolution on it
      // every cycle burned two LLM calls per expired market, every 5 minutes,
      // forever — and never produced a different answer.
      if (market.status === "pending_resolution") continue;

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
    const brainContext = await this.brainQuery(
      `Latest developments for prediction market: "${market.title}". Include recent news, social media activity, and on-chain data.`,
    );

    const system = `You are Inbrain's real-time probability updater. Given a market and new context,
decide if the probability should change. If no meaningful new info, respond with null.

${PROBABILITY_SCALE_RULE}
Respond with ONLY valid JSON (or the word "null"):
{
  "yesProbability": number (0-1),
  "confidence": number (0-1),
  "reasoning": string,
  "sources": [string]
}`;

    const prompt = `Market: ${market.title}
Current YES: ${formatPercent(market.aiEstimate.yesProbability)}
Current Confidence: ${formatPercent(market.aiEstimate.confidence)}

New Context:
${brainContext}

Should the probability be updated? Only update if there's meaningful new evidence.`;

    const response = await this.llmCall(system, prompt);

    if (isExplicitNull(response)) return null;

    const context = `refreshEstimate(${market.id})`;
    try {
      const raw = parseLlmJson<Record<string, unknown>>(response, context);
      // A missing yesProbability made `delta` NaN, and `NaN < 0.02` is false —
      // so the malformed estimate was written into the market and the stored
      // probability became undefined.
      const yesProbability = requireProbability(raw.yesProbability, "yesProbability", context);
      const confidence = requireProbability(raw.confidence, "confidence", context);

      const delta = Math.abs(yesProbability - market.aiEstimate.yesProbability);
      if (delta < 0.02) return null; // skip trivial changes

      return {
        yesProbability,
        confidence,
        reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
        sources: optionalStringArray(raw.sources),
        estimatedResolutionDays: market.aiEstimate.estimatedResolutionDays,
        modelVersion: market.aiEstimate.modelVersion,
        updatedAt: new Date(),
      };
    } catch (err) {
      logValidationFailure(context, err);
      return null;
    }
  }

  private async checkForEarlyResolution(
    market: PredictionMarket,
  ): Promise<MarketResolution | null> {
    const system = `You are Inbrain's Auto-Resolution Engine. Determine if a prediction market 
can be definitively resolved based on publicly verifiable information.

Only resolve if confidence >= ${this.resolutionThreshold * 100}%.

${PROBABILITY_SCALE_RULE}
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

    if (isExplicitNull(response)) return null;

    const context = `checkForEarlyResolution(${market.id})`;
    try {
      const raw = parseLlmJson<Record<string, unknown>>(response, context);

      // Fail CLOSED. `undefined < 0.9` is false, so an answer with no
      // confidence field used to resolve the market — the single most
      // consequential decision this agent makes, taken on missing data.
      const confidence = requireProbability(raw.confidence, "confidence", context);
      if (confidence < this.resolutionThreshold) return null;

      if (raw.outcome !== "yes" && raw.outcome !== "no") {
        logValidationFailure(
          context,
          new Error(`outcome must be "yes" or "no", got ${JSON.stringify(raw.outcome)}`),
        );
        return null;
      }

      const evidence = optionalStringArray(raw.evidence);
      if (evidence.length === 0) {
        logValidationFailure(context, new Error("resolution carried no evidence"));
        return null;
      }

      return {
        outcome: raw.outcome,
        resolvedBy: "auto",
        evidence,
        verificationSources: optionalStringArray(raw.verificationSources),
        resolvedAt: new Date(),
      };
    } catch (err) {
      logValidationFailure(context, err);
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

    // Hand the market off and stop tracking it. Keeping resolved markets in the
    // map forever meant the monitor loop's iteration cost — and memory — grew
    // without bound over a long-running process.
    this.activeMarkets.delete(market.id);

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
- AI Prediction: ${formatPercent(aiPrediction)} YES
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
