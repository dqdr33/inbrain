import { describe, test, expect } from "bun:test";
import { formatProbability, formatPercent } from "../../src/prediction/format.ts";

describe("formatProbability", () => {
  test("keeps the short integer form for ordinary values", () => {
    expect(formatProbability(0.04)).toBe("4");
    expect(formatProbability(0.5)).toBe("50");
    expect(formatProbability(0.782)).toBe("78");
  });

  test("prints the genuine extremes as-is", () => {
    expect(formatProbability(0)).toBe("0");
    expect(formatProbability(1)).toBe("100");
  });

  // The regression this module exists for. A market at 0.001 rendered as "0%",
  // that zero was fed into the Analyst prompt, and the model then produced an
  // entry that contradicted its own number inside one sentence:
  //   "A 0% probability ... if any non-zero, albeit minuscule, chance exists"
  test("never renders a positive probability as zero", () => {
    expect(formatProbability(0.001)).toBe("0.1");
    expect(formatProbability(0.0015)).toBe("0.1");
    expect(formatProbability(0.0004)).toBe("0.04");
    expect(formatProbability(0.00001)).toBe("0.001");
  });

  test("never renders a sub-certain probability as one hundred", () => {
    expect(formatProbability(0.9999)).toBe("99.99");
    expect(formatProbability(0.99999)).toBe("99.999");
  });

  // Past the precision ceiling, state the bound rather than round to a lie.
  test("falls back to a bound beyond the precision ceiling", () => {
    expect(formatProbability(1e-7)).toBe("<0.001");
    expect(formatProbability(1 - 1e-9)).toBe(">99.999");
  });

  test("clamps out-of-range input instead of emitting nonsense", () => {
    expect(formatProbability(1.4)).toBe("100");
    expect(formatProbability(-0.2)).toBe("0");
  });

  test("degrades visibly on non-finite input", () => {
    expect(formatProbability(NaN)).toBe("?");
    expect(formatProbability(Infinity)).toBe("?");
  });
});

describe("formatPercent", () => {
  test("appends the sign to whatever formatProbability produced", () => {
    expect(formatPercent(0.001)).toBe("0.1%");
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(1)).toBe("100%");
  });
});
