#!/usr/bin/env bun
/**
 * scripts/gemini-key.ts — tiny CLI wrapper over scripts/lib/gemini-keys.ts for
 * inspecting or rotating the shared key-pool state without duplicating the
 * rotation logic.
 *
 * Usage:
 *   bun run scripts/gemini-key.ts status          # pool size + active index, no secrets
 *   bun run scripts/gemini-key.ts current         # prints the active key (see warning)
 *   bun run scripts/gemini-key.ts rotate "reason" # advances to the next key
 *
 * `current` prints a live API key on stdout. Never pipe it into a log file.
 * run-analytics-cycle.ps1 no longer uses it at all — the runners rotate keys
 * internally and propagate the result through process.env.
 */
import { loadKeyPool } from "./lib/gemini-keys.ts";

const cmd = process.argv[2];

// Parse the command BEFORE touching the pool: loadKeyPool() applies the active
// key and rewrites .env as a side effect, so even an invalid command used to
// mutate the secrets file.
if (cmd !== "status" && cmd !== "current" && cmd !== "rotate") {
  console.error("Usage: bun run scripts/gemini-key.ts <status|current|rotate> [reason]");
  process.exit(2);
}

let pool;
try {
  pool = loadKeyPool();
} catch (err) {
  console.error(`[gemini-key] ${(err as Error).message}`);
  process.exit(1);
}

if (cmd === "status") {
  console.log(
    `pool: ${pool.size()} key(s) (${pool.freeCount()} free, ${pool.paidCount()} paid reserve), ` +
      `active ${pool.activeLabel()}`,
  );
  process.exit(0);
}

if (cmd === "current") {
  console.log(pool.current());
  process.exit(0);
}

const reason = process.argv[3] ?? "manual rotate";
const next = pool.rotate(reason);
if (next === null) {
  // Exit non-zero: printing "EXHAUSTED" on stdout with status 0 meant a caller
  // doing `KEY=$(gemini-key.ts rotate)` set its API key to the literal string.
  console.error("[gemini-key] all keys exhausted for the current quota day");
  process.exit(1);
}
console.log(next);
