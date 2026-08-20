/**
 * The EV gate — where are we actually allowed to act?
 *
 * `shrink.ts` makes the published probability less wrong. It does not stop the
 * pipeline from ACTING where it has no demonstrated edge, and those are separate
 * decisions: publishing a number is free, betting on it is not.
 *
 * The gate is fail-closed by construction. A category qualifies only when it has
 * enough priced, oracle-grade history AND beats the venue price on that history.
 * On today's data that means NOTHING qualifies — no category has 25 priced
 * oracle-grade records with positive skill. That is the correct answer, and it
 * is the whole reason the gate exists rather than a threshold to be tuned until
 * something passes. It opens by itself as honest history accumulates.
 *
 * Built on `scoreByGroup` so it shares the one scoring implementation rather
 * than growing a second opinion about what skill means.
 */

import { scoreByGroup, type ForecastRecord, type Scorecard } from "./scoring.js";

/** Priced oracle-grade records a group needs before any claim is admissible. */
export const MIN_GROUP_SAMPLES = 25;

/** Skill against the venue price must exceed this. Zero means "strictly better
 *  than reading the price off the screen" — the only bar that maps to positive
 *  expected value after costs are ignored. */
export const MIN_SKILL_VS_PRICE = 0;

export type EdgeStatus = "eligible" | "insufficient-sample" | "no-edge";

export interface EdgeVerdict {
  group: string;
  status: EdgeStatus;
  /** Records in the group that carried a venue price. */
  pricedCount: number;
  /** NaN when unmeasurable (no priced records). */
  skillVsPrice: number;
  reason: string;
}

/** Verdict for every group present in `records`. */
export function edgeVerdicts(records: ForecastRecord[]): Map<string, EdgeVerdict> {
  const cards = scoreByGroup(records, (r) => r.group ?? "unknown");
  const out = new Map<string, EdgeVerdict>();

  for (const [group, card] of cards) {
    out.set(group, verdictFor(group, card));
  }
  return out;
}

function verdictFor(group: string, card: Scorecard): EdgeVerdict {
  const pricedCount = card.baselines.marketPriceSampleSize;
  const skillVsPrice = card.skill.vsMarketPrice;

  if (pricedCount < MIN_GROUP_SAMPLES) {
    return {
      group,
      status: "insufficient-sample",
      pricedCount,
      skillVsPrice,
      reason: `${pricedCount} priced record(s), need ${MIN_GROUP_SAMPLES}`,
    };
  }

  // Unmeasurable skill is not permission. A NaN here means the comparison could
  // not be made, which is a reason to stay out, not a reason to proceed.
  if (!Number.isFinite(skillVsPrice) || skillVsPrice <= MIN_SKILL_VS_PRICE) {
    return {
      group,
      status: "no-edge",
      pricedCount,
      skillVsPrice,
      reason: Number.isFinite(skillVsPrice)
        ? `skill vs price ${skillVsPrice.toFixed(3)} <= ${MIN_SKILL_VS_PRICE}`
        : "skill vs price not measurable",
    };
  }

  return {
    group,
    status: "eligible",
    pricedCount,
    skillVsPrice,
    reason: `skill vs price ${skillVsPrice.toFixed(3)} over ${pricedCount} priced records`,
  };
}

/** A group absent from the map has no history at all, so it is not eligible. */
export function isActionable(group: string, verdicts: Map<string, EdgeVerdict>): boolean {
  return verdicts.get(group)?.status === "eligible";
}

/** One-line summary for reports. Leads with the count because "0 eligible" is
 *  the finding, not a formatting accident. */
export function formatEdgeSummary(verdicts: Map<string, EdgeVerdict>): string {
  const all = [...verdicts.values()];
  const eligible = all.filter((v) => v.status === "eligible");
  if (all.length === 0) return "EV gate: no grouped history yet — nothing eligible.";

  const head = `EV gate: ${eligible.length}/${all.length} group(s) eligible to act on.`;
  const detail = all
    .sort((a, b) => a.group.localeCompare(b.group))
    .map((v) => `  ${v.group.padEnd(14)} ${v.status.padEnd(20)} ${v.reason}`)
    .join("\n");
  return `${head}\n${detail}`;
}
