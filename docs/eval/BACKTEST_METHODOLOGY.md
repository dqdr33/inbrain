# Prediction backtest methodology

How the prediction pipeline is scored against history, what the numbers mean,
and — most importantly — the specific ways this measurement can lie to you.

## The question this answers

The live pipeline forecasts events that have not happened yet, so its accuracy
cannot be known for months. A backtest replays *resolved* markets at a past
as-of date, asks the pipeline for a probability using only what was knowable
then, and scores it against the outcome that is now known.

That gives a read on calibration in hours instead of quarters. It also, done
carelessly, gives a spectacular number that means nothing.

## Running it

```bash
# 1. Fetch resolved markets + their price history (once; cached to disk)
bun run scripts/backtest-fetch.ts --limit 150 --min-volume 200000

# 2. The real run: the model sees the venue price, as it does live
bun run scripts/backtest-run.ts --limit 90 --offsets 30,90,180

# 3. The control run: identical, but the price is withheld
bun run scripts/backtest-run.ts --limit 90 --offsets 30,90,180 --blind

# 4. Read them together. Never read step 2 alone.
bun run scripts/backtest-score.ts --compare
```

`backtest-score.ts` re-scores saved results without LLM calls, so fixing a
metric bug costs a second rather than a whole run.

## Running it unattended

The backtest is never urgent — it scores history, and history does not move.
What it must never do is spend the paid Gemini key, which is reserved for the
live prediction cycle.

```bash
bun run backtest:status   # lanes, quota, last outcome — changes nothing
bun run backtest:auto     # one slice IF free quota exists, else exit 0
bun run backtest:commit   # bank run data to the backtest-data branch
```

`backtest-auto.ts` reads the existing key pool and refuses when only the paid
key is available, exiting 0 in milliseconds having spent nothing. That is what
makes a frequent schedule safe.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backtest-schedule.ps1
powershell -ExecutionPolicy Bypass -File scripts\backtest-schedule.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\backtest-schedule.ps1 -Remove
```

Hourly is deliberate: Google resets free quota at Pacific midnight and the live
cycle competes for the same daily budget, so checking often and backing off
instantly beats one daily attempt that may land when the pool is dry. Slices
default to 20 forecasts (~40 calls) to leave that budget largely intact.

The runner prefers the **blind** lane until it reaches target, because without
the control the priced numbers cannot be distinguished from memorised outcomes.

### Why slices resume instead of re-sampling

Task order is a deterministic shuffle from a fixed seed, and each forecast has a
stable id (`backtest_<venue>_<market>_<as-of-date>`). `--append` skips ids
already banked, so slice N+1 continues slice N's walk. Results are written after
every chunk, so a killed slice keeps what it paid for.

### Run data lives on its own branch

Code and measurement have opposite lifecycles. Code is reviewed, bisected and
read as history; run data is append-only output that grows by a slice per tick.
Mixed into `main` it would drown `git log`, wreck `git bisect`, and bloat every
clone permanently.

So `scripts/backtest-commit.ts` commits results to **`backtest-data`**, an
orphan branch with no shared history with `main` — a filing cabinet in the same
repo, not a fork of the code. It works through a temporary git index, so the
working tree is never touched and there is no branch switch to get stuck
halfway.

The branch advances only when *forecast* data changes. Comparing whole trees was
not enough: `.backtest-progress.json` carries `lastRunAt` and a quota-wait
counter that move on every tick, which would mint an empty commit an hour.

Snapshots are deliberately **not** committed — a large, regenerable cache of
public venue data. Run data is not pushed automatically; publish with
`git push origin backtest-data`.

## Design

### Snapshots, not live fetches

`scripts/backtest-fetch.ts` writes `.backtest-snapshots.json` once; scoring runs
read only that file. A scoring run that hit the network could pick up
post-resolution information about the market it is mid-forecast on, and the
resulting score would be unfalsifiable.

Source: Polymarket gamma (`closed=true`) for questions + settled outcomes, CLOB
`prices-history` for the daily price curve.

### What counts as a scorable market

Filtered at fetch time:

- **Genuine Yes/No only.** Polymarket reuses the binary contract for
  "Team A vs Team B" and over/under markets, where "Yes" labels a side rather
  than asserting a proposition. Scoring those mixes different questions into one
  calibration curve.
- **Settled to 1/0.** A 50-50 void has no binary truth. Coercing it to `false`
  would score the model as wrong about an event that never resolved either way.
- **Liquid** (`--min-volume`, default 100k). A market nobody traded has no
  price discovery, so beating its "price" proves nothing.
- **Has price history.** No history means no as-of price is knowable.

### As-of pricing is strict by design

`priceAsOf` returns the last trade **at or before** the as-of instant, and
returns `null` rather than approximating when the as-of date predates all
recorded history. Returning the nearest point, or falling back to the first
known price, would import a price set *after* the as-of date. That is the
central leak this whole module exists to prevent.

`viewAsOf` additionally rejects a market when:

| Rejection | Why |
|---|---|
| as-of at/after close | the outcome is known or imminent |
| as-of before creation | nothing existed to forecast |
| horizon < 3 days | a market closing in hours is priced ~0/~1; including these manufactures fake accuracy |
| no price knowable | see above |

### The agent cannot tell it is being backtested

`BrainAgent` takes `now: () => Date`. The replay freezes it at the as-of date,
so the `TODAY IS` line in both prompts, the days-to-deadline horizon, `createdAt`
and the expiry fallback all read the historical date. The signal's own
`timestamp` is the as-of date too — the agent serialises the whole signal into
the quality prompt, so a real timestamp there would hand it the present in a
field nobody thinks to check.

The brain is empty by default (`noBrainContext`). A live brain cannot be
date-filtered reliably — its notes carry ingest dates, not statement-validity
dates — and one post-resolution note about the market under test invalidates the
run. An empty context is weaker than a correct historical brain but it is
honest, which is what matters when the output is a claim about skill.

## Metrics

Defined in `src/prediction/scoring.ts`.

| Metric | Reads as |
|---|---|
| **Brier** | mean squared error vs the 0/1 outcome. 0 perfect, 0.25 = "always 50%" |
| **Log loss** | punishes confident mistakes far harder than Brier |
| **ECE** | average gap between claimed and observed frequency |
| **Reliability bins** | *where* the miscalibration is; the diagnostic a correction layer acts on |
| **Skill vs baseline** | fractional improvement. **≤ 0 means no edge** |

### Why skill is printed above raw Brier

Prediction venues are dominated by "will X happen by date Y" questions, and most
resolve NO. Our sample runs ~13% YES. On that skew, a model that ignores the
question and always answers the base rate scores a Brier around 0.11 — which
*looks* good.

Three baselines are therefore scored alongside the model:

- **base rate** — the constant that skew makes deceptively hard to beat
- **always-50%** — the floor; losing to it means something is inverted
- **market price** — the only one that matters commercially

A model that cannot beat the venue quote has no betting edge no matter how good
its Brier looks. `formatScorecard` leads with skill for exactly this reason.

The market baseline is scored **on the same subset** as the model. Comparing a
model average over all records against a market average over the priced subset
would be two different questions on two different samples.

### Degenerate samples

When every record in a bucket resolved the same way, the base-rate constant is
right by construction and its Brier collapses to ~0, so the skill ratio explodes
to an arbitrarily large negative number that looks like a catastrophic finding
and is pure artifact. `skillScore` returns `NaN` below a reference of 1e-9, and
the scorecard labels the bucket `[degenerate]`.

### Parse-failure fallbacks are not forecasts

`BrainAgent` answers 0.5 at confidence 0.1 when the model's JSON cannot be
parsed — a transport failure shaped like a forecast. Scoring it as a real 50%
call is wrong twice: it inflates Brier against the usual NO outcome, and it
fabricates a "maximum divergence from market" no model expressed.

These are recorded as `NaN` and dropped, with the count reported. In the first
real run they were 6 of 75 rows (8%), and excluding them moved measured skill vs
market from **-0.76 to -0.31** — i.e. more than half the apparent deficit was
instrumentation.

## The control run is not optional

**An LLM asked about a market that resolved before its training cutoff may
simply remember the outcome.** It is not forecasting; it is recalling. This
produces excellent backtest scores and zero live skill, and no amount of
statistical care on the priced run alone can detect it.

`--blind` withholds the venue price (removed from `rawData`, not merely from the
prompt — `crowd.ts` recovers the quote from `rawData`, and a leftover field
would silently re-anchor the control). Everything else is identical, including
the as-of date.

Read the two together:

- **Blind collapses toward the base rate** → the priced run's edge comes from
  the market anchor. Honest result.
- **Blind retains real skill** → you are measuring recall. Treat the priced
  numbers as an upper bound and re-run on markets that closed *after* the
  model's cutoff.

`backtest-score.ts --compare` prints this verdict explicitly rather than leaving
it to the reader.

## Known limitations

**Sample size.** ~70 scorable forecasts gives wide error bars. Most reliability
bins are thin (marked `(thin)` when n < 5); a 100% observed frequency over 1
sample is not a finding. No paired-bootstrap CI is computed yet.

**Venue monoculture.** Polymarket only. Kalshi's settled markets carry the same
shape and the snapshot type already anticipates it, but no fetcher exists.

**Survivorship.** Markets are selected by volume among those that *resolved*.
Cancelled and re-formulated markets are absent, which biases toward the
tractable. A stricter design would fix the market list as of the as-of date.

**Empty brain.** The pipeline's retrieval layer is switched off, so this scores
the estimator, not the full system. The live pipeline may do better (real
context) or worse (self-reference contamination — see the `stripSelfReference`
comment in `brain-agent.ts`).

**Backtest ≠ forward test.** Backtesting is for debugging the pipeline and rough
calibration. The only unimpeachable evidence is a forward test: record forecasts
on open markets, wait, score. Slow, but it cannot be gamed by memorisation.

## First run: results

75 evaluated, 69 scorable, gemini-2.5-flash, offsets 30/90/180d, base rate 13% YES.

| | Model | Market | Base rate | Always-50% |
|---|---|---|---|---|
| Brier | 0.0602 | **0.0460** | 0.1134 | 0.2500 |
| Skill | — | **-0.309** | +0.469 | +0.759 |

Calibration is good where the mass is: the 0-10% bin (47 of 69 forecasts) claims
2.1% and observes 2.1%. The mid-range bins are thin and noisy.

**The headline -0.309 skill vs market is one row.** "TikTok banned in the US
before May 2025?" — market 99.6%, model 1%, resolved YES — contributes 0.98 of
the 0.98 total excess Brier. Excluding it, the model's excess over the market
across the other 68 forecasts is **0.0006**: indistinguishable from the market,
beating it on 35 and losing on 33.

That single failure is worth more than the aggregate. The model's stated
reasoning was that the divest-or-ban law "has not yet passed the Senate and has
not been signed into law" as of 2025-01-30. It was signed in April 2024 and the
ban took effect on 2025-01-19 — eleven days *before* the as-of date. The model
asserted a false world state at 90% confidence and priced against a market that
was correctly at 99.6%.

This is a knowledge-cutoff hallucination, not a calibration problem, and it is
the opposite of the memorisation failure the blind run is designed to catch. It
argues for a guard on large departures from a near-certain market price: at
`|model - market| > 0.5` with market beyond 90/10, the model's world-model is a
more likely culprit than the market's.
