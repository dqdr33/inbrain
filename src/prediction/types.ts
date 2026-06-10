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
  | "manual";

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
  predictionsAccuracy: number;
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
