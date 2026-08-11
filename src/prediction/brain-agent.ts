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
import {
  parseLlmJson,
  requireScore,
  requireProbability,
  requireIntInRange,
  optionalStringArray,
  logValidationFailure,
  PROBABILITY_SCALE_RULE,
} from "./llm-json.js";
import { CALIBRATION_SLUG_QUERY } from "./calibration.js";
import { extractCrowdProbability } from "./crowd.js";
import { formatPercent } from "./format.js";

const DEFAULT_QUALITY_THRESHOLD = 65;
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/** Sources that are themselves prediction-market venues. Signals from these
 *  arrive with a resolution rule and deadline already attached. */
const EXISTING_MARKET_SOURCES = new Set<PredictionSignal["source"]>([
  "polymarket",
  "kalshi",
  "predictit",
]);

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

    // Empty string, not a sentence. A non-empty default gets interpolated into
    // the system prompt as if it were real calibration guidance.
    this.brainQuery = opts.brainQuery ?? (async () => "");
    this.brainWrite = opts.brainWrite ?? (async () => {});
    this.llmCall =
      opts.llmCall ??
      (async () => {
        throw new Error("BrainAgent: no llmCall configured");
      });
  }

  /** Calibration rules are the same for every signal in a run, but the old code
   *  fetched them inside both assessQuality and generateEstimate — two extra
   *  brain queries per signal, each a fresh CLI process. Fetch once, reuse. */
  private calibrationCache: Promise<string> | null = null;

  private calibrationRules(): Promise<string> {
    if (!this.calibrationCache) {
      this.calibrationCache = this.brainQuery(CALIBRATION_SLUG_QUERY).catch((err) => {
        console.error(`[brain-agent] calibration lookup failed: ${(err as Error).message}`);
        return "";
      });
    }
    return this.calibrationCache;
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

    const historicalContext = await this.queryHistoricalContext(signal);
    const crowdWisdom = this.crowdWisdomFor(signal);

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
      `[brain-agent] accepted signal ${signal.id} → market "${market.title}" (quality: ${qualityScore.overall}, YES: ${formatPercent(estimate.yesProbability)})`,
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

  /**
   * Crowd consensus for this signal.
   *
   * This used to issue a brain query asking a semantic search engine to return
   * a JSON array — it never did, so the parse always failed and every
   * evaluation was handed an empty array at the cost of one CLI process per
   * signal. The signal itself already carries the exchange's own numbers, so
   * read them instead of asking for them.
   */
  private crowdWisdomFor(signal: PredictionSignal): CrowdWisdom[] {
    const probability = extractCrowdProbability(signal);
    if (probability === undefined) return [];

    const raw = signal.rawData ?? {};
    const volume = Number(raw.volume24hr ?? raw.volume ?? 0);

    return [
      {
        platform: signal.source,
        marketId: signal.id,
        question: signal.content.slice(0, 200),
        consensusProbability: probability,
        volume: Number.isFinite(volume) ? volume : 0,
        participants: 0,
        lastUpdated: signal.timestamp,
      },
    ];
  }

  private async assessQuality(
    signal: PredictionSignal,
    historicalContext: string,
    crowdWisdom: CrowdWisdom[],
  ): Promise<MarketQualityScore> {
    const calibrationContext = await this.calibrationRules();

    // Signals scraped from an existing prediction market arrive pre-formed: a
    // resolution rule, a deadline and real liquidity already exist, so those
    // dimensions score ~100 for free and the gate accepted everything (10 of 10
    // in production, at 96-99/100, including League of Legends match markets).
    // Tell the model not to award points for properties it did not have to
    // judge, so the score reflects whether WE can add information.
    const isDerivedFromMarket = EXISTING_MARKET_SOURCES.has(signal.source);
    const derivedNote = isDerivedFromMarket
      ? `
IMPORTANT: this signal was scraped from an existing prediction market on ${signal.source}.
Its verifiability, resolution criteria and deadline were written by that venue — they are
NOT evidence of a good opportunity, so do NOT award high verifiability/timelineFeasibility
points merely because the venue supplied them. Score this signal on whether OUR pipeline can
add information the venue's own crowd does not already price in:
  - verifiability: is the resolution rule objective AND independently checkable by us?
  - historicalSimilarity: do we hold history that informs this specific question?
  - communityPotential: does this matter to a macro/crypto audience, or is it niche
    entertainment (individual sports fixtures, esports matches) with no analytical value?
  - liquidityPotential: is the venue's volume meaningful, or is this a thin novelty market?
  - timelineFeasibility: will it resolve soon enough to feed our calibration loop?
Score niche entertainment fixtures LOW on communityPotential even when they are perfectly
verifiable.
`
      : "";

    const system = `You are Inbrain's Market Quality Engine. You evaluate whether a social signal
should become a prediction market. Score each dimension 0-100. Be strict about verifiability.
${derivedNote}${calibrationContext ? "\nApply these calibration rules from past accuracy analysis:\n" + calibrationContext + "\n" : ""}
Respond with ONLY valid JSON matching this schema:
{
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

    const context = `assessQuality(${signal.id})`;
    try {
      const raw = parseLlmJson<Record<string, unknown>>(response, context);

      // Every dimension must be present and numeric. Defaulting a missing one
      // to 0 would quietly understate the score; leaving it undefined made the
      // whole sum NaN, and `NaN < threshold` is false — i.e. the signal was
      // ACCEPTED. Both are wrong, so an incomplete answer is a rejection.
      const verifiability = requireScore(raw.verifiability, "verifiability", context);
      const historicalSimilarity = requireScore(raw.historicalSimilarity, "historicalSimilarity", context);
      const communityPotential = requireScore(raw.communityPotential, "communityPotential", context);
      const liquidityPotential = requireScore(raw.liquidityPotential, "liquidityPotential", context);
      const timelineFeasibility = requireScore(raw.timelineFeasibility, "timelineFeasibility", context);

      const overall = Math.round(
        0.30 * verifiability +
        0.20 * historicalSimilarity +
        0.20 * communityPotential +
        0.15 * liquidityPotential +
        0.15 * timelineFeasibility
      );

      return {
        overall,
        verifiability,
        historicalSimilarity,
        communityPotential,
        liquidityPotential,
        timelineFeasibility,
        reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
        historicalCases: Array.isArray(raw.historicalCases)
          ? (raw.historicalCases as HistoricalCase[])
          : [],
        risks: optionalStringArray(raw.risks),
      };
    } catch (err) {
      logValidationFailure(context, err);
      return {
        overall: 0,
        verifiability: 0,
        historicalSimilarity: 0,
        communityPotential: 0,
        liquidityPotential: 0,
        timelineFeasibility: 0,
        reasoning: `Quality assessment could not be validated: ${(err as Error).message}`,
        historicalCases: [],
        risks: ["Assessment validation failed"],
      };
    }
  }

  private async generateEstimate(
    signal: PredictionSignal,
    historicalContext: string,
    crowdWisdom: CrowdWisdom[],
  ): Promise<AIEstimate> {
    const calibrationContext = await this.calibrationRules();

    const system = `You are Inbrain's AI probability estimator. Given a prediction signal and
historical context, estimate the YES probability. Be calibrated — don't default to 50%.
${calibrationContext ? "\nApply these calibration rules from past accuracy analysis:\n" + calibrationContext + "\n" : ""}
${PROBABILITY_SCALE_RULE}
Respond with ONLY valid JSON:
{
  "yesProbability": number (0-1),
  "confidence": number (0-1),
  "reasoning": string,
  "sources": [string],
  "estimatedResolutionDays": number (1-365)
}`;

    const prompt = `Signal: ${signal.content}

Historical Brain Context:
${historicalContext}

Cross-Platform Consensus:
${crowdWisdom.map((cw) => `${cw.platform}: ${formatPercent(cw.consensusProbability)} YES (${cw.participants} participants)`).join("\n")}

Estimate the probability that this event resolves YES.`;

    const response = await this.llmCall(system, prompt, {
      model: this.modelId,
    });

    const context = `generateEstimate(${signal.id})`;
    try {
      const raw = parseLlmJson<Record<string, unknown>>(response, context);
      // Spreading `...parsed` used to let an absent yesProbability through as
      // undefined, which then rendered as NaN% everywhere downstream.
      return {
        yesProbability: requireProbability(raw.yesProbability, "yesProbability", context),
        confidence: requireProbability(raw.confidence, "confidence", context),
        reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
        sources: optionalStringArray(raw.sources),
        estimatedResolutionDays: requireIntInRange(
          raw.estimatedResolutionDays ?? 30,
          "estimatedResolutionDays",
          context,
          1,
          365,
        ),
        modelVersion: this.modelId,
        updatedAt: new Date(),
      };
    } catch (err) {
      logValidationFailure(context, err);
      return {
        yesProbability: 0.5,
        confidence: 0.1,
        reasoning: `Unable to generate estimate (${(err as Error).message}) — using base rate`,
        sources: [],
        estimatedResolutionDays: 30,
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
    const daysUntilExpiry = estimate.estimatedResolutionDays ?? 30;
    const expiresAt = new Date(Date.now() + daysUntilExpiry * 86400000);

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
        // AnalystAgent.discoverAlpha reads metadata.crowdProbability. Nothing
        // ever wrote it, so every market screened as "AI vs 0% crowd" — i.e.
        // maximum divergence on every row.
        crowdProbability: extractCrowdProbability(signal),
      },
    };
  }

  private inferCategory(signal: PredictionSignal): MarketCategory {
    const text = signal.content.toLowerCase();
    // Whole-word matching. Substring matching sent almost everything to
    // "technology" because "ai" appears inside said/chain/raise/available, and
    // "sec"/"ban" matched second/sector/bank/urban.
    const has = (...words: string[]): boolean =>
      words.some((w) => new RegExp(`\\b${w}\\b`).test(text));

    if (has("bitcoin", "btc", "ethereum", "eth", "crypto", "cryptocurrency", "token", "stablecoin", "defi"))
      return "crypto";
    if (has("election", "elections", "president", "presidential", "congress", "senate", "parliament", "vote", "votes", "ballot"))
      return "politics";
    if (has("regulation", "regulatory", "sec", "cftc", "lawsuit", "ban", "sanction", "sanctions", "legislation"))
      return "regulation";
    if (has("fed", "fomc", "inflation", "cpi", "interest rate", "rates", "stock", "stocks", "earnings", "gdp", "recession"))
      return "finance";
    if (has("ai", "llm", "gpt", "chip", "chips", "semiconductor", "software", "startup", "model", "models"))
      return "technology";
    if (has("nba", "nfl", "fifa", "olympics", "match", "tournament", "league", "playoffs", "esports", "lol", "dota"))
      return "sports";
    if (has("science", "vaccine", "climate", "nasa", "spacex", "launch"))
      return "science";
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
- YES Probability: ${formatPercent(market.aiEstimate.yesProbability)}
- Confidence: ${formatPercent(market.aiEstimate.confidence)}
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
