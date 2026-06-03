# meridian-briefing — CR DEV server install (runs IN PLACE from a git clone).
#
# Registers a scheduled task that starts the PowerShell server (deploy\server.ps1)
# AT SYSTEM STARTUP (no interactive logon needed), running as SYSTEM so it can
# bind 0.0.0.0 and satisfy the HttpListener URL ACL. NO Node required — this is
# the no-Node production path. (Node boxes can run server.js instead; see
# deploy\README-server.md.) To update later: `git pull` in the clone, then
# restart the task (last line prints how).
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
$ServerPs1 = Join-Path $ScriptDir "server.ps1"
if (-not (Test-Path -LiteralPath $ServerPs1)) {
  Write-Host "ERROR: server.ps1 not found in $ScriptDir. Run from deploy\ inside the clone." -ForegroundColor Red
  exit 1
}

# --- 2. Windows PowerShell 5.1+ (no Node needed) ---
if ($PSVersionTable.PSVersion.Major -lt 5) {
  Write-Host "ERROR: Windows PowerShell 5.1+ required (found $($PSVersionTable.PSVersion))." -ForegroundColor Red
  exit 1
}
Write-Host "PowerShell: $($PSVersionTable.PSVersion)  (.NET Framework 4.6.1+ required for Rfc2898DeriveBytes/SHA256)"

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

# --- 5b. Reserve the URL ACL so SYSTEM can bind http://+:PORT/ (HOST=0.0.0.0) ---
# SYSTEM can usually bind the wildcard prefix without this, but reserving it is
# harmless and removes one failure mode. Already-exists (error 183) is fine.
$prefix = "http://+:$Port/"
& netsh http add urlacl url=$prefix user="NT AUTHORITY\SYSTEM" 2>&1 | Out-Null
Write-Host "URL ACL ensured for $prefix (SYSTEM)."

# --- 6. Register: runs as SYSTEM at startup, from the clone dir ---
$PsExe     = (Get-Command powershell.exe).Source
$PsArgs    = "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$ServerPs1`""
$Action    = New-ScheduledTaskAction -Execute $PsExe -Argument $PsArgs -WorkingDirectory $Root
$Trigger   = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
Write-Host "Task '$TaskName' registered (PowerShell server, runs as SYSTEM at startup)." -ForegroundColor Green

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
