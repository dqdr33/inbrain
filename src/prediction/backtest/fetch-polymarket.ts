/**
 * Build MarketSnapshots from Polymarket's public API.
 *
 * Two endpoints:
 *   gamma-api /markets?closed=true   — the settled question + ground truth
 *   clob      /prices-history        — the price curve, for as-of pricing
 *
 * This is the ONLY place in the backtest that touches the network. Everything
 * downstream reads the snapshot file, so a scoring run is reproducible and
 * cannot accidentally consult the live venue for a market it is mid-forecast on.
 */

import {
  normalizeHistory,
  parseBinaryOutcome,
  type MarketSnapshot,
  type PricePoint,
} from "./snapshot.ts";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const FETCH_TIMEOUT_MS = 30_000;

async function fetchT(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** Raw gamma market shape, narrowed to the fields the snapshot needs. */
interface GammaMarket {
  id: string;
  question?: string;
  slug?: string;
  description?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  volumeNum?: number;
  volume?: string | number;
  createdAt?: string;
  endDate?: string;
  endDateIso?: string;
  closedTime?: string;
  closed?: boolean;
  category?: string;
  events?: Array<{ title?: string; seriesSlug?: string }>;
}

/**
 * Only genuine two-sided Yes/No questions are scorable.
 *
 * Polymarket reuses the binary contract shape for "Team A vs Team B" and
 * over/under markets, where "Yes" is not a proposition about the world but a
 * label for one side. Scoring those as P(YES) mixes two different questions
 * into one calibration curve.
 */
function isYesNoMarket(m: GammaMarket): boolean {
  if (!m.outcomes) return false;
  try {
    const outcomes = JSON.parse(m.outcomes) as unknown;
    if (!Array.isArray(outcomes) || outcomes.length !== 2) return false;
    const [a, b] = outcomes.map((o) => String(o).trim().toLowerCase());
    return a === "yes" && b === "no";
  } catch {
    return false;
  }
}

/** The YES token id — the first of the two clob tokens, matching outcomes[0]. */
function yesTokenId(m: GammaMarket): string | null {
  if (!m.clobTokenIds) return null;
  try {
    const ids = JSON.parse(m.clobTokenIds) as unknown;
    if (!Array.isArray(ids) || ids.length < 1) return null;
    const id = String(ids[0]);
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Daily price history for one token.
 *
 * `fidelity=1440` is one point per day, which is the right grain for as-of
 * dates measured in months. Finer resolution multiplies payload for no gain:
 * a backtest asking "what was the price 90 days out" does not care about the
 * intraday path.
 */
export async function fetchPriceHistory(tokenId: string): Promise<PricePoint[]> {
  const url = `${CLOB}/prices-history?market=${tokenId}&interval=max&fidelity=1440`;
  try {
    const r = await fetchT(url);
    if (!r.ok) return [];
    const data = (await r.json()) as { history?: unknown };
    return normalizeHistory(data.history);
  } catch {
    return [];
  }
}

export interface FetchOptions {
  /** How many settled markets to consider, highest-volume first. */
  limit?: number;
  /** Skip markets below this traded volume. Thin markets have noisy prices and
   *  no meaningful crowd to beat, so they measure nothing. */
  minVolume?: number;
  /** Only markets that closed on or after this date. */
  closedAfter?: Date;
  /** Only markets that closed on or before this date. The upper bound is how a
   *  run targets questions the model is least likely to have memorised. */
  closedBefore?: Date;
  onProgress?: (done: number, total: number, note: string) => void;
}

/**
 * Page through settled markets and build snapshots.
 *
 * Ordered by volume descending: liquid markets have real price discovery, which
 * is what makes the market-price baseline a meaningful opponent. A backtest
 * that beats a market nobody traded has proven nothing.
 */
export async function fetchSnapshots(opts: FetchOptions = {}): Promise<MarketSnapshot[]> {
  const limit = opts.limit ?? 200;
  const minVolume = opts.minVolume ?? 50_000;
  const pageSize = 100;

  const candidates: GammaMarket[] = [];
  let offset = 0;

  // Over-fetch: most settled markets are sports/esports and fail isYesNoMarket,
  // so the yield per page is low. Cap the crawl so a bad filter cannot spin.
  const maxPages = 40;
  for (let page = 0; page < maxPages && candidates.length < limit * 3; page++) {
    const url =
      `${GAMMA}/markets?closed=true&limit=${pageSize}&offset=${offset}` +
      `&order=volumeNum&ascending=false`;
    const r = await fetchT(url);
    if (!r.ok) break;
    const batch = (await r.json()) as GammaMarket[];
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const m of batch) {
      if (!isYesNoMarket(m)) continue;
      const vol = Number(m.volumeNum ?? m.volume ?? 0);
      if (!Number.isFinite(vol) || vol < minVolume) continue;

      const endRaw = m.endDate ?? m.endDateIso;
      if (!endRaw) continue;
      const end = new Date(endRaw);
      if (Number.isNaN(end.getTime())) continue;
      if (opts.closedAfter && end < opts.closedAfter) continue;
      if (opts.closedBefore && end > opts.closedBefore) continue;

      if (parseBinaryOutcome(m.outcomePrices) === null) continue;
      if (!yesTokenId(m)) continue;

      candidates.push(m);
    }

    offset += pageSize;
    opts.onProgress?.(candidates.length, limit, `scanned ${offset} markets`);
    if (batch.length < pageSize) break;
  }

  const selected = candidates.slice(0, limit);
  const out: MarketSnapshot[] = [];

  // Price history is one request per market — the slow part. Small concurrency
  // keeps it civil; the CLOB endpoint throttles under heavier fan-out.
  const CONCURRENCY = 4;
  for (let i = 0; i < selected.length; i += CONCURRENCY) {
    const chunk = selected.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (m) => {
        const token = yesTokenId(m)!;
        const history = await fetchPriceHistory(token);
        const outcome = parseBinaryOutcome(m.outcomePrices);
        if (outcome === null) return null;

        // No history means no as-of price is knowable, so the market can never
        // produce a view. Dropping it here keeps the snapshot file honest about
        // what it can actually support.
        if (history.length === 0) return null;

        const snapshot: MarketSnapshot = {
          id: String(m.id),
          venue: "polymarket",
          question: m.question ?? "",
          description: m.description,
          slug: m.slug,
          createdAt: m.createdAt ?? new Date(history[0]!.t * 1000).toISOString(),
          endDate: new Date(m.endDate ?? m.endDateIso!).toISOString(),
          closedTime: m.closedTime,
          outcome,
          volume: Number(m.volumeNum ?? m.volume ?? 0),
          history,
          category: m.events?.[0]?.seriesSlug,
        };
        return snapshot;
      }),
    );
    for (const s of results) if (s) out.push(s);
    opts.onProgress?.(out.length, selected.length, "fetching price history");
  }

  return out;
}
