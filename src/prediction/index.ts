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

export { AnalystAgent } from "./analyst-agent.js";
export type {
  AnalystAgentOptions,
  DailyReport,
  AlphaDiscovery,
} from "./analyst-agent.js";

export { DreamCycle } from "./dream-cycle.js";
export type { DreamCycleOptions } from "./dream-cycle.js";

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
