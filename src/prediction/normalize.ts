/**
 * src/prediction/normalize.ts — probability normalization for related markets.
 *
 * When the Brain Agent evaluates each market independently, mutually exclusive
 * outcomes on the same event can sum to more (or less) than 100%. A FOMC
 * meeting with three contracts — "No change" (86%), "Cut 25bp" (38%),
 * "Hike 25bp" (25%) — sums to 149%, which is mathematically impossible for
 * exhaustive, mutually exclusive outcomes.
 *
 * This module groups markets by their event key and proportionally rescales
 * the AI probabilities so they sum to exactly 1.0 within each group. The
 * original raw probability is preserved in metadata.rawAiProbability.
 *
 * Grouping strategy:
 *   1. Exact match on `metadata.eventKey` (Polymarket slug / Kalshi event_ticker)
 *   2. Fallback: token-set Jaccard >= 0.7 within the same category
 *
 * Markets without an event key or that form single-market groups are untouched.
 */

import type { PredictionMarket } from "./types.js";
import type { CrowdQuote } from "./crowd.js";

const JACCARD_MIN = 0.7;

/** Below this, an anchor-weighted cut has eaten the whole estimate and the
 *  anchored method no longer has a defensible answer. Signals a fallback to
 *  proportional normalization — never a clamped output value. */
const MIN_ANCHORED_PROBABILITY = 0.001;

const STOPWORDS = new Set([
  "a", "an", "the", "will", "would", "does", "do", "did", "is", "are", "be",
  "been", "to", "of", "in", "on", "at", "for", "and", "or", "it", "its",
  "this", "that", "by", "before", "through", "until", "prior", "during",
  "there", "any", "have", "has", "than", "then", "with", "from", "as", "if",
  "not", "yes", "no",
]);

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface NormalizationResult {
  /** Number of groups that were actually normalized (size >= 2). */
  groupCount: number;
  /** Total markets whose probability was adjusted. */
  adjustedCount: number;
  /** Groups whose members are mutually exclusive but sum over 100%. Rescaled,
   *  and reported so the caller can keep them out of narrative sections. */
  conflicts: ProbabilityConflict[];
}

export interface ProbabilityConflict {
  groupKey: string;
  /** Sum of the raw probabilities, e.g. 1.38 for the 86% + 52% FOMC pair. */
  rawSum: number;
  marketIds: string[];
  titles: string[];
}

/**
 * Normalize AI probabilities across groups of related markets.
 *
 * Mutates markets in place: `aiEstimate.yesProbability` is set to the
 * normalized value, and `metadata.rawAiProbability` preserves the original.
 * `metadata.normalizationGroup` records the group key for transparency.
 *
 * Uses anchor-weighted normalization: estimates close to the venue price
 * absorb less of the correction, while estimates far from the venue absorb
 * more. Falls back to proportional when no venue prices are available.
 *
 * Returns a summary of how many groups and markets were affected.
 */
export function normalizeRelatedMarkets(
  markets: PredictionMarket[],
): NormalizationResult {
  const groups = groupMarkets(markets);

  let groupCount = 0;
  let adjustedCount = 0;
  const conflicts: ProbabilityConflict[] = [];

  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;

    // Normalize from the ORIGINAL model output, never from a previously
    // normalized value. The pipeline persists `aiEstimate.yesProbability` and
    // reloads it next run, so reading the live field here would rescale an
    // already-rescaled number and compound every cycle. That is how five
    // September FOMC contracts whose model estimates summed to 0.77 came to be
    // stored summing to 2.00 — each run divided by a sum that its own previous
    // run had inflated.
    const rawProbs = group.map((m) =>
      typeof m.metadata.rawAiProbability === "number"
        ? m.metadata.rawAiProbability
        : m.aiEstimate.yesProbability,
    );
    const sum = rawProbs.reduce((a, b) => a + b, 0);

    // Already sums to ~1.0 (within 1pp tolerance) — no adjustment needed.
    if (Math.abs(sum - 1.0) < 0.01) {
      restoreRaw(group);
      continue;
    }

    // All zeros: nothing to normalize.
    if (sum === 0) continue;

    // Undershoot is not a defect. A group of mutually exclusive outcomes that
    // sums to 0.6 is almost always partial coverage — the remaining 40% sits on
    // outcome contracts this run never ingested. Scaling those two up to 100%
    // would invent confidence the pipeline does not have. Only the overshoot is
    // impossible regardless of coverage, so only the overshoot is corrected.
    if (sum < 1.0) {
      restoreRaw(group);
      continue;
    }

    conflicts.push({
      groupKey: key,
      rawSum: sum,
      marketIds: group.map((m) => m.id),
      titles: group.map((m) => m.title),
    });

    groupCount++;

    const normalized = anchorWeightedNormalize(group, rawProbs);
    for (let i = 0; i < group.length; i++) {
      const market = group[i]!;
      market.metadata.rawAiProbability = rawProbs[i]!;
      market.metadata.normalizationGroup = key;
      market.aiEstimate.yesProbability = normalized[i]!;
      adjustedCount++;
    }
  }

  return { groupCount, adjustedCount, conflicts };
}

/**
 * Anchor-weighted normalization: estimates close to the venue price are
 * preserved; estimates far from the venue absorb most of the correction.
 *
 * Pure proportional normalization (old method) divides every estimate by the
 * same factor. When one estimate is wildly wrong (Zema 75% vs market 0.4%),
 * the proportional cut also hammers estimates that were correct: Lula at 57%
 * (market 55%) got compressed to 32%, creating a fictitious 23pp divergence.
 *
 * This method distributes the excess proportionally to each estimate's
 * distance from its venue price. Estimates that agree with the market keep
 * their number; estimates that disagree absorb the excess.
 *
 * Falls back to proportional normalization when no venue prices are available.
 */
export function anchorWeightedNormalize(
  group: PredictionMarket[],
  rawProbs: number[],
): number[] {
  const sum = rawProbs.reduce((a, b) => a + b, 0);
  if (sum <= 1.0) return rawProbs;

  const excess = sum - 1.0;

  // Check if we have ANY real venue prices. If not, pure proportional is better
  // than flat absolute cuts.
  const hasAnyPrices = group.some(m => {
    const quote = m.metadata?.crowdQuote as CrowdQuote | undefined;
    const venue = quote?.probability ?? m.metadata?.crowdProbability;
    return typeof venue === "number";
  });

  if (!hasAnyPrices) {
    return rawProbs.map((p) => p / sum);
  }

  // Distance of each raw AI estimate from its venue price. Markets without a
  // venue price get a neutral distance of 0.5 — roughly the midpoint —
  // so they share the correction but do not dominate it.
  const distances = group.map((m, i) => {
    const quote = m.metadata?.crowdQuote as CrowdQuote | undefined;
    const venue = quote?.probability ?? m.metadata?.crowdProbability;
    if (typeof venue !== "number") return 0.5;
    return Math.abs(rawProbs[i]! - venue);
  });

  const totalDistance = distances.reduce((a, b) => a + b, 0);

  // If total distance is 0 (all exactly match venue), fallback to proportional
  if (totalDistance < 1e-9) {
    return rawProbs.map((p) => p / sum);
  }

  // Each estimate is cut in proportion to how far it sits from the venue.
  //
  // A cut that exceeds the estimate itself is not a small number — it is a
  // failed computation. The old code clamped it to 0.001 and shipped that as an
  // estimate: the LAPTOP $500M rung published 0.1% against a venue price of
  // 79.5%, and the 0.1% was the clamp, not a view. Clamping silently is what
  // made a grouping bug read as a confident contrarian call.
  //
  // So detect the overshoot instead of hiding it, and fall back to proportional
  // normalization, which cannot go negative: every estimate keeps its share of
  // the total. The group is still forced to 1.0 — the caller decided these
  // outcomes are exclusive — but no member is invented.
  const overshoots = rawProbs.some(
    (p, i) => p - excess * (distances[i]! / totalDistance) < MIN_ANCHORED_PROBABILITY,
  );
  if (overshoots) {
    return rawProbs.map((p) => p / sum);
  }

  const result = rawProbs.map((p, i) => {
    const cut = excess * (distances[i]! / totalDistance);
    return p - cut;
  });

  // The cuts sum to `excess` by construction, so this should already be 1.0.
  // Kept as a guard against floating-point residue only; it no longer repairs a
  // clamp, because there is no longer a clamp to repair.
  const resultSum = result.reduce((a, b) => a + b, 0);
  if (Math.abs(resultSum - 1.0) > 0.001) {
    return result.map((p) => p / resultSum);
  }
  return result;
}

/**
 * Undo a previous run's rescale.
 *
 * A group that no longer overshoots must not keep a stale correction: the
 * estimates it was divided by came from a different set of contracts. Without
 * this, a rescale applied once stays applied for the life of the market even
 * after the group that justified it is gone.
 */
function restoreRaw(group: PredictionMarket[]): void {
  for (const m of group) {
    if (typeof m.metadata.rawAiProbability === "number") {
      m.aiEstimate.yesProbability = m.metadata.rawAiProbability;
      delete m.metadata.rawAiProbability;
      delete m.metadata.normalizationGroup;
    }
  }
}

/**
 * Invariant validator: ensures that no mutually exclusive group of markets has
 * sum of AI probabilities exceeding 1.0 (with 0.01 tolerance).
 * If an unnormalized group is found, it automatically normalizes it and logs a warning.
 */
export function validateNormalizedProbabilities(markets: PredictionMarket[]): void {
  const groups = groupMarkets(markets);
  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    const sum = group.reduce((acc, m) => acc + m.aiEstimate.yesProbability, 0);
    if (sum > 1.01) {
      console.warn(
        `[normalize] Invariant violation: group "${key}" probability sum is ${(sum * 100).toFixed(1)}% (>100%) — forcing normalization`,
      );
      for (const m of group) {
        // Preserve the FIRST raw value seen. Overwriting it here would destroy
        // the model's original output and leave the next run normalizing an
        // already-normalized number — the compounding that drove one FOMC
        // group to a stored sum of 200%.
        if (typeof m.metadata.rawAiProbability !== "number") {
          m.metadata.rawAiProbability = m.aiEstimate.yesProbability;
        }
        m.aiEstimate.yesProbability = m.aiEstimate.yesProbability / sum;
      }
    }
  }
}

/**
 * Extract a policy-decision key: one scheduled decision with several mutually
 * exclusive outcome contracts (hold / cut 25bp / cut 50bp / hike).
 *
 * These never cluster by Jaccard — "Will the Fed hold rates in September?" and
 * "Will the Fed cut by 25bp in September?" share almost no tokens once the
 * stopwords go, so the similarity lands near 0.4 and the group is never formed.
 * That is how a September FOMC meeting reported 86% no-change alongside 52%
 * cut-25bp: two contracts on one decision, each estimated in a vacuum, summing
 * to 138%.
 *
 * Keyed on (authority, period) — the decision — deliberately NOT on the
 * outcome, so every outcome contract for the same meeting lands in one group.
 */
export function extractPolicyDecisionKey(title: string): string | undefined {
  const t = title.toLowerCase();

  const authority = /\b(fed|federal reserve|fomc)\b/.test(t)
    ? "fomc"
    : /\b(ecb|european central bank)\b/.test(t)
      ? "ecb"
      : /\b(boe|bank of england)\b/.test(t)
        ? "boe"
        : /\b(boj|bank of japan)\b/.test(t)
          ? "boj"
          : undefined;
  if (!authority) return undefined;

  // Must actually be about the rate decision, not commentary about the body.
  if (!/\b(rate|rates|basis point|bps?|bp|hike|cut|raise|lower|hold|unchanged|no change)\b/.test(t)) {
    return undefined;
  }

  // The period scopes the group to ONE meeting. Without it, a September hold
  // and a December cut — not mutually exclusive — would be normalized together.
  const monthMatch = t.match(
    new RegExp(`\\b(${MONTH_RE_LOWER})\\b(?:\\s+(\\d{4}))?`),
  );
  const yearMatch = t.match(/\b(20\d{2})\b/);
  const quarterMatch = t.match(/\bq([1-4])\b(?:\s*(20\d{2}))?/);

  let period: string | undefined;
  if (monthMatch) {
    period = `${monthMatch[1]!.slice(0, 3)}${monthMatch[2] ?? yearMatch?.[1] ?? ""}`;
  } else if (quarterMatch) {
    period = `q${quarterMatch[1]}${quarterMatch[2] ?? yearMatch?.[1] ?? ""}`;
  } else if (yearMatch) {
    period = yearMatch[1];
  }
  // No period means no way to know which meeting — leave it ungrouped rather
  // than normalizing across meetings, which would invent a contradiction.
  if (!period) return undefined;

  return `policy:${authority}_${period}`;
}

const MONTH_RE_LOWER =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|" +
  "aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/**
 * Extract multi-candidate political elections, nominations, or contest keys from titles.
 * e.g. "Will Romeu Zema win the 2026 Brazilian presidential election?" -> "contest:2026_brazilian_presidential_election"
 * e.g. "Will Wes Moore win the 2028 Democratic presidential nomination?" -> "contest:2028_democratic_presidential_nomination"
 */
export function extractContestKey(title: string): string | undefined {
  const m = title.match(
    /will\s+.+?\s+(?:win|be|become|gain)\s+(?:the\s+)?(?:(most seats in the next|next)\s+)?((?:\d{4}\s+)?[a-z0-9\- ]*?\s*(?:presidential election|presidential nomination|parliamentary election|election|nominee|governor|president|prime minister|chancellor|mayor|ballon d'or|finals|champions league)(?:\s+(?:of|in)\s+[a-z0-9\- ]+)*)/i,
  );
  if (m && m[2]) {
    const raw = m[2].toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return `contest:${raw}`;
  }
  return undefined;
}

/**
 * Extract a band-ladder key: one measured quantity carved into mutually
 * exclusive ranges ("60–70% of votes", "70–80%", "at least 80%").
 *
 * These defeat every other strategy at once. Each band arrives from the venue
 * with its OWN per-contract slug, so `metadata.eventKey` isolates them instead
 * of joining them; and their titles differ only in the numbers, which tokenise
 * away, so Jaccard never sees a ladder either. That is how one Clacton
 * by-election came to report 95% for the 60–70% band beside 20% for 70–80% and
 * 3% for 80%+ — 118% spread over three slices of a single vote share.
 *
 * The key is the title with the band erased, so every slice of one quantity
 * collapses onto the same string. Deliberately NOT keyed on the band itself —
 * that is exactly the part that must vary within a group.
 */
export function extractBandKey(title: string): string | undefined {
  const BAND_RE =
    /\b(?:at least|no less than|more than|greater than|over|above|under|below|less than|fewer than|at most|up to)\s+\$?[\d,.]+\s*%?|\$?[\d,.]+\s*%?\s*[–\-—]\s*\$?[\d,.]+\s*%?/gi;

  if (!BAND_RE.test(title)) return undefined;
  BAND_RE.lastIndex = 0;

  // A bare date range ("August 14 to August 21") is a shared window, not a
  // band — erasing it is harmless, but a title whose ONLY match is the date
  // range has no ladder and must not be grouped.
  const stripped = title
    .toLowerCase()
    .replace(BAND_RE, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length < 12) return undefined;
  return `band:${stripped.replace(/ /g, "_")}`;
}

/**
 * A one-sided threshold ladder: one measured quantity asked at several cut-offs
 * that all point the same way ("FDV above $100M", "above $250M", "above $500M").
 *
 * These look like bands and are not. A band ladder slices a quantity into
 * disjoint ranges, so exactly one slice can be true and the slices must sum to
 * 100%. A threshold ladder NESTS: an FDV of $600M makes "above $100M", "above
 * $250M" AND "above $500M" all true at once. Their probabilities are not a
 * distribution and forcing them to sum to 1.0 is a category error.
 *
 * That error shipped on 2026-09-10. Three LAPTOP FDV contracts estimated at
 * 80% / 55% / 27.75% summed to 162.75%, the normalizer treated the overshoot as
 * impossible, and anchor-weighting charged the whole excess to the contract
 * furthest from its venue price — driving "above $500M" negative, where the
 * Math.max(0.001) floor published it as 0.1% against a venue price of 79.5%.
 * The floor is what reached the report: not an estimate, a clamp.
 *
 * What DOES bind a threshold ladder is monotonicity — a harder cut-off can
 * never be likelier than an easier one — which monotonic.ts already enforces by
 * isotonic regression. So this key exists to keep such ladders OUT of the
 * sum-to-one path and route them to the ordering check instead.
 *
 * Keyed on the title with both the comparator and the magnitude erased, so
 * every rung of one quantity collapses onto the same string.
 */
export function extractThresholdKey(title: string): string | undefined {
  const THRESHOLD_RE = new RegExp(
    `\\b(?:${THRESHOLD_COMPARATORS})\\s+${MAGNITUDE_SRC}`,
    "gi",
  );

  // A range ("60–70%", "$100M-$250M") is a band, not a threshold, even when a
  // comparator sits elsewhere in the title. Ranges win; they are disjoint.
  if (RANGE_RE.test(title)) {
    RANGE_RE.lastIndex = 0;
    return undefined;
  }
  RANGE_RE.lastIndex = 0;

  if (!THRESHOLD_RE.test(title)) return undefined;
  THRESHOLD_RE.lastIndex = 0;

  const stripped = title
    .toLowerCase()
    .replace(THRESHOLD_RE, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length < 12) return undefined;
  return `threshold:${stripped.replace(/ /g, "_")}`;
}

/** Comparators that open a half-line rather than close an interval. */
const THRESHOLD_COMPARATORS =
  "at least|no less than|no fewer than|more than|greater than|over|above|" +
  "under|below|less than|fewer than|at most|up to|reach(?:es)?|hits?|exceeds?";

/** A number with an optional currency mark and an optional k/m/b/t suffix.
 *  The suffix matters: `[\d,.]+` alone does not match "$1B", which is how the
 *  fourth LAPTOP rung sat outside the group that mangled the other three. */
const MAGNITUDE_SRC = "\\$?[\\d,.]+\\s*(?:k|m|b|t|bn|mn|trillion|billion|million|thousand)?\\s*%?";

const RANGE_RE = new RegExp(`${MAGNITUDE_SRC}\\s*[–\\-—]\\s*${MAGNITUDE_SRC}`, "gi");

/**
 * Parse the numeric cut-off of a threshold rung, in absolute units.
 *
 * "above $500M" -> 500000000. Used to order the rungs of a ladder; the ordering
 * is what the monotonic check needs, so only relative magnitude has to be right.
 */
export function parseThresholdMagnitude(title: string): number | undefined {
  const m = title.match(
    new RegExp(`\\b(?:${THRESHOLD_COMPARATORS})\\s+\\$?([\\d,.]+)\\s*(k|m|b|t|bn|mn|trillion|billion|million|thousand)?`, "i"),
  );
  if (!m) return undefined;
  const base = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(base)) return undefined;
  const suffix = m[2]?.toLowerCase();
  const mult =
    suffix === "k" || suffix === "thousand"
      ? 1e3
      : suffix === "m" || suffix === "mn" || suffix === "million"
        ? 1e6
        : suffix === "b" || suffix === "bn" || suffix === "billion"
          ? 1e9
          : suffix === "t" || suffix === "trillion"
            ? 1e12
            : 1;
  return base * mult;
}

/**
 * Is this comparator pointing UP ("above X", "at least X") or DOWN ("below X")?
 *
 * An upward ladder is non-increasing in its cut-off (harder target, lower
 * probability); a downward ladder is non-decreasing. The monotonic repair needs
 * to know which way to sort before it can fit.
 */
export function thresholdDirection(title: string): "up" | "down" | undefined {
  const t = title.toLowerCase();
  if (!extractThresholdKey(title)) return undefined;
  if (/\b(at least|no less than|no fewer than|more than|greater than|over|above|reach(?:es)?|hits?|exceeds?)\s+\$?[\d,.]/.test(t)) {
    return "up";
  }
  if (/\b(under|below|less than|fewer than|at most|up to)\s+\$?[\d,.]/.test(t)) {
    return "down";
  }
  return undefined;
}

/** The key that decides which markets belong to the same event.
 *
 *  The policy, band and contest keys ALL outrank `metadata.eventKey` on
 *  purpose: a venue event key is per-contract, so the same September FOMC
 *  decision arrives as a Polymarket slug and a Kalshi event_ticker — and each
 *  vote-share band arrives under its own slug — forming groups that each
 *  normalize to 100% independently, still summing well over 100% across the
 *  real event.
 *
 *  A multi-candidate election is the same trap in its purest form: every
 *  candidate gets a slug naming that candidate
 *  ("will-ronaldo-caiado-win-the-2026-brazilian-presidential-election"), so
 *  eventKey isolates all nine into groups of one, `group.length < 2` skips
 *  each, and nothing is ever normalized. The 2026 Brazilian presidential race
 *  published Lula 57%, Bolsonaro 39% and Zema 75% — 177% across nine mutually
 *  exclusive outcomes. extractContestKey had matched every one of those titles
 *  correctly all along; it just never got to run. */
function groupKeyOf(market: PredictionMarket): string | undefined {
  const policy = extractPolicyDecisionKey(market.title);
  if (policy) return policy;
  const band = extractBandKey(market.title);
  if (band) return band;
  const contest = extractContestKey(market.title);
  if (contest) return contest;
  const key = market.metadata?.eventKey;
  if (typeof key === "string" && key) return key;
  return undefined;
}

/**
 * Group markets by event. Two strategies:
 *
 *   1. Explicit: markets sharing the same `metadata.eventKey`.
 *   2. Fuzzy: markets in the same category whose titles share >= 70% of their
 *      token set (Jaccard). This catches "Fed rate hike 2026?" and "Fed rate
 *      cut 2026?" that share no explicit key.
 *
 * Explicit grouping takes priority: a market with an eventKey is never
 * placed into a fuzzy cluster.
 */
function groupMarkets(
  markets: PredictionMarket[],
): Map<string, PredictionMarket[]> {
  const groups = new Map<string, PredictionMarket[]>();

  // --- Pass 1: explicit event keys ----------------------------------------
  const ungrouped: PredictionMarket[] = [];
  for (const market of markets) {
    const key = groupKeyOf(market);
    if (key) {
      const list = groups.get(key) ?? [];
      list.push(market);
      groups.set(key, list);
    } else {
      ungrouped.push(market);
    }
  }

  // --- Pass 2: fuzzy Jaccard clustering for markets without event keys ------
  interface Candidate {
    market: PredictionMarket;
    tokens: Set<string>;
  }

  const candidates: Candidate[] = ungrouped.map((m) => ({
    market: m,
    tokens: tokenise(m.title),
  }));

  const fuzzyGroups: Candidate[][] = [];

  for (const candidate of candidates) {
    if (candidate.tokens.size === 0) continue;

    const target = fuzzyGroups.find(
      (cluster) =>
        cluster[0]!.market.category === candidate.market.category &&
        jaccard(cluster[0]!.tokens, candidate.tokens) >= JACCARD_MIN,
    );

    if (target) {
      target.push(candidate);
    } else {
      fuzzyGroups.push([candidate]);
    }
  }

  // Only register fuzzy groups of 2+; singletons don't need normalization.
  let fuzzyIdx = 0;
  for (const cluster of fuzzyGroups) {
    if (cluster.length < 2) continue;
    const key = `_fuzzy_${fuzzyIdx++}`;
    groups.set(
      key,
      cluster.map((c) => c.market),
    );
  }

  // Drop groups that turned out to be nested rather than exclusive. This is a
  // whole-group verdict on purpose: a lone "at least 80%" among real 60–70% and
  // 70–80% bands is the closing slice of a partition and belongs in the rescale,
  // while a group where EVERY member is a one-sided threshold is a nested ladder
  // and must not be rescaled at all.
  for (const [key, group] of [...groups.entries()]) {
    if (isNestedThresholdLadder(group)) groups.delete(key);
  }

  return groups;
}

/**
 * Is every member of this group a one-sided threshold on the same quantity?
 *
 * Nested ladders ("above $100M" / "above $250M" / "above $500M") can all be true
 * at once, so their probabilities are not a distribution and forcing them to sum
 * to 1.0 is meaningless. A group containing any genuine range is a partition and
 * is left to the normalizer.
 */
function isNestedThresholdLadder(group: PredictionMarket[]): boolean {
  if (group.length < 2) return false;

  const directions = new Set<string>();
  for (const m of group) {
    const dir = thresholdDirection(m.title);
    // Any member that is not a one-sided threshold means this group is not a
    // pure nested ladder — one real band makes the whole set a partition.
    if (!dir) return false;
    if (parseThresholdMagnitude(m.title) === undefined) return false;
    directions.add(dir);
  }

  // Mixed directions ("above $100M" with "below $100M") are exclusive, not
  // nested, so they keep their rescale.
  return directions.size === 1;
}
