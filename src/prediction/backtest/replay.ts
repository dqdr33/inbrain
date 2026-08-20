/**
 * Replay — turn a historical snapshot into the signal a live run would have
 * seen, and evaluate it with the clock frozen at the as-of date.
 *
 * The contract this module enforces: the BrainAgent must not be able to tell it
 * is being backtested. It gets a signal, a market price and a date, exactly as
 * it would live. Anything the agent could use to date itself to the real
 * present is a leak.
 *
 * Three leaks are closed here, and they are the entire reason this file exists
 * rather than the caller wiring BrainAgent directly:
 *
 *   1. The clock — `now: () => asOf`.
 *   2. The brain — a live `brainQuery` searches notes written after `asOf`,
 *      including this pipeline's own later reports about the same market. The
 *      default here is a query that returns nothing; see `noBrainContext`.
 *   3. The price — `marketPrice` comes from the snapshot's history AT `asOf`,
 *      never the settled price.
 */

import { BrainAgent } from "../brain-agent.ts";
import type { PredictionSignal } from "../types.ts";
import type { ForecastRecord } from "../scoring.ts";
import { viewAsOf, type MarketSnapshot, type SnapshotView } from "./snapshot.ts";

/**
 * The default brain for a backtest: no context at all.
 *
 * A live brain cannot be date-filtered reliably (its notes carry ingest dates,
 * not statement-validity dates), and a single post-resolution note about the
 * market under test invalidates the whole run. An empty context is weaker than
 * a correct historical brain but it is HONEST, which is the property that
 * matters when the output is a claim about forecasting skill.
 */
export const noBrainContext = async (): Promise<string> => "";

/** Rebuild the venue signal as it would have arrived on the as-of date. */
export function signalFromView(view: SnapshotView): PredictionSignal {
  const { snapshot, asOf, marketPrice } = view;
  const no = 1 - marketPrice;

  return {
    id: `backtest_${snapshot.venue}_${snapshot.id}_${asOf.toISOString().slice(0, 10)}`,
    source: "polymarket",
    content: snapshot.question,
    // The signal's own timestamp is the as-of date, not today. The agent
    // serialises the whole signal into the quality prompt, so a real timestamp
    // here would hand it the present date in a field nobody thinks to check.
    timestamp: asOf,
    deadline: new Date(snapshot.endDate),
    entities: [],
    engagement: {
      likes: Math.round(snapshot.volume),
      reposts: 0,
      replies: 0,
      velocityPerHour: snapshot.volume / 24,
    },
    rawData: {
      venueMarketId: snapshot.id,
      eventKey: snapshot.slug,
      volume24hr: snapshot.volume,
      outcomes: '["Yes", "No"]',
      // The as-of price, formatted exactly as the live gamma feed formats it,
      // so crowd.ts extracts it through the same path as production.
      outcomePrices: JSON.stringify([marketPrice.toFixed(4), no.toFixed(4)]),
      endDate: snapshot.endDate,
    },
  };
}

export interface ReplayOptions {
  llmCall: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;
  modelId?: string;
  /** Quality gate. Lowered from the production 65 by default: the gate exists
   *  to ration spend on live signals, whereas a backtest wants an estimate for
   *  every market in the cohort or the sample self-selects. */
  qualityThreshold?: number;
  /** Override the brain. Defaults to `noBrainContext`. */
  brainQuery?: (query: string) => Promise<string>;
  /**
   * Blind mode: withhold the market price from the agent.
   *
   * THE CONTROL RUN. An LLM asked about a market that closed before its
   * training cutoff may simply remember the outcome, which produces excellent
   * backtest scores and zero live skill. With the price withheld and the brain
   * empty, a model with no memory of the event should score near the base rate.
   * If it still scores well, the run is measuring recall, not forecasting.
   */
  blind?: boolean;
}

/** One replayed forecast, with everything needed to audit it after the fact. */
export interface ReplayResult {
  record: ForecastRecord;
  question: string;
  asOf: string;
  endDate: string;
  outcome: boolean;
  marketPrice: number;
  forecast: number;
  confidence: number;
  reasoning: string;
  /** True when the quality gate rejected the signal and no estimate was made. */
  skipped: boolean;
  skipReason?: string;
}

/**
 * Evaluate one market at one as-of date.
 *
 * Returns null when the market is not a legitimate target at that date (see
 * `viewAsOf`), which is a silent, expected outcome — not an error.
 */
export async function replayOne(
  snapshot: MarketSnapshot,
  asOf: Date,
  opts: ReplayOptions,
  minHorizonDays = 3,
): Promise<ReplayResult | null> {
  const view = viewAsOf(snapshot, asOf, { minHorizonDays });
  if (!view) return null;

  const signal = signalFromView(view);

  // Blind mode strips the price from the payload the agent reads. It must be
  // removed from rawData, not merely omitted from a prompt: crowd.ts recovers
  // the quote from rawData, and a leftover field would silently re-anchor the
  // control run and make it agree with the priced run.
  if (opts.blind) {
    const raw = signal.rawData as Record<string, unknown>;
    delete raw.outcomePrices;
    delete raw.outcomes;
  }

  const agent = new BrainAgent({
    qualityThreshold: opts.qualityThreshold ?? 0,
    modelId: opts.modelId,
    now: () => asOf,
    brainQuery: opts.brainQuery ?? noBrainContext,
    brainWrite: async () => {},
    llmCall: opts.llmCall,
  });

  const result = await agent.evaluate(signal);

  const base = {
    question: snapshot.question,
    asOf: asOf.toISOString(),
    endDate: snapshot.endDate,
    outcome: view.snapshot.outcome,
    marketPrice: view.marketPrice,
  };

  if (!result.accepted) {
    return {
      ...base,
      record: {
        id: signal.id,
        forecast: NaN,
        outcome: view.snapshot.outcome,
        marketPrice: view.marketPrice,
        horizonDays: view.horizonDays,
      },
      forecast: NaN,
      confidence: 0,
      reasoning: "",
      skipped: true,
      skipReason: result.reason,
    };
  }

  const est = result.market.aiEstimate;

  // The RAW model output, before the calibration layer and the price shrink.
  //
  // The backtest is the instrument that measures whether those corrections help;
  // replaying with them already applied would measure the corrections against
  // themselves. Worse, the results file is a training input, so scoring
  // post-shrink output would feed corrected numbers back into the next fit —
  // the compounding this whole design exists to prevent.
  //
  // `rawYesProbability` is absent only on the fallback path below, where the
  // ?? fallback is exactly right.
  const rawForecast = est.rawYesProbability ?? est.yesProbability;

  // BrainAgent answers 0.5 at confidence 0.1 when the model's JSON could not be
  // parsed or validated — a transport failure wearing the shape of a forecast.
  // Scoring it as a real 50% call would be wrong in both directions: it inflates
  // the model's Brier on the (usually NO) outcome, and it fabricates a
  // "maximum divergence from market" that no model actually expressed.
  //
  // Recorded as NaN so `scoreForecasts` drops it and says how many it dropped,
  // rather than silently deleting the row here.
  const isFallback = rawForecast === 0.5 && est.confidence <= 0.1;
  const forecast = isFallback ? NaN : rawForecast;

  return {
    ...base,
    record: {
      id: signal.id,
      forecast,
      outcome: view.snapshot.outcome,
      marketPrice: view.marketPrice,
      horizonDays: view.horizonDays,
      group: snapshot.category,
    },
    forecast,
    confidence: est.confidence,
    reasoning: est.reasoning,
    skipped: isFallback,
    skipReason: isFallback
      ? "estimate could not be parsed or validated — not a forecast"
      : undefined,
  };
}
