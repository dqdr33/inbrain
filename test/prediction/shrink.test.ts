import { describe, test, expect } from "bun:test";
import {
  shrinkTowardPrice,
  FREE_DEPARTURE,
  PRICE_SHRINK_LAMBDA,
} from "../../src/prediction/shrink.ts";

describe("shrinkTowardPrice", () => {
  test("small disagreements pass through untouched", () => {
    // The 47-record [0,0.1) bin is the zone that already works (gap +0.0007).
    // The deadband is what protects it: squeezing it to fix the mid-range would
    // damage the only part of the distribution that is currently calibrated.
    const r = shrinkTowardPrice(0.04, 0.05);
    expect(r.shrunk).toBe(0.04);
    expect(r.applied).toBe(false);
  });

  test("exactly at the deadband edge is still untouched", () => {
    const r = shrinkTowardPrice(0.35, 0.35 - FREE_DEPARTURE);
    expect(r.shrunk).toBe(0.35);
    expect(r.applied).toBe(false);
  });

  test("the pathological mid-range case is pulled halfway back", () => {
    // raw 0.55 vs price 0.30: keep (0.25 - 0.05) * 0.5 = 0.10 of the departure.
    // On a NO outcome this cuts Brier from 0.3025 to 0.16.
    const r = shrinkTowardPrice(0.55, 0.3);
    expect(r.shrunk).toBeCloseTo(0.4, 9);
    expect(r.applied).toBe(true);
  });

  test("no price means nothing to shrink toward", () => {
    const r = shrinkTowardPrice(0.72, undefined);
    expect(r.shrunk).toBe(0.72);
    expect(r.applied).toBe(false);
  });

  test("a non-finite price is treated as no price", () => {
    expect(shrinkTowardPrice(0.72, NaN).shrunk).toBe(0.72);
  });

  test("a non-finite forecast passes through rather than being invented", () => {
    expect(Number.isNaN(shrinkTowardPrice(NaN, 0.3).shrunk)).toBe(true);
  });

  test("symmetric: equal departures move equally in both directions", () => {
    const up = shrinkTowardPrice(0.55, 0.3);
    const down = shrinkTowardPrice(0.05, 0.3);
    expect(Math.abs(up.shrunk - 0.3)).toBeCloseTo(Math.abs(down.shrunk - 0.3), 9);
  });

  test("output always lands between the forecast and the price", () => {
    for (let i = 0; i <= 100; i++) {
      for (let j = 0; j <= 20; j++) {
        const raw = i / 100;
        const price = j / 20;
        const { shrunk } = shrinkTowardPrice(raw, price);
        expect(shrunk).toBeGreaterThanOrEqual(Math.min(raw, price) - 1e-12);
        expect(shrunk).toBeLessThanOrEqual(Math.max(raw, price) + 1e-12);
        expect(shrunk).toBeGreaterThanOrEqual(0);
        expect(shrunk).toBeLessThanOrEqual(1);
      }
    }
  });

  test("lambda is a real discount, not a pass-through or full collapse", () => {
    // lambda = 1 would score exactly 0 skill against the price by construction
    // and guarantee the pipeline never finds alpha; lambda = 0 would be a no-op.
    expect(PRICE_SHRINK_LAMBDA).toBeGreaterThan(0);
    expect(PRICE_SHRINK_LAMBDA).toBeLessThan(1);
  });
});
