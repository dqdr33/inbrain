/**
 * Lookahead-leak guards.
 *
 * Every test here is a specific way a backtest can quietly consult the future
 * and report a score it did not earn. These are the tests that decide whether
 * the whole exercise is measurement or theatre.
 */
import { describe, test, expect } from "bun:test";
import {
  priceAsOf,
  viewAsOf,
  parseBinaryOutcome,
  normalizeHistory,
  asOfBeforeClose,
  type MarketSnapshot,
  type PricePoint,
} from "../../src/prediction/backtest/snapshot.ts";
import { signalFromView } from "../../src/prediction/backtest/replay.ts";

const DAY = 86_400;
/** 2026-01-01T00:00:00Z in unix seconds. */
const T0 = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);

function history(points: Array<[number, number]>): PricePoint[] {
  return points.map(([dayOffset, p]) => ({ t: T0 + dayOffset * DAY, p }));
}

function snap(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    id: "m1",
    venue: "polymarket",
    question: "Will X happen?",
    createdAt: new Date(T0 * 1000).toISOString(),
    endDate: new Date((T0 + 100 * DAY) * 1000).toISOString(),
    outcome: true,
    volume: 1_000_000,
    history: history([
      [0, 0.20],
      [10, 0.30],
      [50, 0.60],
      [99, 0.98],
    ]),
    ...overrides,
  };
}

function at(dayOffset: number): Date {
  return new Date((T0 + dayOffset * DAY) * 1000);
}

describe("priceAsOf", () => {
  test("returns the last price at or before the as-of instant", () => {
    const h = history([[0, 0.2], [10, 0.3], [50, 0.6]]);
    expect(priceAsOf(h, at(20))).toBe(0.3);
  });

  test("NEVER returns a price set after the as-of instant", () => {
    // The leak this module exists to prevent: at day 20 the market later moved
    // to 0.6, and a naive nearest-point lookup would return it.
    const h = history([[0, 0.2], [10, 0.3], [21, 0.95]]);
    const p = priceAsOf(h, at(20))!;
    expect(p).toBe(0.3);
    expect(p).not.toBe(0.95);
  });

  test("an exact timestamp match is included, not excluded", () => {
    const h = history([[10, 0.42]]);
    expect(priceAsOf(h, at(10))).toBe(0.42);
  });

  test("returns null when as-of predates all history", () => {
    // Falling back to the first known price would import a price set later.
    const h = history([[10, 0.3]]);
    expect(priceAsOf(h, at(5))).toBeNull();
  });

  test("returns null on empty history", () => {
    expect(priceAsOf([], at(10))).toBeNull();
  });

  test("finds the right point across a long series", () => {
    const h = history(Array.from({ length: 500 }, (_, i) => [i, i / 1000] as [number, number]));
    expect(priceAsOf(h, at(321))).toBeCloseTo(0.321, 9);
  });
});

describe("viewAsOf", () => {
  test("rejects an as-of at or after the close", () => {
    // At close the outcome is known; scoring it is scoring hindsight.
    expect(viewAsOf(snap(), at(100))).toBeNull();
    expect(viewAsOf(snap(), at(101))).toBeNull();
  });

  test("rejects an as-of before the market existed", () => {
    const s = snap({ createdAt: new Date((T0 + 20 * DAY) * 1000).toISOString() });
    expect(viewAsOf(s, at(10))).toBeNull();
  });

  test("rejects a horizon shorter than the minimum", () => {
    // A market closing in hours is a settlement formality priced at ~0 or ~1;
    // including these manufactures spectacular fake accuracy.
    expect(viewAsOf(snap(), at(99), { minHorizonDays: 3 })).toBeNull();
  });

  test("accepts a legitimate mid-life view and prices it as of then", () => {
    const v = viewAsOf(snap(), at(20))!;
    expect(v).not.toBeNull();
    expect(v.marketPrice).toBe(0.30);
    expect(v.horizonDays).toBeCloseTo(80, 6);
  });

  test("rejects when no price is knowable at the as-of date", () => {
    const s = snap({ history: history([[50, 0.6]]) });
    expect(viewAsOf(s, at(20))).toBeNull();
  });

  test("horizon is measured to the close, not to today", () => {
    const v = viewAsOf(snap(), at(30))!;
    expect(v.horizonDays).toBeCloseTo(70, 6);
  });
});

describe("parseBinaryOutcome", () => {
  test("reads a settled YES and NO", () => {
    expect(parseBinaryOutcome('["1", "0"]')).toBe(true);
    expect(parseBinaryOutcome('["0", "1"]')).toBe(false);
  });

  test("accepts an already-parsed array", () => {
    expect(parseBinaryOutcome([1, 0])).toBe(true);
  });

  test("returns null for a 50-50 void rather than calling it NO", () => {
    // Coercing a void to `false` would score the model as wrong about an event
    // that never resolved either way, poisoning the calibration curve.
    expect(parseBinaryOutcome('["0.5", "0.5"]')).toBeNull();
  });

  test("returns null for an unresolved mid-range price", () => {
    expect(parseBinaryOutcome('["0.73", "0.27"]')).toBeNull();
  });

  test("returns null for malformed or multi-outcome input", () => {
    expect(parseBinaryOutcome("not json")).toBeNull();
    expect(parseBinaryOutcome('["1", "0", "0"]')).toBeNull();
    expect(parseBinaryOutcome(null)).toBeNull();
  });
});

describe("normalizeHistory", () => {
  test("sorts ascending so the binary search is valid", () => {
    const h = normalizeHistory([
      { t: 300, p: 0.3 },
      { t: 100, p: 0.1 },
      { t: 200, p: 0.2 },
    ]);
    expect(h.map((x) => x.t)).toEqual([100, 200, 300]);
  });

  test("drops probabilities outside [0,1] instead of clamping", () => {
    // A 1.4 clamped to 1.0 would read as a confident YES the venue never quoted.
    const h = normalizeHistory([{ t: 1, p: 1.4 }, { t: 2, p: -0.2 }, { t: 3, p: 0.5 }]);
    expect(h).toEqual([{ t: 3, p: 0.5 }]);
  });

  test("drops non-numeric points and non-array input", () => {
    expect(normalizeHistory([{ t: "x", p: 0.5 }])).toEqual([]);
    expect(normalizeHistory(null)).toEqual([]);
  });
});

describe("asOfBeforeClose", () => {
  test("lands exactly N days before the close", () => {
    const s = snap();
    const d = asOfBeforeClose(s, 30);
    const gap = (new Date(s.endDate).getTime() - d.getTime()) / 86_400_000;
    expect(gap).toBeCloseTo(30, 9);
  });
});

describe("signalFromView — what the agent is allowed to see", () => {
  test("the signal timestamp is the as-of date, never the present", () => {
    // The agent serialises the whole signal into the quality prompt, so a real
    // timestamp here hands it today's date in a field nobody thinks to check.
    const v = viewAsOf(snap(), at(20))!;
    const s = signalFromView(v);
    expect(s.timestamp.toISOString()).toBe(at(20).toISOString());
  });

  test("carries the as-of price, not the settled price", () => {
    const v = viewAsOf(snap(), at(20))!;
    const s = signalFromView(v);
    const prices = JSON.parse(s.rawData!.outcomePrices as string) as string[];
    expect(Number(prices[0])).toBeCloseTo(0.30, 4);
    // The market settled YES (1.0); that must not appear anywhere.
    expect(Number(prices[0])).not.toBeCloseTo(1, 2);
  });

  test("YES and NO prices sum to 1", () => {
    const v = viewAsOf(snap(), at(20))!;
    const s = signalFromView(v);
    const [yes, no] = JSON.parse(s.rawData!.outcomePrices as string) as string[];
    expect(Number(yes) + Number(no)).toBeCloseTo(1, 6);
  });

  test("the deadline is the venue close date", () => {
    const v = viewAsOf(snap(), at(20))!;
    const s = signalFromView(v);
    expect(s.deadline!.toISOString()).toBe(new Date(snap().endDate).toISOString());
  });

  test("the id is stable for the same market and date", () => {
    const v = viewAsOf(snap(), at(20))!;
    expect(signalFromView(v).id).toBe(signalFromView(v).id);
  });

  test("nothing in the signal carries the outcome", () => {
    const v = viewAsOf(snap(), at(20))!;
    const serialized = JSON.stringify(signalFromView(v));
    expect(serialized).not.toContain('"outcome"');
    expect(serialized).not.toContain("resolved");
  });
});
