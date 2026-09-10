/**
 * src/prediction/monotonic.ts — enforce cumulative monotonicity across horizons.
 *
 * A cumulative question cannot get less likely as its deadline moves out:
 * P("by Dec 31") >= P("by Aug 31"), always. The Brain Agent estimates each
 * contract in isolation, so nothing holds that ordering. On 2026-08-19 the
 * production state carried one question at five horizons reading
 * 95 / 91 / 13 / 91 / 15 — incoherent in both directions.
 *
 * cross-market.ts DETECTS this and reports it. Detection alone still shipped the
 * broken numbers: the same 91% that the desync section flagged as a model
 * inconsistency was simultaneously printed as a HIGH-urgency alpha opportunity
 * against a 7% market price. This module is the repair pass.
 *
 * Method: isotonic regression (pool-adjacent-violators) under the L2 norm — the
 * closest non-decreasing sequence to what the model actually said, weighted by
 * estimator confidence. It is the standard, order-preserving fit, so a confident
 * estimate moves less than a hesitant one and no value is invented from nothing.
 *
 * Deliberately NOT a repair for the underlying estimator. The right long-term
 * fix is to condition each estimate on its siblings at ingest. This keeps the
 * published report internally consistent in the meantime, and records what it
 * changed so the drift stays visible rather than being silently smoothed away.
 */

import type { PredictionMarket } from "./types.js";
import { parseDeadlineFromTitle, isLive } from "./deadline.js";
import { shrinkTowardPrice } from "./shrink.js";
import type { CrowdQuote } from "./crowd.js";
import {
  extractThresholdKey,
  parseThresholdMagnitude,
  thresholdDirection,
} from "./normalize.js";

/** Adjustment below this is rounding, not a correction worth recording. */
const MIN_REPORTABLE_PP = 0.05;

/** How alike two questions must be, as token-set Jaccard, to count as the same
 *  underlying question at different horizons. Matches cross-market.ts so the
 *  detector and the repair always agree on what forms a series. */
const JACCARD_MIN = 0.85;

const STOPWORDS = new Set([
  "a", "an", "the", "will", "would", "does", "do", "did", "is", "are", "be", "been",
  "to", "of", "in", "on", "at", "for", "and", "or", "it", "its", "this", "that",
  "by", "before", "through", "until", "prior", "during", "there", "any", "have",
  "has", "than", "then", "with", "from", "as", "if", "not",
]);

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface MonotonicAdjustment {
  marketId: string;
  title: string;
  deadline: Date;
  before: number;
  after: number;
  /** Signed change in percentage points. */
  deltaPp: number;
}

/**
 * The venue price this market trades at, when one was quoted.
 *
 * Only a quote with a basis is a price. A bare `crowdProbability` left by an
 * older state file has no venue and no timestamp behind it, and shrinking
 * toward it would pull an estimate toward a number nobody quoted.
 */
function venuePrice(market: PredictionMarket): number | undefined {
  const quote = market.metadata?.crowdQuote as CrowdQuote | undefined;
  if (typeof quote?.probability !== "number" || typeof quote.basis !== "string") {
    return undefined;
  }
  return Number.isFinite(quote.probability) ? quote.probability : undefined;
}

export interface MonotonicResult {
  /** Series that contained at least one violation and were repaired. */
  seriesCount: number;
  adjustments: MonotonicAdjustment[];
}

interface Point {
  market: PredictionMarket;
  deadline: Date;
  value: number;
  weight: number;
}

/**
 * Pool-adjacent-violators algorithm: the L2-closest non-decreasing sequence.
 *
 * Walks left to right maintaining blocks of a pooled weighted mean. Whenever a
 * new block would sit below the one before it, the two merge and share their
 * mean — repeated until order is restored. The result is the unique isotonic fit.
 */
export function isotonicFit(values: number[], weights: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];

  const mean: number[] = [];
  const mass: number[] = [];
  const size: number[] = [];

  for (let i = 0; i < n; i++) {
    const w = weights[i]! > 0 ? weights[i]! : 1e-9;
    mean.push(values[i]!);
    mass.push(w);
    size.push(1);

    // Merge backwards while the block order is violated.
    while (mean.length > 1 && mean[mean.length - 2]! > mean[mean.length - 1]! + 1e-12) {
      const curMean = mean.pop()!;
      const curMass = mass.pop()!;
      const curSize = size.pop()!;
      const prevMean = mean.pop()!;
      const prevMass = mass.pop()!;
      const prevSize = size.pop()!;
      const totalMass = prevMass + curMass;
      mean.push((prevMean * prevMass + curMean * curMass) / totalMass);
      mass.push(totalMass);
      size.push(prevSize + curSize);
    }
  }

  const out: number[] = [];
  for (let b = 0; b < mean.length; b++) {
    for (let k = 0; k < size[b]!; k++) out.push(mean[b]!);
  }
  return out;
}

/**
 * Repair AI probabilities so every THRESHOLD ladder is ordered by its cut-off.
 *
 * A cumulative series is monotonic in its deadline; a threshold ladder is
 * monotonic in its magnitude. "FDV above $100M" cannot be less likely than "FDV
 * above $500M", because every world satisfying the second satisfies the first.
 * The Brain Agent estimates each rung alone, so nothing holds that ordering —
 * and normalize.ts deliberately does NOT touch these ladders, since their
 * probabilities are nested rather than exclusive and must not sum to 1.0.
 *
 * On 2026-09-10 the LAPTOP ladder published 67.6% / 32.3% / 0.1% for the $100M,
 * $250M and $500M rungs. The ordering there was accidentally correct; the values
 * were not, because the sum-to-one rescale had produced them. With that rescale
 * removed the model's own 80% / 55% / 27.75% already satisfies the ordering, and
 * this pass leaves it alone. It exists for the case where the model itself
 * inverts two rungs.
 *
 * Same machinery as the deadline pass: isotonic regression weighted by
 * confidence, fitted on the model's original output, then re-shrunk toward the
 * venue price so pooling cannot manufacture a fictitious edge.
 */
export function enforceThresholdMonotonicity(
  markets: PredictionMarket[],
  opts: { now?: Date } = {},
): MonotonicResult {
  const now = opts.now ?? new Date();

  interface Rung {
    market: PredictionMarket;
    key: string;
    magnitude: number;
    direction: "up" | "down";
  }

  const rungs: Rung[] = [];
  for (const market of markets) {
    if (!isLive(market, now)) continue;
    const key = extractThresholdKey(market.title);
    if (!key) continue;
    const magnitude = parseThresholdMagnitude(market.title);
    if (magnitude === undefined) continue;
    const direction = thresholdDirection(market.title);
    if (!direction) continue;
    rungs.push({ market, key, magnitude, direction });
  }

  const clusters = new Map<string, Rung[]>();
  for (const rung of rungs) {
    // Direction is part of the cluster identity: "above $100M" and "below $100M"
    // measure the same quantity but run opposite ways, and pooling them would
    // assert an ordering neither one claims.
    const id = `${rung.key}|${rung.direction}|${rung.market.category}`;
    const list = clusters.get(id) ?? [];
    list.push(rung);
    clusters.set(id, list);
  }

  const adjustments: MonotonicAdjustment[] = [];
  let seriesCount = 0;

  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue;

    // Sort so the fit always runs in the non-decreasing direction. An upward
    // ladder ("above X") falls as X rises, so walking it from the HARDEST rung
    // down gives a non-decreasing sequence — the shape isotonicFit expects.
    const ordered = [...cluster].sort((a, b) =>
      a.direction === "up" ? b.magnitude - a.magnitude : a.magnitude - b.magnitude,
    );

    const points: Point[] = ordered
      .map((r) => {
        const stored = r.market.metadata?.preMonotonicProbability;
        const value =
          typeof stored === "number" ? stored : r.market.aiEstimate.yesProbability;
        const confidence = r.market.aiEstimate?.confidence;
        return {
          market: r.market,
          // The deadline field is unused by the threshold fit; carry the
          // market's own expiry so the adjustment record stays well-formed.
          deadline: new Date(r.market.expiresAt),
          value,
          weight: typeof confidence === "number" && confidence > 0 ? confidence : 0.5,
        };
      })
      .filter((p) => Number.isFinite(p.value));

    if (points.length < 2) continue;

    const fitted = isotonicFit(
      points.map((p) => p.value),
      points.map((p) => p.weight),
    );

    const changed = points.some(
      (p, i) => Math.abs(fitted[i]! - p.value) * 100 >= MIN_REPORTABLE_PP,
    );
    if (!changed) {
      for (const p of points) {
        if (typeof p.market.metadata.preMonotonicProbability === "number") {
          p.market.aiEstimate.yesProbability = p.market.metadata.preMonotonicProbability;
          delete p.market.metadata.preMonotonicProbability;
        }
      }
      continue;
    }

    seriesCount++;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const after = shrinkTowardPrice(fitted[i]!, venuePrice(p.market)).shrunk;
      const deltaPp = (after - p.value) * 100;
      p.market.metadata.preMonotonicProbability = p.value;
      p.market.aiEstimate.yesProbability = after;
      if (Math.abs(deltaPp) >= MIN_REPORTABLE_PP) {
        adjustments.push({
          marketId: p.market.id,
          title: p.market.title,
          deadline: p.deadline,
          before: p.value,
          after,
          deltaPp,
        });
      }
    }
  }

  return { seriesCount, adjustments };
}

/**
 * Repair AI probabilities so every cumulative series is non-decreasing in its
 * deadline. Mutates `aiEstimate.yesProbability`; the pre-repair value is kept in
 * `metadata.preMonotonicProbability` so the change stays auditable and a later
 * run can recompute from the model's own output rather than from a repair.
 */
export function enforceMonotonicity(
  markets: PredictionMarket[],
  opts: { now?: Date } = {},
): MonotonicResult {
  const now = opts.now ?? new Date();

  interface Entry {
    market: PredictionMarket;
    deadline: Date;
    tokens: Set<string>;
  }

  const entries: Entry[] = [];
  for (const market of markets) {
    // An expired horizon must not pull on a live one. The blockade series read
    // 95 / 91 / 13 / 91 / 15 across five dates, but the first two were already
    // past — fitting all five pooled everything to a flat 61%, asserting a
    // probability that never moves and that the model never gave. Restricted to
    // the live horizons the report actually publishes, the same fit keeps the
    // genuine 13% and pools only the contradictory pair.
    if (!isLive(market, now)) continue;
    const parsed = parseDeadlineFromTitle(market.title, now);
    // Only cumulative framings carry the monotonic guarantee. "in September" is
    // a window: a later window being less likely is ordinary, not a violation.
    if (!parsed || parsed.framing !== "cumulative") continue;
    const stripped = market.title.replace(parsed.phrase, " ");
    const tokens = tokenise(stripped);
    if (tokens.size === 0) continue;
    entries.push({ market, deadline: parsed.at, tokens });
  }

  const clusters: Entry[][] = [];
  for (const entry of entries) {
    const target = clusters.find(
      (c) =>
        c[0]!.market.category === entry.market.category &&
        jaccard(c[0]!.tokens, entry.tokens) >= JACCARD_MIN,
    );
    if (target) target.push(entry);
    else clusters.push([entry]);
  }

  const adjustments: MonotonicAdjustment[] = [];
  let seriesCount = 0;

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;

    const points: Point[] = cluster
      .map((e) => {
        // Always fit from the model's ORIGINAL output. Reading the live field
        // would fit a previous run's repair and let corrections compound the way
        // the normalizer's did.
        const stored = e.market.metadata?.preMonotonicProbability;
        const value =
          typeof stored === "number" ? stored : e.market.aiEstimate.yesProbability;
        const confidence = e.market.aiEstimate?.confidence;
        return {
          market: e.market,
          deadline: e.deadline,
          value,
          // A confident estimate should move less than a hesitant one.
          weight: typeof confidence === "number" && confidence > 0 ? confidence : 0.5,
        };
      })
      .filter((p) => Number.isFinite(p.value))
      .sort((a, b) => a.deadline.getTime() - b.deadline.getTime());

    if (points.length < 2) continue;

    const fitted = isotonicFit(
      points.map((p) => p.value),
      points.map((p) => p.weight),
    );

    const changed = points.some((p, i) => Math.abs(fitted[i]! - p.value) * 100 >= MIN_REPORTABLE_PP);
    if (!changed) {
      // Series is already coherent. Drop any stale repair marker so the market
      // carries the model's own number again.
      for (const p of points) {
        if (typeof p.market.metadata.preMonotonicProbability === "number") {
          p.market.aiEstimate.yesProbability = p.market.metadata.preMonotonicProbability;
          delete p.market.metadata.preMonotonicProbability;
        }
      }
      continue;
    }

    seriesCount++;
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      // Pooling can MANUFACTURE a divergence the model never claimed. The
      // blockade series read 50% at Sep 7 and 37% at Sep 30 against a ~3% venue
      // price; the isotonic fit pooled them to 43.9% and that number was then
      // published as a 41pp alpha opportunity six days before the deadline.
      //
      // shrinkTowardPrice runs once, at estimate time (brain-agent.ts), so a
      // value the repair moved afterwards was never re-tested against the
      // price. Re-shrink here: the pooled 43.9% against 3% publishes near 6%
      // and stops looking like an edge, while a series with no quote passes
      // through untouched.
      const after = shrinkTowardPrice(fitted[i]!, venuePrice(p.market)).shrunk;
      const deltaPp = (after - p.value) * 100;
      p.market.metadata.preMonotonicProbability = p.value;
      p.market.aiEstimate.yesProbability = after;
      if (Math.abs(deltaPp) >= MIN_REPORTABLE_PP) {
        adjustments.push({
          marketId: p.market.id,
          title: p.market.title,
          deadline: p.deadline,
          before: p.value,
          after,
          deltaPp,
        });
      }
    }
  }

  return { seriesCount, adjustments };
}
