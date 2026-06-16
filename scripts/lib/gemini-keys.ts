/**
 * scripts/lib/gemini-keys.ts — multi-account Gemini key rotation.
 *
 * Reads GEMINI_API_KEY_1..N from .env (numbered, ordered pool) and persists
 * "which key is currently active" in .gemini-key-state.json next to .env
 * (gitignored). State survives across separate process invocations — the
 * AM/PM scheduled runs and the prediction-cycle script all share it, so a
 * key marked exhausted at 16:15 stays skipped at the next run instead of
 * re-discovering the same 429 from scratch.
 *
 * Reset heuristic: Google's free-tier RPD quota resets at midnight Pacific
 * time (~10:00 Moscow in summer DST, ~11:00 in winter). Rather than hard-
 * coding that offset, we just reset the pool to index 0 once the persisted
 * state is older than RESET_AFTER_HOURS — simple, timezone-agnostic, and
 * self-healing if the offset assumption drifts.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENV_PATH = join(REPO_ROOT, ".env");
const STATE_PATH = join(REPO_ROOT, ".gemini-key-state.json");
const RESET_AFTER_HOURS = 20; // conservative: shorter than 24h so a missed reset window self-corrects within a day

export interface KeyPoolState {
  activeIndex: number;
  rotatedAt: string; // ISO timestamp
  exhausted: Record<number, string>; // index -> ISO timestamp marked exhausted (informational/log only)
}

function loadPool(): string[] {
  const lines = readFileSync(ENV_PATH, "utf-8").split(/\r?\n/);
  const byIndex = new Map<number, string>();
  for (const line of lines) {
    const m = line.match(/^\s*GEMINI_API_KEY_(\d+)\s*=\s*(.+?)\s*$/);
    if (m) {
      byIndex.set(Number(m[1]), m[2].trim().replace(/^["']|["']$/g, ""));
    }
  }
  const sortedIndices = [...byIndex.keys()].sort((a, b) => a - b);
  return sortedIndices.map((i) => byIndex.get(i)!);
}

function loadState(poolLength: number): KeyPoolState {
  if (existsSync(STATE_PATH)) {
    try {
      const state = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as KeyPoolState;
      const ageHours = (Date.now() - new Date(state.rotatedAt).getTime()) / 3_600_000;
      if (ageHours < RESET_AFTER_HOURS && state.activeIndex < poolLength) {
        return state;
      }
      // Stale (likely past the daily quota reset) or pool shrank — start fresh.
    } catch {
      // corrupt state file — fall through to fresh state
    }
  }
  return { activeIndex: 0, rotatedAt: new Date().toISOString(), exhausted: {} };
}

function saveState(state: KeyPoolState): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Sync the plain GOOGLE_GENERATIVE_AI_API_KEY line so non-rotation-aware
 *  tools (`inbrain` CLI subprocess calls, `inbrain dream`) pick up whichever
 *  key is currently active. */
function syncActiveKeyIntoEnvFile(key: string): void {
  const content = readFileSync(ENV_PATH, "utf-8");
  const updated = content.replace(
    /^(\s*GOOGLE_GENERATIVE_AI_API_KEY\s*=).*$/m,
    `$1${key}`,
  );
  if (updated !== content) writeFileSync(ENV_PATH, updated);
}

export interface KeyPool {
  /** Current best-guess working key. Also sets process.env + .env's
   *  GOOGLE_GENERATIVE_AI_API_KEY so subprocess calls (`inbrain put`,
   *  `inbrain query`, `inbrain dream`) inherit the same key. */
  current(): string;
  /** Advance to the next key in the pool (persists immediately). Returns
   *  the new key, or null if every key in the pool has been tried. */
  rotate(reason: string): string | null;
  size(): number;
  activeIndex(): number;
}

export function loadKeyPool(): KeyPool {
  const pool = loadPool();
  if (pool.length === 0) {
    throw new Error("No GEMINI_API_KEY_N entries found in .env — nothing to rotate.");
  }
  let state = loadState(pool.length);

  function apply(): string {
    const key = pool[state.activeIndex];
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = key;
    syncActiveKeyIntoEnvFile(key);
    return key;
  }

  apply(); // make the persisted/initial key active immediately on load

  return {
    current: () => pool[state.activeIndex],
    activeIndex: () => state.activeIndex,
    size: () => pool.length,
    rotate(reason: string) {
      state.exhausted[state.activeIndex] = new Date().toISOString();
      console.error(
        `[gemini-keys] key #${state.activeIndex + 1}/${pool.length} exhausted (${reason}), rotating...`,
      );
      if (state.activeIndex + 1 >= pool.length) {
        saveState(state);
        return null;
      }
      state.activeIndex += 1;
      state.rotatedAt = new Date().toISOString();
      saveState(state);
      const key = apply();
      console.error(`[gemini-keys] now using key #${state.activeIndex + 1}/${pool.length}`);
      return key;
    },
  };
}

/** True if a Gemini error message/body indicates "this key is done for now"
 *  (daily quota, free-tier RPD, or prepay credits depleted) as opposed to a
 *  transient server hiccup that's worth retrying on the SAME key. */
export function isKeyExhaustedError(statusCode: number, bodyText: string): boolean {
  if (statusCode !== 429) return false;
  return /RESOURCE_EXHAUSTED|quota|prepayment credits are depleted/i.test(bodyText);
}
