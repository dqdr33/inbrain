/**
 * Append-mode identity.
 *
 * The opportunistic runner works in small slices, so slice N+1 must continue
 * where slice N stopped rather than re-sampling. That rests entirely on two
 * properties: the task order is deterministic across runs, and a forecast has
 * a stable identity so an already-banked one can be recognised and skipped.
 *
 * If either breaks, the scheduler silently pays for the same forecasts forever
 * and the sample never grows — a failure that looks exactly like "it's working,
 * just slowly".
 */
import { describe, test, expect } from "bun:test";
import { signalFromView } from "../../src/prediction/backtest/replay.ts";
import {
  viewAsOf,
  asOfBeforeClose,
  type MarketSnapshot,
} from "../../src/prediction/backtest/snapshot.ts";

const DAY = 86_400;
const T0 = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);

function snap(id: string, endOffsetDays = 100): MarketSnapshot {
  return {
    id,
    venue: "polymarket",
    question: `Will ${id} happen?`,
    createdAt: new Date(T0 * 1000).toISOString(),
    endDate: new Date((T0 + endOffsetDays * DAY) * 1000).toISOString(),
    outcome: false,
    volume: 500_000,
    history: Array.from({ length: endOffsetDays }, (_, i) => ({
      t: T0 + i * DAY,
      p: 0.3,
    })),
  };
}

/** The deterministic shuffle used by backtest-run.ts, reproduced exactly. */
function shuffled<T>(items: T[]): T[] {
  let seed = 20260819;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  return [...items].sort(() => rand() - 0.5);
}

describe("forecast identity", () => {
  test("the same market at the same as-of date yields the same id", () => {
    // This is the key append-mode reads to decide "already done".
    const s = snap("m1");
    const asOf = asOfBeforeClose(s, 30);
    const a = signalFromView(viewAsOf(s, asOf)!);
    const b = signalFromView(viewAsOf(s, asOf)!);
    expect(a.id).toBe(b.id);
  });

  test("different as-of dates on one market are different forecasts", () => {
    const s = snap("m1");
    const a = signalFromView(viewAsOf(s, asOfBeforeClose(s, 30))!);
    const b = signalFromView(viewAsOf(s, asOfBeforeClose(s, 90))!);
    expect(a.id).not.toBe(b.id);
  });

  test("different markets at the same offset are different forecasts", () => {
    const a = signalFromView(viewAsOf(snap("m1"), asOfBeforeClose(snap("m1"), 30))!);
    const b = signalFromView(viewAsOf(snap("m2"), asOfBeforeClose(snap("m2"), 30))!);
    expect(a.id).not.toBe(b.id);
  });

  test("the id is reconstructible from snapshot + as-of alone", () => {
    // backtest-run.ts builds the skip-set key WITHOUT calling signalFromView,
    // so the two constructions must agree or append mode re-runs everything.
    const s = snap("m7");
    const asOf = asOfBeforeClose(s, 60);
    const fromSignal = signalFromView(viewAsOf(s, asOf)!).id;
    const fromParts = `backtest_${s.venue}_${s.id}_${asOf.toISOString().slice(0, 10)}`;
    expect(fromSignal).toBe(fromParts);
  });
});

describe("deterministic task order", () => {
  test("the shuffle is stable across runs", () => {
    // Slice 2 continues slice 1's walk only if the order never changes.
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(shuffled(items)).toEqual(shuffled(items));
  });

  test("the shuffle actually reorders", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(shuffled(items)).not.toEqual(items);
  });

  test("consecutive slices cover disjoint work", () => {
    // The property that makes an opportunistic scheduler accumulate rather than
    // spin: take 10, mark done, take 10 more — no overlap, and progress is 20.
    const tasks = shuffled(Array.from({ length: 40 }, (_, i) => `t${i}`));

    const slice1 = tasks.slice(0, 10);
    const done = new Set(slice1);
    const slice2 = tasks.filter((t) => !done.has(t)).slice(0, 10);

    expect(slice2).toHaveLength(10);
    expect(slice1.some((t) => slice2.includes(t))).toBe(false);
    expect(new Set([...slice1, ...slice2]).size).toBe(20);
  });

  test("slicing terminates once every task is banked", () => {
    const tasks = shuffled(Array.from({ length: 12 }, (_, i) => `t${i}`));
    const done = new Set(tasks);
    expect(tasks.filter((t) => !done.has(t))).toHaveLength(0);
  });
});
