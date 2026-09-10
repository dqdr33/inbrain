/**
 * Inbrain Prediction Intelligence Network
 *
 * Four-layer agent architecture for AI-driven social prediction:
 *   Signal Agent  → event detection
 *   Brain Agent   → reasoning & quality evaluation
 *   Execution Agent → market lifecycle & auto-resolution
 *   Analyst Agent → intelligence reports & alpha discovery
 *
 * Plus the Dream Cycle for nightly self-evolution.
 */

export { SignalAgent } from "./signal-agent.js";
export type { SignalAgentOptions } from "./signal-agent.js";

export { BrainAgent } from "./brain-agent.js";
export type { BrainAgentOptions } from "./brain-agent.js";

export { ExecutionAgent } from "./execution-agent.js";
export type { ExecutionAgentOptions } from "./execution-agent.js";

export {
  AnalystAgent,
  normaliseTrends,
  MIN_TREND_CONFIDENCE,
  normaliseAlpha,
  findAlphaCandidates,
} from "./analyst-agent.js";
export type {
  AnalystAgentOptions,
  DailyReport,
  AlphaDiscovery,
  AlphaCandidate,
  // TrendInsight is NOT re-exported here: it is defined in ./types.js (and only
  // imported by analyst-agent), and the duplicate made this module fail to
  // typecheck. The canonical export is in the types.js block below.
} from "./analyst-agent.js";

export { DreamCycle } from "./dream-cycle.js";
export type { DreamCycleOptions } from "./dream-cycle.js";

export { InbrainOrchestrator } from "./orchestrator.js";
export type { OrchestratorOptions } from "./orchestrator.js";

export { extractCrowdProbability, extractCrowdQuote } from "./crowd.js";
export type { CrowdQuote, QuoteBasis, QuoteVenue } from "./crowd.js";

export {
  parseDeadlineFromTitle,
  resolveExpiry,
  isLive,
} from "./deadline.js";
export type { DeadlineFraming, ParsedDeadline, ExpirySource, ResolvedExpiry } from "./deadline.js";

export {
  findStructuralDesyncs,
  describeDesync,
  relatedMarketIds,
  DESYNC_THRESHOLD_PP,
} from "./cross-market.js";
export type { DesyncFinding, DesyncSide, DesyncSeries } from "./cross-market.js";

export {
  CALIBRATION_SLUG,
  CALIBRATION_SLUG_QUERY,
  renderCalibrationPage,
} from "./calibration.js";
export type { CalibrationRule } from "./calibration.js";

export {
  normalizeRelatedMarkets,
  validateNormalizedProbabilities,
  extractContestKey,
  extractPolicyDecisionKey,
  extractThresholdKey,
  parseThresholdMagnitude,
  thresholdDirection,
} from "./normalize.js";
export type { NormalizationResult, ProbabilityConflict } from "./normalize.js";

export {
  enforceMonotonicity,
  enforceThresholdMonotonicity,
  isotonicFit,
} from "./monotonic.js";
export type { MonotonicResult, MonotonicAdjustment } from "./monotonic.js";

export {
  LlmValidationError,
  parseLlmJson,
  requireProbability,
  requireScore,
  stripFences,
} from "./llm-json.js";

export type {
  PredictionSignal,
  SignalSource,
  EngagementMetrics,
  MarketQualityScore,
  HistoricalCase,
  PredictionMarket,
  MarketCategory,
  MarketStatus,
  AIEstimate,
  MarketResolution,
  DreamCycleReport,
  PredictionForecast,
  TrendInsight,
  MetaModelUpdate,
  CrowdWisdom,
  AgentConfig,
} from "./types.js";
