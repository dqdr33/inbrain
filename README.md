# Inbrain

**The first Self-Evolving Prediction Intelligence Network.**

Inbrain is an AI-driven social prediction infrastructure built on top of [GBrain](https://github.com/garrytan/gbrain)'s knowledge graph and long-term memory system. It transforms raw social signals into high-quality prediction markets with autonomous reasoning, continuous learning, and multi-agent collaboration.

> Traditional prediction markets are amnesiac — no memory, no context, no learning. Inbrain gives prediction markets a brain.

## What makes Inbrain different

| Feature | Traditional Platforms | Inbrain |
|---|---|---|
| Memory | None | Long-term knowledge graph |
| Market creation | Manual | AI-evaluated with quality filtering |
| Odds estimation | Crowd-only | AI + crowd wisdom hybrid |
| Resolution | Manual review | Auto-resolution with evidence verification |
| Learning | Static | Continuous self-evolution via Dream Cycle |
| Intelligence | None | Daily reports, alpha discovery, trend analysis |

## Architecture

```
Signal Agent → Brain Agent → Execution Agent → Analyst Agent
     ↑                                              ↓
     └──────────── Dream Cycle (nightly) ←──────────┘
```

### Four-Layer Agent System

**Signal Agent** — Real-time event detection
- Monitors X (Twitter), news, on-chain data, Polymarket, Kalshi
- Filters by engagement velocity and KOL influence
- Emits structured prediction signals

**Brain Agent** — Central reasoning engine
- Queries Inbrain Memory Graph for historical context
- AI quality evaluation (verifiability, historical similarity, community potential)
- Cross-platform crowd wisdom integration
- Only markets scoring above threshold get created

**Execution Agent** — Market lifecycle management
- Continuous monitoring of active markets
- Real-time probability updates based on new evidence
- Auto-resolution when verifiable outcomes are found
- Brier score tracking for calibration

**Analyst Agent** — Intelligence output
- Daily AI reports with top markets and alpha opportunities
- Weekly trend summaries
- Alpha discovery (AI vs. crowd divergence)
- Distribution to Discord, X, and community

### Dream Cycle (Nightly Self-Evolution)

Every night, Inbrain runs a five-phase self-improvement cycle:

1. **Full Review** — Analyze all markets and prediction accuracy
2. **Forecast Generation** — Predict tomorrow's high-potential markets
3. **Knowledge Gap Discovery** — Find and fill missing data
4. **Meta-Model Update** — Learn calibration patterns (e.g., "KOL tweets in bull markets have 23% higher accuracy")
5. **Community Publishing** — Auto-distribute intelligence reports

## Quick Start

```bash
# Clone and install
git clone https://github.com/inbrain-ai/inbrain.git
cd inbrain
bun install

# Initialize local brain (2 seconds, no Docker)
bun run dev init --pglite

# Start the prediction engine
bun run dev start

# Run a one-off dream cycle
bun run dev dream
```

### Environment Variables

```bash
# Required: AI provider
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Signal sources
INBRAIN_X_BEARER_TOKEN=...        # Twitter/X API
INBRAIN_NEWS_API_KEY=...          # NewsAPI

# Optional: Distribution
INBRAIN_DISCORD_WEBHOOK=...       # Discord reports
```

## Core Capabilities

### From GBrain Foundation
- **Hybrid search** — Vector + BM25 + knowledge graph traversal
- **Self-wiring knowledge graph** — Auto-extracted entity relationships
- **43 curated skills** — Signal capture, enrichment, querying, brain ops
- **PGLite or Postgres** — Zero-config local or production-scale

### Inbrain Prediction Layer
- **AI Market Quality Engine** — Filters out low-quality, unverifiable markets
- **Cross-Platform Crowd Wisdom** — Polymarket + Kalshi + PredictIt consensus
- **Auto-Resolution** — AI-verified market settlement with evidence
- **Prediction Meta-Model** — Self-improving calibration from historical outcomes
- **Alpha Discovery** — Finds markets where AI significantly diverges from crowd

## How it works

```
Real-time Signal → AI Evaluation → Market Creation → Dynamic Monitoring
       → Auto-Resolution → Learning Reinforcement → Better Predictions
```

1. **Signal Agent** detects a trending tweet about ETH ETF approval
2. **Brain Agent** queries memory: "similar events historically resolved at 61% YES"
3. Brain Agent scores quality (verifiability: 85, historical similarity: 72, community: 90)
4. Market is created: "Will ETH ETF be approved by Q1 2027?" with AI estimate 58% YES
5. **Execution Agent** monitors news, updates odds as SEC statements emerge
6. When outcome is confirmed, auto-resolution triggers with evidence links
7. **Dream Cycle** records: "crypto regulation predictions are overconfident by 8%"
8. Next similar market is automatically better calibrated

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **Database**: PGLite (local) / PostgreSQL + pgvector (production)
- **AI**: Claude, GPT-4, Gemini via AI SDK
- **Knowledge Graph**: Auto-wiring entity extraction
- **Protocol**: MCP (Model Context Protocol)
- **Data Sources**: Twitter API, NewsAPI, Polymarket API, Kalshi API

## Contributing

```bash
bun run test          # fast unit tests
bun run verify        # pre-push checks
bun run typecheck     # TypeScript validation
```

## License

MIT — Built on [GBrain](https://github.com/garrytan/gbrain) by Garry Tan (YC President).

## Vision

Inbrain aims to be the **global AI-native Prediction Intelligence Network** — not just for crypto prediction markets, but expandable to:

- Political prediction
- Financial event forecasting
- AI agent markets
- Social trend prediction
- Real-time information verification
- Decentralized Oracle Intelligence

The goal: upgrade prediction markets from betting tools into **next-generation social intelligence infrastructure**.
