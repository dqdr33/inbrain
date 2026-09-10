/**
 * normaliseAlpha's urgency handling.
 *
 * The pipeline asks the model for an urgency and accepts "high" | "medium" |
 * "low". Anything else — a missing field, a typo, a truncated response — used to
 * become "low" silently, and the report printed that identically to a low the
 * model actually chose. On 2026-09-10 five opportunities changed label on the
 * same day, which read as a considered de-escalation and could equally have
 * been five malformed rows. These tests keep the two distinguishable.
 */

import { describe, test, expect } from "bun:test";
import { normaliseAlpha } from "../../src/prediction/analyst-agent.ts";

describe("normaliseAlpha urgency", () => {
  test("keeps an urgency the model actually stated", () => {
    const out = normaliseAlpha([
      { title: "A", reasoning: "r", urgency: "high" },
      { title: "B", reasoning: "r", urgency: "medium" },
      { title: "C", reasoning: "r", urgency: "low" },
    ]);
    expect(out.map((o) => o.urgency)).toEqual(["high", "medium", "low"]);
    for (const o of out) expect(o.urgencyUnstated).toBeUndefined();
  });

  test("flags a missing urgency instead of inventing a verdict", () => {
    const out = normaliseAlpha([{ title: "A", reasoning: "r" }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.urgency).toBe("low");
    expect(out[0]!.urgencyUnstated).toBe(true);
  });

  test("flags a malformed urgency the same way", () => {
    const out = normaliseAlpha([
      { title: "A", reasoning: "r", urgency: "URGENT" },
      { title: "B", reasoning: "r", urgency: 3 },
      { title: "C", reasoning: "r", urgency: null },
    ]);
    expect(out).toHaveLength(3);
    for (const o of out) {
      expect(o.urgency).toBe("low");
      expect(o.urgencyUnstated).toBe(true);
    }
  });

  test("a whole batch losing its urgency stays visible as such", () => {
    // The shape of the 2026-09-10 report: every row unrated at once. If this
    // ever collapses back to plain "low", the signal is gone again.
    const out = normaliseAlpha(
      Array.from({ length: 5 }, (_, i) => ({ title: `M${i}`, reasoning: "r" })),
    );
    expect(out.every((o) => o.urgencyUnstated === true)).toBe(true);
  });
});
