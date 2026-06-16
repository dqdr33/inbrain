#!/usr/bin/env bun
/**
 * scripts/gemini-key.ts — tiny CLI wrapper over scripts/lib/gemini-keys.ts
 * for non-TS callers (run-analytics-cycle.ps1) that need to read or rotate
 * the shared key-pool state without duplicating the rotation logic.
 *
 * Usage:
 *   bun run scripts/gemini-key.ts current        # prints the active key
 *   bun run scripts/gemini-key.ts rotate "reason" # advances to next key, prints it (or "EXHAUSTED")
 */
import { loadKeyPool } from "./lib/gemini-keys.ts";

const cmd = process.argv[2];
const pool = loadKeyPool();

if (cmd === "current") {
  console.log(pool.current());
} else if (cmd === "rotate") {
  const reason = process.argv[3] ?? "manual rotate";
  const next = pool.rotate(reason);
  console.log(next ?? "EXHAUSTED");
} else {
  console.error("Usage: bun run scripts/gemini-key.ts <current|rotate> [reason]");
  process.exit(1);
}
