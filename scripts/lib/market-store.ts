/**
 * scripts/lib/market-store.ts — persistence for the prediction pipeline.
 *
 * The pipeline runs as one-shot scheduled processes, not a daemon, so every
 * piece of in-memory state died at exit. That is why the "self-evolving" half
 * never worked: ExecutionAgent had no markets to monitor, nothing ever reached
 * `resolved`, DreamCycle scored Brier over an empty array, and the calibration
 * page it should have produced was never written.
 *
 * This file is that missing memory. It also carries the set of already-seen
 * signal ids, so a market that Polymarket still lists tomorrow is not paid for
 * a second time.
 *
 * Format is plain JSON next to the repo root and gitignored. Written through a
 * temp file + rename so an interrupted run cannot truncate it.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { PredictionMarket } from "../../src/prediction/types.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const STATE_PATH = join(REPO_ROOT, ".prediction-state.json");

/** Cap on retained seen-ids. Old ids age out; a market that has been gone from
 *  the feed for this long is worth re-evaluating anyway. */
const MAX_SEEN_IDS = 5_000;

export interface PredictionState {
  activeMarkets: PredictionMarket[];
  resolvedMarkets: PredictionMarket[];
  seenSignalIds: string[];
  updatedAt: string;
}

const EMPTY: PredictionState = {
  activeMarkets: [],
  resolvedMarkets: [],
  seenSignalIds: [],
  updatedAt: new Date(0).toISOString(),
};

/** JSON.parse gives back ISO strings where the types promise Date objects.
 *  Everything downstream calls .toISOString() / compares with >=, so they have
 *  to be revived or the first comparison silently misbehaves. */
function reviveMarket(raw: unknown): PredictionMarket | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.title !== "string") return null;

  const toDate = (v: unknown): Date | undefined => {
    if (v instanceof Date) return v;
    if (typeof v !== "string") return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };

  const createdAt = toDate(m.createdAt);
  const expiresAt = toDate(m.expiresAt);
  if (!createdAt || !expiresAt) return null;

  const estimate = m.aiEstimate as Record<string, unknown> | undefined;
  if (!estimate || typeof estimate.yesProbability !== "number") return null;

  const resolution = m.resolution as Record<string, unknown> | undefined;

  return {
    ...(m as unknown as PredictionMarket),
    createdAt,
    expiresAt,
    resolvedAt: toDate(m.resolvedAt),
    aiEstimate: {
      ...(estimate as unknown as PredictionMarket["aiEstimate"]),
      updatedAt: toDate(estimate.updatedAt) ?? new Date(),
    },
    resolution: resolution
      ? {
          ...(resolution as unknown as NonNullable<PredictionMarket["resolution"]>),
          resolvedAt: toDate(resolution.resolvedAt) ?? new Date(),
        }
      : undefined,
  };
}

/**
 * Remove duplicate markets that share the same venue market id.
 *
 * `market.id` is always unique (`mkt_${Date.now()}_…`), so if the same
 * Polymarket/Kalshi contract enters the pipeline on two runs — or through two
 * source-lists — it creates two market objects, and the report prints both.
 * The real identity is `metadata.venueMarketId`; when two markets share it,
 * keep the one with the more recent AI estimate.
 *
 * Markets without a venueMarketId (telegram, rss, news, …) are never dupes
 * and pass through untouched.
 */
export function deduplicateMarkets(markets: PredictionMarket[]): PredictionMarket[] {
  // Pass 1: the same venue contract, by id.
  const byVenueId = new Map<string, PredictionMarket>();
  const rest: PredictionMarket[] = [];
  for (const m of markets) {
    const venueId = m.metadata?.venueMarketId;
    if (typeof venueId !== "string" || !venueId) {
      rest.push(m);
      continue;
    }
    const existing = byVenueId.get(venueId);
    if (!existing) {
      byVenueId.set(venueId, m);
      continue;
    }
    if (preferMarket(m, existing) === m) byVenueId.set(venueId, m);
  }

  // Pass 2: the same venue contract that lost its id.
  //
  // Older state rows carry no venueMarketId, so pass 1 cannot see them — yet
  // they still record which signal produced them, and one venue contract yields
  // one signal id. The live state held "Fed rate hike in 2026?" twice and the
  // 50+bps question twice, each pair sharing a source signal, each pair paid
  // for on every run.
  const bySignal = new Map<string, PredictionMarket>();
  const unkeyed: PredictionMarket[] = [];
  for (const m of [...byVenueId.values(), ...rest]) {
    const signal = m.metadata?.venueMarketId ? undefined : soleSourceSignal(m);
    if (!signal) {
      unkeyed.push(m);
      continue;
    }
    const existing = bySignal.get(signal);
    if (!existing) {
      bySignal.set(signal, m);
      continue;
    }
    if (preferMarket(m, existing) === m) bySignal.set(signal, m);
  }

  // Pass 3: one question the venue listed twice under DIFFERENT ids.
  //
  // Polymarket listed "Will United Russia (ER) GAIN the most seats…" (id
  // 1130012) beside "…WIN the most seats…" (id 1129894). Both are real,
  // separately-traded contracts, so neither id nor signal can join them — but
  // they ask one question, and normalize.ts then grouped a party against
  // itself. Matching is on a canonical title: synonym-folded, stopword-stripped
  // and sorted, so wording differences collapse while any difference in
  // subject, number or date still separates. Deliberately conservative — it
  // only ever merges titles that reduce to the identical canonical string.
  const byTitle = new Map<string, PredictionMarket>();
  const out: PredictionMarket[] = [];
  for (const m of [...bySignal.values(), ...unkeyed]) {
    const key = canonicalTitleKey(m);
    if (!key) {
      out.push(m);
      continue;
    }
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, m);
      continue;
    }
    if (preferMarket(m, existing) === m) byTitle.set(key, m);
  }
  out.push(...byTitle.values());
  return out;
}

/**
 * Which of two duplicate listings to keep.
 *
 * Spread first. Both Russian-election listings were live and heavily traded, so
 * recency of our own estimate says nothing about which contract the market
 * actually uses — and the two prices differed by 24.5 points, so the choice
 * decides which number the whole pipeline treats as the market's view.
 *
 * 24-hour volume looks like the obvious tiebreak and is the weaker signal here:
 * it separated the pair by 9% (243k vs 224k), well inside what a couple of
 * large trades move, and it would have kept the listing quoted at 74.5% while
 * discarding the one at 99%. Bid-ask spread separated the same pair five-fold
 * (1.0% vs 0.2%). A book that tight is being actively made; that is the price
 * to trust. Volume breaks a spread tie, and the fresher estimate breaks a tie
 * on both.
 */
function preferMarket(a: PredictionMarket, b: PredictionMarket): PredictionMarket {
  const spreadA = spreadOf(a);
  const spreadB = spreadOf(b);
  if (spreadA !== undefined && spreadB !== undefined && spreadA !== spreadB) {
    return spreadA < spreadB ? a : b;
  }
  // One side quoted and the other not: prefer the quoted one, it is the listing
  // with a live book behind it.
  if (spreadA !== undefined && spreadB === undefined) return a;
  if (spreadB !== undefined && spreadA === undefined) return b;

  const volA = numeric(a.metadata?.volume24hr);
  const volB = numeric(b.metadata?.volume24hr);
  if (volA !== volB) return volA > volB ? a : b;

  const tsA = a.aiEstimate?.updatedAt?.getTime?.() ?? 0;
  const tsB = b.aiEstimate?.updatedAt?.getTime?.() ?? 0;
  return tsA > tsB ? a : b;
}

/** The quoted bid-ask spread, when this listing carries a live quote. */
function spreadOf(m: PredictionMarket): number | undefined {
  const quote = m.metadata?.crowdQuote as { spread?: unknown } | undefined;
  const spread = quote?.spread;
  return typeof spread === "number" && Number.isFinite(spread) && spread >= 0
    ? spread
    : undefined;
}

function numeric(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The one signal that produced this market, when there is exactly one. Two
 *  signals mean the market was merged from several sources and its identity is
 *  no longer a single contract. */
function soleSourceSignal(m: PredictionMarket): string | undefined {
  const signals = m.sourceSignals;
  if (!Array.isArray(signals) || signals.length !== 1) return undefined;
  const s = signals[0];
  return typeof s === "string" && s ? s : undefined;
}

/** Verb variants that name the same outcome in a prediction-market title. */
const TITLE_SYNONYMS: Array<[RegExp, string]> = [
  [/\b(?:wins?|winning|gains?|gaining|takes?|taking|secures?|securing|captures?|capturing)\b/g, "win"],
  [/\b(?:receives?|gets?|obtains?)\b/g, "win"],
];

const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "will", "be", "to", "of", "in", "on", "at", "for", "and",
  "or", "it", "its", "this", "that", "by", "next", "is", "are", "does", "do",
]);

/**
 * A canonical form of a title, for spotting one question listed twice.
 *
 * Folds the win/gain family to one verb, drops stopwords and punctuation, then
 * SORTS the remaining words — so word order cannot hide a match. Numbers and
 * proper nouns survive untouched, which is what keeps "$250M" apart from
 * "$500M" and one candidate apart from another.
 *
 * Returns undefined for titles too short to be distinctive, so two terse
 * headlines cannot collide on a handful of shared words.
 */
export function canonicalTitleKey(m: PredictionMarket): string | undefined {
  const title = typeof m.title === "string" ? m.title : "";
  let t = title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  for (const [re, rep] of TITLE_SYNONYMS) t = t.replace(re, rep);
  const words = t.split(/\s+/).filter((w) => w && !TITLE_STOPWORDS.has(w));
  if (words.length < 4) return undefined;
  // Category scopes the match: two domains can share a phrasing without asking
  // the same question.
  return `${m.category}|${[...words].sort().join(" ")}`;
}

export function loadState(): PredictionState {
  if (!existsSync(STATE_PATH)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<PredictionState>;
    const rawActive = (parsed.activeMarkets ?? [])
      .map(reviveMarket)
      .filter((m): m is PredictionMarket => m !== null);
    const rawResolved = (parsed.resolvedMarkets ?? [])
      .map(reviveMarket)
      .filter((m): m is PredictionMarket => m !== null);
    const active = deduplicateMarkets(rawActive);
    const resolved = deduplicateMarkets(rawResolved);
    if (active.length < rawActive.length || resolved.length < rawResolved.length) {
      console.log(
        `[market-store] deduplicated: ${rawActive.length - active.length} active, ` +
          `${rawResolved.length - resolved.length} resolved duplicates removed`,
      );
    }
    return {
      activeMarkets: active,
      resolvedMarkets: resolved,
      seenSignalIds: Array.isArray(parsed.seenSignalIds)
        ? parsed.seenSignalIds.filter((s): s is string => typeof s === "string")
        : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : EMPTY.updatedAt,
    };
  } catch (err) {
    // A corrupt state file must not stop the cycle — start clean and say so.
    console.error(
      `[market-store] could not read state (${(err as Error).message}); starting from empty`,
    );
    return { ...EMPTY };
  }
}

export function saveState(state: Omit<PredictionState, "updatedAt">): void {
  const payload: PredictionState = {
    ...state,
    // Newest ids last; keep the tail.
    seenSignalIds: state.seenSignalIds.slice(-MAX_SEEN_IDS),
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  renameSync(tmp, STATE_PATH);
}

export { STATE_PATH };
