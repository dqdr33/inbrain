#!/usr/bin/env bun
/**
 * scripts/run-prediction-cycle.ts — one-shot wiring for the Inbrain
 * Prediction Intelligence Network (src/prediction/*).
 *
 * The four-agent pipeline (Signal -> Brain -> Execution -> Analyst) ships
 * as library code but is NOT wired into the CLI (no `inbrain start`).
 * This script is the missing integration: it takes one snapshot of live
 * signals, evaluates them with the Brain Agent, and produces a daily
 * intelligence report — written both as a brain page (so it's part of
 * the personal-brain digest too) and printed to stdout.
 *
 * Design choices (testing phase, free-tier Gemini key):
 *   - Sources: polymarket + kalshi only (public APIs, no key required).
 *     x_twitter / news are wired in SignalAgent but need
 *     INBRAIN_X_BEARER_TOKEN / INBRAIN_NEWS_API_KEY — add them later and
 *     pass --sources x_twitter,news,polymarket,kalshi.
 *   - One-shot snapshot, not the long-running daemon (orchestrator.start()
 *     with setInterval). Run this on a schedule (Task Scheduler) instead
 *     of keeping a process alive — simpler and more robust on Windows.
 *   - maxSignals kept small by default to stay under Gemini free-tier RPM
 *     and to keep cost/latency predictable while testing.
 *   - brainQuery/brainWrite shell out to the real `inbrain` CLI so writes
 *     go through the actual engine (chunking, embeddings, link
 *     extraction) instead of bypassing it.
 *
 * Usage:
 *   bun run scripts/run-prediction-cycle.ts
 *   bun run scripts/run-prediction-cycle.ts --max-signals 5 --dry-run
 *   bun run scripts/run-prediction-cycle.ts --sources polymarket,kalshi --quality-threshold 60
 *
 * Key rotation: see scripts/lib/gemini-keys.ts. GEMINI_API_KEY_1..N in .env
 * are tried in order; on a quota/billing 429 the pool advances and the
 * call retries on the next key. State persists in .gemini-key-state.json
 * (gitignored) so later runs and run-analytics-cycle.ps1's `inbrain dream`
 * step share the same "currently active key" decision.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SignalAgent } from "../src/prediction/signal-agent.ts";
import { BrainAgent, type ContestContext } from "../src/prediction/brain-agent.ts";
import { AnalystAgent, maxEstimateAgeFor } from "../src/prediction/analyst-agent.ts";
import { ExecutionAgent } from "../src/prediction/execution-agent.ts";
import { extractCrowdQuote } from "../src/prediction/crowd.ts";
import { isLive } from "../src/prediction/deadline.ts";
import { findStructuralDesyncs, relatedMarketIds } from "../src/prediction/cross-market.ts";
import { normalizeRelatedMarkets, extractContestKey } from "../src/prediction/normalize.ts";
import {
  enforceMonotonicity,
  enforceThresholdMonotonicity,
} from "../src/prediction/monotonic.ts";
import { sweepUnsettleable } from "../src/prediction/unsettleable.ts";
import type { PredictionSignal, PredictionMarket, SignalSource } from "../src/prediction/types.ts";
import { formatReportMarkdown } from "./lib/report-format.ts";
import { refreshQuotes } from "./lib/quote-refresh.ts";
import { fetchVenueResolution as fetchVenueOutcome } from "./lib/venue-settle.ts";
import { loadKeyPool, FREE_TIER_DAILY_REQUESTS } from "./lib/gemini-keys.ts";
import { createLlmCall, formatUsage, DEFAULT_GEMINI_MODEL, stripFences } from "./lib/llm.ts";
import { brainGet, brainQuery, brainWrite as brainWriteRaw } from "./lib/brain-cli.ts";
import { loadCalibrationFit } from "./lib/calibration-store.ts";
import { sendTelegram } from "./lib/telegram.ts";
import { loadState, saveState, deduplicateMarkets } from "./lib/market-store.ts";
import { acquireLockOrExit, PIPELINE_LOCK } from "./lib/run-lock.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/** Stale estimates refreshed per cycle. One LLM call each, so this is bounded
 *  by the same free-tier budget as the signal evaluations above it. */
const MAX_REFRESH_PER_CYCLE = 6;
// gemini-2.0-flash / -lite return free-tier limit=0 on this project; 2.5-flash
// has a working free-tier chat quota (verified empirically — see PR discussion).
const GEMINI_MODEL = DEFAULT_GEMINI_MODEL;

// ---------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------
function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  // `--max-signals` with nothing after it, or followed by the next flag, used
  // to yield undefined -> Number(undefined) -> NaN. NaN then made
  // `slice(0, NaN)` return zero signals and `overall < NaN` always false, i.e.
  // every signal accepted. Both failures were silent.
  if (value === undefined || value.startsWith("--")) {
    console.error(`[run-prediction-cycle] --${name} requires a value`);
    process.exit(2);
  }
  return value;
}

function numericFlag(name: string, fallback: number, min: number, max: number): number {
  const raw = flag(name, String(fallback))!;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(
      `[run-prediction-cycle] --${name} must be a number in [${min}, ${max}], got "${raw}"`,
    );
    process.exit(2);
  }
  return n;
}

const DRY_RUN = process.argv.includes("--dry-run");
// Free-tier Gemini quota is GenerateRequestsPerDayPerProjectPerModel = 20/day
// per key for gemini-2.5-flash. Each evaluated signal costs 2 calls (quality +
// estimate); the daily report and the translation cost 1 each. Keep
// --max-signals in run-analytics-cycle.ps1 in step with the number of keys in
// the pool, or the pool burns out mid-cycle.
const MAX_SIGNALS = numericFlag("max-signals", 4, 1, 200);
const QUALITY_THRESHOLD = numericFlag("quality-threshold", 55, 0, 100);
const DEFAULT_SOURCES = [
  "polymarket",
  "kalshi",
  "predictit",
  "news",
  "telegram",
  "rss",
  "defillama",
  "binance",
  "bybit",
  "coingecko",
  "fred",
  "onchain",
  "reddit",
  "discord",
  "x_twitter",
  "gdelt",
  "alphavantage",
  "dune",
  "farcaster",
  "covalent",
  "cmc",
  "token_unlocks",
  "lunarcrush",
].join(",");

const SOURCES = (flag("sources", DEFAULT_SOURCES) ?? DEFAULT_SOURCES)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean) as SignalSource[];

if (SOURCES.length === 0) {
  console.error("[run-prediction-cycle] --sources resolved to an empty list");
  process.exit(2);
}

// Reject a misspelled source outright. Previously an unknown name fell through
// the fetcher switch and returned an empty array, so "alpha_vantage" (the real
// name has no underscore) looked identical to a source that simply had no news.
const KNOWN_SOURCES: ReadonlySet<string> = new Set<SignalSource>([
  "x_twitter", "news", "onchain", "polymarket", "kalshi", "predictit", "reddit",
  "discord", "manual", "defillama", "rss", "binance", "bybit", "coingecko",
  "gdelt", "telegram", "fred", "alphavantage", "dune", "farcaster",
  "covalent", "cmc", "token_unlocks", "lunarcrush"
]);
const unknownSources = SOURCES.filter((s) => !KNOWN_SOURCES.has(s));
if (unknownSources.length > 0) {
  console.error(
    `[run-prediction-cycle] unknown source(s): ${unknownSources.join(", ")}\n` +
      `  valid: ${[...KNOWN_SOURCES].sort().join(", ")}`,
  );
  process.exit(2);
}

// Each accepted signal costs 2 calls (quality + estimate), plus one report and
// one translation per cycle. The capacity check needs the key pool, so it runs
// once the pool is loaded, below.
const estimatedCalls = MAX_SIGNALS * 2 + 2;
console.log(
  `[run-prediction-cycle] budget: up to ~${estimatedCalls} Gemini call(s) this cycle ` +
    `(${MAX_SIGNALS} signals x2 + report + translation)`,
);

// ---------------------------------------------------------------------
// Multi-account key pool (scripts/lib/gemini-keys.ts). Rotates to the next
// GEMINI_API_KEY_N in .env when the active one hits a quota/billing error,
// and persists the active index so later runs (and the separate `inbrain
// dream` step in run-analytics-cycle.ps1) pick up where this left off.
// ---------------------------------------------------------------------
const keyPool = loadKeyPool();
console.log(
  `[run-prediction-cycle] key pool: ${keyPool.size()} key(s) ` +
    `(${keyPool.freeCount()} free, ${keyPool.paidCount()} paid reserve), starting on ${keyPool.activeLabel()}`,
);

// Capacity is counted over FREE keys only. A paid key is bounded by spend, not
// by a request-per-day quota, so folding it into this number would invent a
// limit nobody knows — it is the overflow that keeps a cycle from dying, and
// the warning says exactly that.
const freeCapacity = keyPool.freeCount() * FREE_TIER_DAILY_REQUESTS;
if (estimatedCalls > freeCapacity) {
  console.warn(
    `[run-prediction-cycle] WARNING: ~${estimatedCalls} calls exceeds the free-tier capacity of ` +
      `${freeCapacity} (${keyPool.freeCount()} key(s) x ${FREE_TIER_DAILY_REQUESTS}/day)` +
      (keyPool.paidCount() > 0
        ? "; the overflow will bill to the paid reserve key."
        : "; the pool will exhaust mid-cycle."),
  );
}

// ---------------------------------------------------------------------
// Gemini call path + brain CLI bridge now live in scripts/lib/ � they used to
// be copy-pasted into this file and run-dream-cycle.ts, and had already
// drifted apart.
// ---------------------------------------------------------------------
const llmCall = createLlmCall(keyPool, { model: GEMINI_MODEL });

async function brainWrite(slug: string, content: string): Promise<boolean> {
  return brainWriteRaw(slug, content, { dryRun: DRY_RUN });
}

// ---------------------------------------------------------------------
// One-shot signal snapshot (reuses SignalAgent's real fetch logic via
// its public start()/stop() — start() awaits exactly one poll cycle
// before arming the interval, which we then cancel immediately).
// ---------------------------------------------------------------------
async function collectSignals(
  seenSignalIds: string[],
): Promise<{ signals: PredictionSignal[]; seenIds: string[] }> {
  const collected: PredictionSignal[] = [];
  const agent = new SignalAgent({
    sources: SOURCES,
    maxSignalsPerCycle: MAX_SIGNALS,
    seenSignalIds,
    onSignal: (signal) => {
      collected.push(signal);
    },
  });
  try {
    await agent.start(); // awaits exactly one poll() cycle
  } finally {
    agent.stop(); // cancel the interval before it fires again
  }
  return { signals: collected, seenIds: agent.seenIds() };
}

// Crowd-price extraction moved to src/prediction/crowd.ts so the Brain Agent
// and this report use one implementation (and one set of units). Markdown
// rendering moved to scripts/lib/report-format.ts so it can be imported and
// tested without running a pipeline cycle.

// ---------------------------------------------------------------------
// Report file output — saves bilingual .md to Report/YYYY-MM-DD_HHMM.md
// ---------------------------------------------------------------------
const REPORT_DIR = join(REPO_ROOT, "Report");

async function translateToRussian(englishMd: string): Promise<string> {
  try {
    const raw = await llmCall(
      "Переведи этот отчёт с английского на русский, сохранив разметку Markdown " +
        "(заголовки, списки, жирный шрифт, frontmatter). Числа, проценты,slug'и и " +
        "ключи YAML оставь как есть. Части, уже написанные по-русски, не трогай.\n\n" +
        "ГЛАВНОЕ — пиши живым человеческим языком, как объясняют знакомому, а не " +
        "биржевому аналитику. Никакого жаргона: не используй слова «альфа», " +
        "«дивергенция», «п.п.» вместо «процентных пунктов», «арбитраж», «стакан», " +
        "«ордербук», «конвикция», «недооценённость». Вместо «наш ИИ оценивает» пиши «мы " +
        "считаем»; вместо «рыночная цена составляет» — «рынок считает». " +
        "Короткие фразы. Если фразу нельзя понять без финансового словаря — " +
        "перепиши её проще.",
      englishMd,
      {
        // Translation is mechanical — there is nothing to deliberate about, and
        // on gemini-2.5-flash the thinking budget is drawn from the same
        // allowance as the answer. Disabling it is what stops the model from
        // running out mid-document and returning just the frontmatter.
        thinkingBudget: 0,
        // Headroom for the whole report: Russian runs longer than English, and
        // one token is well under one character here (Cyrillic costs more
        // tokens per character than Latin), so scale generously off the input.
        maxOutputTokens: Math.min(32_000, Math.max(4_000, englishMd.length)),
      },
    );
    const translated = stripFences(raw);

    // A truncated translation is worse than none. Gemini 2.5-flash is a
    // thinking model: when reasoning eats the output budget it can return
    // finishReason=STOP having emitted only the YAML frontmatter — 109 chars
    // for a 3.3KB report. That stub is still truthy, so `ruTranslation ||
    // reportMd` happily published it and the Telegram channel got a message
    // consisting of `type: prediction-daily-report` and nothing else
    // (2026-09-10 10:43, and 2026-09-09 10:40 before it).
    //
    // Judge it by body length after the frontmatter, not total length: the
    // frontmatter is copied through verbatim and is the exact part that
    // survives a truncation.
    if (!isCompleteTranslation(translated, englishMd)) {
      console.error(
        `[report-file] translation came back truncated (${translated.length} chars for a ` +
          `${englishMd.length}-char report) — discarding, English original will be used`,
      );
      return "";
    }
    return translated;
  } catch (err) {
    console.error("[report-file] translation failed (non-fatal):", (err as Error).message.slice(0, 200));
    return "";
  }
}

/** Strip a leading `---`-delimited YAML frontmatter block, if present. */
function stripFrontmatter(md: string): string {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? md.slice(m[0].length) : md;
}

/**
 * Does this translation actually cover the report, or is it a truncated stub?
 *
 * Requires the body (frontmatter excluded) to reach a third of the original's
 * body. Russian renders longer than English, so a genuine translation clears
 * this by a wide margin; the observed failures produced a body of zero.
 */
export function isCompleteTranslation(translated: string, englishMd: string): boolean {
  const ruBody = stripFrontmatter(translated).trim();
  const enBody = stripFrontmatter(englishMd).trim();
  if (ruBody.length === 0) return false;
  if (enBody.length === 0) return true;
  return ruBody.length >= enBody.length / 3;
}

async function saveReportFile(reportMd: string, startedAt: Date, ruMd: string): Promise<void> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = startedAt.getFullYear();
  const mo = pad(startedAt.getMonth() + 1);
  const d = pad(startedAt.getDate());
  const h = pad(startedAt.getHours());
  const mi = pad(startedAt.getMinutes());
  const filename = `${y}-${mo}-${d}_${h}${mi}.md`;
  const filePath = join(REPORT_DIR, filename);

  const combined =
    reportMd +
    "\n\n---\n\n" +
    "# Русский перевод\n\n" +
    (ruMd || "_Перевод недоступен — квота Gemini исчерпана._");

  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(filePath, combined, "utf-8");
    console.log(`[report-file] saved → Report/${filename}`);
  } catch (err) {
    console.error("[report-file] write failed:", (err as Error).message.slice(0, 200));
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main(): Promise<void> {
  // Taken before anything is read. The state file is loaded here and rewritten
  // whole at the end, so an overlapping run would load a pre-write copy and
  // erase whatever this run adds — and both would draw on the same daily API
  // quota. Held for the whole cycle, including the dream cycle, which reads the
  // same file.
  acquireLockOrExit(PIPELINE_LOCK);

  const startedAt = new Date();
  console.log(`[run-prediction-cycle] starting — sources=${SOURCES.join(",")} max=${MAX_SIGNALS} threshold=${QUALITY_THRESHOLD} dry-run=${DRY_RUN}`);

  // Carried over from previous runs. Without it every run started from nothing:
  // the same markets were re-evaluated and paid for daily, and nothing ever
  // reached a resolved state for the calibration loop to learn from.
  const state = loadState();
  console.log(
    `[run-prediction-cycle] state: ${state.activeMarkets.length} active, ` +
      `${state.resolvedMarkets.length} resolved, ${state.seenSignalIds.length} seen signal id(s)`,
  );

  const { signals, seenIds } = await collectSignals(state.seenSignalIds);
  console.log(`[run-prediction-cycle] collected ${signals.length} new signal(s)`);

  const quoted = signals.filter((s) => extractCrowdQuote(s) !== undefined).length;
  console.log(`[run-prediction-cycle] ${quoted} signal(s) carry a crowd quote`);

  // The mapping the nightly dream cycle fitted from venue-confirmed outcomes.
  // Identity when there is not enough honest history yet, which is the common
  // case and the correct default — see calibration-fit.ts for why the guards
  // are biased that hard toward declining to adjust.
  const calibrationFit = loadCalibrationFit();
  console.log(
    `[run-prediction-cycle] calibration: ${calibrationFit.method}` +
      (calibrationFit.method === "identity"
        ? " (no adjustment)"
        : ` a=${calibrationFit.a.toFixed(3)} b=${calibrationFit.b.toFixed(3)} n=${calibrationFit.n}`),
  );

  const brainAgent = new BrainAgent({
    qualityThreshold: QUALITY_THRESHOLD,
    modelId: GEMINI_MODEL,
    brainQuery,
    // Exact-slug fetch for the calibration page. brainQuery is a top-5 semantic
    // search and could silently fail to return a page whose address we know.
    brainGet,
    brainWrite: async (slug, content) => {
      await brainWrite(slug, content);
    },
    llmCall,
    calibrationFit,
  });

  const newMarkets: PredictionMarket[] = [];
  let rejected = 0;
  let skipped = 0;
  for (const signal of signals) {
    try {
      let contestContext: ContestContext | undefined;
      const contestKey = extractContestKey(signal.content);
      if (contestKey) {
        const all = [...state.activeMarkets, ...newMarkets];
        const peers = all.filter(m => (m.metadata?.normalizationGroup ?? extractContestKey(m.title)) === contestKey);
        contestContext = {
          groupKey: contestKey,
          totalCandidates: peers.length + 1,
          peers: peers.map(p => {
            const q = p.metadata?.crowdQuote as { probability?: number } | undefined;
            const price = q?.probability ?? p.metadata?.crowdProbability as number | undefined;
            return { title: p.title, venuePrice: price };
          })
        };
      }
      const result = await brainAgent.evaluate(signal, { contestContext });
      if (result.accepted) {
        newMarkets.push(result.market);
      } else {
        rejected++;
      }
    } catch (err) {
      // Transient overload or network error on a single signal — skip it rather
      // than aborting the cycle. The report covers the signals that succeeded.
      skipped++;
      console.error(`[run-prediction-cycle] skipped signal ${signal.id} (${(err as Error).message.slice(0, 120)})`);
    }
  }
  console.log(`[run-prediction-cycle] ${newMarkets.length} accepted, ${rejected} rejected, ${skipped} skipped (API error)`);

  // --- Deduplication against existing state --------------------------------
  // The same venue contract can re-enter the pipeline on consecutive runs
  // (seen-ids cap out, or the venue relists it).  `market.id` is always fresh,
  // so without this check the state file grows a second row for the same
  // Polymarket/Kalshi market, and the report prints both.
  const existingVenueIds = new Set<string>();
  for (const m of state.activeMarkets) {
    const vid = m.metadata?.venueMarketId;
    if (typeof vid === "string" && vid) existingVenueIds.add(vid);
  }
  let dupeCount = 0;
  const dedupedNew: PredictionMarket[] = [];
  for (const m of newMarkets) {
    const vid = m.metadata?.venueMarketId;
    if (typeof vid === "string" && vid && existingVenueIds.has(vid)) {
      // Update the existing market's AI estimate rather than adding a dupe.
      const existing = state.activeMarkets.find(
        (e) => e.metadata?.venueMarketId === vid,
      );
      if (existing) {
        existing.aiEstimate = m.aiEstimate;
        existing.metadata.crowdQuote = m.metadata.crowdQuote;
        existing.metadata.crowdProbability = m.metadata.crowdProbability;
      }
      dupeCount++;
    } else {
      dedupedNew.push(m);
      if (typeof vid === "string" && vid) existingVenueIds.add(vid);
    }
  }
  if (dupeCount > 0) {
    console.log(`[run-prediction-cycle] deduplicated ${dupeCount} market(s) already in state`);
  }

  // --- Market lifecycle -------------------------------------------------
  // ExecutionAgent shipped as library code that no runner ever imported, so
  // no market was ever monitored, expired, or resolved — which is also why
  // Brier scoring and the meta-model had nothing to work with.
  const execution = new ExecutionAgent({
    // The venue's own settlement, read over HTTP. Without this the outcome had
    // to be guessed by an LLM against a brain that holds no news — 56% accurate
    // while claiming 90%+ confidence — or left to a human who was never going
    // to adjudicate 59 markets by hand.
    fetchVenueOutcome,
    brainQuery,
    brainWrite: async (slug, content) => {
      await brainWrite(slug, content);
    },
    llmCall,
    onMarketResolved: (market) => {
      state.resolvedMarkets.push(market);
    },
  });
  for (const market of [...state.activeMarkets, ...dedupedNew]) {
    execution.addMarket(market);
  }
  try {
    await execution.runMonitorCycle();
  } catch (err) {
    console.error(`[run-prediction-cycle] monitor cycle failed: ${(err as Error).message}`);
  }
  const stillActive = execution.getActiveMarkets();
  console.log(
    `[run-prediction-cycle] lifecycle: ${stillActive.length} active, ${state.resolvedMarkets.length} resolved to date`,
  );

  // Re-quote everything, not just this run's new markets. Crowd prices were read
  // once at ingest and never again, so a report headed "54 active markets"
  // carried two AI-vs-Crowd rows: the two created that run.
  const now = new Date();
  const liveMarkets = stillActive.filter((m) => isLive(m, now));
  try {
    const quotes = await refreshQuotes(liveMarkets);
    for (const market of liveMarkets) {
      const quote = quotes.get(market.id);
      // A venue that failed or dropped the market keeps its stored quote; the
      // renderer prints the age rather than a fresh-looking stale number.
      if (!quote) continue;
      market.metadata.crowdQuote = quote;
      market.metadata.crowdProbability = quote.probability;
    }
    console.log(
      `[run-prediction-cycle] re-quoted ${quotes.size}/${liveMarkets.length} live market(s)`,
    );
  } catch (err) {
    console.error(`[run-prediction-cycle] quote refresh failed: ${(err as Error).message}`);
  }

  // --- Refresh the oldest estimates --------------------------------------
  // Quotes refresh every cycle; estimates never did. The median stored estimate
  // was 26 hours old (one was 157), so the report compared a live price against
  // yesterday's view and published the difference as an opportunity — Bitcoin
  // ran up overnight, the quote went 47% -> 87%, our 06:42 estimate stayed at
  // 40%, and that 47-point "edge" was really just staleness. findAlphaCandidates
  // now refuses estimates older than MAX_ESTIMATE_AGE_SECONDS, which hides the
  // false signal; re-estimating is what actually fixes it.
  //
  // Capped hard: each refresh is one LLM call, and the free-tier pool is small.
  // Oldest-first, only markets carrying a live quote — those are the only ones
  // that can produce a tradeable comparison anyway.
  const staleMarkets = liveMarkets
    .filter((m) => {
      const q = m.metadata?.crowdQuote as { basis?: string } | undefined;
      if (q?.basis !== "orderbook_mid") return false;
      const at = m.aiEstimate?.updatedAt;
      if (!(at instanceof Date) || Number.isNaN(at.getTime())) return false;
      // Same per-category window the alpha screen applies, so a market can never
      // be too stale to publish yet not stale enough to refresh.
      return now.getTime() - at.getTime() > maxEstimateAgeFor(m.category) * 1000;
    })
    // Widest gap first, not oldest first. Age alone spent the whole budget on
    // week-old estimates that already agreed with the price (1.5% vs 1.3%),
    // where the model correctly answered "nothing to change" and the call was
    // wasted. The markets worth a call are the ones whose stored view has
    // drifted furthest from the live price — those are exactly the rows that
    // would otherwise be published as a false opportunity.
    .sort((a, b) => {
      const gap = (m: PredictionMarket): number => {
        const q = m.metadata?.crowdQuote as { probability?: number } | undefined;
        return typeof q?.probability === "number"
          ? Math.abs(m.aiEstimate.yesProbability - q.probability)
          : 0;
      };
      return gap(b) - gap(a);
    })
    .slice(0, MAX_REFRESH_PER_CYCLE);

  if (staleMarkets.length > 0) {
    console.log(
      `[run-prediction-cycle] re-estimating ${staleMarkets.length} stale market(s) (widest gap first)`,
    );
    for (const market of staleMarkets) {
      try {
        const before = market.aiEstimate.yesProbability;
        const updated = await execution.refreshMarketEstimate(market, liveMarkets);
        if (updated) {
          console.log(
            `    ${(before * 100).toFixed(1)}% -> ${(updated.yesProbability * 100).toFixed(1)}%  ${market.title.slice(0, 48)}`,
          );
        }
      } catch (err) {
        console.error(
          `[run-prediction-cycle] re-estimate failed for ${market.id}: ${(err as Error).message.slice(0, 120)}`,
        );
      }
    }
  }

  // Normalize AI probabilities for related/multi-outcome markets to sum to 100%.
  const normResult = normalizeRelatedMarkets(liveMarkets);
  if (normResult.groupCount > 0) {
    console.log(
      `[run-prediction-cycle] normalized ${normResult.adjustedCount} market(s) across ${normResult.groupCount} group(s) to sum to 100%`,
    );
  }

  // Then restore monotonicity across cumulative horizons, so a repaired estimate
  // is what gets persisted, linked, and screened for alpha.
  const monoResult = enforceMonotonicity(liveMarkets, { now });
  if (monoResult.seriesCount > 0) {
    console.log(
      `[run-prediction-cycle] monotonicity: repaired ${monoResult.adjustments.length} estimate(s) across ${monoResult.seriesCount} series`,
    );
    for (const a of monoResult.adjustments) {
      console.log(
        `    ${(a.before * 100).toFixed(1)}% -> ${(a.after * 100).toFixed(1)}% ` +
          `by ${a.deadline.toISOString().slice(0, 10)}  ${a.title.slice(0, 54)}`,
      );
    }
  }

  // Threshold ladders are monotonic in magnitude rather than in time, and are
  // excluded from the sum-to-one pass above because their outcomes nest instead
  // of excluding each other. This is the ordering check that does bind them.
  const thresholdResult = enforceThresholdMonotonicity(liveMarkets, { now });
  if (thresholdResult.seriesCount > 0) {
    console.log(
      `[run-prediction-cycle] threshold monotonicity: repaired ${thresholdResult.adjustments.length} estimate(s) across ${thresholdResult.seriesCount} ladder(s)`,
    );
    for (const a of thresholdResult.adjustments) {
      console.log(
        `    ${(a.before * 100).toFixed(1)}% -> ${(a.after * 100).toFixed(1)}%  ${a.title.slice(0, 60)}`,
      );
    }
  }

  // Same cumulative question at two horizons, priced inconsistently. Computed
  // AFTER both repairs so the detector sees what the report will actually print;
  // running it first flagged inconsistencies that were about to be fixed.
  // Recorded on the markets so the pairing survives into the next run's state.
  const desyncLinks = relatedMarketIds(findStructuralDesyncs(liveMarkets, { now }));
  for (const market of liveMarkets) {
    const linked = desyncLinks.get(market.id);
    if (linked) market.relatedMarkets = [...linked];
  }

  // Cancel what no venue can ever settle, before anything is reported or
  // saved. Feed posts with no price were accumulating without bound: 172 of
  // 302 active markets came from telegram, none of them tradeable, and the
  // two cleanup scripts that addressed this were manual and only looked at
  // `pending_resolution` — which 79 of those rows were not. Running it here
  // means the state file converges instead of growing every cycle.
  const sweep = sweepUnsettleable(stillActive, { now });
  if (sweep.cancelled.length > 0) {
    console.log(
      `[run-prediction-cycle] cancelled ${sweep.cancelled.length} unsettleable market(s)`,
    );
  }
  if (sweep.flaggedForReview.length > 0) {
    console.log(
      `[run-prediction-cycle] ${sweep.flaggedForReview.length} expired question(s) need a human answer — kept`,
    );
  }
  const reportable = stillActive.filter((m) => m.status !== "cancelled");
  const liveReportable = liveMarkets.filter((m) => m.status !== "cancelled");

  const analyst = new AnalystAgent({ brainQuery, llmCall });
  // Pass resolved markets too — the report's Brier score is computed from them.
  const report = await analyst.generateDailyReport([...reportable, ...state.resolvedMarkets]);
  // Render from `liveMarkets`, not `stillActive`. The repairs above all ran on
  // the live set, but the renderer was handed the raw one — 302 rows including
  // 101 already past their deadline. `formatReportMarkdown` re-filters by
  // isLive internally, so this was not visibly broken, but passing the
  // unfiltered list meant the report and the repairs disagreed about what the
  // day's markets were. `generateDailyReport` above still gets the full set:
  // it needs the pending backlog for expiredPending and the resolved markets
  // for the Brier score.
  const reportMd = formatReportMarkdown(report, liveReportable, now);

  console.log("\n" + reportMd + "\n");

  // Durable outputs first. Telegram used to run before the brain write and was
  // not wrapped, so a single 400/429 from the Bot API aborted main() and the
  // report was lost even though it had already been generated and translated.
  const slug = reportSlug(startedAt);
  const written = await brainWrite(slug, reportMd);
  if (DRY_RUN) {
    console.log(`[run-prediction-cycle] dry run — brain page not written: ${slug}`);
  } else {
    console.log(
      written
        ? `[run-prediction-cycle] report written to brain page: ${slug}`
        : `[run-prediction-cycle] report NOT written to brain (see errors above): ${slug}`,
    );
  }

  const ruTranslation = await translateToRussian(reportMd);
  await saveReportFile(reportMd, startedAt, ruTranslation);

  if (!DRY_RUN) {
    saveState({
      activeMarkets: stillActive,
      resolvedMarkets: state.resolvedMarkets,
      seenSignalIds: seenIds,
    });
  }

  // Last, and never fatal. A dry run must not publish to a real channel —
  // --dry-run gated the brain write but still broadcast to Telegram.
  if (DRY_RUN) {
    console.log("[telegram] dry run — not sending");
  } else {
    try {
      const sent = await sendTelegram(ruTranslation || reportMd, { envPath: join(REPO_ROOT, ".env") });
      if (sent) console.log("[telegram] report sent");
    } catch (err) {
      console.error(`[telegram] send failed (report already persisted): ${(err as Error).message.slice(0, 200)}`);
    }
  }

  const elapsedSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
  console.log(`[run-prediction-cycle] gemini usage: ${formatUsage(llmCall.usage())}`);
  console.log(`[run-prediction-cycle] done in ${elapsedSec}s`);
}

/** Slug for the report page. Built entirely from local time — mixing
 *  toISOString() (UTC) with getHours() (local) filed a 00:54 run under the
 *  previous day. */
function reportSlug(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `predictions/reports/${date}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

main().catch((err) => {
  console.error("[run-prediction-cycle] FATAL:", err);
  process.exit(1);
});
