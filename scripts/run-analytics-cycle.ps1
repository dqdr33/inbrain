# scripts/run-analytics-cycle.ps1
#
# Twice-daily analytics wrapper, invoked by Windows Task Scheduler
# ("Inbrain-Analytics-AM" / "Inbrain-Analytics-PM"). Runs both halves:
#   1. Prediction-markets cycle (scripts/run-prediction-cycle.ts) -
#      market/news/macro signals -> Brain Agent evaluation (Gemini) ->
#      Analyst daily report, written as a brain page.
#   2. Nightly self-evolution (scripts/run-dream-cycle.ts) - Brier scoring
#      over resolved markets, meta-calibration, forecasts.
#
# Logs to logs/analytics-cycle-<timestamp>.log so failures are visible without
# watching the Task Scheduler UI.
#
# Two Windows PowerShell 5.1 rules this file depends on:
#   - `2>&1` on a NATIVE command wraps every stderr line in an ErrorRecord
#     (NativeCommandError noise) and sets $? to $false on a clean exit 0.
#     We therefore never redirect a native command's stderr; it flows to the
#     transcript on its own.
#   - A native command NEVER raises a terminating error, so try/catch around
#     `& bun ...` can never fire. $LASTEXITCODE is the only truthful signal.
#     The previous version relied on catch and logged "finished" for every
#     failed run, including quota exhaustion.

$ErrorActionPreference = "Continue"

# bun writes UTF-8; without this, PowerShell decodes it with the OEM codepage
# and every em dash / arrow / Cyrillic character lands in the log as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$repoRoot = "C:\AI_Inbrain\inbrain"
if (-not (Test-Path $repoRoot)) {
    Write-Error "Repo root not found: $repoRoot"
    exit 1
}
Set-Location $repoRoot

$logDir = Join-Path $repoRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stamp = (Get-Date).ToString("yyyy-MM-dd-HHmm")
$logFile = Join-Path $logDir "analytics-cycle-$stamp.log"

function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $logFile -Value $line -Encoding utf8
    Write-Host $line
}

# Runs a bun script, tees its output into the log, and reports the REAL exit
# code. Returns $true on success so the caller can branch honestly.
function Invoke-BunStep {
    param(
        [string]$Label,
        [string[]]$BunArgs
    )
    Write-Log "$Label starting..."
    $out = & bun @BunArgs | Out-String
    $code = $LASTEXITCODE
    if ($out) { Add-Content -Path $logFile -Value $out -Encoding utf8 }
    if ($code -eq 0) {
        Write-Log "$Label finished OK."
        return $true
    }
    # Exit 3 = the runner declined because another cycle holds the pipeline lock.
    # That is the lock doing its job, not a failure, so it must not mark the whole
    # run as failed (and must not page anyone).
    if ($code -eq 3) {
        Write-Log "$Label SKIPPED - another cycle is already running (pipeline lock held)."
        return $true
    }
    Write-Log "$Label FAILED with exit code $code."
    return $false
}

# Keep the last N run logs and reports; twice-daily forever otherwise grows
# without bound (100 logs / 91 reports at the time this was added).
function Remove-OldFiles {
    param([string]$Path, [string]$Filter, [int]$Keep)
    if (-not (Test-Path $Path)) { return }
    Get-ChildItem -Path $Path -Filter $Filter -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip $Keep |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-Log "=== Analytics cycle starting ==="

$anyFailed = $false

# --- Step 1: prediction-markets cycle ---
# (loads/rotates its own key pool internally via scripts/lib/gemini-keys.ts)
#
# Source list and --max-signals are kept in sync with the Gemini free-tier
# budget documented in run-prediction-cycle.ts: each accepted signal costs
# 2 LLM calls, plus one report and one translation.
$sources = @(
    "polymarket", "kalshi", "predictit",
    "news", "rss", "gdelt",
    "onchain", "defillama", "binance", "bybit", "coingecko",
    "telegram", "fred", "reddit", "x_twitter",
    # NOTE: "alphavantage" has no underscore - it must match the SignalSource
    # union in src/prediction/types.ts exactly. The runner now rejects unknown
    # source names instead of silently dropping them.
    "alphavantage", "dune", "farcaster", "discord"
) -join ","

if (-not (Invoke-BunStep -Label "Prediction cycle" -BunArgs @(
    "run", "scripts/run-prediction-cycle.ts",
    "--max-signals", "30",
    "--sources", $sources
))) { $anyFailed = $true }

# --- Step 2: nightly self-evolution (dream cycle) ---
# Run dream exactly ONCE with whichever key the pool has left. run-dream-cycle
# rotates keys itself on quota errors and updates process.env as it goes, so no
# key needs to be plumbed in from here.
if (-not (Invoke-BunStep -Label "Dream cycle" -BunArgs @(
    "run", "scripts/run-dream-cycle.ts"
))) { $anyFailed = $true }

Remove-OldFiles -Path $logDir -Filter "analytics-cycle-*.log" -Keep 60
Remove-OldFiles -Path (Join-Path $repoRoot "Report") -Filter "*.md" -Keep 60

if ($anyFailed) {
    Write-Log "=== Analytics cycle done WITH FAILURES ==="
    exit 1
}
Write-Log "=== Analytics cycle done ==="
exit 0
