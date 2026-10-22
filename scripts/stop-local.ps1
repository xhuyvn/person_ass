<#
.SYNOPSIS
  Stop the PersonalAss local backend started by scripts\start-local.ps1.

.DESCRIPTION
  Reads .data\local.lock.json, stops the recorded process chain gracefully
  (Stop-Process), removes the lock file and reports what was stopped.

  Every recorded PID is verified against the process name and the start time
  that were captured when the process was started: a PID that has been
  recycled by the operating system is SKIPPED (with a warning) instead of
  killing an unrelated process.

  No admin rights are required and no secrets are read or written.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) { Write-Host "[stop-local] $Message" }
function Write-WarnMsg([string]$Message) { Write-Host "[stop-local][WARN] $Message" -ForegroundColor Yellow }
function Write-ErrMsg([string]$Message) { Write-Host "[stop-local][ERROR] $Message" -ForegroundColor Red }

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

$DataDir = Join-Path $RepoRoot '.data'
$LockFile = Join-Path $DataDir 'local.lock.json'

if (-not (Test-Path $LockFile)) {
  Write-WarnMsg "No lock file found at $LockFile. Nothing to stop."
  exit 0
}

$Lock = $null
try {
  $Lock = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json
} catch {
  Write-ErrMsg "The lock file could not be parsed: $($_.Exception.Message)"
  exit 1
}

$Stopped = New-Object System.Collections.Generic.List[string]
$Skipped = New-Object System.Collections.Generic.List[string]

function Stop-ProcessTree([int]$ProcessId, [int]$Depth = 0) {
  if ($Depth -gt 4) { return }
  try {
    $Children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
    foreach ($Child in $Children) { Stop-ProcessTree ([int]$Child.ProcessId) ($Depth + 1) }
  } catch {
    # ignore enumeration errors; the parent is still stopped below
  }

  $Proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $Proc) { return }

  $Name = $Proc.ProcessName
  try {
    Stop-Process -Id $ProcessId -ErrorAction Stop
    $Stopped.Add("PID $ProcessId ($Name)")
  } catch {
    try {
      Stop-Process -Id $ProcessId -Force -ErrorAction Stop
      $Stopped.Add("PID $ProcessId ($Name, forced)")
    } catch {
      Write-WarnMsg "Could not stop PID $ProcessId ($Name): $($_.Exception.Message)"
    }
  }
}

function Get-ProcessSignature([int]$ProcessId) {
  $Proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $Proc) { return $null }
  # A process that is exiting can still be returned by Get-Process with an
  # empty ProcessName: treat it as gone instead of reporting a bogus recycled
  # PID.
  if (-not $Proc.ProcessName) { return $null }
  $StartTime = $null
  try { $StartTime = $Proc.StartTime.ToString('o') } catch { $StartTime = $null }
  return [ordered]@{
    pid = $ProcessId
    name = $Proc.ProcessName
    startTime = $StartTime
  }
}

# Verify that the PID still belongs to the process that was started.
# Returns $true when the process may be stopped.
function Test-RecordedProcess($Record) {
  $ExpectedPid = 0
  try { $ExpectedPid = [int]$Record.pid } catch { $ExpectedPid = 0 }
  if ($ExpectedPid -le 0) { return $false }

  $Current = Get-ProcessSignature $ExpectedPid
  if ($null -eq $Current) {
    $Skipped.Add("PID $ExpectedPid is not running any more.")
    return $false
  }

  $ExpectedName = $null
  if ($Record.PSObject.Properties.Name -contains 'name') { $ExpectedName = $Record.name }
  if ($ExpectedName -and $Current.name -ne $ExpectedName) {
    $Skipped.Add("PID $ExpectedPid is now '$($Current.name)' (expected '$ExpectedName'): the PID was recycled, skipping.")
    return $false
  }

  $ExpectedStart = $null
  if ($Record.PSObject.Properties.Name -contains 'startTime') { $ExpectedStart = $Record.startTime }
  if ($ExpectedStart -and $Current.startTime -and $ExpectedStart -ne $Current.startTime) {
    $Skipped.Add("PID $ExpectedPid was started at a different time: the PID was recycled, skipping.")
    return $false
  }

  return $true
}

$Seen = @{}

# Preferred path: the recorded process signatures (name + start time).
$Records = @()
if ($Lock.PSObject.Properties.Name -contains 'backendProcesses' -and $Lock.backendProcesses) {
  $Records += @($Lock.backendProcesses)
}
if ($Lock.PSObject.Properties.Name -contains 'webProcess' -and $Lock.webProcess) {
  $Records += @($Lock.webProcess)
}

if ($Records.Count -gt 0) {
  # Reverse order: the lock file lists the launcher first and its descendants
  # afterwards. Stopping the deepest process first means a recorded PID is
  # never killed as a child of an earlier record before its own name/start
  # time has been verified.
  for ($i = $Records.Count - 1; $i -ge 0; $i--) {
    $Record = $Records[$i]
    $Key = "$($Record.pid)"
    if ($Seen.ContainsKey($Key)) { continue }
    $Seen[$Key] = $true
    if (Test-RecordedProcess $Record) {
      Stop-ProcessTree ([int]$Record.pid)
    }
  }
} else {
  # Legacy lock file without signatures: the PIDs cannot be verified, so the
  # stop is reported explicitly.
  Write-WarnMsg "The lock file contains no process signature; the recorded PIDs cannot be verified."
  $TargetIds = New-Object System.Collections.Generic.List[int]
  if ($Lock.PSObject.Properties.Name -contains 'backendPids' -and $Lock.backendPids) {
    foreach ($Id in $Lock.backendPids) { $TargetIds.Add([int]$Id) }
  }
  if ($Lock.PSObject.Properties.Name -contains 'backendPid' -and $Lock.backendPid) {
    $TargetIds.Add([int]$Lock.backendPid)
  }
  if ($Lock.PSObject.Properties.Name -contains 'webPid' -and $Lock.webPid) {
    $TargetIds.Add([int]$Lock.webPid)
  }
  foreach ($Id in $TargetIds) {
    if ($Seen.ContainsKey("$Id")) { continue }
    $Seen["$Id"] = $true
    Stop-ProcessTree $Id
  }
}

Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue

if ($Skipped.Count -gt 0) {
  Write-WarnMsg "Skipped (not started by this script):"
  foreach ($Entry in $Skipped) { Write-Host "    $Entry" }
}

if ($Stopped.Count -eq 0) {
  Write-Info "No running process was recorded. The lock file has been removed."
} else {
  Write-Info "Stopped:"
  foreach ($Entry in $Stopped) { Write-Host "    $Entry" }
}
Write-Info "Lock file removed: $LockFile"
exit 0
