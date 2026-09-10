/**
 * scripts/lib/report-format.ts — markdown rendering for the daily report.
 *
 * Lived inside run-prediction-cycle.ts, which is a top-level `main()` script and
 * therefore cannot be imported without running a full pipeline cycle. That is
 * why none of the report's rendering had a single test while it was quietly
 * printing an AI estimate under a heading readers took for market prices.
 *
 * The rule this module enforces: every percentage says where it came from. An
 * AI estimate is labelled AI, a venue price is labelled with its venue and its
 * basis, and the two never appear as bare comparable numbers.
 */

import type { DailyReport } from "../../src/prediction/analyst-agent.ts";
import type { PredictionMarket } from "../../src/prediction/types.ts";
import type { CrowdQuote } from "../../src/prediction/crowd.ts";
import { formatProbability } from "../../src/prediction/format.ts";
import { describeDesync } from "../../src/prediction/cross-market.ts";
import { isLive } from "../../src/prediction/deadline.ts";

// Divergence worth calling out, in percentage points.
//
// This was 3pp, which flagged literally every row in every shipped report —
// including rows whose "crowd" number came from the outcome-index bug. An LLM
// probability carries several points of noise on its own, so a threshold below
// that noise floor is not a signal, it is decoration. 20pp is roughly the point
// where a disagreement is larger than the model's own run-to-run spread.
export const ALPHA_DIVERGENCE_THRESHOLD_PP = 20;

/** A spread this wide means the midpoint sits between two prices nobody is
 *  actually trading at, and should not be read to a tenth of a point. */
const WIDE_SPREAD = 0.1;

/** Maximum allowable quote age in seconds (5 minutes). Quotes older than 300s or with
 *  unknown age are excluded from comparison to eliminate latency & phantom prices. */
export const MAX_CACHE_AGE_SECONDS = 300;

export function isFreshQuote(quote: CrowdQuote | undefined, now: Date): quote is CrowdQuote {
  if (!quote || !quote.asOf || quote.asOf.trim() === "") return false;
  // Strictly require live two-sided orderbook and non-stale quote
  if (quote.basis !== "orderbook_mid" || quote.stale) return false;
  const asOf = new Date(quote.asOf);
  if (Number.isNaN(asOf.getTime())) return false;
  const ageSeconds = (now.getTime() - asOf.getTime()) / 1000;
  return ageSeconds >= 0 && ageSeconds <= MAX_CACHE_AGE_SECONDS;
}

/**
 * A probability rendered as a price, always to one decimal.
 *
 * `formatProbability` deliberately picks the shortest honest form — "4" rather
 * than "3.9" — which is right for prose and for long shots, and wrong here: it
 * printed a 61.5% market as "62%" beside an AI estimate of "61.5%", so a row
 * whose two numbers were IDENTICAL read as a disagreement, with "(+0.0pp)"
 * sitting next to two visibly different figures. Half a point is real money on
 * a prediction market; prices get a fixed scale.
 *
 * Falls back to `formatProbability` whenever one decimal would collapse a real
 * value to 0.0 or 100.0 — a long-shot market keeps its number.
 */
function formatPrice(p: number): string {
  if (!Number.isFinite(p)) return "?";
  const pct = Math.min(100, Math.max(0, p * 100));
  const oneDecimal = Number(pct.toFixed(1));
  if ((oneDecimal === 0 && pct > 0) || (oneDecimal === 100 && pct < 100)) {
    return formatProbability(p);
  }
  return pct.toFixed(1);
}

const BASIS_LABEL: Record<CrowdQuote["basis"], string> = {
  orderbook_mid: "живые заявки",
  venue_mid: "цена площадки",
  last_trade: "последняя сделка",
};

export function crowdQuoteOf(market: PredictionMarket): CrowdQuote | undefined {
  const quote = market.metadata?.crowdQuote as CrowdQuote | undefined;
  if (quote && typeof quote.probability === "number") return quote;
  // State files written before quotes carried provenance.
  const bare = market.metadata?.crowdProbability;
  const venue = market.metadata?.venue;
  if (typeof bare !== "number") return undefined;
  return {
    probability: bare,
    basis: "venue_mid",
    venue: venue === "kalshi" || venue === "predictit" ? venue : "polymarket",
    // Genuinely unknown, and rendered as such — not backdated to the epoch,
    // which would print as "490000h old".
    asOf: "",
  };
}

/** "3.9% (Polymarket book mid)" — never a bare number. */
function renderQuote(quote: CrowdQuote, now: Date): string {
  const venue = quote.venue.charAt(0).toUpperCase() + quote.venue.slice(1);
  const parts = [`${venue}, ${BASIS_LABEL[quote.basis]}`];
  if (quote.stale) parts.push("цена ориентировочная");
  if (quote.spread !== undefined && quote.spread > WIDE_SPREAD) {
    parts.push("между покупкой и продажей большой разрыв");
  }

  const asOf = new Date(quote.asOf);
  const ageSeconds = Number.isNaN(asOf.getTime())
    ? Infinity
    : (now.getTime() - asOf.getTime()) / 1000;
  if (ageSeconds > MAX_CACHE_AGE_SECONDS) {
    parts.push(
      Number.isFinite(ageSeconds)
        ? `данным ${Math.round(ageSeconds / 60)} мин`
        : "давность неизвестна",
    );
  }
  return `${formatPrice(quote.probability)}% (${parts.join(", ")})`;
}

function closesOn(market: PredictionMarket): string {
  const at = market.expiresAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return "";
  return ` · срок до ${at.toISOString().slice(0, 10)}`;
}

/**
 * The markets worth leading with: the widest AI-vs-venue disagreements first,
 * then the busiest. Assembled from the market records themselves — this section
 * used to be the LLM restating AI estimates under reworded titles.
 */
export function formatTopMarkets(markets: PredictionMarket[], now: Date): string[] {
  if (markets.length === 0) return [];

  const isNicheSports = (title: string, category: string) => {
    if (category === "entertainment" || category === "other") return true;
    return /vs\.?|bo[1-35]|playoffs|league of legends|dota|cs2|counter-strike|ufc|atp|wta|tennis|baseball|sox|tigers|pirates/i.test(
      title,
    );
  };

  // A question whose answer is already all but settled carries no information:
  // "will this 2% long shot happen — we say 2%" is true, dull, and crowds out
  // whatever the reader actually needs. This section led with five such lines
  // (1.5%, 2%, 3%, 5%) because the old sort ranked no-quote markets — scored -1
  // — above genuine agreements at 0pp, so the top five were effectively
  // arbitrary. Rank on how undecided a market is, and let a verified
  // disagreement with the venue override that.
  const undecidedness = (p: number) => 1 - Math.abs(p - 0.5) * 2; // 1 at 50%, 0 at 0/100%

  // The parse-failure sentinel from generateEstimate's catch block: exactly
  // 0.5 at confidence <= 0.1 (brain-agent.ts). It is not a forecast, it is the
  // record of an LLM call that did not return usable JSON. It must never be
  // read as a genuine 50% — least of all here, where undecidedness() scores
  // exactly 0.5 as maximally interesting.
  const isFallbackEstimate = (market: PredictionMarket) =>
    Math.abs(market.aiEstimate.yesProbability - 0.5) < 1e-9 &&
    typeof market.aiEstimate.confidence === "number" &&
    market.aiEstimate.confidence <= 0.1;

  const rows = markets
    .map((market) => {
      const quote = crowdQuoteOf(market);
      const isFresh = isFreshQuote(quote, now);
      const freshQuote = isFresh ? quote : undefined;
      const aiPct = market.aiEstimate.yesProbability * 100;
      const diffPp = freshQuote ? Math.abs(aiPct - freshQuote.probability * 100) : 0;
      const volume = Number(market.metadata?.volume24hr ?? 0) || 0;
      const niche = isNicheSports(market.title, market.category);
      // Disagreement is worth more than uncertainty — a 30pp gap against a live
      // price is the reason to read on — but a market with no fresh quote still
      // ranks on its own merits rather than being silently promoted.
      //
      // The one exception is the parse-failure sentinel. undecidedness() peaks
      // at exactly 0.5, which is precisely the number a failed LLM call leaves
      // behind, so the section led with Bybit giveaway posts and TVL rankings:
      // maximum uncertainty score, zero information, and no venue that could
      // ever settle them. A genuine 50% estimate still earns the bonus; a
      // record of a broken call does not.
      const uncertaintyBonus = isFallbackEstimate(market)
        ? 0
        : undecidedness(market.aiEstimate.yesProbability) * 50;
      const interest = diffPp * 2 + uncertaintyBonus;
      return { market, quote: freshQuote, diffPp, volume, niche, interest };
    })
    .sort((a, b) => {
      // Individual sports fixtures stay below analytical markets regardless.
      if (a.niche !== b.niche) return a.niche ? 1 : -1;
      if (b.interest !== a.interest) return b.interest - a.interest;
      return b.volume - a.volume;
    });

  const lines = ["## Главное на сегодня", ""];
  for (const row of rows.slice(0, 5)) {
    const venue = row.quote ? `рынок ${renderQuote(row.quote, now)} · ` : "";
    lines.push(
      `- ${row.market.title} — ${venue}наша оценка ${formatPrice(row.market.aiEstimate.yesProbability)}%${closesOn(row.market)}`,
    );
  }
  lines.push("");
  return lines;
}

export function formatCrowdComparison(markets: PredictionMarket[], now: Date): string[] {
  // Deduplicate by venueMarketId: a second line of defense in case the state
  // file still holds dupes from before the market-store dedup was added.
  const seenVenueIds = new Set<string>();
  const uniqueMarkets = markets.filter((m) => {
    const vid = m.metadata?.venueMarketId;
    if (typeof vid !== "string" || !vid) return true;
    if (seenVenueIds.has(vid)) return false;
    seenVenueIds.add(vid);
    return true;
  });

  const rows = uniqueMarkets
    .map((market) => ({ market, quote: crowdQuoteOf(market) }))
    .filter((r): r is { market: PredictionMarket; quote: CrowdQuote } => {
      // Purge phantom/stale quotes: must be fresh (<= 300s) with valid orderbook timestamp
      return isFreshQuote(r.quote, now);
    })
    .map(({ market, quote }) => {
      const aiPct = market.aiEstimate.yesProbability * 100;
      const crowdPct = quote.probability * 100;
      return { market, quote, aiPct, crowdPct, diffPp: aiPct - crowdPct };
    })
    // Sort by absolute divergence, biggest first — the interesting rows lead.
    .sort((a, b) => Math.abs(b.diffPp) - Math.abs(a.diffPp));

  if (rows.length === 0) return [];

  const lines = [
    "## Где мы не согласны с рынком",
    "",
    "_Это не найденная ошибка рынка, а наше расхождение с ним._",
    "_Рынок обычно прав: за его ценой стоят реальные деньги многих людей._",
    "",
  ];
  for (const r of rows.slice(0, 15)) {
    const sign = r.diffPp >= 0 ? "+" : "";
    // A stale/indicative quote (no live orderbook) is not a reliable basis for
    // flagging a divergence — the spread is unknown and the price may be hours
    // old. Suppress the warning so the report does not cry wolf.
    const flag =
      !r.quote.stale && Math.abs(r.diffPp) >= ALPHA_DIVERGENCE_THRESHOLD_PP
        ? " ⚠ расхождение стоит проверить"
        : "";
    lines.push(
      `- ${r.market.title} — мы ${formatPrice(r.market.aiEstimate.yesProbability)}%, рынок ${renderQuote(r.quote, now)} (разница ${sign}${r.diffPp.toFixed(1)} п.п.)${flag}`,
    );
  }
  lines.push("");
  return lines;
}

/**
 * Estimates moved to restore cumulative monotonicity.
 *
 * Printed rather than applied silently: the reader is seeing a repaired number,
 * and a series that needs repairing every day is telling you the estimator
 * judges each horizon in isolation.
 */
export function formatMonotonicAdjustments(report: DailyReport): string[] {
  const adj = report.monotonicAdjustments;
  if (!adj || adj.length === 0) return [];
  const lines = [
    "## Мы поправили сами себя",
    "",
    "_Если событие может случиться до 31 августа, то до 31 декабря — тем более._",
    "_Наши оценки это нарушали, и мы их выправили. Ниже — что изменилось._",
    "",
  ];
  for (const a of adj.slice(0, 8)) {
    const dir = a.deltaPp >= 0 ? "подняли" : "опустили";
    lines.push(
      `- ${a.title} — ${dir} с ${formatPrice(a.before)}% до ${formatPrice(a.after)}% ` +
        `(на ${Math.abs(a.deltaPp).toFixed(1)} п.п.; срок — ${a.deadline.toISOString().slice(0, 10)})`,
    );
  }
  lines.push("");
  return lines;
}

/**
 * The Brier score in words.
 *
 * "Avg Brier score: 0.3715" tells a non-specialist nothing, and its direction is
 * counter-intuitive: lower is better. 0.25 is what you get by answering 50% to
 * everything, so anything above that is worse than a coin toss — which is the
 * single fact a reader needs and the raw number hides.
 */
export function describeAccuracy(brier: number | null, sampleSize?: number): string {
  if (brier === null) return "пока не измерить — ни одно событие ещё не завершилось";
  const n = brier.toFixed(3);

  // Say the sample size out loud. "0.294" reads like a settled fact; "0.294 по
  // 13 событиям" tells the reader it is a hint, not a verdict. Below ~30
  // resolved markets a Brier score moves several hundredths on one outcome.
  const basis =
    sampleSize === undefined
      ? ""
      : sampleSize < 30
        ? ` — посчитано всего по ${sampleSize} событиям, это слишком мало для вывода`
        : ` (по ${sampleSize} событиям)`;

  if (brier <= 0.10) return `отличная: ${n}${basis}`;
  if (brier <= 0.18) return `хорошая: ${n}${basis}`;
  if (brier <= 0.25) return `сносная: ${n}${basis}`;
  return `плохая: ${n}. Угадывание монеткой дало бы 0.250 — мы пока хуже${basis}`;
}

export function formatDesyncs(report: DailyReport): string[] {
  if (report.desyncs.length === 0) return [];
  const lines = [
    "## Противоречия, которые мы не смогли выправить",
    "",
    "_Одинаковые вопросы с разными сроками оценены несогласованно._",
    "",
  ];
  for (const finding of report.desyncs.slice(0, 5)) {
    lines.push(`- ${describeDesync(finding)}`);
  }
  lines.push("");
  return lines;
}

/**
 * The full report page. `markets` are the live markets the report covers; the
 * expiry gate is applied here as well as in the analyst agent, so a section can
 * never render a question the prompt did not see.
 */
export function formatReportMarkdown(
  report: DailyReport,
  markets: PredictionMarket[],
  now: Date = new Date(),
): string {
  const live = markets.filter((m) => isLive(m, now));
  const dateStr = report.date.toISOString().slice(0, 10);
  const lines = [
    "---",
    "type: prediction-daily-report",
    `date: ${dateStr}`,
    `active_markets: ${report.activeMarkets}`,
    `resolved_today: ${report.resolvedMarkets}`,
    "---",
    "",
    `# Сводка Inbrain за ${dateStr}`,
    "",
    report.summary,
    "",
    `**Отслеживаем сейчас:** ${report.activeMarkets}  |  **Исход стал известен сегодня:** ${report.resolvedMarkets}`,
    "",
  ];

  lines.push(...formatTopMarkets(live, now));
  lines.push(...formatCrowdComparison(live, now));
  lines.push(...formatDesyncs(report));
  lines.push(...formatMonotonicAdjustments(report));

  if (report.alphaOpportunities.length) {
    lines.push("## Возможности заработать");
    lines.push("");
    lines.push("_Случаи, где наша оценка сильно расходится с ценой рынка._");
    lines.push("");
    const urgencyWord: Record<string, string> = {
      HIGH: "срочно",
      MEDIUM: "не горит",
      LOW: "на заметку",
    };
    for (const a of report.alphaOpportunities.slice(0, 5)) {
      // "не оценено" is not a rung on the scale — it means the model never gave
      // one and the pipeline substituted a default. Printing that as "на
      // заметку" would make a dropped field look like a considered verdict.
      const word = a.urgencyUnstated
        ? "не оценено"
        : (urgencyWord[a.urgency.toUpperCase()] ?? "на заметку");
      lines.push(`- [${word}] ${a.title} — ${a.reasoning}`);
    }
    lines.push("");
  }
  if (report.trends.length) {
    lines.push("## К чему всё идёт");
    const dirWord: Record<string, string> = {
      rising: "набирает силу",
      falling: "затухает",
      stable: "без перемен",
    };
    for (const t of report.trends.slice(0, 5)) {
      const dir = dirWord[t.direction] ?? "без перемен";
      lines.push(
        `- ${t.topic} (${dir}, уверенность ${formatProbability(t.confidence)}%): ${t.prediction}`,
      );
    }
    lines.push("");
  }
  lines.push("## Как мы справляемся");
  lines.push(`- Следим за событиями: ${report.performanceMetrics.totalActive}`);
  lines.push(`- Исход стал известен сегодня: ${report.performanceMetrics.resolvedToday}`);
  if (report.performanceMetrics.expiredPending > 0) {
    lines.push(
      `- Срок вышел, итог ещё не подведён: ${report.performanceMetrics.expiredPending} (в разделы выше не попали)`,
    );
  }
  // Say "no data" in words. Printing the literal `null` (or, before that, a
  // hallucinated 0) reads as "our calibration is perfect / catastrophic".
  lines.push(
    `- Точность прогнозов: ${describeAccuracy(report.performanceMetrics.avgBrierScore, report.performanceMetrics.brierSampleSize)}`,
  );
  return lines.join("\n");
}
