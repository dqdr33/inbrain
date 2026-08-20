# Register (or remove) the opportunistic backtest slice in Windows Task Scheduler.
#
# The backtest is never urgent — it scores history, and history does not move.
# What matters is that it only ever runs on FREE Gemini quota, which the runner
# itself enforces: backtest-auto.ts exits 0 without spending anything when only
# the paid key is left. That makes a frequent schedule safe; most ticks are a
# few-hundred-millisecond no-op that just checks the key pool.
#
# Hourly is the right cadence. Google's free tier resets at Pacific midnight and
# the live prediction cycle competes for the same daily budget, so checking often
# and backing off instantly beats one big daily attempt that may land at a moment
# when the pool is spent.
#
#   powershell -ExecutionPolicy Bypass -File scripts\backtest-schedule.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\backtest-schedule.ps1 -Remove
#   powershell -ExecutionPolicy Bypass -File scripts\backtest-schedule.ps1 -Status

param(
    [switch]$Remove,
    [switch]$Status,
    [int]$IntervalHours = 1,
    [int]$Budget = 20
)

$ErrorActionPreference = 'Stop'

$TaskName = 'InbrainBacktestSlice'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir   = Join-Path $RepoRoot 'logs'
$LogPath  = Join-Path $LogDir 'backtest-auto.log'

function Get-BunPath {
    $cmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
    if (Test-Path $fallback) { return $fallback }
    throw "bun not found on PATH or at $fallback"
}

# ---- status ---------------------------------------------------------------
if ($Status) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Output "not registered - run this script without -Status to install"
        exit 0
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Output "task      : $TaskName"
    Write-Output "state     : $($task.State)"
    Write-Output "last run  : $($info.LastRunTime)  (result $($info.LastTaskResult))"
    Write-Output "next run  : $($info.NextRunTime)"
    Write-Output "log       : $LogPath"
    Write-Output ""
    Push-Location $RepoRoot
    try { & (Get-BunPath) run scripts/backtest-auto.ts --status }
    finally { Pop-Location }
    exit 0
}

# ---- remove ---------------------------------------------------------------
if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "removed scheduled task $TaskName"
    } else {
        Write-Output "task $TaskName was not registered"
    }
    exit 0
}

# ---- register -------------------------------------------------------------
$bun = Get-BunPath
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# One slice, then commit whatever it banked to the data branch. Both steps are
# no-ops when there is nothing to do, so a tick with no free quota costs nothing
# and writes nothing.
$inner = "& '$bun' run scripts/backtest-auto.ts --budget $Budget; " +
         "& '$bun' run scripts/backtest-commit.ts"
$command = "Set-Location '$RepoRoot'; $inner *>> '$LogPath'"

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `"$command`"" `
    -WorkingDirectory $RepoRoot

# Repeat indefinitely from the next whole hour.
$start = (Get-Date).Date.AddHours((Get-Date).Hour + 1)
$trigger = New-ScheduledTaskTrigger -Once -At $start `
    -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)

# StartWhenAvailable catches up after the machine was asleep — a laptop that was
# closed overnight should take its next slice on wake, not wait for the hour.
# The 2h execution limit is a backstop: a slice is ~20 forecasts and should take
# well under an hour, so anything longer is wedged and should be killed.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "replaced existing task"
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Inbrain: run one backtest slice when free Gemini quota is available, then commit run data to the backtest-data branch.' | Out-Null

Write-Output "registered $TaskName"
Write-Output "  every    : $IntervalHours hour(s), starting $start"
Write-Output "  budget   : $Budget forecast(s) per slice"
Write-Output "  log      : $LogPath"
Write-Output ""
Write-Output "Ticks with no free quota exit immediately and spend nothing."
Write-Output "Check progress: powershell -File scripts\backtest-schedule.ps1 -Status"
