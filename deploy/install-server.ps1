# meridian-briefing — CR DEV server install (runs IN PLACE from a git clone).
#
# Registers a scheduled task that starts the Node server AT SYSTEM STARTUP (no
# interactive logon needed), running as SYSTEM so it can bind 0.0.0.0. To update
# later: `git pull` in the clone, then restart the task (last line prints how).
#
#   cd D:\meridian-briefing
#   powershell -ExecutionPolicy Bypass -File deploy\install-server.ps1
#
# Prefer a real Windows Service? See deploy\README-server.md ("nssm option").
# ASCII-only / no here-strings so encoding + line endings don't matter.

$ErrorActionPreference = "Stop"

$TaskName = "BriefingServer"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $ScriptDir "..")).Path

Write-Host ""
Write-Host "meridian-briefing server install (in-place from clone)" -ForegroundColor Cyan
Write-Host "------------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "Repo root: $Root"

# --- 1. Sanity ---
if (-not (Test-Path -LiteralPath (Join-Path $Root "server.js"))) {
  Write-Host "ERROR: server.js not found in $Root. Run from deploy\ inside the clone." -ForegroundColor Red
  exit 1
}

# --- 2. Node 20.6+ ---
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
  Write-Host "ERROR: 'node' not on PATH. Install Node 20.6+ (LTS), reopen the terminal." -ForegroundColor Red
  exit 1
}
$verRaw = (& node --version).TrimStart('v')
$verParts = $verRaw.Split('.'); $major = [int]$verParts[0]; $minor = [int]$verParts[1]
Write-Host "Node: v$verRaw"
if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 6)) {
  Write-Host "ERROR: Node v$verRaw too old; --env-file needs 20.6+." -ForegroundColor Red
  exit 1
}

# --- 3. .env from example if missing ---
$envPath    = Join-Path $Root ".env"
$envExample = Join-Path $Root ".env.example"
if (-not (Test-Path -LiteralPath $envPath)) {
  Copy-Item -LiteralPath $envExample -Destination $envPath
  Write-Host ""
  Write-Host "Created .env from .env.example. EDIT IT before the server is useful:" -ForegroundColor Yellow
  Write-Host "  HOST=0.0.0.0                 (accept in-network connections)" -ForegroundColor Yellow
  Write-Host "  PORT=<port Billy assigned>   (e.g. 8090)" -ForegroundColor Yellow
  Write-Host "  BRIEFING_DB=D:\meridian-briefing-data\state.json   (persistent, outside the clone)" -ForegroundColor Yellow
  Write-Host "  ADMIN_PASSWORD_HASH / ADMIN_PASSWORD_SALT   (from: npm run hash-password on the Linux box)" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Re-run this script after editing .env, or just restart the task (printed below)." -ForegroundColor Yellow
} else {
  Write-Host ".env already present (preserved)."
}

# --- 4. Read PORT from .env for the post-start health check (default 8788) ---
$Port = 8788
if (Test-Path -LiteralPath $envPath) {
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*PORT\s*=\s*(\d+)') { $Port = [int]$Matches[1] }
  }
}
Write-Host "Configured port: $Port"

# --- 5. Stop prior task + free the port ---
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Stopping prior '$TaskName'..." -ForegroundColor Yellow
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}
try {
  $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($ownerPid in $owners) {
    Write-Host "  killing PID $ownerPid (port $Port owner)" -ForegroundColor Yellow
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
  }
} catch {
  Write-Host "  (no port owner found)" -ForegroundColor DarkGray
}

# --- 6. Register: runs as SYSTEM at startup, from the clone dir ---
$Action    = New-ScheduledTaskAction -Execute "node.exe" -Argument "--env-file=.env server.js" -WorkingDirectory $Root
$Trigger   = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Write-Host "Task '$TaskName' registered (runs as SYSTEM at startup)." -ForegroundColor Green

# --- 7. Start + verify ---
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$attempt = 0; $listening = $false
while ($attempt -lt 12) {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $listening = $true; break }
  Start-Sleep -Seconds 1; $attempt++
}
Write-Host ""
if ($listening) {
  Write-Host "meridian-briefing is listening on port $Port." -ForegroundColor Green
  Write-Host "  Local check:    http://127.0.0.1:$Port/" -ForegroundColor Green
  Write-Host "  In-network:     http://<this-host>:$Port/   (Billy: open the firewall / front with IIS)" -ForegroundColor Green
} else {
  Write-Host "WARNING: port $Port did not come up in 12s." -ForegroundColor Yellow
  Write-Host "  Check: Get-ScheduledTaskInfo -TaskName $TaskName" -ForegroundColor Yellow
  Write-Host "  Common causes: .env not yet edited (no admin password), BRIEFING_DB parent folder missing," -ForegroundColor Yellow
  Write-Host "    or another process already on port $Port." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "To UPDATE later: git pull, then:" -ForegroundColor Cyan
Write-Host "  Stop-ScheduledTask -TaskName $TaskName ; Start-ScheduledTask -TaskName $TaskName" -ForegroundColor Cyan
