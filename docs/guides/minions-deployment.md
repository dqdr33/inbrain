# Minions Worker Deployment Guide

Keep `inbrain jobs work` running across crashes, reboots, and Postgres
connection blips. Written for agents to execute line-by-line.

## The problem

The persistent worker can die silently from:

- Database connection drops (Supabase/Postgres maintenance or network blips).
- Lock-renewal failures → the stall detector eventually dead-letters jobs.
- Bun process crashes with no automatic restart.
- Internal event-loop death (PID alive, worker loop stopped).

When the worker dies, submitted jobs sit in `waiting` forever. The
canonical answer is `inbrain jobs supervisor` — a first-class CLI that
spawns `inbrain jobs work` as a child and auto-restarts it on crash.

## Worker supervision

### The canonical pattern

`inbrain jobs supervisor` is an auto-restarting wrapper around
`inbrain jobs work`. It writes a PID file, restarts the worker on crash
with exponential backoff (1s → 60s cap), emits lifecycle events to an
audit file, and drains gracefully on SIGTERM (35s worker-drain window
before SIGKILL). Exit codes are documented so agents can branch on them.

**Typical commands:**

```bash
# Start in the foreground (blocks; Ctrl-C to stop).
inbrain jobs supervisor --concurrency 4

# Start detached — returns {"event":"started","supervisor_pid":…} on stdout.
inbrain jobs supervisor start --detach --json

# Check liveness without reading log files.
inbrain jobs supervisor status --json

# Graceful stop (SIGTERM + drain wait + SIGKILL fallback).
inbrain jobs supervisor stop
```

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Clean shutdown (SIGTERM/SIGINT received, worker drained) |
| 1 | Max crashes exceeded (worker kept dying) |
| 2 | Another supervisor holds the PID lock |
| 3 | PID file unwritable (permission / path error) |

An agent seeing exit=2 can safely treat it as "one is already running";
exit=1 should page a human.

### Lowering scheduling priority (`--nice`)

When the worker pool runs at full concurrency on a machine you also use
interactively, it can drive the load average high enough to starve your
shell. Cutting `--concurrency` throws away throughput. Reach for `--nice`
instead — it lowers the job tree's CPU scheduling priority without touching
width, so the work runs full-speed when the box is idle and yields when it
isn't:

```bash
# Full concurrency, low priority. Propagates to the spawned worker and its
# children (shell jobs, subagents) via OS niceness inheritance.
inbrain jobs supervisor --concurrency 4 --nice 10

# Equivalent for a bare worker, or set it durably in the environment.
INBRAIN_NICE=10 inbrain jobs work --concurrency 4
```

`--nice` takes a POSIX value from `-20` (highest priority) to `19`
(nicest/lowest); positive values need no privilege, negative values need
root. `INBRAIN_NICE` is the env equivalent (the flag wins). Confirm the
effective value with `inbrain jobs stats`, `inbrain jobs supervisor status
--json`, or the `supervisor_niceness` check in `inbrain doctor` — the doctor
check warns if what you asked for isn't what's actually running (e.g. a
negative value denied without privilege, or an OS `RLIMIT_NICE` clamp). This
is distinct from the concurrency / inflight cap and composes with it.

### Which supervisor when?

The supervisor solves in-process crash recovery. Platform-level
supervision (systemd, Fly, Render) handles host-level failures. You
usually want both.

| Environment | Recommendation |
|---|---|
| **Container (Fly / Railway / Render / Heroku)** | `inbrain jobs supervisor` runs as PID 1. The platform restarts the container on OOM / host loss; supervisor restarts the worker on crash. See [Fly.io](#flyio) / [Render / Railway / Heroku](#render--railway--heroku). |
| **Linux VM with systemd** | Two-layer recommended: systemd supervises `inbrain jobs supervisor`, which in turn supervises `inbrain jobs work`. Buys you automatic restart on reboot (systemd) plus fast crash recovery (supervisor). See [systemd](#systemd). |
| **Dev laptop / macOS** | `inbrain jobs supervisor` in a terminal. Ctrl-C stops it. No system-level setup needed. |

### Variables used in this guide

Substitute these once before copy-pasting any snippet.

| Variable | Meaning | Typical value |
|---|---|---|
| `$INBRAIN_BIN` | Absolute path to the `inbrain` binary | `$(command -v inbrain)` — often `/usr/local/bin/inbrain` or `~/.bun/bin/inbrain` |
| `$INBRAIN_WORKER_USER` | OS user that owns the worker process | the same user that ran `inbrain init`; never `root` |
| `$INBRAIN_WORKSPACE` | `cwd` for shell jobs submitted by this deployment | absolute path, e.g. `/srv/my-brain` |
| `$INBRAIN_ENV_FILE` | Secrets file sourced by systemd / shell | `/etc/inbrain.env` (mode 600) |

### Preconditions

Run these before any deployment step.

```bash
# 1. inbrain is on PATH and resolves to an absolute location.
command -v inbrain || { echo "inbrain not on PATH. Install, then retry."; exit 1; }

# 2. DATABASE_URL points at reachable Postgres.
#    (Supervisor is Postgres-only. PGLite's exclusive file lock blocks the
#    separate worker process. If `config.engine === 'pglite'` the CLI rejects
#    with a clear error.)
inbrain doctor --fast --json | jq '.checks[] | select(.name=="db_connectivity")'

# 3. Schema is up to date. If version=0 or status=="fail":
#    inbrain apply-migrations --yes
inbrain doctor --fast --json | jq '.checks[] | select(.name=="schema_version")'

# 4. If you plan to submit `shell` jobs, pass --allow-shell-jobs to the
#    supervisor (or export INBRAIN_ALLOW_SHELL_JOBS=1 before starting).
#    Without the flag, the shell handler is disabled at worker startup.
```

## Agent usage (OpenClaw / Hermes / Cursor / Codex)

Three-command pattern an agent can drive without shell archaeology:

```bash
# Start (returns PIDs + pid_file on stdout as JSON, then detaches)
inbrain jobs supervisor start --detach --json
# → {"event":"started","supervisor_pid":1234,"worker_pid":1235,"pid_file":"/Users/you/.inbrain/supervisor.pid"}

# Check health (machine-parseable JSON, no log scraping)
inbrain jobs supervisor status --json
# → {"running":true,"supervisor_pid":1234,"last_start":"2026-04-23T15:30:22Z","crashes_24h":0, ...}

# Stop cleanly (SIGTERM + 35s drain + SIGKILL fallback)
inbrain jobs supervisor stop
```

Every lifecycle event (spawn, crash, backoff, health warning, max-crashes,
shutdown) is also written to `${INBRAIN_AUDIT_DIR:-~/.inbrain/audit}/supervisor-YYYY-Www.jsonl`
for historical inspection. `inbrain doctor` reads that file and surfaces
a `supervisor` check in its health report.

## Deployment: systemd

For long-running Linux VMs with shell access.

```bash
# Create the worker user if it doesn't exist.
sudo useradd --system --home "$INBRAIN_WORKSPACE" --shell /usr/sbin/nologin inbrain \
  2>/dev/null || true
sudo mkdir -p "$INBRAIN_WORKSPACE" && sudo chown inbrain:inbrain "$INBRAIN_WORKSPACE"

# Install the env file (secrets stay out of the unit file).
sudo install -m 600 -o inbrain -g inbrain \
  docs/guides/minions-deployment-snippets/inbrain.env.example /etc/inbrain.env
sudoedit /etc/inbrain.env
# Fill in DATABASE_URL, optional INBRAIN_ALLOW_SHELL_JOBS=1.

# Install the unit file, substituting /srv/inbrain → your workspace path.
sudo install -m 644 docs/guides/minions-deployment-snippets/systemd.service \
  /etc/systemd/system/inbrain-worker.service
sudo sed -i "s|/srv/inbrain|$INBRAIN_WORKSPACE|g" \
  /etc/systemd/system/inbrain-worker.service

sudo systemctl daemon-reload
sudo systemctl enable --now inbrain-worker
sudo systemctl status inbrain-worker
journalctl -u inbrain-worker -n 50
```

The shipped unit file invokes `inbrain jobs supervisor` (not `inbrain jobs work`
directly) so you get two-layer supervision: systemd restarts the supervisor
on host reboot, supervisor restarts the worker on in-process crash.

`Restart=always` + `RestartSec=10s` handle the supervisor-level recovery.
The unit runs as unprivileged `inbrain` with `PrivateTmp`, `ProtectSystem=strict`,
and `ReadWritePaths=$INBRAIN_WORKSPACE,$HOME/.inbrain` (for the PID file and
audit log). `LimitNOFILE=65535` covers Bun + Postgres pool + concurrent
LLM subagent calls without hitting the default 1024 cap.

## Deployment: Fly.io

```bash
# Merge the [processes] block from fly.toml.partial into your fly.toml.
cat docs/guides/minions-deployment-snippets/fly.toml.partial >> fly.toml
# Review + edit as needed.

# Set secrets (Fly handles restart on crash).
fly secrets set DATABASE_URL='postgres://…' INBRAIN_ALLOW_SHELL_JOBS=1
```

The `[processes]` block runs `inbrain jobs supervisor` as PID 1. Fly
restarts the container on host failure; the supervisor restarts the
worker on in-process crash.

## Deployment: Render / Railway / Heroku

Drop [`Procfile`](./minions-deployment-snippets/Procfile) at the repo
root. The shipped Procfile calls `inbrain jobs supervisor`. Set
`DATABASE_URL` + optional `INBRAIN_ALLOW_SHELL_JOBS=1` via the platform's
env UI or CLI.

## Deployment: inline `--follow` (no persistent worker)

For short deterministic scripts on a fixed schedule where you don't need
a persistent worker between runs. Each cron run brings its own temporary
worker. `--follow` starts one on the queue and blocks until the
just-submitted job reaches a terminal state (`completed` / `failed` /
`dead` / `cancelled`). 2-3 s startup overhead per job; negligible vs job
duration for scheduled work.

```bash
INBRAIN_ALLOW_SHELL_JOBS=1 inbrain jobs submit shell \
  --queue nightly-enrich \
  --params "{\"cmd\":\"$INBRAIN_BIN embed --stale\",\"cwd\":\"$INBRAIN_WORKSPACE\"}" \
  --follow \
  --timeout-ms 600000
```

Replace `inbrain embed --stale` with whichever inbrain subcommand you're
scheduling (`sync`, `extract`, `orphans`, `doctor`, `check-backlinks`,
`lint`, `autopilot`). For strict single-job semantics on shared queues,
use a dedicated queue name like `nightly-enrich` above.

## Upgrading from an older deployment

### From `minion-watchdog.sh` (pre-v0.20)

Earlier versions of this guide shipped a 68-line bash watchdog
(`minion-watchdog.sh`). It's been replaced by `inbrain jobs supervisor`
which handles everything the script did, plus atomic PID locking,
structured audit events, queue-scoped health checks, and graceful
drain on SIGTERM.

**Migration:**

```bash
# 1. Stop and remove the old watchdog.
sudo kill $(head -n1 /tmp/inbrain-worker.pid) 2>/dev/null
sudo rm -f /usr/local/bin/minion-watchdog.sh /tmp/inbrain-worker.pid \
           /tmp/inbrain-worker.log
crontab -e   # delete the "*/5 * * * * /usr/local/bin/minion-watchdog.sh" line

# 2. Start the supervisor (systemd users: reinstall the unit from
#    docs/guides/minions-deployment-snippets/systemd.service, which
#    now calls `inbrain jobs supervisor`).
inbrain jobs supervisor start --detach --json
# Or: sudo systemctl restart inbrain-worker

# 3. Verify.
inbrain jobs supervisor status --json
inbrain doctor   # 'supervisor' check should report running=true
```

### Schema / migration hygiene

Regardless of which deployment path you're upgrading from:

1. **Stop the worker before upgrading.** `inbrain jobs supervisor stop`
   (or `sudo systemctl stop inbrain-worker`). Skipping this risks an
   in-flight job landing partial schema.
2. **Run `inbrain upgrade`**. Then `inbrain apply-migrations --yes` if
   `inbrain doctor` reports any migration as `partial` or `pending`.
3. **If you run shell jobs:** from v0.14 onward, pass
   `--allow-shell-jobs` to the supervisor (or keep
   `INBRAIN_ALLOW_SHELL_JOBS=1` in `/etc/inbrain.env`). Submitters don't
   need the flag; only the worker does.
4. **Verify.** `inbrain doctor` should report zero `pending` or `partial`
   migrations plus a healthy `supervisor` check. `inbrain jobs stats`
   should show no unexplained growth in `dead` between pre- and
   post-upgrade.

## Known issues

### Supabase connection drops

The worker uses a single Postgres connection. If Supabase drops it
(maintenance, connection limits, network blip), lock renewal fails
silently. The stall detector then dead-letters the job after
`max_stalled` misses.

**Current defaults that make this worse:**

- `lockDuration: 30000` (30 s) — too short for long jobs during
  connection blips.
- `max_stalled: 5` (schema column default — see `src/schema.sql` and
  `src/core/pglite-schema.ts`). Five missed heartbeats before dead-letter.
- `stalledInterval: 30000` (30 s) — checks too aggressively.

**Tune per-job today.** `inbrain jobs submit` accepts `--max-stalled N`,
`--backoff-type fixed|exponential`, `--backoff-delay <ms>`,
`--backoff-jitter 0..1`, and `--timeout-ms N` as first-class flags
(since v0.13.1). These write onto the job row at submit time — which is
what `handleStalled()` reads — so per-job tuning is the real knob today.

### DO NOT pass `maxStalledCount` to `MinionWorker`

It's a no-op. The stall detector reads the row's `max_stalled` column
(set at submit time), not the worker opt in `src/core/minions/worker.ts:74`.
Use `inbrain jobs submit --max-stalled N` per-job instead.

### Zombie shell children

When the Bun worker crashes hard, child processes from shell jobs can
become zombies. The supervisor's SIGTERM → 35s drain → SIGKILL window
covers the shell handler's 5 s child-kill grace (`KILL_GRACE_MS`). For
long-running shell jobs, prefer timeouts via `--timeout-ms` on submit
over relying on hard kills.

## Smoke test

```bash
# Supervisor alive?
inbrain jobs supervisor status --json | jq .running

# Aggregate queue health.
inbrain jobs stats

# Jobs currently stalled (still `active` with expired lock_until, pre-requeue).
inbrain jobs list --status active --limit 10

# Dead-lettered jobs.
inbrain jobs list --status dead --limit 10

# Shell handler registered? (check supervisor audit log or worker stderr.)
inbrain jobs supervisor status --json | jq '.worker_config.allow_shell_jobs'
```

## Uninstall

**`inbrain jobs supervisor`** (foreground or `--detach`):

```bash
inbrain jobs supervisor stop
```

**systemd:**

```bash
sudo systemctl disable --now inbrain-worker
sudo rm /etc/systemd/system/inbrain-worker.service /etc/inbrain.env
sudo systemctl daemon-reload
```

**Fly / Render / Railway:** delete the `worker` process from `fly.toml`
/ `Procfile` and redeploy. Secrets set via `fly secrets` persist until
`fly secrets unset`.

**Inline `--follow`:** remove the cron entry. Nothing else to clean up
— temporary workers exit with their jobs.
