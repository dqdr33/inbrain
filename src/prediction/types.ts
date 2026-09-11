/**
 * Core types for Inbrain Prediction Intelligence Network.
 *
 * Four-layer agent architecture:
 *   Signal → Brain → Execution → Analyst
 */

export interface PredictionSignal {
  id: string;
  source: SignalSource;
  content: string;
  author?: string;
  authorInfluence?: number;
  timestamp: Date;
  url?: string;
  engagement?: EngagementMetrics;
  entities: string[];
  sentiment?: number; // -1 to 1
  /** The venue's own close date, where the source has one (polymarket, kalshi,
   *  predictit). Typed rather than left in `rawData` because it decides the
   *  market's expiry — see src/prediction/deadline.ts. Absent for the sources
   *  with no deadline concept (telegram, rss, news, …), which fall back to the
   *  deadline written in the title. */
  deadline?: Date;
  rawData?: Record<string, unknown>;
}

export type SignalSource =
  | "x_twitter"
  | "news"
  | "onchain"
  | "polymarket"
  | "kalshi"
  | "predictit"
  | "reddit"
  | "discord"
  | "manual"
  | "defillama"
  | "rss"
  | "binance"
  | "bybit"
  | "coingecko"
  | "gdelt"
  | "telegram"
  | "fred"
  | "alphavantage"
  | "dune"
  | "farcaster"
  | "covalent"
  | "cmc"
  | "token_unlocks"
  | "lunarcrush";

export interface EngagementMetrics {
  likes: number;
  reposts: number;
  replies: number;
  views?: number;
  velocityPerHour?: number;
}

export interface MarketQualityScore {
  overall: number; // 0-100
  verifiability: number;
  historicalSimilarity: number;
  communityPotential: number;
  liquidityPotential: number;
  timelineFeasibility: number;
  reasoning: string;
  historicalCases: HistoricalCase[];
  risks: string[];
}

export interface HistoricalCase {
  slug: string;
  title: string;
  outcome: "yes" | "no" | "unresolved";
  similarity: number;
  finalProbability?: number;
  lessonLearned?: string;
}

export interface PredictionMarket {
  id: string;
  title: string;
  description: string;
  category: MarketCategory;
  status: MarketStatus;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt?: Date;

  aiEstimate: AIEstimate;
  qualityScore: MarketQualityScore;

  sourceSignals: string[]; // signal IDs
  relatedMarkets: string[];

  resolution?: MarketResolution;
  metadata: Record<string, unknown>;
}

export type MarketCategory =
  | "crypto"
  | "politics"
  | "technology"
  | "finance"
  | "sports"
  | "entertainment"
  | "science"
  | "social"
  | "regulation"
  | "other";

export type MarketStatus =
  | "proposed"
  | "evaluating"
  | "active"
  | "monitoring"
  | "pending_resolution"
  | "resolved"
  | "cancelled";

export interface AIEstimate {
  yesProbability: number;
  confidence: number;
  reasoning: string;
  sources: string[];
  modelVersion: string;
  updatedAt: Date;
  historicalAccuracy?: number;
  /** Model's expected horizon to resolution, 1-365 days. Drives expiresAt.
   *  Used to live only on an `as any` cast, so nothing validated its range. */
  estimatedResolutionDays?: number;

  /**
   * True when no estimate was produced at all — the model's answer failed to
   * parse or validate — and `yesProbability` is a placeholder, not a forecast.
   *
   * Load-bearing: such a row must never be screened for alpha, scored for
   * calibration, or described in a report. The old fallback wrote 0.5 with no
   * marker, which is maximally far from the near-zero price of the long-shot
   * questions whose answers tend to fail, so a JSON error surfaced as a
   * 50-point disagreement and the analyst model wrote a rationale for it.
   */
  estimateFailed?: boolean;

  /**
   * The model's own output, before the calibration layer and the price shrink.
   *
   * THE ONLY FIELD A CALIBRATION FIT MAY EVER TRAIN ON. If a fit learns from
   * `yesProbability` after a correction has been applied to it, the correction
   * compounds every night — 0.55 becomes 0.45, the next fit sees 0.45 as still
   * miscalibrated and pushes it to 0.38, and so on until every forecast has
   * collapsed to the base rate. The system would look like it was learning while
   * destroying the sharpness that makes it worth anything.
   *
   * Same problem and same solution as `metadata.preMonotonicProbability` in
   * monotonic.ts.
   */
  rawYesProbability?: number;

  /** What the calibration layer did, so the adjustment stays auditable. */
  calibration?: {
    method: "identity" | "platt" | "isotonic";
    fittedAt: string;
    /** After the fitted mapping, before shrinking toward the venue price. */
    afterCalibration: number;
    priceShrinkApplied: boolean;
  };
}

export interface MarketResolution {
  outcome: "yes" | "no" | "cancelled";
  resolvedBy: "auto" | "manual" | "oracle";
  evidence: string[];
  verificationSources: string[];
  resolvedAt: Date;
}

export interface DreamCycleReport {
  id: string;
  runAt: Date;
  duration: number;

  marketsReviewed: number;
  /** null when nothing has resolved yet — distinct from a genuine 0.0. */
  predictionsAccuracy: number | null;
  knowledgeGapsFound: string[];
  knowledgeGapsFilled: string[];

  tomorrowPredictions: PredictionForecast[];
  trendAnalysis: TrendInsight[];

  metaModelUpdates: MetaModelUpdate[];
}

export interface PredictionForecast {
  title: string;
  category: MarketCategory;
  estimatedProbability: number;
  reasoning: string;
  potentialSignals: string[];
}

export interface TrendInsight {
  topic: string;
  direction: "rising" | "falling" | "stable";
  confidence: number;
  relatedEvents: string[];
  prediction: string;
}

export interface MetaModelUpdate {
  rule: string;
  previousValue: number;
  newValue: number;
  evidence: string;
}

export interface CrowdWisdom {
  platform: string;
  marketId: string;
  question: string;
  consensusProbability: number;
  volume: number;
  participants: number;
  lastUpdated: Date;
}

export interface AgentConfig {
  signalAgent: {
    sources: SignalSource[];
    pollIntervalMs: number;
    minEngagementThreshold: number;
    maxSignalsPerCycle: number;
  };
  brainAgent: {
    qualityThreshold: number;
    maxConcurrentEvaluations: number;
    historicalLookbackDays: number;
    modelId: string;
  };
  executionAgent: {
    monitorIntervalMs: number;
    autoResolutionEnabled: boolean;
    resolutionConfidenceThreshold: number;
  };
  analystAgent: {
    dailyReportEnabled: boolean;
    weeklyTrendEnabled: boolean;
    reportChannels: ("discord" | "x" | "community")[];
  };
  dreamCycle: {
    enabled: boolean;
    cronExpression: string;
    maxRunTimeMinutes: number;
  };
}
