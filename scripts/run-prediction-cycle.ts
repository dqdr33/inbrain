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

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { SignalAgent } from "../src/prediction/signal-agent.ts";
import { BrainAgent } from "../src/prediction/brain-agent.ts";
import { AnalystAgent } from "../src/prediction/analyst-agent.ts";
import type { PredictionSignal, PredictionMarket, SignalSource } from "../src/prediction/types.ts";
import { loadKeyPool, isKeyExhaustedError } from "./lib/gemini-keys.ts";

const REPO_ROOT = join(import.meta.dir, "..");
// gemini-2.0-flash / -lite return free-tier limit=0 on this project; 2.5-flash
// has a working free-tier chat quota (verified empirically — see PR discussion).
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ---------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------
function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const DRY_RUN = process.argv.includes("--dry-run");
// Free-tier Gemini quota is GenerateRequestsPerDayPerProjectPerModel = 20/day
// for gemini-2.5-flash (verified empirically). Each evaluated signal costs
// 2 calls (quality + estimate); the daily report costs 1 more. Default of 4
// signals/cycle = 9 calls/cycle, leaving headroom for 2 cycles/day (18/20)
// plus a little slack. Raise this once billing is enabled on the project.
const MAX_SIGNALS = Number(flag("max-signals", "4"));
const QUALITY_THRESHOLD = Number(flag("quality-threshold", "55"));
const SOURCES = (flag("sources", "polymarket,kalshi") ?? "polymarket,kalshi")
  .split(",")
  .map((s) => s.trim()) as SignalSource[];

// ---------------------------------------------------------------------
// Multi-account key pool (scripts/lib/gemini-keys.ts). Rotates to the next
// GEMINI_API_KEY_N in .env when the active one hits a quota/billing error,
// and persists the active index so later runs (and the separate `inbrain
// dream` step in run-analytics-cycle.ps1) pick up where this left off.
// ---------------------------------------------------------------------
const keyPool = loadKeyPool();
console.log(`[run-prediction-cycle] key pool: ${keyPool.size()} key(s), starting at #${keyPool.activeIndex() + 1}`);

// ---------------------------------------------------------------------
// Gemini-backed llmCall with 429/503 backoff + cross-key rotation + fence
// stripping
// ---------------------------------------------------------------------
function stripFences(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return m ? m[1] : text;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastCallAt = 0;
const MIN_GAP_MS = 15_000; // poor-man's rate limiter — gemini-2.5-flash free tier RPM is tight

async function llmCall(
  system: string,
  prompt: string,
  _opts?: { model?: string },
): Promise<string> {
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ parts: [{ text: prompt }] }],
  });

  // Outer loop: cross-key rotation. Inner loop: same-key retry for
  // transient (non-exhaustion) errors.
  for (;;) {
    const key = keyPool.current();

    for (let attempt = 1; attempt <= 3; attempt++) {
      const gap = Date.now() - lastCallAt;
      if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
      lastCallAt = Date.now();

      let res: Response;
      try {
        res = await fetch(GEMINI_URL, {
          method: "POST",
          headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
          body,
        });
      } catch (err) {
        if (attempt === 3) throw err;
        await sleep(5_000 * attempt);
        continue;
      }

      if (res.ok) {
        const json = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        return stripFences(text);
      }

      const bodyText = await res.text().catch(() => "");

      if (isKeyExhaustedError(res.status, bodyText)) {
        const nextKey = keyPool.rotate(`HTTP ${res.status}: ${bodyText.slice(0, 150)}`);
        if (nextKey === null) {
          throw new Error(
            `All ${keyPool.size()} Gemini key(s) exhausted. Last error: ${bodyText.slice(0, 300)}`,
          );
        }
        break; // restart outer loop with the new key
      }

      if (res.status === 503 || res.status === 504) {
        if (attempt === 3) {
          throw new Error(`Gemini HTTP ${res.status} (transient, exhausted retries): ${bodyText.slice(0, 300)}`);
        }
        const backoff = 8_000 * attempt;
        console.error(`[llmCall] ${res.status} (transient), retrying same key in ${backoff}ms (attempt ${attempt}/3)`);
        await sleep(backoff);
        continue;
      }

      throw new Error(`Gemini HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    }
  }
}

// ---------------------------------------------------------------------
// brainQuery / brainWrite — shell out to the real inbrain CLI so writes
// go through actual chunking/embedding/link-extraction, not a bypass.
// ---------------------------------------------------------------------
// Each `inbrain` invocation is a fresh process: PGLite cold-start + config
// load + (for put) an embedding round-trip, easily 30-60s on this machine.
// 30s timeouts caused real ETIMEDOUT failures in production (2026-06-16
// 16:15 run lost 2/4 market pages). 90s + one retry covers cold start with
// headroom while still failing fast if `inbrain` is genuinely stuck.
const CLI_TIMEOUT_MS = 90_000;

async function brainQuery(query: string): Promise<string> {
  try {
    return execFileSync(
      "inbrain",
      ["query", query, "--no-expand", "--limit", "5"],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: CLI_TIMEOUT_MS, env: process.env },
    );
  } catch (err) {
    return `Brain query failed (non-fatal): ${(err as Error).message.slice(0, 200)}`;
  }
}

async function brainWrite(slug: string, content: string): Promise<void> {
  if (DRY_RUN) {
    console.log(`[dry-run] would write page "${slug}" (${content.length} chars)`);
    return;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      execFileSync("inbrain", ["put", slug], {
        cwd: REPO_ROOT,
        input: content,
        encoding: "utf-8",
        timeout: CLI_TIMEOUT_MS,
        env: process.env,
      });
      return;
    } catch (err) {
      if (attempt === 2) {
        console.error(`[brainWrite] failed for "${slug}" after ${attempt} attempts: ${(err as Error).message.slice(0, 300)}`);
      } else {
        console.error(`[brainWrite] attempt ${attempt} failed for "${slug}", retrying: ${(err as Error).message.slice(0, 150)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// One-shot signal snapshot (reuses SignalAgent's real fetch logic via
// its public start()/stop() — start() awaits exactly one poll cycle
// before arming the interval, which we then cancel immediately).
// ---------------------------------------------------------------------
async function collectSignals(): Promise<PredictionSignal[]> {
  const collected: PredictionSignal[] = [];
  const agent = new SignalAgent({
    sources: SOURCES,
    maxSignalsPerCycle: MAX_SIGNALS,
    onSignal: (signal) => {
      collected.push(signal);
    },
  });
  await agent.start(); // awaits exactly one poll() cycle
  agent.stop(); // cancel the interval before it fires again
  return collected;
}

// ---------------------------------------------------------------------
// Markdown formatting for the brain page (mirrors AnalystAgent's private
// formatDailyReport shape since that method isn't exported).
// ---------------------------------------------------------------------
// The prompt doesn't pin down whether "probability" is 0-1 or 0-100, and
// Gemini has returned both shapes across runs. Treat anything > 1 as
// already-a-percentage instead of multiplying it into nonsense like "1800%".
function asPercent(value: number): number {
  return Math.round(value > 1 ? value : value * 100);
}

function formatReportMarkdown(report: Awaited<ReturnType<AnalystAgent["generateDailyReport"]>>): string {
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
      lines.push(`- ${t.topic} (${t.direction}, confidence ${Math.round(t.confidence * 100)}%): ${t.prediction}`);
    }
    lines.push("");
  }
  lines.push("## Performance Metrics");
  lines.push(`- Total active: ${report.performanceMetrics.totalActive}`);
  lines.push(`- Resolved today: ${report.performanceMetrics.resolvedToday}`);
  lines.push(`- Avg Brier score: ${report.performanceMetrics.avgBrierScore}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------
async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`[run-prediction-cycle] starting — sources=${SOURCES.join(",")} max=${MAX_SIGNALS} threshold=${QUALITY_THRESHOLD} dry-run=${DRY_RUN}`);

  const signals = await collectSignals();
  console.log(`[run-prediction-cycle] collected ${signals.length} signal(s)`);

  const brainAgent = new BrainAgent({
    qualityThreshold: QUALITY_THRESHOLD,
    modelId: GEMINI_MODEL,
    brainQuery,
    brainWrite: DRY_RUN ? async () => {} : brainWrite,
    llmCall,
  });

  const markets: PredictionMarket[] = [];
  let rejected = 0;
  for (const signal of signals) {
    const result = await brainAgent.evaluate(signal);
    if (result.accepted) {
      markets.push(result.market);
    } else {
      rejected++;
    }
  }
  console.log(`[run-prediction-cycle] ${markets.length} accepted, ${rejected} rejected`);

  const analyst = new AnalystAgent({ brainQuery, llmCall });
  const report = await analyst.generateDailyReport(markets);
  const reportMd = formatReportMarkdown(report);

  console.log("\n" + reportMd + "\n");

  const slug = `predictions/reports/${startedAt.toISOString().slice(0, 10)}-${String(startedAt.getHours()).padStart(2, "0")}${String(startedAt.getMinutes()).padStart(2, "0")}`;
  await brainWrite(slug, reportMd);
  console.log(`[run-prediction-cycle] report written to brain page: ${slug}`);

  const elapsedSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
  console.log(`[run-prediction-cycle] done in ${elapsedSec}s`);
}

main().catch((err) => {
  console.error("[run-prediction-cycle] FATAL:", err);
  process.exit(1);
});
