/**
 * The calibration feedback loop's single source of truth.
 *
 * The loop used to be open: BrainAgent queried `predictions/meta/calibration`
 * before every evaluation, but nothing in the project ever wrote that page —
 * DreamCycle wrote `predictions/meta/accuracy-log` instead, and its
 * meta-model findings only ever reached the human-readable dream report. So
 * "self-evolving" read from an address that was permanently empty.
 *
 * Both ends now import these constants, which makes the two sides impossible
 * to drift apart silently.
 */

import { serializeFit, type CalibrationFit } from "./calibration-fit.js";
import type { ForecastRecord, Scorecard } from "./scoring.js";

/** Brain page the meta-model writes and the Brain Agent reads. */
export const CALIBRATION_SLUG = "predictions/meta/calibration";

/**
 * Query string used to retrieve it.
 *
 * @deprecated Legacy fallback only. This addressed a page whose slug is known
 * through a top-5 semantic search over the entire brain, so the read could —
 * and did — silently return four unrelated pages and nothing usable, leaving
 * the Brain Agent with an empty calibration block and no way to notice.
 * Prefer `brainGet(CALIBRATION_SLUG)` (scripts/lib/brain-cli.ts), which fetches
 * the exact address. Kept because callers without a `brainGet` still fall back
 * to it.
 */
export const CALIBRATION_SLUG_QUERY = `${CALIBRATION_SLUG} latest rules`;

/** Rolling accuracy log — history, not the rules the agent applies. */
export const ACCURACY_LOG_SLUG_PREFIX = "predictions/meta/accuracy";

export interface CalibrationRule {
  rule: string;
  previousValue: number;
  newValue: number;
  evidence: string;
}

/** Render meta-model findings as the page BrainAgent will read back. Kept next
 *  to the slug so the format and the address move together. */
export function renderCalibrationPage(
  rules: CalibrationRule[],
  stats: { marketsReviewed: number; avgBrierScore: number | null },
): string {
  const brier =
    stats.avgBrierScore === null ? "n/a (no resolved markets yet)" : stats.avgBrierScore.toFixed(4);

  const body = rules.length
    ? rules
        .map(
          (r) =>
            `- **${r.rule}**: ${r.previousValue.toFixed(2)} → ${r.newValue.toFixed(2)}\n  - Evidence: ${r.evidence}`,
        )
        .join("\n")
    : "_No calibration rules derived yet — not enough resolved markets._";

  return `---
type: meta-calibration
updated: ${new Date().toISOString()}
markets_reviewed: ${stats.marketsReviewed}
avg_brier_score: ${brier}
rule_count: ${rules.length}
---

# Prediction Calibration Rules

These rules are derived from resolved markets and are injected into the Brain
Agent's system prompt on every evaluation. Higher-quality rules come from more
resolved markets, so this page gets sharper as the pipeline accumulates history.

- Markets reviewed: ${stats.marketsReviewed}
- Average Brier score: ${brier}

## Active rules

${body}
`;
}

/** Everything the factual page needs. All of it arithmetic over scored
 *  records — nothing here can be invented by a language model. */
export interface CalibrationPageData {
  fit: CalibrationFit;
  /** Scorecard over the oracle-grade learning set. */
  scorecard: Scorecard;
  byGroup: Map<string, Scorecard>;
  byHorizon: Map<string, Scorecard>;
  /** Worst calls by Brier, most instructive first. */
  worstMisses: Array<{ record: ForecastRecord; title?: string }>;
  /** The LLM-resolved records: reported, never fitted. Null when there are none. */
  autoScorecard: Scorecard | null;
  sources: { live: number; backtest: number };
  pricedCount: number;
}

function num(x: number, digits = 4): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "n/a";
}

function percent(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

/**
 * Beyond this magnitude a skill ratio stops being a measurement.
 *
 * Skill is `1 - model/reference`. When the reference is a near-certain venue
 * price its Brier approaches zero and the ratio diverges: real data produced
 * -8065 and -11393, and a contrived near-certain sample gives -9800. All three
 * mean the same modest thing — "the market was nearly right and we were nearly
 * opposite" — but printed as a number they read as a magnitude, and a reader
 * (or a model consuming this page) will try to interpret the size.
 */
const SKILL_REPORTABLE_LIMIT = 100;

/** Skill formatted for a reader, or an honest verbal fallback. */
function skillText(x: number): string {
  if (!Number.isFinite(x)) return "n/a";
  if (Math.abs(x) > SKILL_REPORTABLE_LIMIT) {
    return x < 0 ? "far worse than the price" : "far better than the price";
  }
  return x.toFixed(4);
}

/**
 * The one-line verdict.
 *
 * This is the sentence a reader (human or model) should take away, so it states
 * the commercial fact rather than the flattering one. A good Brier on a skewed
 * question set means very little; losing to the venue price means the forecasts
 * are not worth acting on, and that has to be said in those words.
 */
function verdict(card: Scorecard, pricedCount: number): string {
  if (card.count === 0) return "No oracle-grade records yet — nothing measured.";

  const skill = card.skill.vsMarketPrice;
  const head = `On ${card.count} oracle-grade records: ECE ${num(card.expectedCalibrationError)}`;

  if (!Number.isFinite(skill) || pricedCount === 0) {
    return `${head}. No venue prices in the sample, so skill vs the market is not measurable — treat every number here as provisional.`;
  }
  if (skill > 0) {
    return `${head}, skill vs market price ${skillText(skill)} over ${pricedCount} priced records. The model BEATS the venue quote on this sample.`;
  }
  return `${head}, skill vs market price ${skillText(skill)} over ${pricedCount} priced records. The model does NOT beat the venue quote — departures from the price are currently value-destroying.`;
}

function reliabilityTable(card: Scorecard): string {
  const rows = card.bins
    .filter((b) => b.count > 0)
    .map((b) => {
      const range = `${(b.lower * 100).toFixed(0)}-${(b.upper * 100).toFixed(0)}%`;
      const thin = b.count < 5 ? " (thin)" : "";
      const gap = `${b.gap >= 0 ? "+" : ""}${(b.gap * 100).toFixed(1)}pp`;
      return `| ${range} | ${b.count} | ${percent(b.meanForecast)} | ${percent(b.observedFrequency)} | ${gap}${thin} |`;
    });

  if (rows.length === 0) return "_No populated bins._";
  return [
    "| Claimed | n | Mean claimed | Observed | Gap |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Priced records a group needs before its skill figure is worth printing.
 *  Below this a single lucky or unlucky call swings the ratio by orders of
 *  magnitude — `fomc` showed -49.5 on three records, which reads as a finding
 *  and is arithmetic. */
const MIN_GROUP_FOR_SKILL = 10;

function groupTable(cards: Map<string, Scorecard>, label: string): string {
  const rows = [...cards.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, c]) => {
      const priced = c.baselines.marketPriceSampleSize;
      const skill =
        priced >= MIN_GROUP_FOR_SKILL ? skillText(c.skill.vsMarketPrice) : "too few to say";
      return `| ${key} | ${c.count} | ${num(c.meanBrier)} | ${skill} | ${priced} |`;
    });
  if (rows.length === 0) return `_No ${label} breakdown available._`;
  return [
    `| ${label} | n | Brier | Skill vs price | priced n |`,
    "|---|---|---|---|---|",
    ...rows,
    "",
    `_Skill is shown only for groups with ${MIN_GROUP_FOR_SKILL}+ priced records._`,
  ].join("\n");
}

/**
 * Render the calibration page from measured facts.
 *
 * Replaces the LLM-authored aphorisms ("crypto is overconfident") that the old
 * meta-model produced. Those were unfalsifiable and, worse, were derived mostly
 * from outcomes the pipeline had invented for itself. Everything below is
 * arithmetic over venue-confirmed results, and the numbers are the point: a
 * model reasoning from "you said 90% and it happened 56% of the time, here are
 * the five worst calls" has something to work with.
 */
export function renderFactualCalibrationPage(data: CalibrationPageData): string {
  const { fit, scorecard: card } = data;

  const missRows = data.worstMisses.map((m) => {
    const r = m.record;
    const claimed = percent(r.forecast);
    const price = r.marketPrice === undefined ? "n/a" : percent(r.marketPrice);
    const brier = num((r.forecast - (r.outcome ? 1 : 0)) ** 2);
    const title = (m.title ?? r.id).slice(0, 70);
    return `| ${title} | ${claimed} | ${price} | ${r.outcome ? "YES" : "NO"} | ${brier} |`;
  });

  const misses = missRows.length
    ? [
        "| Question | Claimed | Venue price | Outcome | Brier |",
        "|---|---|---|---|---|",
        ...missRows,
      ].join("\n")
    : "_No scorable misses yet._";

  const autoBlock = data.autoScorecard
    ? `These ${data.autoScorecard.count} records were resolved by asking a language model
what happened, not by an exchange. They are shown for transparency and are
NEVER fitted — their Brier of ${num(data.autoScorecard.meanBrier)} largely measures the
auto-resolver's guessing, not this pipeline's probability estimates.`
    : "_No LLM-resolved records._";

  return `---
type: meta-calibration
updated: ${new Date().toISOString()}
fit_method: ${fit.method}
fit_n: ${fit.n}
fit_shrink: ${num(fit.shrink, 3)}
records_live: ${data.sources.live}
records_backtest: ${data.sources.backtest}
priced_records: ${data.pricedCount}
ece: ${num(card.expectedCalibrationError)}
skill_vs_price: ${skillText(card.skill.vsMarketPrice)}
---

# Prediction Calibration

**${verdict(card, data.pricedCount)}**

Derived from venue-confirmed outcomes only (${data.sources.live} live oracle
resolutions + ${data.sources.backtest} backtest records). Injected into the Brain
Agent's prompt on every evaluation.

## Active correction

- Method: **${fit.method}**${fit.method === "identity" ? " — no numeric adjustment is being applied" : ` (a=${num(fit.a, 3)}, b=${num(fit.b, 3)}, shrink=${num(fit.shrink, 2)})`}
- Reason: ${fit.rationale}

## Headline scores

| Metric | Model | Base rate | Market price | Always 50% |
|---|---|---|---|---|
| Brier | ${num(card.meanBrier)} | ${num(card.baselines.baseRate)} | ${num(card.baselines.marketPrice)} | ${num(card.baselines.alwaysFifty)} |

- Skill vs market price: **${skillText(card.skill.vsMarketPrice)}** (n=${card.baselines.marketPriceSampleSize})
- Skill vs base rate: ${skillText(card.skill.vsBaseRate)}
- Log loss: ${num(card.meanLogLoss)} · ECE: ${num(card.expectedCalibrationError)}
- Base rate (YES) in sample: ${percent(card.baseRate)}

## Reliability — claimed vs what actually happened

A negative gap means overconfidence at that level. Bins under 5 records are
noise, not evidence; they are marked.

${reliabilityTable(card)}

## By category

${groupTable(data.byGroup, "Category")}

## By horizon

${groupTable(data.byHorizon, "Horizon")}

## Worst calls

The specific mistakes, not a summary of them.

${misses}

## Excluded from learning

${autoBlock}

${serializeFit(fit)}
`;
}
