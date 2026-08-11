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
import { BrainAgent } from "../src/prediction/brain-agent.ts";
import { AnalystAgent } from "../src/prediction/analyst-agent.ts";
import { ExecutionAgent } from "../src/prediction/execution-agent.ts";
import { extractCrowdProbability } from "../src/prediction/crowd.ts";
import { formatProbability } from "../src/prediction/format.ts";
import type { PredictionSignal, PredictionMarket, SignalSource } from "../src/prediction/types.ts";
import { loadKeyPool, FREE_TIER_DAILY_REQUESTS } from "./lib/gemini-keys.ts";
import { createLlmCall, formatUsage, DEFAULT_GEMINI_MODEL } from "./lib/llm.ts";
import { brainQuery, brainWrite as brainWriteRaw } from "./lib/brain-cli.ts";
import { sendTelegram } from "./lib/telegram.ts";
import { loadState, saveState } from "./lib/market-store.ts";
import { acquireLockOrExit, PIPELINE_LOCK } from "./lib/run-lock.ts";

const REPO_ROOT = join(import.meta.dir, "..");
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
const SOURCES = (flag("sources", "polymarket,kalshi") ?? "polymarket,kalshi")
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
// and this report use one implementation (and one set of units).

// Divergence worth calling out, in percentage points.
//
// This was 3pp, which flagged literally every row in every shipped report —
// including rows whose "crowd" number came from the outcome-index bug. An LLM
// probability carries several points of noise on its own, so a threshold below
// that noise floor is not a signal, it is decoration. 20pp is roughly the point
// where a disagreement is larger than the model's own run-to-run spread.
const ALPHA_DIVERGENCE_THRESHOLD_PP = 20;

interface MarketWithCrowd {
  market: PredictionMarket;
  crowdProb?: number;
}

function formatCrowdComparison(items: MarketWithCrowd[]): string[] {
  const withCrowd = items.filter((i) => i.crowdProb !== undefined);
  if (withCrowd.length === 0) return [];

  const lines = ["## AI vs Crowd", ""];
  // Sort by absolute divergence, biggest first — the interesting rows lead.
  const rows = withCrowd
    .map(({ market, crowdProb }) => {
      const aiPct = market.aiEstimate.yesProbability * 100;
      const crowdPct = crowdProb! * 100;
      const diffPp = aiPct - crowdPct;
      return { market, aiPct, crowdPct, diffPp };
    })
    .sort((a, b) => Math.abs(b.diffPp) - Math.abs(a.diffPp));

  for (const r of rows) {
    const sign = r.diffPp >= 0 ? "+" : "";
    const flag = Math.abs(r.diffPp) >= ALPHA_DIVERGENCE_THRESHOLD_PP ? " ⚠ notable divergence" : "";
    lines.push(
      `- ${r.market.title} — AI ${r.aiPct.toFixed(1)}% vs Crowd ${r.crowdPct.toFixed(1)}% (${sign}${r.diffPp.toFixed(1)}pp)${flag}`,
    );
  }
  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------
// Markdown formatting for the brain page (mirrors AnalystAgent's private
// formatDailyReport shape since that method isn't exported).
// ---------------------------------------------------------------------
// analyst-agent prompt now pins probability to 0-1 scale. As a safety net for
// any residual integer-percentage response from the LLM (e.g. 18 for 18%),
// treat values >= 2 as already-percentages. Value 1 is unambiguously 1.0 = 100%
// in the 0-1 scale — Gemini no longer returns bare "1" to mean "1%".
// Rendering goes through formatProbability so a long-shot market keeps its
// real number: Math.round printed 0.001 as "0%", and a market the report calls
// impossible is precisely the one an alpha section exists to surface.
function asPercent(value: number): string {
  return formatProbability(value >= 2 ? value / 100 : value);
}

function formatReportMarkdown(
  report: Awaited<ReturnType<AnalystAgent["generateDailyReport"]>>,
  marketsWithCrowd: MarketWithCrowd[],
): string {
  const dateStr = report.date.toISOString().slice(0, 10);
  const lines = [
    "---",
    "type: prediction-daily-report",
    `date: ${dateStr}`,
    `active_markets: ${report.activeMarkets}`,
    `resolved_today: ${report.resolvedMarkets}`,
    "---",
    "",
    `# Inbrain Daily Intelligence — ${dateStr}`,
    "",
    report.summary,
    "",
    `**Active Markets:** ${report.activeMarkets}  |  **Resolved Today:** ${report.resolvedMarkets}`,
    "",
  ];
  if (report.topMarkets.length) {
    lines.push("## Top Markets");
    for (const m of report.topMarkets.slice(0, 5)) {
      lines.push(`- ${m.title} — ${asPercent(m.probability)}% YES (${m.trend})`);
    }
    lines.push("");
  }
  lines.push(...formatCrowdComparison(marketsWithCrowd));
  if (report.alphaOpportunities.length) {
    lines.push("## Alpha Opportunities");
    for (const a of report.alphaOpportunities.slice(0, 5)) {
      lines.push(`- [${a.urgency.toUpperCase()}] ${a.title} — ${a.reasoning}`);
    }
    lines.push("");
  }
  if (report.trends.length) {
    lines.push("## Trends");
    for (const t of report.trends.slice(0, 5)) {
      lines.push(`- ${t.topic} (${t.direction}, confidence ${formatProbability(t.confidence)}%): ${t.prediction}`);
    }
    lines.push("");
  }
  lines.push("## Performance Metrics");
  lines.push(`- Total active: ${report.performanceMetrics.totalActive}`);
  lines.push(`- Resolved today: ${report.performanceMetrics.resolvedToday}`);
  // Say "no data" in words. Printing the literal `null` (or, before that, a
  // hallucinated 0) reads as "our calibration is perfect / catastrophic".
  const brier = report.performanceMetrics.avgBrierScore;
  lines.push(
    `- Avg Brier score: ${brier === null ? "n/a — no resolved markets yet" : brier.toFixed(4)}`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Report file output — saves bilingual .md to Report/YYYY-MM-DD_HHMM.md
// ---------------------------------------------------------------------
const REPORT_DIR = join(REPO_ROOT, "Report");

async function translateToRussian(englishMd: string): Promise<string> {
  try {
    return await llmCall(
      "You are a professional translator. Translate the following Markdown report from English to Russian. " +
        "Preserve all Markdown formatting (headers, lists, bold, frontmatter). " +
        "Translate all text content but keep slugs, numbers, percentages, and YAML keys as-is.",
      englishMd,
    );
  } catch (err) {
    console.error("[report-file] translation failed (non-fatal):", (err as Error).message.slice(0, 200));
    return "";
  }
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

  const crowdBySignalId = new Map<string, number>();
  for (const signal of signals) {
    const crowd = extractCrowdProbability(signal);
    if (crowd !== undefined) crowdBySignalId.set(signal.id, crowd);
  }

  const brainAgent = new BrainAgent({
    qualityThreshold: QUALITY_THRESHOLD,
    modelId: GEMINI_MODEL,
    brainQuery,
    brainWrite: async (slug, content) => {
      await brainWrite(slug, content);
    },
    llmCall,
  });

  const newMarkets: PredictionMarket[] = [];
  let rejected = 0;
  let skipped = 0;
  for (const signal of signals) {
    try {
      const result = await brainAgent.evaluate(signal);
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

  // --- Market lifecycle -------------------------------------------------
  // ExecutionAgent shipped as library code that no runner ever imported, so
  // no market was ever monitored, expired, or resolved — which is also why
  // Brier scoring and the meta-model had nothing to work with.
  const execution = new ExecutionAgent({
    brainQuery,
    brainWrite: async (slug, content) => {
      await brainWrite(slug, content);
    },
    llmCall,
    onMarketResolved: (market) => {
      state.resolvedMarkets.push(market);
    },
  });
  for (const market of [...state.activeMarkets, ...newMarkets]) {
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

  const marketsWithCrowd: MarketWithCrowd[] = newMarkets.map((market) => ({
    market,
    crowdProb: crowdBySignalId.get(market.sourceSignals[0] ?? ""),
  }));

  const analyst = new AnalystAgent({ brainQuery, llmCall });
  // Pass resolved markets too — the report's Brier score is computed from them.
  const report = await analyst.generateDailyReport([...stillActive, ...state.resolvedMarkets]);
  const reportMd = formatReportMarkdown(report, marketsWithCrowd);

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
