/**
 * scripts/lib/brain-cli.ts — brainQuery / brainWrite backed by the real inbrain
 * CLI, so writes go through the actual engine (chunking, embeddings, link
 * extraction) instead of bypassing it.
 *
 * Shared by run-prediction-cycle.ts and run-dream-cycle.ts.
 *
 * Two properties this module guarantees that the previous inline copies did not:
 *   - Fully async. The old code used execFileSync, which blocks the event loop
 *     for up to 90s per call and made the Promise.all in BrainAgent.evaluate
 *     purely decorative (the second query could not start until the first
 *     finished).
 *   - brainWrite reports whether the write actually landed, so callers stop
 *     printing "written" after two failed attempts.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

// Each invocation is a fresh process: PGLite cold-start + config load + (for
// put) an embedding round-trip, easily 30-60s on a laptop. 30s timeouts caused
// real ETIMEDOUT failures in production. 90s + one retry covers cold start with
// headroom while still failing fast if the CLI is genuinely stuck.
const CLI_TIMEOUT_MS = 90_000;

/** Marker returned (not thrown) when the brain is unreachable. Callers that
 *  feed brain output into a prompt must be able to recognise a failure string
 *  instead of passing an error message off as knowledge. */
export const BRAIN_QUERY_FAILED_PREFIX = "Brain query failed (non-fatal):";

export function isBrainFailure(text: string): boolean {
  return text.startsWith(BRAIN_QUERY_FAILED_PREFIX);
}

function runCli(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "bun",
      ["run", "src/cli.ts", ...args],
      { cwd: REPO_ROOT, encoding: "utf-8", timeout: CLI_TIMEOUT_MS, env: process.env },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout as string);
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.write(input, "utf-8");
      child.stdin.end();
    }
  });
}

export async function brainQuery(query: string): Promise<string> {
  try {
    return await runCli(["query", query, "--no-expand", "--limit", "5"]);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 200);
    console.error(`[brainQuery] failed: ${msg}`);
    return `${BRAIN_QUERY_FAILED_PREFIX} ${msg}`;
  }
}

/**
 * Exact-slug page fetch.
 *
 * `brainQuery` is a top-5 semantic search: asking it for a page whose address
 * you already know is a category error. It can return four unrelated pages and
 * a near-miss, or nothing at all, and the caller has no way to tell. The
 * calibration loop read its own rules that way, so a page written at
 * `predictions/meta/calibration` was retrieved by embedding similarity against
 * the whole brain — and silently produced "" whenever it lost the ranking.
 *
 * Returns null when the page does not exist, so a miss is distinguishable from
 * an empty page.
 */
export async function brainGet(slug: string): Promise<string | null> {
  try {
    return await runCli(["get", slug]);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 200);
    console.error(`[brainGet] failed for "${slug}": ${msg}`);
    return null;
  }
}

export interface BrainWriteOpts {
  dryRun?: boolean;
}

/** Returns true only when the page actually landed. */
export async function brainWrite(
  slug: string,
  content: string,
  opts: BrainWriteOpts = {},
): Promise<boolean> {
  if (opts.dryRun) {
    console.log(`[dry-run] would write page "${slug}" (${content.length} chars)`);
    return true;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await runCli(["put", slug], content);
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt === 2) {
        console.error(`[brainWrite] failed for "${slug}" after ${attempt} attempts: ${msg.slice(0, 300)}`);
      } else {
        console.error(`[brainWrite] attempt ${attempt} failed for "${slug}", retrying: ${msg.slice(0, 150)}`);
      }
    }
  }
  return false;
}
