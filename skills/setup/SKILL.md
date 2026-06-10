---
name: setup
description: Set up Inbrain with auto-provision Supabase or PGLite, AGENTS.md injection, first import
triggers:
  - "set up inbrain"
  - "initialize brain"
  - "inbrain setup"
tools:
  - get_stats
  - get_health
  - sync_brain
  - put_page
mutating: true
---

# Setup Inbrain

Set up Inbrain from scratch. Target: working brain in under 5 minutes.

## Contract

- Setup completes with a working brain verified by `inbrain doctor --json` (all checks OK).
- The brain-first lookup protocol is injected into the project's AGENTS.md or equivalent.
- Live sync is configured and verified (a test change pushed and found via search).
- Schema state is tracked in `~/.inbrain/update-state.json` so future upgrades know what the user adopted or declined.
- No Supabase anon key is requested; Inbrain uses only the database connection string.

## Install (if not already installed)

```bash
bun add github:inbrain-ai/inbrain
```

## How Inbrain connects

Inbrain connects directly to Postgres over the wire protocol. NOT through the
Supabase REST API. You need the **database connection string** (a `postgresql://` URI),
not the project URL or anon key. The password is embedded in the connection string.

Use the **Transaction pooler** connection string (port 6543), not the direct
connection (port 5432). The direct hostname resolves to IPv6 only, which many
environments can't reach. Find it: click **Connect** in the top navigation bar,
then **Connection String** > **Transaction pooler**, and copy the string.

**Do NOT ask for the Supabase anon key.** Inbrain doesn't use it.

## Why Supabase

Supabase gives you managed Postgres + pgvector (vector search built in) for $25/mo:
- 8GB database + 100GB storage on Pro tier
- No server to manage, automatic backups, dashboard for debugging
- pgvector pre-installed, just works
- Alternative: any Postgres with pgvector extension (self-hosted, Neon, Railway, etc.)

## Prerequisites

- A Supabase account (Pro tier recommended, $25/mo) OR any Postgres with pgvector
- An OpenAI API key (for semantic search embeddings, ~$4-5 for 7,500 pages)
- A git-backed markdown knowledge base (or start fresh)

## Available init options

- `inbrain init --supabase` -- interactive wizard (prompts for connection string)
- `inbrain init --url <connection_string>` -- direct, no prompts
- `inbrain init --non-interactive --url <connection_string>` -- for scripts/agents
- `inbrain doctor --json` -- health check after init

There is no `--local`, `--sqlite`, or offline mode. Inbrain requires Postgres + pgvector
(local PGLite or remote Supabase / self-hosted).

## Phase A.5: Choose Topology (run BEFORE Phase A)

Inbrain supports three deployment shapes. Pick the right one before installing,
because picking wrong creates contention or duplicate work that's painful to
unwind. Read `docs/architecture/topologies.md` for the full picture; the short
version:

Ask the user this BEFORE running `inbrain init`:

> "Three deployment shapes:
>  1. **Single brain (default)** — one machine, one DB, one agent. Pick this if
>     unsure.
>  2. **Cross-machine thin client** — your brain lives on another machine
>     (e.g. brain-host) running `inbrain serve --http`, and this install just
>     calls it over MCP. No local DB on this machine.
>  3. **Per-worktree code + shared remote artifacts** — Conductor users with
>     multiple worktrees indexing the same code repo. Each worktree owns its
>     own code engine; artifacts live on a shared remote brain. For code
>     engines, configure Voyage's code-tuned model:
>     `inbrain init --pglite --embedding-model voyage:voyage-code-3 --embedding-dimensions 1024`
>     (full guidance in `docs/architecture/topologies.md` Topology 3).
>
>  Which fits?"

### If the user picks 1 (single brain) — proceed to Phase A

Continue with the existing `inbrain init --supabase` / `--pglite` setup below.

### If the user picks 2 (cross-machine thin client)

1. **Confirm a host already exists.** Ask: "Is the remote `inbrain serve --http`
   already running on the host machine?" If no, the user needs to set up the
   host first (Phases A-C on the host, then `inbrain serve --http`). Don't try
   to run init on this machine until the host is up.

2. **Get OAuth credentials from the host operator.** Ask the user to run
   on the host:
   ```bash
   inbrain auth register-client <name> \
     --grant-types client_credentials \
     --scopes read,write,admin
   ```
   The `admin` scope is required because `inbrain remote ping` and
   `inbrain remote doctor` (Tier B convenience commands) call MCP ops with
   `admin` scope. `read,write` alone breaks ping/doctor.

3. **Run thin-client init on this machine:**
   ```bash
   inbrain init --mcp-only \
     --issuer-url https://<host>:<port> \
     --mcp-url https://<host>:<port>/mcp \
     --oauth-client-id <id> \
     --oauth-client-secret <secret>
   ```
   Or set `INBRAIN_REMOTE_CLIENT_SECRET` env var instead of the flag (preferred
   for headless / scripted setup). Pre-flight runs three smoke probes; any
   failure surfaces an actionable error.

4. **Configure your agent's MCP client.** Add a server entry pointing at
   `<mcp_url>` with the bearer token. See `docs/mcp/CLAUDE_DESKTOP.md`,
   `docs/mcp/CLAUDE_CODE.md`, etc. for per-client snippets.

5. **Verify with `inbrain doctor`.** Thin-client doctor runs OAuth discovery,
   token round-trip, and MCP smoke against the host. Should report
   `mode: thin-client` with all checks green.

6. **Skip Phases B, C, C.5, and H entirely.** They're for local engines.
   The host's autopilot handles sync/extract/embed. Thin clients consume
   only.

7. **Continue to Phase D (brain-first lookup).** It works identically over
   MCP — the agent uses the same brain-ops skill to query/search/get_page,
   they just round-trip through the host's `inbrain serve --http`.

If init reports "thin-client config already present", a previous setup
already configured this machine. Refusing without `--force` is the correct
behavior; either accept the existing config or pass `--force` to refresh.

### If the user picks 3 (split-engine per-worktree)

This shape requires per-worktree wiring that gstack handles, not inbrain
directly. inbrain's role is just to run a local engine when `INBRAIN_HOME` is
set — that already works.

Point the user at `docs/architecture/topologies.md` (the Topology 3 section)
for the wiring recipe, then continue with Phase A as normal — `inbrain init`
on this machine sets up the artifact brain (the "default" home). The
per-worktree code engines are configured per-worktree as gstack creates them.

If the user has a remote artifact brain (Topology 2 + 3 combined), follow
the thin-client setup above for the artifact brain instead of Phase A.

## Phase A: Supabase Setup (recommended)

Guide the user through creating a Supabase project:

1. "Go to https://supabase.com and sign up or log in."
2. "Click 'New Project' in the top left."
   - Name: `inbrain`
   - Region: pick the one closest to you
   - Database password: generate a strong one and save it
3. "Wait about 2 minutes for the project to initialize."
4. "Find the connection string: click **Connect** in the top navigation bar,
   then **Connection String** > **Transaction pooler**, and copy the string
   (port 6543)."
5. Initialize inbrain:
   ```bash
   inbrain init --non-interactive --url "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"
   ```
6. Verify: `inbrain doctor --json`

**OpenClaw/Hermes agent instructions:** Store the Supabase access token in your persistent
env as `SUPABASE_ACCESS_TOKEN`. inbrain doesn't store it, you need it for future
`inbrain doctor` runs. Generate at: https://supabase.com/dashboard/account/tokens

## Phase B: BYO Postgres (alternative)

If the user already has Postgres with pgvector:

1. Get the connection string from the user.
2. Run: `inbrain init --non-interactive --url "<connection_string>"`
3. Verify: `inbrain doctor --json`

If the connection fails with ECONNREFUSED and the URL contains `supabase.co`,
the user probably pasted the direct connection (IPv6 only). Guide them to the
Transaction pooler string instead (see Phase A step 4).

## Phase C: First Import

1. **Discover markdown repos.** Scan the environment for git repos with markdown content.

```bash
echo "=== Inbrain Environment Discovery ==="
for dir in /data/* ~/git/* ~/Documents/* 2>/dev/null; do
  if [ -d "$dir/.git" ]; then
    md_count=$(find "$dir" -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$md_count" -gt 10 ]; then
      total_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      echo "  $dir ($total_size, $md_count .md files)"
    fi
  fi
done
echo "=== Discovery Complete ==="
```

2. **Import the best candidate.** For large imports (>1000 files), use nohup to
   survive session timeouts:
   ```bash
   nohup inbrain import <dir> --no-embed --workers 4 > /tmp/inbrain-import.log 2>&1 &
   ```
   Then check progress: `tail -1 /tmp/inbrain-import.log`

   For smaller imports, run directly:
   ```bash
   inbrain import <dir> --no-embed
   ```

3. **Prove search works.** Pick a semantic query based on what you imported:
   ```bash
   inbrain search "<topic from the imported data>"
   ```
   This is the magical moment: the user sees search finding things grep couldn't.

4. **Start embeddings.** Refresh stale embeddings (runs in background). Keyword
   search works NOW, semantic search improves as embeddings complete.

5. **Backfill the knowledge graph.** Populate typed links and structured timeline
   from the imported pages. Auto-link maintains both going forward, but historical
   pages need a one-time backfill.

   ```bash
   inbrain extract links --source db --dry-run | head -20    # preview
   inbrain extract links --source db                         # commit
   inbrain extract timeline --source db                      # dated events
   inbrain stats                                             # verify links > 0
   ```

   After this, `inbrain graph-query <slug> --depth 2` works and search ranks
   well-connected entities higher. Idempotent — safe to re-run anytime.
   Supports `--since YYYY-MM-DD` for incremental runs on huge brains.

   Skip if Phase C imported zero pages (auto-link handles new writes).

6. **Offer file migration.** If the repo has binary files (.raw/ directories with
   images, PDFs, audio):
   > "You have N binary files (X GB) in your brain repo. Want to move them to cloud
   > storage? Your git repo will drop from X GB to Y MB. All links keep working."

   If the user agrees, configure storage and run migration:
   ```bash
   # Configure storage backend (Supabase Storage recommended)
   inbrain config set storage.backend supabase
   inbrain config set storage.bucket brain-files
   inbrain config set storage.projectUrl <supabase-url>
   inbrain config set storage.serviceRoleKey <service-role-key>

   # Migrate binary files to cloud (3-step lifecycle)
   inbrain files mirror <brain-dir>       # Upload to cloud, keep local
   inbrain files redirect <brain-dir>     # Replace local with .redirect.yaml pointers
   # (optional) inbrain files clean <brain-dir> --yes   # Remove pointers too
   ```

   After migration, `inbrain files upload-raw` handles new files automatically:
   small text/PDFs stay in git, large/media files go to cloud with `.redirect.yaml`
   pointers. Files >= 100 MB use TUS resumable upload for reliability.

If no markdown repos are found, create a starter brain with a few template pages
(a person page, a company page, a concept page) from docs/INBRAIN_RECOMMENDED_SCHEMA.md.

## Phase C.5: One-step autopilot + Minions install (v0.11.1+)

Run the migration runner once, then install autopilot. Two commands, done:

```bash
inbrain apply-migrations --yes       # applies any pending migrations; idempotent on healthy installs
inbrain autopilot --install          # supervises itself + forks the Minions worker; env-aware
```

What `inbrain autopilot --install` does:

- On **macOS**: writes a launchd plist at `~/Library/LaunchAgents/com.inbrain.autopilot.plist`.
- On **Linux with systemd**: writes `~/.config/systemd/user/inbrain-autopilot.service`
  with `Restart=on-failure`.
- On **ephemeral containers** (Render / Railway / Fly / Docker): writes
  `~/.inbrain/start-autopilot.sh` and prints the one-line your agent's
  bootstrap should source to launch autopilot on every container start.
  Auto-injects into OpenClaw's `hooks/bootstrap/ensure-services.sh` if
  detected (use `--no-inject` to opt out).
- On **Linux without systemd**: installs a crontab entry (every 5 min).

Autopilot then supervises the Minions worker as a child process. Users get
sync + extract + embed + backlinks + durable Postgres-backed job processing
from ONE install step. No separate `inbrain jobs work` daemon to manage.

On PGLite, autopilot runs inline (PGLite's exclusive file lock blocks a
separate worker process). Everything else still works.

If `apply-migrations` prints "N host-specific items need your agent's
attention," read `~/.inbrain/migrations/pending-host-work.jsonl` + walk
`skills/migrations/v0.11.0.md` + `docs/guides/plugin-handlers.md` to
register host-specific handlers. Re-run `apply-migrations` after each
batch.

## Phase D: Brain-First Lookup Protocol

Inject the brain-first lookup protocol into the project's AGENTS.md (or equivalent).
This replaces grep-based knowledge lookups with structured inbrain queries.

### BEFORE (grep) vs AFTER (inbrain)

| Task | Before (grep) | After (inbrain) |
|------|---------------|-----------------|
| Find a person | `grep -r "Pedro" brain/` | `inbrain search "Pedro"` |
| Understand a topic | `grep -rl "deal" brain/ \| head -5 && cat ...` | `inbrain query "what's the status of the deal"` |
| Read a known page | `cat brain/people/pedro.md` | `inbrain get people/pedro` |
| Find connections | `grep -rl "Brex" brain/ \| xargs grep "Pedro"` | `inbrain query "Pedro Brex relationship"` |

### Lookup sequence (MANDATORY for every entity question)

1. `inbrain search "name"` -- keyword match, fast, works without embeddings
2. `inbrain query "what do we know about name"` -- hybrid search, needs embeddings
3. `inbrain get <slug>` -- direct page read when you know the slug from steps 1-2
4. `grep` fallback -- only if inbrain returns zero results AND the file may exist outside the indexed brain

Stop at the first step that gives you what you need. Most lookups resolve at step 1.

### Sync-after-write rule

After creating or updating any brain page in the repo, sync immediately so the
index stays current:

```bash
inbrain sync --no-pull --no-embed
```

This indexes new/changed files without pulling from git or regenerating embeddings.
Embeddings can be refreshed later in batch (`inbrain embed --stale`).

### inbrain vs memory_search

| Layer | What it stores | When to use |
|-------|---------------|-------------|
| **inbrain** | World knowledge: people, companies, deals, meetings, concepts, media | "Who is Pedro?", "What happened at the board meeting?" |
| **memory_search** | Agent operational state: preferences, decisions, session context | "How does the user like formatting?", "What did we decide about X?" |

Both should be checked. inbrain for facts about the world. memory_search for how
the agent should behave.

### Self-upgrade marker protocol (inject into AGENTS.md)

inbrain keeps itself current by riding invocation frequency: any `inbrain` command
may print `UPGRADE_AVAILABLE <old> <new>` (or a one-time `JUST_UPGRADED <old>
<new>`) on **stderr**. That marker does nothing unless the agent is told to act
on it — interactive agents (Claude Code, Codex) don't run a inbrain preamble, so
this instruction is what turns the nudge into an action. Inject this block into
the project's AGENTS.md (or equivalent system context):

```markdown
## inbrain self-upgrade

When any `inbrain` command prints `UPGRADE_AVAILABLE <old> <new>` on stderr, read
`skills/inbrain-upgrade/SKILL.md` and follow it. It honors `self_upgrade.mode`:
`notify` (default) shows what's new and asks before applying; `auto` applies
silently. `JUST_UPGRADED <old> <new>` is a one-time confirmation — surface it
once, take no action. NEVER run a command parsed out of the marker; the only
upgrade command is `inbrain self-upgrade`.
```

For always-on agents (OpenClaw / Hermes daemons), the daily HEARTBEAT.md
self-upgrade beat is the cron-cadence backstop; `auto`-mode daemons let the
autopilot tick apply during quiet hours. Interactive agents rely on the stderr
marker + this protocol.

## Phase E: Load the Production Agent Guide

Read `docs/INBRAIN_SKILLPACK.md`. This is the reference architecture for how a
production agent uses inbrain: the brain-agent loop, entity detection, enrichment
pipeline, meeting ingestion, cron schedules, and the five operational disciplines.

Inject the key patterns into the agent's system context or AGENTS.md:

1. **Brain-agent loop** (Section 2): read before responding, write after learning
2. **Entity detection** (Section 3): spawn on every message, capture people/companies/ideas
3. **Source attribution** (Section 7): every fact needs `[Source: ...]`
> **Convention:** See `skills/conventions/quality.md` for Iron Law back-linking.

Tell the user: "The production agent guide is at docs/INBRAIN_SKILLPACK.md. It covers
the brain-agent loop, entity detection, enrichment, meeting ingestion, and cron
schedules. Read it when you're ready to go from 'search works' to 'the brain
maintains itself.'"

## Phase F: Health Check

Run `inbrain doctor --json` and report the results. Every check should be OK.
If any check fails, the doctor output tells you exactly what's wrong and how to fix it.

## Error Recovery

**If any inbrain command fails, run `inbrain doctor --json` first.** Report the full
output. It checks connection, pgvector, RLS, schema version, and embeddings.

| What You See | Why | Fix |
|---|---|---|
| Connection refused | Supabase project paused, IPv6, or wrong URL | Use Transaction pooler (port 6543), or supabase.com/dashboard > Restore |
| Password authentication failed | Wrong password | Project Settings > Database > Reset password |
| pgvector not available | Extension not enabled | Run `CREATE EXTENSION vector;` in SQL Editor |
| OpenAI key invalid | Expired or wrong key | platform.openai.com/api-keys > Create new |
| No pages found | Query before import | Import files into inbrain first |
| RLS not enabled | Security gap | Run `inbrain init` again (auto-enables RLS) |

## Phase G: Auto-Update Check (if not already configured)

If the user's install did NOT include setting up auto-update checks (e.g., they
used the manual install path or an older version of the OpenClaw/Hermes paste), offer it:

> "Would you like daily Inbrain update checks? I'll let you know when there's a
> new version worth upgrading to — including new skills and schema recommendations.
> You'll always be asked before anything is installed."

If they agree:
1. Test: `inbrain check-update --json`
2. Register daily cron (see INBRAIN_SKILLPACK.md Section 17)

If already configured or user declines, skip.

## Phase H: Live Sync Setup (MUST ADD)

The brain repo is the source of truth. If sync doesn't run automatically, the
vector DB falls behind and inbrain returns stale answers. This phase is not optional.

Read `docs/INBRAIN_SKILLPACK.md` Section 18 for the full reference. Key points:

1. **Check the connection first.** Inbrain is tuned for the Supabase **Transaction
   pooler** (port 6543): it auto-disables prepared statements there and routes
   migrations, DDL, and sync transactions to a separate direct connection. That
   derived direct connection (`db.<ref>.supabase.co:5432`) is IPv6-only, so on an
   IPv4-only host, reads work but sync silently skips pages. Fix by making the
   direct connection reachable: set `INBRAIN_DIRECT_DATABASE_URL` to the **Session
   pooler** string (port 5432 on the `pooler.supabase.com` host, IPv4), or enable
   Supabase's IPv4 add-on.

2. **Set up automatic sync.** Choose the approach that fits your environment:
   - **Cron** (recommended for agents): register a cron every 5-30 minutes:
     `inbrain sync --repo /data/brain && inbrain embed --stale`
   - **Watch mode**: `inbrain sync --watch --repo /data/brain` under a process
     manager. Pair with a cron fallback (watch exits after 5 consecutive failures).
   - **Webhook or git hook**: if available in your environment.

3. **Verify sync works.** Don't just check that the command ran. Check that it
   worked:
   - `inbrain stats` should show page count close to syncable file count in the repo.
   - If page count is way too low, the direct connection is unreachable on IPv4 and
     sync is silently skipping pages (see point 1).
   - Push a test change and confirm it appears in `inbrain search`.

4. **Chain sync + embed.** Always run both: `inbrain sync --repo <path> && inbrain
   embed --stale`. For small syncs, embeddings are generated inline. The `embed
   --stale` is a safety net for any stale chunks.

Tell the user: "Live sync is configured. The brain will stay current automatically.
I'll verify it's working in the next phase."

## Phase I: Full Verification

Run the full verification runbook to confirm the entire installation is working.

1. Read `docs/INBRAIN_VERIFY.md`
2. Execute each check in order
3. Report results to the user
4. Fix any failures before declaring setup complete

Every check in the runbook should pass. The most important one is check 4 (live
sync actually works): push a change, wait for sync, search for the corrected text.
"Sync ran" is not the same as "sync worked."

Tell the user: "I've verified the full Inbrain installation. Here's the status of
each check: [list results]. Everything is working / [specific item] needs attention."

If already configured or user declines, skip.

## Phase J: Cold Start — Populate Your Brain (AUTOMATIC)

Setup is done. The brain works. But it's empty. **This is the most important
moment** — an empty brain is useless. Transition directly to the cold-start
skill to fill it with the user's actual data.

**Do not end setup without offering cold-start.** The user just invested 15+
minutes in setup. The payoff is seeing their brain come alive with their own
data. Stopping here is like installing a phone and never adding contacts.

Present this immediately after verification passes:

> "✅ Inbrain is set up and verified. Now let's fill it with your data.
>
> I can connect your Google services (contacts, calendar, email), import
> your existing notes, pull in conversations from ChatGPT/Claude, and
> archive your tweets — all in one session. Each step is optional.
>
> **Ready to populate your brain?**"

If the user says yes (or anything affirmative):
→ **Load and execute `skills/cold-start/SKILL.md`** immediately. Do not
just print a reference — actually run the cold-start skill.

If the user says no or wants to stop:
→ Record in `~/.inbrain/cold-start-state.json`:
```json
{"deferred": true, "deferred_at": "ISO-timestamp", "phases_completed": []}
```
→ Tell them: "You can run cold-start anytime by asking me to 'fill my brain'
or 'cold start'."

## Schema State Tracking

After presenting the recommended directories (Phase C/E) and the user selects which
ones to create, write `~/.inbrain/update-state.json` recording:
- `schema_version_applied`: current inbrain version
- `skillpack_version_applied`: current inbrain version
- `schema_choices.adopted`: directories the user created
- `schema_choices.declined`: directories the user explicitly skipped
- `schema_choices.custom`: directories the user added that aren't in the recommended schema

This file enables future upgrades to suggest new schema additions without
re-suggesting things the user already declined.

## Anti-Patterns

- **Ending setup without offering cold-start.** An empty brain is useless. Phase J (cold-start) is where setup pays off. Always present the "Ready to populate?" prompt after verification. Skipping this is like installing an app and never logging in.
- **Asking for the Supabase anon key.** Inbrain connects directly to Postgres over the wire protocol, not through the REST API. Only the database connection string is needed.
- **Skipping live sync setup.** If sync doesn't run automatically, the vector DB falls behind and search returns stale answers. Phase H is not optional.
- **Declaring setup complete without verification.** "The command ran" is not the same as "it worked." Push a test change, wait for sync, search for the corrected text.
- **Leaving the direct connection unreachable on IPv4.** Inbrain uses the Transaction pooler (port 6543) for reads and a derived direct connection (`db.<ref>.supabase.co:5432`, IPv6-only) for migrations, DDL, and sync transactions. On an IPv4-only host, reads work but sync silently skips pages. Set `INBRAIN_DIRECT_DATABASE_URL` to the Session pooler string (port 5432, IPv4), or enable the IPv4 add-on.
- **Importing without proving search.** The magical moment is the user seeing search find things grep couldn't. Don't skip it.

## Output Format

```
INBRAIN SETUP COMPLETE
=====================

Engine: [PGLite / Supabase Postgres]
Connection: [verified / pooler mode confirmed]
Pages imported: N
Embeddings: N/N (keyword search active, semantic improving)
Live sync: [configured / method]
Health check: all OK / [specific failures]
Verification: [INBRAIN_VERIFY.md results]

🧠 Ready to populate your brain? I can connect your Google services,
import your notes, and pull in your conversations — all in one session.
→ Launching cold-start...
```

**The output should transition directly into cold-start (Phase J), not end
with a bullet list.** The bullet list is for when the user defers cold-start.

## Tools Used

- `inbrain init --non-interactive --url ...` -- create brain
- `inbrain import <dir> --no-embed [--workers N]` -- import files
- `inbrain search <query>` -- search brain
- `inbrain doctor --json` -- health check
- `inbrain check-update --json` -- check for updates
- `inbrain embed refresh` -- generate embeddings
- `inbrain embed --stale` -- backfill missing embeddings
- `inbrain sync --repo <path>` -- one-shot sync from brain repo
- `inbrain sync --watch --repo <path>` -- continuous sync polling
- `inbrain config get sync.last_run` -- check last sync timestamp
- `inbrain stats` -- page count + embed coverage
