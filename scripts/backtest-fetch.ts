#!/usr/bin/env bun
/**
 * Fetch resolved markets into a snapshot file.
 *
 * Run this once; every scoring run afterwards reads the file. Separating fetch
 * from score is what makes a backtest reproducible — and stops a scoring run
 * from consulting the live venue about a market it is mid-forecast on.
 *
 *   bun run scripts/backtest-fetch.ts --limit 150 --min-volume 100000
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchSnapshots } from "../src/prediction/backtest/fetch-polymarket.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = join(import.meta.dir, "..", ".backtest-snapshots.json");

const limit = Number(arg("limit", "150"));
const minVolume = Number(arg("min-volume", "100000"));
const closedAfter = arg("closed-after");
const closedBefore = arg("closed-before");

console.log(
  `[backtest-fetch] limit=${limit} minVolume=${minVolume}` +
    `${closedAfter ? ` closedAfter=${closedAfter}` : ""}` +
    `${closedBefore ? ` closedBefore=${closedBefore}` : ""}`,
);

const snapshots = await fetchSnapshots({
  limit,
  minVolume,
  closedAfter: closedAfter ? new Date(closedAfter) : undefined,
  closedBefore: closedBefore ? new Date(closedBefore) : undefined,
  onProgress: (done, total, note) => {
    process.stderr.write(`\r[backtest-fetch] ${done}/${total} — ${note}          `);
  },
});
process.stderr.write("\n");

if (snapshots.length === 0) {
  console.error("[backtest-fetch] no snapshots matched — widen the filters");
  process.exit(1);
}

const yes = snapshots.filter((s) => s.outcome).length;
const spanStart = snapshots.reduce(
  (min, s) => (s.endDate < min ? s.endDate : min),
  snapshots[0]!.endDate,
);
const spanEnd = snapshots.reduce(
  (max, s) => (s.endDate > max ? s.endDate : max),
  snapshots[0]!.endDate,
);

writeFileSync(OUT, JSON.stringify(snapshots, null, 2), "utf-8");

console.log(`[backtest-fetch] wrote ${snapshots.length} snapshots to ${OUT}`);
console.log(
  `[backtest-fetch] base rate: ${((yes / snapshots.length) * 100).toFixed(1)}% YES ` +
    `(${yes}/${snapshots.length})`,
);
console.log(`[backtest-fetch] close dates: ${spanStart.slice(0, 10)} … ${spanEnd.slice(0, 10)}`);
console.log(
  `[backtest-fetch] median history points: ` +
    `${snapshots.map((s) => s.history.length).sort((a, b) => a - b)[Math.floor(snapshots.length / 2)]}`,
);
