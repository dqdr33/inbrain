/**
 * Inbrain Orchestrator — ties the four-agent pipeline together.
 *
 *   Signal → Brain → Execution → Analyst
 *         + nightly Dream Cycle
 *
 * Provides a single entry point for starting the full prediction engine.
 */

import { SignalAgent } from "./signal-agent.js";
import { BrainAgent } from "./brain-agent.js";
import { ExecutionAgent } from "./execution-agent.js";
import { AnalystAgent } from "./analyst-agent.js";
import { DreamCycle } from "./dream-cycle.js";
import type { AgentConfig, PredictionMarket } from "./types.js";

const DEFAULT_CONFIG: AgentConfig = {
  signalAgent: {
    sources: ["x_twitter", "news", "onchain", "polymarket"],
    pollIntervalMs: 60_000,
    minEngagementThreshold: 100,
    maxSignalsPerCycle: 50,
  },
  brainAgent: {
    qualityThreshold: 65,
    maxConcurrentEvaluations: 5,
    historicalLookbackDays: 90,
    modelId: "anthropic/claude-sonnet-4-6",
  },
  executionAgent: {
    monitorIntervalMs: 300_000,
    autoResolutionEnabled: true,
    resolutionConfidenceThreshold: 0.9,
  },
  analystAgent: {
    dailyReportEnabled: true,
    weeklyTrendEnabled: true,
    reportChannels: ["discord"],
  },
  dreamCycle: {
    enabled: true,
    cronExpression: "0 3 * * *", // 3 AM daily
    maxRunTimeMinutes: 60,
  },
};

export interface OrchestratorOptions {
  config?: Partial<AgentConfig>;
  brainQuery?: (query: string) => Promise<string>;
  brainWrite?: (slug: string, content: string) => Promise<void>;
  llmCall?: (
    system: string,
    prompt: string,
    opts?: { model?: string },
  ) => Promise<string>;
}

export class InbrainOrchestrator {
  private signalAgent: SignalAgent;
  private brainAgent: BrainAgent;
  private executionAgent: ExecutionAgent;
  private analystAgent: AnalystAgent;
  private dreamCycle: DreamCycle;

  private config: AgentConfig;
  private resolvedMarkets: PredictionMarket[] = [];
  private dreamTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: OrchestratorOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config };

    this.brainAgent = new BrainAgent({
      qualityThreshold: this.config.brainAgent.qualityThreshold,
      historicalLookbackDays: this.config.brainAgent.historicalLookbackDays,
      modelId: this.config.brainAgent.modelId,
      brainQuery: opts.brainQuery,
      brainWrite: opts.brainWrite,
      llmCall: opts.llmCall,
    });

    this.executionAgent = new ExecutionAgent({
      monitorIntervalMs: this.config.executionAgent.monitorIntervalMs,
      autoResolutionEnabled: this.config.executionAgent.autoResolutionEnabled,
      resolutionConfidenceThreshold:
        this.config.executionAgent.resolutionConfidenceThreshold,
      brainQuery: opts.brainQuery,
      brainWrite: opts.brainWrite,
      llmCall: opts.llmCall,
      onMarketResolved: (_market, _resolution) => {
        this.resolvedMarkets.push(_market);
      },
    });

    this.signalAgent = new SignalAgent({
      sources: this.config.signalAgent.sources,
      pollIntervalMs: this.config.signalAgent.pollIntervalMs,
      minEngagementThreshold:
        this.config.signalAgent.minEngagementThreshold,
      maxSignalsPerCycle: this.config.signalAgent.maxSignalsPerCycle,
      onSignal: async (signal) => {
        const result = await this.brainAgent.evaluate(signal);
        if (result.accepted) {
          this.executionAgent.addMarket(result.market);
        }
      },
    });

    this.analystAgent = new AnalystAgent({
      brainQuery: opts.brainQuery,
      llmCall: opts.llmCall,
    });

    this.dreamCycle = new DreamCycle({
      brainQuery: opts.brainQuery,
      brainWrite: opts.brainWrite,
      llmCall: opts.llmCall,
      getActiveMarkets: () => this.executionAgent.getActiveMarkets(),
      getResolvedMarkets: () => this.resolvedMarkets,
      maxRunTimeMinutes: this.config.dreamCycle.maxRunTimeMinutes,
    });
  }

  async start(): Promise<void> {
    console.log("[inbrain] 🧠 Starting Inbrain Prediction Intelligence Network...");
    console.log("[inbrain] Config:", JSON.stringify(this.config, null, 2));

    await this.signalAgent.start();
    await this.executionAgent.start();

    if (this.config.dreamCycle.enabled) {
      this.scheduleDreamCycle();
    }

    console.log("[inbrain] ✅ All agents running.");
  }

  stop(): void {
    this.signalAgent.stop();
    this.executionAgent.stop();
    if (this.dreamTimer) {
      clearTimeout(this.dreamTimer);
      this.dreamTimer = null;
    }
    console.log("[inbrain] Stopped all agents.");
  }

  async runDreamCycle(): Promise<void> {
    await this.dreamCycle.run();
  }

  async generateDailyReport(): Promise<void> {
    const allMarkets = [
      ...this.executionAgent.getActiveMarkets(),
      ...this.resolvedMarkets,
    ];
    await this.analystAgent.generateDailyReport(allMarkets);
  }

  private scheduleDreamCycle(): void {
    const msUntil3AM = this.msUntilHour(3);
    console.log(
      `[inbrain] Dream cycle scheduled in ${Math.round(msUntil3AM / 60_000)} minutes`,
    );

    this.dreamTimer = setTimeout(async () => {
      await this.dreamCycle.run();
      this.scheduleDreamCycle(); // reschedule for next night
    }, msUntil3AM);
  }

  private msUntilHour(hour: number): number {
    const now = new Date();
    const target = new Date(now);
    target.setHours(hour, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
  }
}
