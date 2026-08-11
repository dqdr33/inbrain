/**
 * Shared probability formatting for prompts and reports.
 *
 * Why this exists: every probability used to be rendered with
 * `Math.round(p * 100)`. For a market sitting at p = 0.001 that prints "0%",
 * and the zero then travelled into the Analyst prompt, so the model reasoned
 * about a market it had been told was impossible. It produced entries that
 * argued with their own number in a single sentence:
 *
 *   "A 0% probability ... if any non-zero, albeit minuscule, chance exists"
 *
 * A long-shot market is exactly where alpha lives, so collapsing it to zero
 * destroys the signal the report is meant to surface. The rule here is simple:
 * a rendered probability never claims 0% or 100% unless the underlying value
 * really is 0 or 1. Precision grows only as far as it takes to stay honest, so
 * ordinary values keep their short, readable form ("4%", not "4.000%").
 */

/** Widest precision worth printing; below this the value is stated as a bound. */
const MAX_DECIMALS = 3;

/**
 * Renders a 0-1 probability as a percentage string WITHOUT the `%` sign.
 *
 * Never returns "0" for a positive probability, nor "100" for one below 1 —
 * those are the two roundings that flip a statement's meaning.
 */
export function formatProbability(p: number): string {
  if (!Number.isFinite(p)) return "?";

  const clamped = Math.min(1, Math.max(0, p));
  const pct = clamped * 100;

  // Genuine extremes are printed as-is; they are not rounding artefacts.
  if (pct === 0) return "0";
  if (pct === 100) return "100";

  for (let decimals = 0; decimals <= MAX_DECIMALS; decimals++) {
    const rendered = pct.toFixed(decimals);
    const value = Number(rendered);
    // Reject any rendering that collapses a real, non-extreme probability into
    // one of the two absolutes. Start at 0 decimals, so "4" wins before "4.0".
    if (value !== 0 && value !== 100) return rendered;
  }

  // Below ~0.0005%: state the bound rather than lie with a zero.
  return pct < 50 ? `<${(10 ** -MAX_DECIMALS).toFixed(MAX_DECIMALS)}` : `>${(100 - 10 ** -MAX_DECIMALS).toFixed(MAX_DECIMALS)}`;
}

/** `formatProbability` with the `%` suffix, for the common call site. */
export function formatPercent(p: number): string {
  return `${formatProbability(p)}%`;
}
