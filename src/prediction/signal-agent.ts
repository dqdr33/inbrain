/**
 * Signal Agent — real-time event detection layer.
 *
 * Monitors X (Twitter), news feeds, on-chain data, and existing prediction
 * markets for high-potential prediction events.  Emits structured
 * PredictionSignal objects to the Brain Agent for quality evaluation.
 */

import type {
  PredictionSignal,
  SignalSource,
  EngagementMetrics,
} from "./types.js";

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_MIN_ENGAGEMENT = 100;
const DEFAULT_MAX_SIGNALS = 50;

export interface SignalAgentOptions {
  sources?: SignalSource[];
  pollIntervalMs?: number;
  minEngagementThreshold?: number;
  maxSignalsPerCycle?: number;
  onSignal?: (signal: PredictionSignal) => void | Promise<void>;
}

export class SignalAgent {
  private sources: SignalSource[];
  private pollIntervalMs: number;
  private minEngagement: number;
  private maxSignals: number;
  private onSignal?: (signal: PredictionSignal) => void | Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: SignalAgentOptions = {}) {
    this.sources = opts.sources ?? [
      "x_twitter",
      "news",
      "onchain",
      "polymarket",
    ];
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.minEngagement = opts.minEngagementThreshold ?? DEFAULT_MIN_ENGAGEMENT;
    this.maxSignals = opts.maxSignalsPerCycle ?? DEFAULT_MAX_SIGNALS;
    this.onSignal = opts.onSignal;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log(
      `[signal-agent] started — monitoring ${this.sources.join(", ")}`,
    );
    await this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log("[signal-agent] stopped");
  }

  private async poll(): Promise<void> {
    const signals: PredictionSignal[] = [];

    for (const source of this.sources) {
      try {
        const batch = await this.fetchSignals(source);
        signals.push(...batch);
      } catch (err) {
        console.error(`[signal-agent] error fetching ${source}:`, err);
      }
    }

    const filtered = signals
      .filter((s) => this.meetsThreshold(s))
      .sort(
        (a, b) =>
          (b.engagement?.velocityPerHour ?? 0) -
          (a.engagement?.velocityPerHour ?? 0),
      )
      .slice(0, this.maxSignals);

    for (const signal of filtered) {
      if (this.onSignal) {
        await this.onSignal(signal);
      }
    }

    if (filtered.length > 0) {
      console.log(
        `[signal-agent] emitted ${filtered.length} signals from ${this.sources.length} sources`,
      );
    }
  }

  private meetsThreshold(signal: PredictionSignal): boolean {
    if (!signal.engagement) return false;
    const total =
      signal.engagement.likes +
      signal.engagement.reposts +
      signal.engagement.replies;
    return total >= this.minEngagement;
  }

  private async fetchSignals(
    source: SignalSource,
  ): Promise<PredictionSignal[]> {
    switch (source) {
      case "x_twitter":
        return this.fetchTwitterSignals();
      case "news":
        return this.fetchNewsSignals();
      case "onchain":
        return this.fetchOnchainSignals();
      case "polymarket":
        return this.fetchPolymarketSignals();
      case "kalshi":
        return this.fetchKalshiSignals();
      default:
        return [];
    }
  }

  private async fetchTwitterSignals(): Promise<PredictionSignal[]> {
    // Twitter/X API integration — uses bearer token from INBRAIN_X_BEARER_TOKEN
    const token = process.env.INBRAIN_X_BEARER_TOKEN;
    if (!token) return [];

    try {
      const response = await fetch(
        "https://api.twitter.com/2/tweets/search/recent?" +
          new URLSearchParams({
            query:
              "(crypto OR bitcoin OR ethereum OR prediction OR market) -is:retweet lang:en",
            max_results: "20",
            "tweet.fields":
              "public_metrics,author_id,created_at,entities,context_annotations",
            expansions: "author_id",
            "user.fields": "public_metrics,verified",
          }),
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (!response.ok) return [];

      const data = (await response.json()) as {
        data?: Array<{
          id: string;
          text: string;
          author_id: string;
          created_at: string;
          public_metrics: {
            like_count: number;
            retweet_count: number;
            reply_count: number;
            impression_count: number;
          };
          entities?: { annotations?: Array<{ normalized_text: string }> };
        }>;
        includes?: {
          users?: Array<{
            id: string;
            username: string;
            public_metrics: { followers_count: number };
          }>;
        };
      };

      const users = new Map(
        (data.includes?.users ?? []).map((u) => [u.id, u]),
      );

      return (data.data ?? []).map((tweet) => {
        const user = users.get(tweet.author_id);
        const metrics = tweet.public_metrics;
        const hoursSincePost =
          Math.max(
            Date.now() - new Date(tweet.created_at).getTime(),
            3_600_000,
          ) / 3_600_000;

        return {
          id: `x_${tweet.id}`,
          source: "x_twitter" as const,
          content: tweet.text,
          author: user?.username,
          authorInfluence: Math.log10(
            (user?.public_metrics.followers_count ?? 1) + 1,
          ),
          timestamp: new Date(tweet.created_at),
          url: user
            ? `https://x.com/${user.username}/status/${tweet.id}`
            : undefined,
          engagement: {
            likes: metrics.like_count,
            reposts: metrics.retweet_count,
            replies: metrics.reply_count,
            views: metrics.impression_count,
            velocityPerHour:
              (metrics.like_count + metrics.retweet_count) / hoursSincePost,
          },
          entities:
            tweet.entities?.annotations?.map((a) => a.normalized_text) ?? [],
          sentiment: undefined,
        };
      });
    } catch {
      return [];
    }
  }

  private async fetchNewsSignals(): Promise<PredictionSignal[]> {
    const key = process.env.INBRAIN_NEWS_API_KEY;
    if (!key) return [];

    try {
      const response = await fetch(
        "https://newsapi.org/v2/everything?" +
          new URLSearchParams({
            q: "crypto OR prediction market OR bitcoin OR ethereum",
            sortBy: "publishedAt",
            pageSize: "20",
            language: "en",
            apiKey: key,
          }),
      );
      if (!response.ok) return [];

      const data = (await response.json()) as {
        articles?: Array<{
          title: string;
          description: string;
          url: string;
          publishedAt: string;
          source: { name: string };
        }>;
      };

      return (data.articles ?? []).map((article, i) => ({
        id: `news_${Date.now()}_${i}`,
        source: "news" as const,
        content: `${article.title}\n\n${article.description ?? ""}`,
        author: article.source.name,
        timestamp: new Date(article.publishedAt),
        url: article.url,
        engagement: { likes: 0, reposts: 0, replies: 0 },
        entities: [],
      }));
    } catch {
      return [];
    }
  }

  private async fetchOnchainSignals(): Promise<PredictionSignal[]> {
    // On-chain event detection — whale transfers, governance votes, etc.
    // Uses Alchemy / Infura / public RPCs
    return [];
  }

  private async fetchPolymarketSignals(): Promise<PredictionSignal[]> {
    try {
      const response = await fetch(
        "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&order=volume24hr&ascending=false",
      );
      if (!response.ok) return [];

      const markets = (await response.json()) as Array<{
        id: string;
        question: string;
        volume24hr: number;
        liquidity: number;
        outcomePrices: string;
        endDate: string;
      }>;

      return markets.map((m) => ({
        id: `poly_${m.id}`,
        source: "polymarket" as const,
        content: m.question,
        timestamp: new Date(),
        engagement: {
          likes: Math.round(m.volume24hr),
          reposts: 0,
          replies: 0,
          velocityPerHour: m.volume24hr / 24,
        },
        entities: [],
        rawData: {
          volume24hr: m.volume24hr,
          liquidity: m.liquidity,
          outcomePrices: m.outcomePrices,
          endDate: m.endDate,
        },
      }));
    } catch {
      return [];
    }
  }

  private async fetchKalshiSignals(): Promise<PredictionSignal[]> {
    try {
      const response = await fetch(
        "https://api.elections.kalshi.com/trade-api/v2/markets?limit=20&status=open",
      );
      if (!response.ok) return [];

      const data = (await response.json()) as {
        markets?: Array<{
          ticker: string;
          title: string;
          volume: number;
          yes_ask: number;
          close_time: string;
        }>;
      };

      return (data.markets ?? []).map((m) => ({
        id: `kalshi_${m.ticker}`,
        source: "kalshi" as const,
        content: m.title,
        timestamp: new Date(),
        engagement: {
          likes: m.volume,
          reposts: 0,
          replies: 0,
        },
        entities: [],
        rawData: {
          volume: m.volume,
          yesAsk: m.yes_ask,
          closeTime: m.close_time,
        },
      }));
    } catch {
      return [];
    }
  }
}
