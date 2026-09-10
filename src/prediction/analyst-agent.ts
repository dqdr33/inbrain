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
  optionalStringArray,
  logValidationFailure,
} from "./llm-json.js";
import { formatPercent } from "./format.js";
import { isLive } from "./deadline.js";
import type { CrowdQuote } from "./crowd.js";
import { findStructuralDesyncs, describeDesync } from "./cross-market.js";
import type { DesyncFinding } from "./cross-market.js";
import { normalizeRelatedMarkets, validateNormalizedProbabilities } from "./normalize.js";
import type { ProbabilityConflict } from "./normalize.js";
import { enforceMonotonicity } from "./monotonic.js";
import type { MonotonicAdjustment } from "./monotonic.js";

/**
 * Mean Brier score over markets that actually resolved, or null when there is
 * nothing to score.
 *
 * This used to be a field in the LLM's JSON schema — the model was asked to
 * report `avgBrierScore` despite the prompt containing no resolved-market data
 * at all, so the number was invented. Calibration is arithmetic; compute it.
 */
/** Markets whose outcome a venue actually settled — the only ones worth scoring.
 *  Exported so the sample size shown in the report and the score itself can
 *  never be computed over different sets. */
export function scorableMarkets(markets: PredictionMarket[]): PredictionMarket[] {
  return markets.filter(
    (m) =>
      m.resolution &&
      m.resolution.outcome !== "cancelled" &&
      m.resolution.resolvedBy !== "auto",
  );
}

export function computeAvgBrierScore(markets: PredictionMarket[]): number | null {
  // Scores ONLY against outcomes a venue actually settled. `resolvedBy: "auto"`
  // is the retired LLM path: it guessed the outcome from a brain holding no news
  // and was right 56% of the time while claiming 90%+ confidence. 83 of the 96
  // stored resolutions came from it, so an unfiltered score measures this system
  // against a pile of coin flips — it cannot improve no matter how good the
  // forecasts get, and it cannot be trusted when it does move.
  const scored = scorableMarkets(markets);
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

/**
 * How old an AI estimate may be and still be compared against a live price.
 *
 * Six hours is a compromise: long enough that a slow-moving political question
 * estimated this morning still counts, short enough that an overnight crypto
 * move cannot masquerade as a disagreement. Markets that fall out of this window
 * are not wrong, they are simply un-re-estimated — the fix is to re-estimate
 * them, not to trade on the gap.
 */
export const MAX_ESTIMATE_AGE_SECONDS = 6 * 3600;

/**
 * Per-category staleness limits, in seconds.
 *
 * A single six-hour window is wrong in both directions. Crypto reprices in
 * hours: three Bitcoin estimates four hours old still showed 30-45 point
 * "divergences" that were purely the overnight run-up, and a bet on any of them
 * loses. A 2028 nomination question, by contrast, is not meaningfully different
 * from this morning's view and re-estimating it every hour just burns quota.
 *
 * The rule of thumb: how long until this market's price could plausibly move
 * more than the divergence threshold on its own.
 */
const CATEGORY_MAX_ESTIMATE_AGE_SECONDS: Record<string, number> = {
  crypto: 2 * 3600,
  finance: 4 * 3600,
  sports: 2 * 3600,
  politics: 24 * 3600,
  regulation: 24 * 3600,
  technology: 12 * 3600,
};

export function maxEstimateAgeFor(category: string | undefined): number {
  return CATEGORY_MAX_ESTIMATE_AGE_SECONDS[category ?? ""] ?? MAX_ESTIMATE_AGE_SECONDS;
}

export interface AlphaCandidate {
  marketId: string;
  title: string;
  aiProbability: number;
  crowdProbability: number;
  diffPp: number;
  direction: "ai_higher" | "ai_lower";
  venue: string;
}

/**
 * Identify real, actionable alpha opportunities by screening for verified,
 * live orderbook quotes where AI probability diverges from venue crowd price.
 */
export function findAlphaCandidates(
  markets: PredictionMarket[],
  opts: { now?: Date; minDivergencePp?: number } = {},
): AlphaCandidate[] {
  const now = opts.now ?? new Date();
  const minDivergencePp = opts.minDivergencePp ?? 10.0;
  const candidates: AlphaCandidate[] = [];

  for (const m of markets) {
    if (!isLive(m, now)) continue;
    const quote = m.metadata?.crowdQuote as CrowdQuote | undefined;
    if (!quote || quote.basis !== "orderbook_mid" || quote.stale) continue;
    const asOf = new Date(quote.asOf);
    if (Number.isNaN(asOf.getTime())) continue;
    const ageSec = (now.getTime() - asOf.getTime()) / 1000;
    if (ageSec < 0 || ageSec > 300) continue; // max 5 min staleness

    // The estimate must be roughly as fresh as the price it is being compared
    // against. Quotes refresh every cycle; estimates do not — the median stored
    // estimate was 26 hours old, and one was 157. Comparing a fresh price to
    // yesterday's estimate produces a "divergence" that is really just the
    // market having moved since: Bitcoin ran up overnight, the quote went
    // 47% -> 87%, our 06:42 estimate stayed at 40%, and the report offered that
    // 47-point gap as an opportunity. Betting on it is a guaranteed loss, so a
    // stale estimate is not alpha, it is a to-do.
    const estimatedAt = m.aiEstimate?.updatedAt;
    if (!(estimatedAt instanceof Date) || Number.isNaN(estimatedAt.getTime())) continue;
    const estimateAgeSec = (now.getTime() - estimatedAt.getTime()) / 1000;
    if (estimateAgeSec > maxEstimateAgeFor(m.category)) continue;

    // A monotonicity-repaired estimate is not a forecast. When the model
    // contradicts itself across horizons, the isotonic fit pools the offending
    // pair into their weighted mean — that restores logical consistency, but it
    // asserts a number no estimate produced and no evidence supports. Published
    // as alpha it reads as conviction: the blockade series pooled 50%/37% into
    // 43.9% and offered it against a 3% price as a 41pp edge.
    //
    // The repair still belongs in the report — it is shown in its own
    // adjustments section — but it is an observation about our own coherence,
    // never a reason to trade.
    if (typeof m.metadata?.preMonotonicProbability === "number") continue;

    const aiProb = m.aiEstimate.yesProbability;
    const crowdProb = quote.probability;
    const diffPp = Number(((aiProb - crowdProb) * 100).toFixed(1));
    if (Math.abs(diffPp) >= minDivergencePp) {
      candidates.push({
        marketId: m.id,
        title: m.title,
        aiProbability: aiProb,
        crowdProbability: crowdProb,
        diffPp,
        direction: diffPp > 0 ? "ai_higher" : "ai_lower",
        venue: quote.venue,
      });
    }
  }

  return candidates.sort((a, b) => Math.abs(b.diffPp) - Math.abs(a.diffPp));
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
    const now = new Date();
    // status === "active" alone is not enough: a market whose deadline has
    // passed keeps that status until the execution agent's next monitor pass,
    // and one whose expiry was corrected after ingest never had a chance. An
    // expired question in a report about today's opportunities is worse than
    // no row at all.
    const stillOpen = markets.filter((m) => m.status === "active");
    const activeMarkets = stillOpen.filter((m) => isLive(m, now));
    // Rescale mutually exclusive outcome groups BEFORE anything reads a
    // probability. Every downstream consumer — the prompt lines, the alpha
    // screen, the desync detector — must see the same normalized number, or the
    // report contradicts itself between sections.
    const normalization = normalizeRelatedMarkets(activeMarkets);
    validateNormalizedProbabilities(activeMarkets);
    // Then make each cumulative series non-decreasing in its deadline. Runs
    // AFTER normalization and BEFORE the alpha screen and desync detector: the
    // August 19 report printed the same 91% as a model inconsistency in one
    // section and a HIGH-urgency alpha opportunity in the next.
    //
    // The two repairs cannot fight: normalization groups competing outcomes of
    // ONE decision (window framing), monotonicity groups one outcome across
    // MANY deadlines (cumulative framing). A market cannot be both.
    const monotonic = enforceMonotonicity(activeMarkets, { now });
    const expiredPending = stillOpen.length - activeMarkets.length;
    const resolvedToday = markets.filter(
      (m) =>
        m.status === "resolved" &&
        m.resolvedAt &&
        isToday(m.resolvedAt),
    );

    const brainContext = await this.brainQuery(
      "Summarize today's prediction market activity, notable outcomes, and emerging trends.",
    );

    const alphaCandidates = findAlphaCandidates(activeMarkets, { now, minDivergencePp: 10.0 });
    const desyncs = findStructuralDesyncs(activeMarkets, { now });

    const system = `You are Inbrain's Analyst Agent. Generate a concise daily intelligence report
covering prediction market performance, notable outcomes, and emerging opportunities.

WRITE FOR AN ORDINARY READER, NOT A TRADER:
- Plain everyday language. No jargon: never write "alpha", "divergence", "pp",
  "basis points", "arbitrage", "orderbook", "mispricing", "conviction", "signal".
- Say "we think" / "the market thinks", never "our AI estimates" or "AI projects".
  The reader knows a program wrote this; repeating it in every line adds nothing.
- Explain WHY it matters in one short clause a non-expert would follow, e.g.
  "we think this is far likelier than the market does — worth a look".
- Percentages are fine. Say "25 percentage points", not "25pp". Write "0.25%
  interest rate change" rather than "25bps".
- Short sentences. If a sentence needs a finance dictionary, rewrite it.

Each market below carries two DIFFERENT numbers: "AI" is this system's own estimate,
"venue" is the live market price. Never present one as the other, and never describe a
gap between an AI estimate and a venue price as an arbitrage — it is a disagreement
with the market, not a mispricing between two markets.

CRITICAL RULES:
1. ALPHA OPPORTUNITIES DEFINITION:
   An "Alpha Opportunity" is STRICTLY a trading disagreement between our AI estimate and the LIVE ORDERBOOK venue price on a prediction market (|AI - Venue| >= 10pp).
   - NEVER include single-sided news, Telegram messages, unlisted events, or internal high-conviction forecasts without a live venue price as Alpha.
   - You may ONLY generate "alphaOpportunities" from the "Verified Tradeable Alpha Divergences" provided below. If none are listed, you MUST return "alphaOpportunities": [].

2. POLITICAL BASE RATE & ELECTIONS RULE:
   - For distant multi-candidate elections (>6 months away), non-incumbent challengers have a low base rate (<35%).
   - Never project a single candidate as having high certainty or rising dominance (>35%) based merely on isolated positive news or self-referential AI feedback.

3. TRENDS FILTER:
   - Only include trends with confidence >= 0.50 (50%). Exclude low-confidence or contradictory sectors (< 0.50).
   - Every market listed carries a "closes" date. Every one of them is still open as of today. Never describe an outcome as pending for a date that has already passed, and never restate a deadline that is not the one printed on that market's line.

4. MUTUALLY EXCLUSIVE OUTCOMES:
   - Markets sharing an "[exclusive group: KEY]" tag are competing outcomes of ONE decision. Exactly one of them can happen.
   - Their probabilities have already been rescaled to sum to 100% across the group. Report them as one distribution ("most likely X at N%, with Y at M%"), never as independent findings.
   - NEVER state two outcomes from the same group in a way that implies both are likely. If two numbers from one group would sum above 100% in your sentence, you have misread the group.

Respond with ONLY valid JSON:
{
  "summary": string,
  "alphaOpportunities": [{"title": string, "reasoning": string, "urgency": "high"|"medium"|"low"}],
  "trends": [{"topic": string, "direction": "rising"|"falling"|"stable", "confidence": number (0.50–1.0), "prediction": string}],
  "bestPrediction": string,
  "worstPrediction": string
}

CRITICAL: Return ONLY raw JSON without markdown formatting (do not wrap in \`\`\`json). ALL property names MUST be in English exactly as shown above, and MUST be enclosed in double quotes. Do not include comments.`;

    const prompt = `Active Markets (${activeMarkets.length}):
${activeMarkets.slice(0, 20).map((m) => describeMarketForPrompt(m)).join("\n")}

${
  alphaCandidates.length
    ? `Verified Tradeable Alpha Divergences (|AI - Live Venue Orderbook| >= 10pp):\n${alphaCandidates
        .slice(0, 5)
        .map(
          (c) =>
            `- ${c.title} — AI ${formatPercent(c.aiProbability)} vs ${c.venue} ${formatPercent(c.crowdProbability)} (${c.diffPp > 0 ? "+" : ""}${c.diffPp.toFixed(1)}pp diff)`,
        )
        .join("\n")}\n`
    : "Verified Tradeable Alpha Divergences: None currently detected (no live orderbook divergences >= 10pp).\n\n"
}${
  desyncs.length
    ? `Cross-market inconsistencies detected in code (these ARE structural — the same cumulative question priced lower at a later deadline):\n${desyncs
        .slice(0, 5)
        .map((d) => `- ${describeDesync(d)}`)
        .join("\n")}\n`
    : ""
}Resolved Today (${resolvedToday.length}):
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
    const brierSampleSize = scorableMarkets(markets).length;

    const metrics = {
      totalActive: activeMarkets.length,
      resolvedToday: resolvedToday.length,
      expiredPending,
      avgBrierScore,
      brierSampleSize,
      bestPrediction: "",
      worstPrediction: "",
    };

    const context = "generateDailyReport";
    let report: DailyReport;
    try {
      const parsed = parseLlmJson<Record<string, unknown>>(response, context);
      report = {
        date: new Date(),
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        alphaOpportunities: normaliseAlpha(parsed.alphaOpportunities, alphaCandidates),
        trends: normaliseTrends(parsed.trends),
        desyncs,
        normalizationConflicts: normalization.conflicts,
        monotonicAdjustments: monotonic.adjustments,
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
        alphaOpportunities: [],
        trends: [],
        // Code-derived, so it survives an unusable LLM response.
        desyncs,
        normalizationConflicts: normalization.conflicts,
        monotonicAdjustments: monotonic.adjustments,
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
    opts: { now?: Date } = {},
  ): Promise<TrendInsight[]> {
    const now = opts.now ?? new Date();
    // Same gate the daily report applies. This path used to take `markets`
    // whole, so a question whose deadline passed ten days ago still fed the
    // trend narrative — the "ceasefire holds through August 9" line that kept
    // reappearing on August 19.
    const liveMarkets = markets.filter((m) => m.status === "active" && isLive(m, now));
    normalizeRelatedMarkets(liveMarkets);

    const brainContext = await this.brainQuery(
      "Analyze weekly prediction market trends. What topics are gaining or losing momentum? What patterns are emerging across categories?",
    );

    const system = `You are Inbrain's trend analyst. Identify the top weekly trends across prediction markets.

WRITE FOR AN ORDINARY READER, NOT A TRADER:
- Plain everyday language. No jargon: never write "alpha", "divergence", "pp",
  "basis points", "arbitrage", "orderbook", "conviction", "signal".
- Say "we think" / "the market thinks", never "our AI estimates" or "AI projects".
- Say "25 percentage points", not "25pp"; "a 0.25% rate cut", not "25bps".
- Short sentences. If a sentence needs a finance dictionary, rewrite it.

Markets tagged "[exclusive group: KEY]" are competing outcomes of a single decision —
exactly one can happen, and their probabilities already sum to 100% across the group.
Describe such a group as one distribution, never as separate independent findings, and
never write a sentence in which two of its outcomes both read as likely.

Respond with ONLY a valid JSON array:
[{
  "topic": string,
  "direction": "rising" | "falling" | "stable",
  "confidence": number (0-1),
  "relatedEvents": [string],
  "prediction": string
}]

CRITICAL: Return ONLY raw JSON without markdown formatting (do not wrap in \`\`\`json). ALL property names MUST be in English exactly as shown above, and MUST be enclosed in double quotes. Do not include comments.`;

    const categoryGroups = groupByCategory(liveMarkets);
    const prompt = `Today is ${now.toISOString().slice(0, 10)}. Every market below is still open;
its "closes" date is in the future. Do not describe any outcome as pending for a date
that has already passed.

Markets by Category:
${Object.entries(categoryGroups)
  .map(
    ([cat, ms]) =>
      `\n${cat.toUpperCase()} (${ms.length}):\n${ms
        .slice(0, 5)
        .map((m) => `  ${describeMarketForPrompt(m)}`)
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

  async discoverAlpha(
    markets: PredictionMarket[],
    opts: { now?: Date } = {},
  ): Promise<AlphaDiscovery[]> {
    const now = opts.now ?? new Date();
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
}]

CRITICAL: Return ONLY raw JSON without markdown formatting (do not wrap in \`\`\`json). ALL property names MUST be in English exactly as shown above, and MUST be enclosed in double quotes. Do not include comments.`;

    // Only markets that actually carry a crowd number can be screened. Rows
    // without one used to be shown as "Crowd: 0%", which made every single
    // market look like a maximum-divergence opportunity.
    // `status === "active"` alone lets an already-expired question through:
    // the flag only flips on the execution agent's next monitor pass. An
    // expired market can never be traded, so it is never alpha.
    // A bare `crowdProbability` with no `crowdQuote` behind it is a number from
    // an old state file with no venue and no timestamp — 17 of 70 in production.
    // Screening against it invents a divergence from a price nobody quoted.
    const screenable = markets
      .filter((m) => m.status === "active" && isLive(m, now))
      .filter((m) => {
        const quote = m.metadata?.crowdQuote as CrowdQuote | undefined;
        return typeof quote?.probability === "number" && typeof quote.basis === "string";
      })
      .slice(0, 30);

    if (screenable.length === 0) {
      console.error("[analyst-agent] discoverAlpha: no markets carry a crowd probability — skipping");
      return [];
    }

    const prompt = `Active markets for alpha screening:
${screenable
  .map((m) => {
    const crowdProb = (m.metadata.crowdQuote as CrowdQuote).probability;
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

    if (report.desyncs.length > 0) {
      lines.push("**🔀 Structural Desync:**");
      for (const d of report.desyncs.slice(0, 5)) {
        lines.push(`  ${describeDesync(d)}`);
      }
      lines.push("");
    }

    if (report.alphaOpportunities.length > 0) {
      lines.push("**💎 Alpha Opportunities:**");
      for (const a of report.alphaOpportunities.slice(0, 3)) {
        const label = a.urgencyUnstated ? "UNRATED" : a.urgency.toUpperCase();
        lines.push(`  [${label}] ${a.title}`);
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

/** One prompt line per market, with both numbers named. The model used to be
 *  shown the AI estimate alone, labelled "YES:", and asked to report the top
 *  markets — which is how an AI estimate came to be printed where a reader
 *  would reasonably expect a market price. */
function describeMarketForPrompt(m: PredictionMarket): string {
  const quote = m.metadata?.crowdQuote as CrowdQuote | undefined;
  const venue =
    quote && typeof quote.probability === "number"
      ? `, venue: ${formatPercent(quote.probability)} on ${quote.venue}`
      : "";
  const closes =
    m.expiresAt instanceof Date && !Number.isNaN(m.expiresAt.getTime())
      ? `, closes ${m.expiresAt.toISOString().slice(0, 10)}`
      : "";
  // Surfaced to the model so competing outcomes of one decision are visibly
  // linked. Without it the model sees "no change 86%" and "cut 25bp 52%" as two
  // unrelated facts and writes both into one sentence, summing to 138%.
  const group =
    typeof m.metadata?.normalizationGroup === "string"
      ? ` [exclusive group: ${m.metadata.normalizationGroup}]`
      : "";
  return `- ${m.title.slice(0, 100)} (AI: ${formatPercent(m.aiEstimate.yesProbability)}${venue}${closes}, category: ${m.category})${group}`;
}

export function normaliseAlpha(
  value: unknown,
  allowedCandidates?: AlphaCandidate[],
): DailyReport["alphaOpportunities"] {
  if (!Array.isArray(value)) return [];
  const validTitles = allowedCandidates ? new Set(allowedCandidates.map((c) => c.title.toLowerCase().trim())) : null;

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.title !== "string") return [];

    // When candidates are provided, ensure the opportunity matches a verified venue divergence
    if (validTitles !== null) {
      if (validTitles.size === 0) return [];
      const rowTitleLower = row.title.toLowerCase().trim();
      const match = Array.from(validTitles).some(
        (t) => rowTitleLower.includes(t) || t.includes(rowTitleLower),
      );
      if (!match) return [];
    }

    // A missing or malformed urgency is NOT a judgement of "low". The report
    // prints both as "[LOW]", so a model that dropped the field reads exactly
    // like one that weighed the risk and dismissed it — and a whole batch of
    // opportunities silently going quiet looks like a considered downgrade.
    // Mark the substitution so the renderer can tell the two apart.
    const stated =
      row.urgency === "high" || row.urgency === "medium" || row.urgency === "low"
        ? row.urgency
        : undefined;
    return [{
      title: row.title,
      reasoning: typeof row.reasoning === "string" ? row.reasoning : "",
      urgency: stated ?? "low",
      ...(stated === undefined ? { urgencyUnstated: true } : {}),
    }];
  });
}

export const MIN_TREND_CONFIDENCE = 0.50;

export function normaliseTrends(value: unknown): TrendInsight[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.topic !== "string") return [];
    const direction =
      row.direction === "rising" || row.direction === "falling" ? row.direction : "stable";
    const rawConfidence = Number(row.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence > 1 ? rawConfidence / 100 : rawConfidence))
      : 0;

    // Exclude sectors with confidence below 50% (contradictory / un-normalized data)
    if (confidence < MIN_TREND_CONFIDENCE) return [];

    return [{
      topic: row.topic,
      direction,
      confidence,
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
  alphaOpportunities: Array<{
    title: string;
    reasoning: string;
    urgency: "high" | "medium" | "low";
    /** True when the model never stated an urgency and "low" is a fallback, not
     *  a judgement. Kept distinct so a batch of dropped fields cannot read as a
     *  deliberate de-escalation. */
    urgencyUnstated?: boolean;
  }>;
  trends: TrendInsight[];
  /** Computed, not asked of the model — see src/prediction/cross-market.ts. */
  desyncs: DesyncFinding[];
  /** Mutually exclusive groups whose raw estimates summed above 100% and were
   *  rescaled. Reported rather than silently fixed: a group that keeps
   *  reappearing means the per-market estimator is double-counting an event. */
  normalizationConflicts: ProbabilityConflict[];
  /** Cumulative-series estimates moved to restore monotonicity. Reported rather
   *  than silently smoothed: a series that keeps needing repair means the
   *  estimator is judging horizons independently. */
  monotonicAdjustments: MonotonicAdjustment[];
  performanceMetrics: {
    totalActive: number;
    resolvedToday: number;
    /** Markets still flagged active whose deadline has passed. Reported rather
     *  than silently dropped: a number that climbs means the lifecycle is not
     *  keeping up, which is how expired questions reached the report before. */
    expiredPending: number;
    /** null means "no resolved markets to score yet" — distinct from a genuine
     *  0.0, which would be perfect calibration. */
    avgBrierScore: number | null;
    /** How many venue-settled outcomes the score is computed over. Reported so a
     *  number derived from 13 events cannot read as a settled fact. */
    brierSampleSize: number;
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
