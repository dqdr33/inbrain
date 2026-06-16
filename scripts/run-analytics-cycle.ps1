# scripts/run-analytics-cycle.ps1
#
# Twice-daily analytics wrapper, invoked by Windows Task Scheduler
# ("Inbrain-Analytics-AM" / "Inbrain-Analytics-PM"). Runs both halves
# of what the user asked for:
#   1. Prediction-markets cycle (scripts/run-prediction-cycle.ts) —
#      Polymarket/Kalshi signals -> Brain Agent evaluation (Gemini) ->
#      Analyst daily report, written as a brain page.
#   2. Personal brain digest (`inbrain dream`) — the already-wired
#      GBrain maintenance/consolidation cycle over whatever content
#      lives in the brain (including the prediction reports from #1).
#
# Logs to logs/analytics-cycle-<timestamp>.log so failures are visible
# without needing to watch the Task Scheduler UI.

$repoRoot = "C:\AI_Inbrain\inbrain"
Set-Location $repoRoot

$logDir = Join-Path $repoRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stamp = (Get-Date).ToString("yyyy-MM-dd-HHmm")
$logFile = Join-Path $logDir "analytics-cycle-$stamp.log"

function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

Write-Log "=== Analytics cycle starting ==="

# --- Step 1: prediction-markets cycle ---
# (loads/rotates its own key pool internally via scripts/lib/gemini-keys.ts)
Write-Log "Running prediction cycle..."
try {
    $out = & bun run scripts/run-prediction-cycle.ts --max-signals 4 2>&1 | Out-String
    Add-Content -Path $logFile -Value $out -Encoding utf8
    Write-Log "Prediction cycle finished."
} catch {
    Write-Log "Prediction cycle FAILED: $($_.Exception.Message)"
}

# --- Step 2: personal brain digest (dream cycle) ---
# `inbrain dream` doesn't know about key rotation itself, so wrap it: load
# whichever key the pool currently considers active (possibly just rotated
# by step 1 above), and if dream's own output shows a quota/billing error,
# rotate to the next key and retry — up to once per key in the pool.
function Get-ActiveGeminiKey {
    (& bun run scripts/gemini-key.ts current 2>$null | Select-Object -Last 1).Trim()
}
function Rotate-GeminiKey($reason) {
    (& bun run scripts/gemini-key.ts rotate $reason 2>$null | Select-Object -Last 1).Trim()
}
function Test-QuotaError($text) {
    $text -match 'RESOURCE_EXHAUSTED|quota|prepayment credits are depleted|429'
}

Write-Log "Running inbrain dream..."
$poolSize = 5
for ($i = 0; $i -le $poolSize; $i++) {
    $env:GOOGLE_GENERATIVE_AI_API_KEY = Get-ActiveGeminiKey
    try {
        $out2 = & inbrain dream --json 2>&1 | Out-String
        Add-Content -Path $logFile -Value $out2 -Encoding utf8
        if (Test-QuotaError $out2) {
            Write-Log "Dream cycle hit quota error, rotating key (attempt $($i+1))..."
            $next = Rotate-GeminiKey "inbrain dream quota error"
            if ($next -eq "EXHAUSTED") {
                Write-Log "Dream cycle FAILED: all keys exhausted."
                break
            }
            continue
        }
        Write-Log "Dream cycle finished."
        break
    } catch {
        Write-Log "Dream cycle FAILED: $($_.Exception.Message)"
        break
    }
}

Write-Log "=== Analytics cycle done ==="
