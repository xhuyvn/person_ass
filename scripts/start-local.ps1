<#
.SYNOPSIS
  Start the PersonalAss local backend (and optionally the Expo web dev server).

.DESCRIPTION
  Steps:
    1. Resolve the repository root.
    2. Check that node and npm are available.
    3. Create .env from .env.example when missing.
    4. Resolve the port (PORT env var, then PORT in .env, then 2310).
    5. Refuse to start when the port is held by a foreign process.
    6. Run database migrations.
    7. Build and start the backend, then wait for /health/ready (HTTP 200).
    8. Print (or start) the Expo web dev server command.

  A PID/port lock file under .data\ prevents a second instance. Every recorded
  PID is stored with its process name and start time so that stop-local.ps1
  never kills a recycled PID.
  No secrets are written by this script and no admin rights are required.
#>
[CmdletBinding()]
param(
  [switch]$Web,
  [int]$ReadyTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) { Write-Host "[start-local] $Message" }
function Write-WarnMsg([string]$Message) { Write-Host "[start-local][WARN] $Message" -ForegroundColor Yellow }
function Write-ErrMsg([string]$Message) { Write-Host "[start-local][ERROR] $Message" -ForegroundColor Red }

# 1. Resolve repo root -------------------------------------------------------
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

$DataDir = Join-Path $RepoRoot '.data'
$LogDir = Join-Path $DataDir 'logs'
$LockFile = Join-Path $DataDir 'local.lock.json'
$EnvFile = Join-Path $RepoRoot '.env'
$EnvExample = Join-Path $RepoRoot '.env.example'

if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# 2. Check node / npm --------------------------------------------------------
foreach ($Tool in @('node', 'npm')) {
  if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) {
    Write-ErrMsg "'$Tool' was not found in PATH. Install Node.js LTS and reopen the terminal."
    exit 1
  }
}
$NodeVersion = (& node --version) 2>$null
$NpmVersion = (& npm --version) 2>$null
Write-Info "node $NodeVersion / npm $NpmVersion"

# 3. .env bootstrap ----------------------------------------------------------
if (-not (Test-Path $EnvFile)) {
  if (Test-Path $EnvExample) {
    Copy-Item $EnvExample $EnvFile
    Write-Info "Created .env from .env.example"
  } else {
    Write-WarnMsg ".env.example not found; continuing without a local .env file."
  }
}

# 4. Resolve the port --------------------------------------------------------
# Priority: the PORT environment variable, then PORT= in .env, then 2310.
function Get-DotEnvValue([string]$File, [string]$Key) {
  if (-not (Test-Path $File)) { return $null }
  foreach ($Line in (Get-Content -LiteralPath $File -ErrorAction SilentlyContinue)) {
    $Trimmed = $Line.Trim()
    if ($Trimmed.Length -eq 0 -or $Trimmed.StartsWith('#')) { continue }
    $Eq = $Trimmed.IndexOf('=')
    if ($Eq -le 0) { continue }
    if ($Trimmed.Substring(0, $Eq).Trim() -ne $Key) { continue }
    $Value = $Trimmed.Substring($Eq + 1).Trim()
    if ($Value.Length -ge 2 -and
        (($Value.StartsWith('"') -and $Value.EndsWith('"')) -or
         ($Value.StartsWith("'") -and $Value.EndsWith("'")))) {
      $Value = $Value.Substring(1, $Value.Length - 2)
    }
    return $Value
  }
  return $null
}

$Port = 0
$PortSource = ''
$EnvPort = $env:PORT
if ($EnvPort -and $EnvPort.Trim().Length -gt 0) {
  $Port = [int]$EnvPort
  $PortSource = 'the PORT environment variable'
} else {
  $DotEnvPort = Get-DotEnvValue $EnvFile 'PORT'
  if ($DotEnvPort -and $DotEnvPort.Trim().Length -gt 0) {
    $Port = [int]$DotEnvPort
    $PortSource = 'PORT in .env'
  } else {
    $Port = 2310
    $PortSource = 'the default value'
  }
}
if ($Port -lt 1 -or $Port -gt 65535) {
  Write-ErrMsg "Invalid port '$Port' (must be between 1 and 65535)."
  exit 1
}
$ReadyUrl = "http://127.0.0.1:$Port/health/ready"
Write-Info "Port $Port (from $PortSource)."

# 5. Guard against a second instance ----------------------------------------
$Existing = $null
if (Test-Path $LockFile) {
  try { $Existing = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json } catch { $Existing = $null }
  $Running = $false
  if ($Existing -and $Existing.backendPid) {
    $Running = $null -ne (Get-Process -Id ([int]$Existing.backendPid) -ErrorAction SilentlyContinue)
  }
  if ($Running) {
    Write-ErrMsg "A local instance is already running (backend PID $($Existing.backendPid)). Run scripts\stop-local.ps1 first."
    exit 1
  }
  Write-Info "Removing stale lock file."
  Remove-Item -LiteralPath $LockFile -Force
}

# 5b. Refuse to start when a FOREIGN process already owns the port ----------
function Get-ListeningProcessIds([int]$TcpPort) {
  try {
    $Connections = Get-NetTCPConnection -LocalPort $TcpPort -State Listen -ErrorAction SilentlyContinue
    if (-not $Connections) { return @() }
    return @($Connections | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
  } catch {
    return @()
  }
}

$OurPids = @()
if ($Existing) {
  foreach ($Name in @('backendPid', 'webPid')) {
    if ($Existing.PSObject.Properties.Name -contains $Name -and $Existing.$Name) {
      $OurPids += [int]$Existing.$Name
    }
  }
  if ($Existing.PSObject.Properties.Name -contains 'backendPids' -and $Existing.backendPids) {
    foreach ($Id in $Existing.backendPids) { $OurPids += [int]$Id }
  }
}

$Owners = @(Get-ListeningProcessIds $Port)
$ForeignOwners = @($Owners | Where-Object { $OurPids -notcontains $_ })
if ($ForeignOwners.Count -gt 0) {
  $Details = ($ForeignOwners | ForEach-Object {
    $Proc = Get-Process -Id $_ -ErrorAction SilentlyContinue
    if ($Proc) { "PID $_ ($($Proc.ProcessName))" } else { "PID $_ (unknown)" }
  }) -join ', '
  Write-ErrMsg "Port $Port is already in use by a process that was not started by this repo: $Details."
  Write-ErrMsg "Refusing to start: another service would answer on the readiness URL."
  exit 1
}

# 6. Migrations --------------------------------------------------------------
Write-Info "Running database migrations..."
& npm run migrate --workspace apps/server
if ($LASTEXITCODE -ne 0) {
  Write-ErrMsg "Migration failed (exit code $LASTEXITCODE)."
  exit 1
}

# 7. Build + start backend --------------------------------------------------
Write-Info "Building the backend..."
& npm run build:server
if ($LASTEXITCODE -ne 0) {
  Write-ErrMsg "Backend build failed (exit code $LASTEXITCODE)."
  exit 1
}

$BackendOut = Join-Path $LogDir 'backend.out.log'
$BackendErr = Join-Path $LogDir 'backend.err.log'

Write-Info "Starting the backend on port $Port..."
$BackendProcess = Start-Process -FilePath 'npm.cmd' `
  -ArgumentList @('run', 'start', '--workspace', 'apps/server') `
  -WorkingDirectory $RepoRoot `
  -RedirectStandardOutput $BackendOut `
  -RedirectStandardError $BackendErr `
  -PassThru -NoNewWindow

# Record the npm launcher PID. The full process chain (npm -> node) is
# collected once the server is up, so stop-local.ps1 can shut all of it down.
$ServerPids = New-Object System.Collections.Generic.List[int]
$ServerPids.Add([int]$BackendProcess.Id)

function Get-DescendantProcessIds([int]$RootProcessId) {
  $Found = New-Object System.Collections.Generic.List[int]
  $Queue = New-Object System.Collections.Generic.Queue[int]
  $Queue.Enqueue($RootProcessId)
  while ($Queue.Count -gt 0) {
    $Current = $Queue.Dequeue()
    $Children = $null
    try {
      $Children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$Current" -ErrorAction SilentlyContinue
    } catch {
      $Children = $null
    }
    if ($Children) {
      foreach ($Child in $Children) {
        $ChildId = [int]$Child.ProcessId
        if (-not $Found.Contains($ChildId)) {
          $Found.Add($ChildId)
          $Queue.Enqueue($ChildId)
        }
      }
    }
  }
  return $Found
}

# 8. Wait for readiness -----------------------------------------------------
# Readiness means exactly HTTP 200. Any other answer (503 degraded, a 404
# from a foreign service, ...) means NOT ready and must fail the script.
Write-Info "Waiting for $ReadyUrl ..."
$Deadline = (Get-Date).AddSeconds($ReadyTimeoutSeconds)
$Ready = $false
$ReadyStatus = $null
while ((Get-Date) -lt $Deadline) {
  if ($BackendProcess.HasExited) {
    Write-ErrMsg "The backend exited early. See $BackendErr"
    exit 1
  }
  $Status = $null
  try {
    $Response = Invoke-WebRequest -Uri $ReadyUrl -UseBasicParsing -TimeoutSec 5
    $Status = [int]$Response.StatusCode
  } catch {
    $Status = $null
    if ($_.Exception.Response) {
      try { $Status = [int]$_.Exception.Response.StatusCode } catch { $Status = $null }
    }
  }

  if ($null -eq $Status) {
    # No answer yet: the backend is probably still starting.
    Start-Sleep -Milliseconds 500
    continue
  }

  $ReadyStatus = $Status
  if ($Status -eq 200) {
    $Ready = $true
    break
  }

  Write-ErrMsg "The backend answered HTTP $Status on $ReadyUrl. Readiness requires HTTP 200."
  Write-ErrMsg "See $BackendErr for the details. The backend has been left running; stop it with scripts\stop-local.ps1."
  exit 1
}

if (-not $Ready) {
  Write-ErrMsg "The backend did not become ready within $ReadyTimeoutSeconds seconds. See $BackendErr"
  exit 1
}

Write-Info "Backend is ready (HTTP 200)."

# 9. Collect the process tree and write the lock file ------------------------
try {
  foreach ($DescendantId in (Get-DescendantProcessIds ([int]$BackendProcess.Id))) {
    if (-not $ServerPids.Contains($DescendantId)) { $ServerPids.Add($DescendantId) }
  }
} catch {
  Write-WarnMsg "Could not inspect child processes; only the launcher PID will be recorded."
}

# Every PID is recorded with its process name and start time so that
# stop-local.ps1 can detect a recycled PID and skip it.
function Get-ProcessSignature([int]$ProcessId) {
  $Proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $Proc) { return $null }
  $StartTime = $null
  try { $StartTime = $Proc.StartTime.ToString('o') } catch { $StartTime = $null }
  return [ordered]@{
    pid = $ProcessId
    name = $Proc.ProcessName
    startTime = $StartTime
  }
}

$ProcessRecords = New-Object System.Collections.Generic.List[object]
foreach ($Id in $ServerPids) {
  $Signature = Get-ProcessSignature $Id
  if ($null -ne $Signature) { $ProcessRecords.Add($Signature) }
}

$Lock = [ordered]@{
  backendPid = [int]$BackendProcess.Id
  backendPids = @($ServerPids)
  # .ToArray() instead of @($ProcessRecords): PowerShell 5.1 throws
  # "Argument types do not match" when an array subexpression wraps a
  # generic List whose items are OrderedDictionary instances.
  backendProcesses = $ProcessRecords.ToArray()
  webPid = $null
  webProcess = $null
  port = $Port
  startedAt = (Get-Date).ToString('o')
  repoRoot = $RepoRoot
}
$Lock | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $LockFile -Encoding ascii

# 10. Expo web dev server ---------------------------------------------------
$WebCommand = "npm run web --workspace apps/client"
if ($Web) {
  $WebOut = Join-Path $LogDir 'web.out.log'
  $WebErr = Join-Path $LogDir 'web.err.log'
  Write-Info "Starting the Expo web dev server..."
  $WebProcess = Start-Process -FilePath 'npm.cmd' `
    -ArgumentList @('run', 'web', '--workspace', 'apps/client') `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $WebOut `
    -RedirectStandardError $WebErr `
    -PassThru -NoNewWindow

  $Lock.webPid = [int]$WebProcess.Id
  $Lock.webProcess = Get-ProcessSignature ([int]$WebProcess.Id)
  $Lock | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $LockFile -Encoding ascii
  Write-Info "Expo web dev server started (PID $($WebProcess.Id)). Logs: $WebOut"
} else {
  Write-Info "Start the Expo web dev server in a second terminal with:"
  Write-Host "    $WebCommand"
}

Write-Info "Done. API: http://127.0.0.1:$Port  |  lock file: $LockFile"
exit 0
