/**
 * scripts/lib/gemini-keys.ts — multi-account Gemini key rotation.
 *
 * Reads GEMINI_API_KEY_1..N from .env (numbered) and persists which keys are
 * spent in .gemini-key-state.json next to .env (gitignored). State survives
 * across separate process invocations — the AM/PM scheduled runs and the
 * prediction-cycle script all share it, so a key marked exhausted at 16:15
 * stays skipped at the next run instead of re-discovering the same 429.
 *
 * FREE vs PAID
 * ------------
 * GEMINI_PAID_KEYS lists the 1-based indexes of billing-enabled keys, e.g.
 *
 *     GEMINI_PAID_KEYS=3
 *
 * A paid key is capped by MONEY, not by a daily request count, so it must not
 * be spent while free quota is still sitting unused. Paid keys are therefore
 * ordered LAST: the pool drains every free key first and only reaches for the
 * paid one to finish a cycle that would otherwise die halfway. Leaving the
 * setting empty reproduces the previous all-free behaviour exactly.
 *
 * ORDER-INDEPENDENT STATE
 * -----------------------
 * State is keyed by a short non-secret fingerprint of each key, never by its
 * position. Position was load-bearing before, so reordering the pool (which is
 * exactly what paid-last does) would have silently re-pointed "key #1 is
 * exhausted" at a different, healthy key. Old positional state files are
 * migrated on first read.
 *
 * The active key is DERIVED, not stored: it is always the first non-exhausted
 * key in pool order. That makes "paid last" structural rather than something
 * a stale index could defeat.
 *
 * Reset heuristic: Google's free-tier RPD quota resets at midnight Pacific
 * time, so all exhaustion marks clear once a Pacific-midnight boundary has
 * passed. A paid key whose credits are genuinely gone simply 429s again on
 * first use and rotates back out — one cheap probe a day, versus wedging the
 * pool if the mark were sticky.
 *
 * Both files written here (.env and the state file) go through writeFileAtomic
 * — .env in particular holds every credential in the project and has no backup.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENV_PATH = join(REPO_ROOT, ".env");
const STATE_PATH = join(REPO_ROOT, ".gemini-key-state.json");
// Google free-tier quota resets at midnight Pacific (PDT = UTC-7 in summer, PST = UTC-8 in winter).
// We use UTC-7 as a fixed offset — in PST this means we treat the reset as 1h earlier than reality,
// which is fine (we reset early rather than miss the window). A calendar-day boundary crossing in
// Pacific time means a new quota day has started.
const PACIFIC_OFFSET_HOURS = 7; // PDT (UTC-7); handles both DST seasons conservatively

/** Free-tier GenerateRequestsPerDayPerProjectPerModel for gemini-2.5-flash. */
export const FREE_TIER_DAILY_REQUESTS = 20;

export interface PoolKey {
  /** The credential itself. Never logged. */
  secret: string;
  /** 1-based N from GEMINI_API_KEY_N, for human-readable logs. */
  envIndex: number;
  /** Billing enabled: bounded by spend, not by a daily request count. */
  paid: boolean;
  /** Short non-secret fingerprint; the persistence key. */
  id: string;
}

export interface KeyPoolState {
  /** Informational only — the active key is derived from `exhausted`. */
  activeKeyId: string;
  rotatedAt: string; // ISO timestamp
  exhausted: Record<string, string>; // key fingerprint -> ISO timestamp
}

/** Non-secret, stable identity for a key. Truncated: this lands in a file, and
 *  a full digest of a live credential is more than the job needs. */
function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

/** 1-based indexes listed in GEMINI_PAID_KEYS. Unparseable entries are ignored
 *  rather than fatal: a typo here must not take the whole pipeline down. */
function loadPaidIndexes(envLines: string[]): Set<number> {
  const line = envLines.find((l) => /^\s*GEMINI_PAID_KEYS\s*=/.test(l));
  if (!line) return new Set();
  const raw = line.replace(/^\s*GEMINI_PAID_KEYS\s*=\s*/, "").trim().replace(/^["']|["']$/g, "");
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return out;
}

/**
 * Pool in TRY order: every free key first (by env index), then every paid key.
 */
function loadPool(): PoolKey[] {
  const lines = readFileSync(ENV_PATH, "utf-8").split(/\r?\n/);
  const paidIndexes = loadPaidIndexes(lines);

  const byIndex = new Map<number, string>();
  for (const line of lines) {
    const m = line.match(/^\s*GEMINI_API_KEY_(\d+)\s*=\s*(.+?)\s*$/);
    if (m) byIndex.set(Number(m[1]), m[2].trim().replace(/^["']|["']$/g, ""));
  }

  const keys: PoolKey[] = [...byIndex.keys()]
    .sort((a, b) => a - b)
    .map((envIndex) => {
      const secret = byIndex.get(envIndex)!;
      return { secret, envIndex, paid: paidIndexes.has(envIndex), id: fingerprint(secret) };
    });

  // Stable partition: free block keeps env order, paid block keeps env order.
  return [...keys.filter((k) => !k.paid), ...keys.filter((k) => k.paid)];
}

/** Returns true if a Pacific-midnight boundary has passed between `since` and `now`.
 *  A Pacific midnight crossing means Google has issued a new free-tier quota day. */
function pacificMidnightPassed(since: Date, now: Date): boolean {
  const offsetMs = PACIFIC_OFFSET_HOURS * 3_600_000;
  const sinceDay = Math.floor((since.getTime() - offsetMs) / 86_400_000);
  const nowDay   = Math.floor((now.getTime()   - offsetMs) / 86_400_000);
  return nowDay > sinceDay;
}

/**
 * Rewrites a pre-fingerprint state file. Old `exhausted` keys were positions in
 * the ENV-ordered pool, so they are translated through env index — doing this
 * by current pool position would mislabel keys the moment paid-last reorders.
 */
function migratePositionalState(parsed: Record<string, unknown>, pool: PoolKey[]): KeyPoolState | null {
  const oldExhausted = parsed.exhausted;
  const hasPositionalMarks =
    oldExhausted && typeof oldExhausted === "object" && !Array.isArray(oldExhausted);
  if (!hasPositionalMarks && !Number.isInteger(parsed.activeIndex)) return null;

  const byEnvIndex = new Map(pool.map((k) => [k.envIndex, k]));
  const exhausted: Record<string, string> = {};
  for (const [rawPos, ts] of Object.entries(oldExhausted as Record<string, string>)) {
    const pos = Number(rawPos);
    if (!Number.isInteger(pos)) continue;
    const key = byEnvIndex.get(pos + 1); // positions were 0-based over env order
    if (key) exhausted[key.id] = typeof ts === "string" ? ts : new Date(0).toISOString();
  }
  console.error(
    `[gemini-keys] migrated ${Object.keys(exhausted).length} positional state mark(s) to key fingerprints`,
  );
  return {
    activeKeyId: "",
    rotatedAt: typeof parsed.rotatedAt === "string" ? parsed.rotatedAt : new Date(0).toISOString(),
    exhausted,
  };
}

function loadState(pool: PoolKey[]): KeyPoolState {
  const fresh = (): KeyPoolState => ({
    activeKeyId: "",
    rotatedAt: new Date().toISOString(),
    exhausted: {},
  });

  if (!existsSync(STATE_PATH)) return fresh();

  let parsed: Record<string, unknown>;
  try {
    // Strip a UTF-8 BOM before parsing. JSON.parse throws on a leading ﻿,
    // and any hand-edit through a BOM-writing editor (Notepad, PowerShell's
    // Set-Content -Encoding utf8) would otherwise look like a corrupt file and
    // silently reset the pool — resurrecting keys that are actually spent.
    const raw = readFileSync(STATE_PATH, "utf-8").replace(/^﻿/, "");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fresh(); // corrupt state file
  }

  const isFingerprintFormat = typeof parsed.activeKeyId === "string";
  const state = isFingerprintFormat
    ? {
        activeKeyId: parsed.activeKeyId as string,
        rotatedAt: typeof parsed.rotatedAt === "string" ? parsed.rotatedAt : new Date(0).toISOString(),
        exhausted:
          parsed.exhausted && typeof parsed.exhausted === "object"
            ? (parsed.exhausted as Record<string, string>)
            : {},
      }
    : migratePositionalState(parsed, pool);

  if (!state) return fresh();

  // A new Pacific quota day clears every mark; see the header note on why paid
  // keys are re-probed rather than kept sticky.
  if (pacificMidnightPassed(new Date(state.rotatedAt), new Date())) return fresh();

  // Drop marks for keys that are no longer in .env at all.
  const live = new Set(pool.map((k) => k.id));
  for (const id of Object.keys(state.exhausted)) {
    if (!live.has(id)) delete state.exhausted[id];
  }
  return state;
}

/** Write via a sibling temp file + rename. On every filesystem we target, rename
 *  over an existing path is atomic, so a crash or an overlapping AM/PM run can
 *  never leave a half-written file behind. Both files this module touches are
 *  irreplaceable: .env holds every API key and Telegram credential, and there
 *  is no backup. */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

function saveState(state: KeyPoolState): void {
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Sync the plain GOOGLE_GENERATIVE_AI_API_KEY line so non-rotation-aware
 *  tools (`inbrain` CLI subprocess calls, `inbrain dream`) pick up whichever
 *  key is currently active. */
function syncActiveKeyIntoEnvFile(key: string): void {
  const content = readFileSync(ENV_PATH, "utf-8");
  const marker = /^(\s*GOOGLE_GENERATIVE_AI_API_KEY\s*=).*$/m;
  if (!marker.test(content)) {
    console.error(
      "[gemini-keys] no GOOGLE_GENERATIVE_AI_API_KEY line in .env — subprocesses will not inherit the rotated key",
    );
    return;
  }
  const updated = content.replace(marker, `$1${key}`);
  if (updated !== content) writeFileAtomic(ENV_PATH, updated);
}

export interface KeyPool {
  /** Current best-guess working key. Also sets process.env + .env's
   *  GOOGLE_GENERATIVE_AI_API_KEY so subprocess calls (`inbrain put`,
   *  `inbrain query`, `inbrain dream`) inherit the same key. */
  current(): string;
  /** Advance past the current key (persists immediately). Returns the next
   *  usable key, or null when every key in the pool has been tried. */
  rotate(reason: string): string | null;
  size(): number;
  /** Position in TRY order, not the GEMINI_API_KEY_N number. */
  activeIndex(): number;
  /** Human-readable active key, e.g. "KEY_3 (paid)". Safe to log. */
  activeLabel(): string;
  /** True when the active key bills to a card rather than a daily free quota. */
  activeIsPaid(): boolean;
  freeCount(): number;
  paidCount(): number;
}

export function loadKeyPool(): KeyPool {
  const pool = loadPool();
  if (pool.length === 0) {
    throw new Error("No GEMINI_API_KEY_N entries found in .env — nothing to rotate.");
  }
  const state = loadState(pool);

  /** First key in try order that has not been marked spent. */
  function pick(): PoolKey | null {
    return pool.find((k) => !state.exhausted[k.id]) ?? null;
  }

  // Fail fast instead of spending a doomed request.
  let active = pick();
  if (!active) {
    throw new Error(
      `All ${pool.length} Gemini key(s) are marked exhausted for the current quota day ` +
        `(last rotation ${state.rotatedAt}). Wait for the Pacific-midnight reset or add another key.`,
    );
  }

  function apply(key: PoolKey): string {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = key.secret;
    syncActiveKeyIntoEnvFile(key.secret);
    return key.secret;
  }

  const label = (k: PoolKey) => `KEY_${k.envIndex}${k.paid ? " (paid)" : ""}`;

  apply(active); // make the resolved key active immediately on load

  return {
    current: () => active!.secret,
    activeIndex: () => pool.indexOf(active!),
    activeLabel: () => label(active!),
    activeIsPaid: () => active!.paid,
    size: () => pool.length,
    freeCount: () => pool.filter((k) => !k.paid).length,
    paidCount: () => pool.filter((k) => k.paid).length,
    rotate(reason: string) {
      const now = new Date().toISOString();
      state.exhausted[active!.id] = now;
      state.rotatedAt = now;
      console.error(`[gemini-keys] ${label(active!)} exhausted (${reason}), rotating...`);

      const next = pick();
      if (!next) {
        state.activeKeyId = "";
        saveState(state);
        return null;
      }
      active = next;
      state.activeKeyId = next.id;
      saveState(state);
      const secret = apply(next);
      console.error(
        `[gemini-keys] now using ${label(next)}` +
          (next.paid ? " — free quota is spent, this one bills to the card" : ""),
      );
      return secret;
    },
  };
}

/** True if a Gemini error message/body indicates "this key is done for now"
 *  (daily quota, free-tier RPD, or prepay credits depleted) as opposed to a
 *  transient server hiccup that's worth retrying on the SAME key.
 *
 *  Google returns 429 + RESOURCE_EXHAUSTED for BOTH the per-day and the
 *  per-minute limit, and the two need opposite handling: a per-minute throttle
 *  clears in seconds, so burning a healthy key on it costs us the rest of the
 *  quota day. The quotaId in the body is what tells them apart
 *  (GenerateRequestsPerDay… vs GenerateRequestsPerMinute…). */
export function isKeyExhaustedError(statusCode: number, bodyText: string): boolean {
  if (statusCode !== 429) return false;
  if (/PerMinute|per minute|RequestsPerMinute/i.test(bodyText)) return false;
  return /PerDay|per day|RESOURCE_EXHAUSTED|quota|prepayment credits are depleted/i.test(
    bodyText,
  );
}

/** Milliseconds to wait before retrying the SAME key, parsed from Google's
 *  RetryInfo (`"retryDelay": "42s"`). Returns null when the body carries no
 *  hint, so the caller falls back to its own backoff. */
export function retryDelayMs(bodyText: string): number | null {
  const m = bodyText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * 1000);
}
