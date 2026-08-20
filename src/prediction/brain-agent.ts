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
import { extractCrowdQuote } from "./crowd.js";
import { resolveExpiry } from "./deadline.js";
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
  /**
   * The agent's "now". Defaults to the system clock.
   *
   * Every date the agent reasons about — the `TODAY IS` line in both prompts,
   * the days-to-deadline horizon, `createdAt`, and the expiry fallback — reads
   * from here rather than `new Date()` directly. A backtest evaluates a signal
   * as of a past date by passing `() => asOf`; nothing else has to change.
   *
   * This is the ONLY clock the agent may consult. A `new Date()` reintroduced
   * anywhere below silently leaks the real present into a retrodiction, which
   * is unrecoverable after the fact — the run looks fine and the numbers lie.
   */
  now?: () => Date;
}

/**
 * Lines in retrieved brain context that are this system's OWN past output.
 *
 * The brain stores every daily report and every market page this pipeline
 * writes. queryHistoricalContext() then does a semantic search over that same
 * brain, so the estimator retrieves its own earlier guesses and reads them as
 * independent corroboration. Its own words, from production state:
 *
 *   "Two independent AI estimates for this specific market consistently
 *    predict a 90% probability."
 *
 *   "The market 'US announces end of Iranian blockade by August 15' has an AI
 *    Estimate of 91%. Logically the probability by a later date cannot be
 *    lower. Therefore the probability must be at least 91%. The current
 *    probability of 72% is inconsistent and has been updated to 91%."
 *
 * That is a self-reinforcing loop: an estimate becomes evidence for the next
 * estimate, which becomes evidence for the one after. It ratcheted one question
 * to 91% against a market pricing it at 7%, and no amount of downstream repair
 * can fix a number produced this way. Cut the loop at the source.
 */
const SELF_REFERENCE_PATTERNS: RegExp[] = [
  /\bAI[- ]?(estimate|estimated|estimates|probability|forecast|prediction)\b/i,
  /\bInbrain\b/i,
  /\b(our|my|previous|prior|earlier|the system'?s)\s+(estimate|forecast|prediction|probability)\b/i,
  // A retrieved line quoting a probability for a DIFFERENT market. Whatever it
  // is called, a number we produced is not evidence about this question.
  /\b(historical context|context)\b[^.]{0,60}\bprobability\b/i,
  /\byes[_ ]?probability\b/i,
  // Any page under predictions/, not just the daily reports: recordToMemory
  // writes one page per market under predictions/markets/, and those carry the
  // estimate too. Matching only the reports let "historical context notes a high
  // probability (65%) ... (predictions/markets/mkt_…)" back into the prompt.
  /\bpredictions?\//i,
  /\bmkt_\d{10,}/i,
  /\bdaily intelligence\b/i,
  /\bprediction-daily-report\b/i,
];

/**
 * Drop lines of retrieved context that restate this pipeline's own estimates.
 *
 * Line-granular on purpose: a genuinely useful brain note about the underlying
 * subject keeps its other lines. Whole-document rejection would throw away real
 * history alongside the echo.
 */
export function stripSelfReference(context: string): string {
  if (!context) return context;
  const kept: string[] = [];
  let dropped = 0;
  for (const line of context.split("\n")) {
    if (line.trim() && SELF_REFERENCE_PATTERNS.some((re) => re.test(line))) {
      dropped++;
      continue;
    }
    kept.push(line);
  }
  if (dropped > 0) {
    console.warn(
      `[brain-agent] dropped ${dropped} self-referential line(s) from brain context ` +
        `(own prior estimates are not evidence)`,
    );
  }
  return kept.join("\n").trim();
}

/**
 * The market price is the single strongest predictor available, and the prompt
 * used to show it without saying what to do with it. The model treated a 7%
 * market as a number to disagree with rather than the prior to start from.
 */
const CROWD_ANCHOR_RULE = `
START FROM THE MARKET PRICE:
- When a live venue price is given, begin there. It aggregates real money from many
  participants and beats a single model's judgement more often than not.
- You are EXPECTED to disagree when you have a reason. Moving 5-15 points off the
  price on an ordinary judgement call is normal and useful — this system exists to
  add a view, not to echo the quote. Simply restating the market price adds nothing.
- Beyond about 20 points, name the specific fact the market plausibly has not
  priced. "The market seems wrong" or "my analysis suggests" is not a fact;
  a dated event, a published figure, or a stated policy is.
- Do NOT anchor so hard that you reproduce the price. If your answer lands within
  1-2 points of the market on every question, you are not estimating, you are copying.
- NEVER justify a probability using an AI estimate, a previous estimate of this
  system, or any figure from a prior Inbrain report. Those are not evidence and
  not independent confirmation. Use only primary facts about the world.
`;

/**
 * Whether a signal reports something that already happened, rather than posing a
 * question about the future.
 *
 * Newswire and whale-alert feeds are announcements: "Grayscale withdraws
 * proposal", "140,000 ETH transferred", "Cardano falls 4.7%". Turned into a
 * "market", each one gets ~98% from the estimator — the event is real — and then
 * an outcome guessed by auto-resolution. 68 of the 83 resolved markets in
 * production came in this way and hit 56%, which is the bulk of the system's
 * accuracy problem.
 *
 * Returns the rejection reason, or null when the signal is a genuine question.
 */
export function reportsSettledFact(signal: PredictionSignal): string | null {
  const text = signal.content ?? "";
  if (!text.trim()) return "empty signal";

  // A real question. Venue markets always take this shape, and a headline that
  // genuinely asks about the future keeps its chance here.
  const isQuestion =
    /\?/.test(text) ||
    /\b(will|would|can|does|is|are|by \d{4}|before|through|until)\b/i.test(text.slice(0, 90));

  // Newswire framing: the flash markers these feeds prefix onto announcements.
  const isNewsFlash = /\b(just in|breaking|update|announced|confirms?|reports?)\b/i.test(
    text.slice(0, 60),
  );

  // Past-tense report of a completed action, the whale-alert / price-move shape.
  const isPastEvent =
    // Both tenses: these feeds write headlines in the "historical present"
    // ("Cardano falls 4.7%") as often as the past ("Cardano fell 4.7%").
    /\b(has|have|was|were|withdrew|withdraws|halted|halts|transferred|transfers|minted|mints|burned|burns|fell|falls|rose|rises|surged|surges|dropped|drops|plunged|plunges|jumped|jumps|launched|launches|filed|files|resigned|resigns|acquired|acquires|approved|approves|rejected|rejects|sold|sells|bought|buys)\b/i.test(
      text,
    );

  if (isQuestion) return null;
  if (isNewsFlash) return "reports an event that already happened, not a question about the future";
  if (isPastEvent) return "describes a completed event, so there is no outcome left to forecast";

  // Operational notices from exchange/newswire channels: "Binance Adds 0G on
  // Spot", "Notice of Removal of Spot Trading Pairs", "Peter Schiff says …".
  // These state a decision or an opinion, never pose a question, and are the
  // rest of the 88 telegram pseudo-markets that piled up in pending_resolution.
  const isOperationalNotice =
    /\b(notice of|will (add|remove|delist|extend|adjust|suspend|open|close)|adds?|removes?|delists?|launches|introduc\w+|says|said|announces?)\b/i.test(
      text,
    );
  if (isOperationalNotice) {
    return "an announcement or opinion, not a question with a future outcome";
  }
  return null;
}

const BASE_RATE_GROUNDING_RULE = `
BASE RATE & PRIOR GROUNDING RULES:
1. MULTI-CANDIDATE ELECTIONS & DISTANT POLITICAL CONTESTS:
   - In national multi-candidate elections resolving in >6 months, ground against the base rate 1/N.
   - An individual non-incumbent challenger in a crowded field MUST NOT be assigned > 0.35 probability without overwhelming conclusive polling data.
   - Account for incumbency advantage (historically ~60-70% re-election rate for incumbents in presidential systems).
2. EXTREME OUTCOMES & SUPERMAJORITIES:
   - Extreme electoral landslides (e.g. winning >= 80% of votes in a competitive seat) have a historical base rate < 0.05.
3. CENTRAL BANK DECISIONS:
   - Status quo ("No change") is the default high base rate unless economic indicators or FOMC forward guidance strongly signal an active easing/tightening cycle.
`;

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
  private now: () => Date;

  constructor(opts: BrainAgentOptions = {}) {
    this.qualityThreshold = opts.qualityThreshold ?? DEFAULT_QUALITY_THRESHOLD;
    this.lookbackDays = opts.historicalLookbackDays ?? 90;
    this.modelId = opts.modelId ?? DEFAULT_MODEL;
    this.now = opts.now ?? (() => new Date());

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

    // Rejected before a single LLM call. A news flash reports something that has
    // ALREADY happened; there is no future outcome to forecast. The estimator
    // dutifully assigned it ~98% (the event is real, after all), auto-resolution
    // then guessed the "outcome" from a brain that holds no news, and the coin
    // landed right 56% of the time. Those 68 pseudo-markets are the single
    // largest contributor to this system's poor accuracy score.
    const reported = reportsSettledFact(signal);
    if (reported) {
      console.log(`[brain-agent] rejected signal ${signal.id} — ${reported}`);
      return { accepted: false, reason: reported };
    }

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

    // Stripped before it reaches any prompt: the brain holds this pipeline's own
    // reports, and retrieving them turns yesterday's guess into today's evidence.
    return stripSelfReference(await this.brainQuery(query));
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
    const quote = extractCrowdQuote(signal);
    if (!quote) return [];
    const probability = quote.probability;

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

TODAY IS ${this.now().toISOString().slice(0, 10)}. Judge timelineFeasibility against
that date; do not infer the current date from anything below.

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
${CROWD_ANCHOR_RULE}
${BASE_RATE_GROUNDING_RULE}
${PROBABILITY_SCALE_RULE}
Respond with ONLY valid JSON:
{
  "yesProbability": number (0-1),
  "confidence": number (0-1),
  "reasoning": string,
  "sources": [string],
  "estimatedResolutionDays": number (1-365)
}`;

    // The venue price led the prompt as a bare "Cross-Platform Consensus" line
    // that the model routinely walked past. Stated as the starting point, with
    // the departure it would have to justify spelled out.
    const anchor = crowdWisdom[0]?.consensusProbability;
    const anchorBlock =
      typeof anchor === "number"
        ? `LIVE MARKET PRICE (your starting point): ${formatPercent(anchor)} YES on ${crowdWisdom[0]!.platform}.
Begin at ${formatPercent(anchor)}. Adjust up or down where your own reading of the evidence
differs — that judgement is the point of this system. Going outside
${formatPercent(Math.max(0, anchor - 0.2))}–${formatPercent(Math.min(1, anchor + 0.2))} needs a specific fact the market has not priced.
Do not simply repeat ${formatPercent(anchor)} back; if you agree that closely, say why in one line.`
        : `LIVE MARKET PRICE: none available for this signal. Ground the estimate in
base rates for this class of event, not in a bare intuition.`;

    // Today's date and the real deadline. Without them the model guessed its own
    // "now" from whatever the retrieved context implied and reasoned about the
    // wrong horizon entirely: on a market closing 2026-12-31 it wrote "over 2.5
    // years from mid-2024" and widened its uncertainty to match — while the
    // actual remaining window was four months. A too-long horizon manufactures
    // room for doubt and pushes the estimate away from the market for no reason.
    const now = this.now();
    const deadline = signal.deadline;
    const horizonBlock =
      deadline instanceof Date && !Number.isNaN(deadline.getTime())
        ? `TODAY IS ${now.toISOString().slice(0, 10)}. This question closes ${deadline.toISOString().slice(0, 10)} — ` +
          `${Math.max(0, Math.round((deadline.getTime() - now.getTime()) / 86_400_000))} days from now.
Reason about THAT window, not a longer one. Do not infer the date from anything below.`
        : `TODAY IS ${now.toISOString().slice(0, 10)}. Do not infer the current date from anything below.`;

    const prompt = `Signal: ${signal.content}

${horizonBlock}

${anchorBlock}

Historical Brain Context (background only — never a source of probabilities):
${historicalContext}

Estimate the probability that this event resolves YES.`;

    const response = await this.llmCall(system, prompt, {
      model: this.modelId,
    });

    const context = `generateEstimate(${signal.id})`;
    try {
      const raw = parseLlmJson<Record<string, unknown>>(response, context);
      let yesProbability = requireProbability(raw.yesProbability, "yesProbability", context);
      const estDays = requireIntInRange(
        raw.estimatedResolutionDays ?? 30,
        "estimatedResolutionDays",
        context,
        1,
        365,
      );

      // Deterministic Base Rate Protection for distant multi-candidate political races:
      const isDistantContest =
        /presidential election|presidential nomination|parliamentary election|election|nominee/i.test(
          signal.content,
        ) && estDays > 180;
      const isIncumbent = /incumbent|re-election/i.test(signal.content);
      if (isDistantContest && !isIncumbent && yesProbability > 0.35) {
        console.warn(
          `[brain-agent] ${context}: political base rate clamp (${(yesProbability * 100).toFixed(1)}% > 35% for distant multi-candidate race) — clamped to 0.35`,
        );
        yesProbability = 0.35;
      }

      return {
        yesProbability,
        confidence: requireProbability(raw.confidence, "confidence", context),
        reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
        sources: optionalStringArray(raw.sources),
        estimatedResolutionDays: estDays,
        modelVersion: this.modelId,
        updatedAt: this.now(),
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
        updatedAt: this.now(),
      };
    }
  }

  private buildMarket(
    signal: PredictionSignal,
    quality: MarketQualityScore,
    estimate: AIEstimate,
  ): PredictionMarket {
    const category = this.inferCategory(signal);
    const title = signal.content.slice(0, 200);
    const now = this.now();
    // The venue's close date, else the deadline written into the question, else
    // the model's guess. This used to be the model's guess unconditionally, so
    // a market asking about August 9 stayed "live" well into September.
    const expiry = resolveExpiry({
      venueDeadline: signal.deadline,
      title,
      estimatedResolutionDays: estimate.estimatedResolutionDays,
      now,
    });
    const quote = extractCrowdQuote(signal);

    return {
      // Deliberately the REAL clock, not this.now(): an id needs uniqueness, not
      // historical accuracy. Under a backtest every signal in a batch shares one
      // frozen `now`, so sourcing the id from it would collide on the timestamp
      // half and lean the whole id on Math.random().
      id: `mkt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      description: `AI-generated prediction market based on ${signal.source} signal.\n\n${estimate.reasoning}`,
      category,
      status: "active",
      createdAt: now,
      expiresAt: expiry.expiresAt,
      aiEstimate: estimate,
      qualityScore: quality,
      sourceSignals: [signal.id],
      relatedMarkets: [],
      metadata: {
        signalSource: signal.source,
        author: signal.author,
        authorInfluence: signal.authorInfluence,
        // AnalystAgent.discoverAlpha and reporting read metadata.crowdProbability
        // alongside crowdQuote for provenance validation.
        crowdProbability: quote?.probability,
        // The full quote carries where that number came from, so no report
        // section or desync detector can present it as a live orderbook if it was not.
        crowdQuote: quote,
        expirySource: expiry.source,
        deadlineFraming: expiry.framing,
        venueDeadline: signal.deadline?.toISOString(),
        venue: quote?.venue,
        venueMarketId: signal.rawData?.venueMarketId,
        eventKey: (signal.rawData?.eventKey as string | undefined) ?? (signal.rawData?.slug as string | undefined),
        venueUrl: signal.url,
        volume24hr: signal.rawData?.volume24hr ?? signal.rawData?.volume,
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
