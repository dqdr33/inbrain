# scripts/auto-commit.ps1
#
# Periodic LOCAL-ONLY commit safety net, invoked by Windows Task Scheduler
# ("Inbrain-AutoCommit"). Stages and commits whatever is dirty in the repo
# so work-in-progress is never lost to a crash/restart — it deliberately
# does NOT run `git push`, so nothing reaches GitHub (origin) on its own.
# A human (or /ship) still decides when/what to push.
#
# Logs to logs/auto-commit-<date>.log (one file per day, appended to).

$repoRoot = "C:\AI_Inbrain\inbrain"
Set-Location $repoRoot

$logDir = Join-Path $repoRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "auto-commit-$((Get-Date).ToString('yyyy-MM-dd')).log"

function Write-Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

try {
    $status = & git status --porcelain 2>&1
    if ([string]::IsNullOrWhiteSpace($status)) {
        Write-Log "No changes, skipping."
        exit 0
    }

    & git add -A 2>&1 | Out-Null

    $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $branch = (& git branch --show-current 2>&1).Trim()
    $commitMsg = "Auto-commit: $stamp"

    $out = & git commit -m $commitMsg 2>&1 | Out-String
    Add-Content -Path $logFile -Value $out -Encoding utf8

    if ($LASTEXITCODE -eq 0) {
        Write-Log "Committed local changes on branch '$branch'. (NOT pushed to origin/GitHub.)"
    } else {
        Write-Log "git commit returned exit code $LASTEXITCODE (see output above)."
    }
} catch {
    Write-Log "Auto-commit FAILED: $($_.Exception.Message)"
}
