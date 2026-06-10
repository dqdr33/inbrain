# Inbrain Deployment Topologies

Inbrain supports three deployment shapes. They compose: a single user can mix
all three on the same machine without conflict, because every shape resolves
to "which `~/.inbrain/config.json` is active right now?" and `INBRAIN_HOME`
controls that selection.

This page covers the three topologies, when each fits, and concrete setup
recipes. Pair this doc with `docs/architecture/brains-and-sources.md` (which
covers the in-brain organization axes) — that doc is about WHICH database;
this doc is about WHERE that database lives.

## Quick decision tree

```
   "I'm setting up inbrain..."
        │
        ▼
  Just for me, on one machine? ─── yes ───▶ Topology 1 (single brain)
        │
        no
        │
        ▼
  Will a remote machine host the brain
  while my agent runs locally? ──── yes ───▶ Topology 2 (cross-machine thin client)
        │
        no
        │
        ▼
  Multiple Conductor worktrees that
  shouldn't share a code index? ─── yes ───▶ Topology 3 (split-engine)
```

Topologies 2 and 3 stack: a thin-client install can also host per-worktree
code engines, and a per-worktree code engine can also point its artifact
brain at a remote server.

## Topology 1 — Single brain (today's default)

```
  ┌────────────────┐
  │   one machine  │
  │  ┌──────────┐  │
  │  │  inbrain  │──┼──→  ~/.inbrain/  →  PGLite  or  Supabase
  │  │   CLI    │  │
  │  └──────────┘  │
  └────────────────┘
```

What you get: one local DB (PGLite for small brains, Supabase for ~1000+
files). All commands work directly against it. `inbrain serve` exposes it
to a single agent over MCP.

When it fits: solo use, single machine, one agent, no Conductor parallelism.
This is the default; `inbrain init` (no flags) gives you this.

Setup:

```
inbrain init           # interactive — defaults to PGLite
inbrain init --pglite  # explicit local
inbrain init --supabase  # remote Supabase (recommended for 1000+ files)
```

Nothing else here is special. The other two topologies are variations on
"who owns the DB" and "how does the agent talk to it."

## Topology 2 — Cross-machine thin client

```
  ┌────────────┐                    ┌──────────────────┐
  │ neuromancer│                    │    brain-host    │
  │ ┌────────┐ │ HTTP MCP / OAuth   │  ┌────────────┐  │
  │ │ Hermes │─┼───────────────────→│  │   inbrain   │──┼──→ Supabase
  │ │ agent  │ │                    │  │ serve --http│  │
  │ └────────┘ │                    │  └────────────┘  │
  │            │                    │   (with autopilot)│
  │  no local  │                    │                  │
  │  inbrain DB │                    │                  │
  └────────────┘                    └──────────────────┘
```

What you get: the agent on one machine ("neuromancer") consumes a brain
hosted on another machine ("brain-host") over HTTP MCP with OAuth. The
agent's machine has NO local engine. All queries, searches, embeddings,
and indexing happen on the host.

When it fits:

- Heavy brain (Supabase + autopilot) lives on a beefy machine; agents
  elsewhere just consume it.
- You want one source of truth across many machines.
- Spinning up a parallel local install would create source-ID contention or
  duplicate work.

The thin client's `~/.inbrain/config.json` carries a `remote_mcp` field
instead of a local DB connection:

```jsonc
{
  "engine": "postgres",  // ignored — never used
  "remote_mcp": {
    "issuer_url": "https://brain-host.local:3001",
    "mcp_url":    "https://brain-host.local:3001/mcp",
    "oauth_client_id": "neuromancer-...",
    "oauth_client_secret": "..."  // or set INBRAIN_REMOTE_CLIENT_SECRET
  }
}
```

The CLI dispatch guard refuses any DB-bound command (`sync`, `embed`,
`extract`, `migrate`, `apply-migrations`, `repair-jsonb`, `orphans`,
`integrity`, `serve`) on a thin-client install with a clear error pointing
at the remote host. `inbrain doctor` runs a dedicated thin-client check set
(OAuth discovery, token round-trip, MCP smoke).

### Setup

**Step 1 — On the host (brain-host):**

```bash
inbrain init --supabase                         # or --pglite, doesn't matter
inbrain serve --http --port 3001 --bind 0.0.0.0 # v0.34: bind explicitly for remote access
                                                # (defaults to 127.0.0.1 since v0.34)
inbrain auth register-client neuromancer \
  --grant-types client_credentials \
  --scopes read,write,admin                    # admin needed for ping/doctor

# v0.34: source-scoped client (write to one source, federate reads across
# multiple sources). Omit both flags for a v0.33-compatible super-client.
inbrain auth register-client neuromancer-dept \
  --grant-types client_credentials \
  --scopes read,write \
  --source dept-x \
  --federated-read dept-x,shared,parent-canon
```

The `register-client` command prints a `client_id` and `client_secret`.
Note both. **Scope must include `admin`** — `submit_job` (used by
`inbrain remote ping`) and `run_doctor` (used by `inbrain remote doctor`)
both require it.

**Step 2 — On the thin client (neuromancer):**

```bash
inbrain init --mcp-only \
  --issuer-url https://brain-host.local:3001 \
  --mcp-url https://brain-host.local:3001/mcp \
  --oauth-client-id <id> \
  --oauth-client-secret <secret>
```

Pre-flight smoke runs three probes (OAuth discovery, token round-trip,
MCP initialize). If any fails, init exits with an actionable error. On
success, `~/.inbrain/config.json` gets `remote_mcp` set and NO local DB
is created.

**Step 3 — Configure your agent's MCP client.**

For Claude Desktop / Hermes / openclaw, add a single MCP server entry
pointing at the host's `mcp_url` with the bearer token from `register-client`.
Example for Claude Desktop's `~/.config/claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "inbrain": {
      "type": "url",
      "url": "https://brain-host.local:3001/mcp",
      "headers": { "Authorization": "Bearer <client_secret>" }
    }
  }
}
```

**Step 4 — Verify.**

```bash
inbrain doctor             # runs thin-client checks (no local DB needed)
inbrain remote ping        # triggers an autopilot cycle on the host (Tier B)
inbrain remote doctor      # asks the host to run its own doctor (Tier B)
```

`inbrain sync` and friends will refuse with a clear thin-client error
naming the `mcp_url`. That's the correct behavior — those commands need
a local engine that doesn't exist here.

### Re-run guard

Running `inbrain init` (no flags) on a machine that already has thin-client
config set refuses without `--force`. This catches the scripted-setup-loop
friction where an orchestrator keeps trying to create a local DB. Use
`inbrain init --mcp-only --force` to refresh thin-client config.

### Storing the OAuth secret

Three storage paths in priority order:

1. **`INBRAIN_REMOTE_CLIENT_SECRET` env var** (preferred for headless agents).
   When set, overrides whatever's in the config file. The init flow doesn't
   persist a config-file copy when the env var was the source.
2. **`~/.inbrain/config.json` with 0600 perms** (default for interactive
   setup; mirrors how Supabase keys are stored today).
3. macOS Keychain integration is on the roadmap; not in v1.

## Topology 3 — Split-engine, per-worktree code + remote artifacts

```
  ┌──────────────────────────────────────────────────────┐
  │                  one machine                         │
  │                                                      │
  │  ┌─ worktree A ──────────────┐                       │
  │  │  INBRAIN_HOME=A/.conductor │                       │
  │  │  inbrain serve --port 3001 │── PGLite (code A)     │
  │  └───────────────────────────┘                       │
  │                                                      │
  │  ┌─ worktree B ──────────────┐                       │
  │  │  INBRAIN_HOME=B/.conductor │                       │
  │  │  inbrain serve --port 3002 │── PGLite (code B)     │
  │  └───────────────────────────┘                       │
  │                                                      │
  │  ┌─ default ~/.inbrain ───────┐    HTTP MCP / OAuth   │
  │  │  inbrain serve --port 3000 │──────────────────────→ remote artifacts
  │  └───────────────────────────┘                        (Supabase / brain-host)
  │                                                      │
  │  Agent's MCP config (Hermes / Claude Desktop):       │
  │    mcp__inbrain_code__*       → http://localhost:3001 │
  │    mcp__inbrain_artifacts__*  → http://brain-host/mcp │
  └──────────────────────────────────────────────────────┘
```

What you get: each Conductor worktree has its own per-worktree code index
(local PGLite, disposable when the worktree dies). Artifacts (plans,
learnings, transcripts) still live in a shared brain that all worktrees
can see and write to.

When it fits:

- Multiple Conductor worktrees on one machine, all touching the same code
  repo.
- You don't want each worktree's code-import to clobber the others'
  `last_commit`, source IDs, or symbol tables.
- You DO want artifacts (plans, learnings, retros, transcripts) to be
  visible across worktrees.

### How it works

`INBRAIN_HOME` selects which `~/.inbrain` directory is active. Set per worktree:

```bash
export INBRAIN_HOME=/path/to/worktree-A/.conductor/inbrain
inbrain init --pglite
inbrain serve --http --port 3001
```

Each worktree's `inbrain serve` instance binds its own port and indexes its
own DB. Multiple `inbrain serve` processes coexist fine — they're separate
OS processes with separate config and separate connection pools.

The artifact brain runs as a separate `inbrain serve` instance with the
default `~/.inbrain` (no INBRAIN_HOME override) — or remote, in which case
it's a Topology 2 setup.

The agent's MCP client config lists multiple servers, each with a unique
alias. Tool names are namespaced as `mcp__<alias>__<tool>`, so the agent
calls `mcp__inbrain_code__search` for code lookups and `mcp__inbrain_artifacts__search`
for artifact lookups.

### Recommended embedding model

Per-worktree code brains index source files only — no meeting notes,
no people pages, no transcripts. Configure each code brain to use
Voyage's code-tuned model at init time so the config can't be lost to a
later `init` overwrite:

```bash
export INBRAIN_HOME=/path/to/worktree-A/.conductor/inbrain
inbrain init --pglite \
  --embedding-model voyage:voyage-code-3 \
  --embedding-dimensions 1024
```

`voyage-code-3` is Voyage's code-specialized embedding model with
head-to-head numbers above their general flagships on code retrieval
([voyageai.com/blog](https://voyageai.com/blog)). For already-initialized
brains, switch with the one-command wipe-and-reinit (preserves every
other config field):

```bash
inbrain reinit-pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024
inbrain reindex --code --yes
```

(`inbrain config set embedding_model` is refused as of v0.37.11.0 because
the schema column has to resize alongside the config.)

`inbrain reindex --code` prints a recommendation when the configured
embedding model isn't code-tuned. Suppress with
`INBRAIN_NO_CODE_MODEL_NUDGE=1` if you've intentionally chosen another
provider (single-vendor procurement, compliance, no Voyage key).

### CRITICAL: alias-level routing is manual

Topology 3 has no smart per-tool routing inside inbrain. The agent picks
which brain to query when it picks the alias. **A wrong alias writes (or
queries) the wrong brain silently.** This is intentional (explicit beats
magic) but real:

- If the agent calls `mcp__inbrain_artifacts__put_page` with code-shaped
  content, that page lands in the artifact brain forever.
- If the agent calls `mcp__inbrain_code__search` for a question that
  actually wants artifact context, the search comes back empty.

Mitigations:

- Name aliases clearly. `inbrain_code` vs `inbrain_artifacts` is unambiguous;
  `inbrain` vs `inbrain_local` is not.
- Document in your agent's system prompt or rules which alias goes where.
  Be explicit about "code questions → `inbrain_code`; everything else →
  `inbrain_artifacts`."
- Pair Topology 3 with `gstack`'s per-worktree wiring (which sets the
  alias names + agent rules consistently across worktrees).

### Setup (manual; gstack automates this side)

The inbrain side requires zero new code — `INBRAIN_HOME` and `--port` already
exist. Setup looks like:

```bash
# Start the artifact brain (default ~/.inbrain) on port 3000
inbrain serve --http --port 3000 &

# Start a per-worktree code brain on port 3001
export INBRAIN_HOME=/path/to/worktree-A/.conductor/inbrain
inbrain init --pglite
inbrain serve --http --port 3001 &
unset INBRAIN_HOME
```

Then configure the agent's MCP config with two entries (different aliases,
different ports). For Claude Desktop:

```jsonc
{
  "mcpServers": {
    "inbrain_artifacts": {
      "type": "url",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <token-A>" }
    },
    "inbrain_code": {
      "type": "url",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer <token-B>" }
    }
  }
}
```

The gstack-side wiring (per-worktree home setup, port allocation, automatic
MCP config generation, gitignore for the per-worktree DB) is in the gstack
repo's setup-inbrain skill — it composes these primitives, inbrain doesn't
have to know about Conductor.

## Combining topologies

The three shapes compose. A single machine can run:

- A thin-client default config pointing at a remote artifact brain
  (Topology 2).
- Plus per-worktree code brains under their own `INBRAIN_HOME` (Topology 3).
- Each worktree's `inbrain serve` instance is local; the agent's MCP config
  lists them alongside the remote artifact brain.

`INBRAIN_HOME` controls which config file is active for any one CLI
invocation. `inbrain serve --port` controls which port a server listens on.
The agent's MCP client picks the alias and thus the destination per tool
call. There's no global inbrain orchestrator that knows about all of them
simultaneously — that's by design.

## When NOT to use these topologies

- **Don't use Topology 2 if your agent only ever runs on the same machine
  as the brain.** A local `inbrain` install + `inbrain serve` (stdio) is
  simpler and faster.
- **Don't use Topology 3 if you only have one Conductor worktree at a
  time.** Per-worktree engines exist to prevent contention; one-at-a-time
  use has no contention.
- **Don't use a `remote_mcp` thin client AND a local engine on the same
  machine in the same `INBRAIN_HOME`.** The dispatch guard refuses DB-bound
  commands when `remote_mcp` is set. If you genuinely want both modes on
  one machine, use `INBRAIN_HOME` to separate them (one home for the thin
  client, another for the local engine).

## See also

- `docs/architecture/brains-and-sources.md` — in-brain organization (brains
  vs sources axes).
- `docs/mcp/CLAUDE_DESKTOP.md` and siblings — per-client MCP setup.
- `inbrain init --help` and `inbrain auth --help` for command-level details.
- [`docs/tutorials/`](../tutorials/) — end-to-end walkthroughs that combine
  these topologies into working setups (company brain, personal brain,
  agent integration, etc.).
