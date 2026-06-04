# ==================================================================
# diagnose-usage.ps1 - standalone diagnostic for the usage/analytics hang.
#
# Does NOT start a server and does NOT modify anything. It copies the usage
# pipeline functions verbatim from server.ps1 and runs them, stage by stage,
# against the real usage log on this box, with timing + error capture - so we
# can see exactly which step (read / summarize / serialize) hangs or throws.
#
# Run on the box (no admin needed; read-only):
#   powershell -ExecutionPolicy Bypass -File deploy\diagnose-usage.ps1
#
# It prints progress live AND writes usage-diagnostics.txt in the repo root.
#   - If it COMPLETES: send usage-diagnostics.txt back.
#   - If it HANGS (>30s on one line): note the LAST "Stage ..." line shown,
#     press Ctrl+C, and send that + usage-diagnostics.txt (it is saved before
#     each stage starts).
# Optional: -UsageDir <path> to point at the log dir explicitly;
#           -Recent <n> to also exercise the recent-events slice.
# ==================================================================

param(
  [string]$UsageDir = '',
  [int]$Recent = 0
)

# Match server.ps1 exactly so Stop-mode error behavior reproduces faithfully.
$ErrorActionPreference = 'Stop'

# ---- usage pipeline, copied VERBATIM from deploy/server.ps1 ----
function Read-DotEnv([string]$path) {
  $h = @{}
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    foreach ($line in (Get-Content -LiteralPath $path)) {
      $t = $line.Trim()
      if ($t -eq '' -or $t.StartsWith('#')) { continue }
      $i = $t.IndexOf('=')
      if ($i -lt 1) { continue }
      $k = $t.Substring(0, $i).Trim()
      $v = $t.Substring($i + 1).Trim()
      if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      $h[$k] = $v
    }
  }
  return $h
}

function Get-EnvOr([string]$key, $default) {
  if ($script:DotEnv.ContainsKey($key) -and $script:DotEnv[$key] -ne '') { return $script:DotEnv[$key] }
  $v = [Environment]::GetEnvironmentVariable($key)
  if ($v) { return $v }
  return $default
}

function Get-Prop($o, [string]$name) {
  if ($null -eq $o) { return $null }
  if ($o -is [System.Collections.IDictionary]) {
    if ($o.Contains($name)) { return $o[$name] }
    return $null
  }
  if ($o -is [psobject]) {
    $p = $o.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
  }
  return $null
}

function Escape-JsonString([string]$s) {
  if ($null -eq $s) { return '""' }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append([char]34)
  foreach ($ch in $s.ToCharArray()) {
    $code = [int]$ch
    if ($ch -eq [char]34) { [void]$sb.Append('\"') }
    elseif ($ch -eq [char]92) { [void]$sb.Append('\\') }
    elseif ($code -eq 8) { [void]$sb.Append('\b') }
    elseif ($code -eq 12) { [void]$sb.Append('\f') }
    elseif ($code -eq 10) { [void]$sb.Append('\n') }
    elseif ($code -eq 13) { [void]$sb.Append('\r') }
    elseif ($code -eq 9) { [void]$sb.Append('\t') }
    elseif ($code -lt 32) { [void]$sb.Append(('\u{0:x4}' -f $code)) }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append([char]34)
  return $sb.ToString()
}

function Write-BriefingJson($obj, [int]$indent = 0) {
  $pad = '  ' * $indent
  $padIn = '  ' * ($indent + 1)
  if ($null -eq $obj) { return 'null' }
  if ($obj -is [bool]) { if ($obj) { return 'true' } else { return 'false' } }
  if ($obj -is [int] -or $obj -is [long] -or $obj -is [int16] -or $obj -is [byte] -or $obj -is [uint32] -or $obj -is [int64]) {
    return [string]$obj
  }
  if ($obj -is [double] -or $obj -is [single] -or $obj -is [decimal]) {
    return [System.Convert]::ToString($obj, [System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($obj -is [string]) { return (Escape-JsonString $obj) }
  if ($obj -is [System.Collections.IDictionary]) {
    $keys = @($obj.Keys)
    if ($keys.Count -eq 0) { return '{}' }
    $parts = foreach ($k in $keys) {
      "$padIn$(Escape-JsonString ([string]$k)): $(Write-BriefingJson $obj[$k] ($indent + 1))"
    }
    return "{`n" + ($parts -join ",`n") + "`n$pad}"
  }
  if ($obj -is [System.Collections.IEnumerable]) {
    $items = @($obj)
    if ($items.Count -eq 0) { return '[]' }
    $parts = foreach ($it in $items) { "$padIn$(Write-BriefingJson $it ($indent + 1))" }
    return "[`n" + ($parts -join ",`n") + "`n$pad]"
  }
  # Fallback: a property bag (e.g. ConvertFrom-Json PSCustomObject).
  $props = @($obj.PSObject.Properties)
  if ($props.Count -eq 0) { return '{}' }
  $parts = foreach ($p in $props) {
    "$padIn$(Escape-JsonString $p.Name): $(Write-BriefingJson $p.Value ($indent + 1))"
  }
  return "{`n" + ($parts -join ",`n") + "`n$pad}"
}

function Get-DbPath {
  $p = Get-EnvOr 'BRIEFING_DB' './data/state.json'
  if ([System.IO.Path]::IsPathRooted($p)) { return $p }
  return [System.IO.Path]::GetFullPath((Join-Path $script:RepoRoot $p))
}

function Get-UsageDir {
  $p = Get-EnvOr 'USAGE_LOG' ''
  $base = [System.IO.Path]::GetDirectoryName((Get-DbPath))
  if (-not $p) { return (Join-Path $base 'usage') }
  if ([System.IO.Path]::IsPathRooted($p)) { return $p }
  return [System.IO.Path]::GetFullPath((Join-Path $base $p))
}

function Read-UsageEvents([string]$since, [string]$until) {
  $dir = Get-UsageDir
  $events = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $dir)) { return , $events.ToArray() }
  $files = Get-ChildItem -LiteralPath $dir -Filter 'usage-*.jsonl' -File -ErrorAction SilentlyContinue | Sort-Object Name
  foreach ($f in $files) {
    $lines = @()
    try { $lines = [System.IO.File]::ReadAllLines($f.FullName, [System.Text.Encoding]::UTF8) } catch { continue }
    foreach ($line in $lines) {
      if (-not $line) { continue }
      $ev = $null
      try { $ev = $line | ConvertFrom-Json } catch { continue }
      $ts = [string](Get-Prop $ev 'ts')
      if ($since -and $ts -lt $since) { continue }
      if ($until -and $ts -gt $until) { continue }
      [void]$events.Add($ev)
    }
  }
  return , $events.ToArray()
}

function Add-UsageBucket($map, $key, $ev) {
  if ($null -eq $key -or $key -eq '') { return }
  $k = [string]$key
  if (-not $map.Contains($k)) { $map[$k] = [ordered]@{ key = $k; events = 0; dwell_ms = 0 } }
  $map[$k]['events'] = [int]$map[$k]['events'] + 1
  $dur = Get-Prop $ev 'dur_ms'
  if ($null -ne $dur) { $map[$k]['dwell_ms'] = [int]$map[$k]['dwell_ms'] + [int]$dur }
}

function Sort-UsageBuckets($map) {
  return @($map.Values | Sort-Object -Property @{ Expression = { $_['events'] }; Descending = $true }, @{ Expression = { $_['dwell_ms'] }; Descending = $true })
}

function Summarize-Usage($events, [int]$recent) {
  $byUser = @{}; $byArea = @{}; $byModule = @{}; $byType = @{}; $byDay = @{}
  $users = @{}
  $from = $null; $to = $null
  foreach ($ev in $events) {
    $u = [string](Get-Prop $ev 'user'); if (-not $u) { $u = 'anonymous' }
    $users[$u] = $true
    $ts = [string](Get-Prop $ev 'ts')
    if (-not $from -or $ts -lt $from) { $from = $ts }
    if (-not $to -or $ts -gt $to) { $to = $ts }
    Add-UsageBucket $byUser $u $ev
    Add-UsageBucket $byType (Get-Prop $ev 'type') $ev
    if ($ts) { Add-UsageBucket $byDay ($ts.Substring(0, [Math]::Min(10, $ts.Length))) $ev }
    $area = Get-Prop $ev 'area'; if ($area) { Add-UsageBucket $byArea $area $ev }
    $mod = Get-Prop $ev 'module_id'; if ($mod) { Add-UsageBucket $byModule $mod $ev }
  }
  $result = [ordered]@{
    total        = $events.Count
    unique_users = $users.Count
    range        = [ordered]@{ from = $from; to = $to }
    by_user      = Sort-UsageBuckets $byUser
    by_area      = Sort-UsageBuckets $byArea
    by_module    = Sort-UsageBuckets $byModule
    by_type      = Sort-UsageBuckets $byType
    by_day       = @($byDay.Values | Sort-Object -Property @{ Expression = { $_['key'] } })
  }
  if ($recent -gt 0 -and $events.Count -gt 0) {
    $rec = New-Object System.Collections.ArrayList
    for ($i = $events.Count - 1; $i -ge 0 -and $rec.Count -lt $recent; $i--) { [void]$rec.Add($events[$i]) }
    $result['recent'] = @($rec.ToArray())
  }
  return $result
}

# ---- diagnostic driver ----
$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:DotEnv   = Read-DotEnv (Join-Path $script:RepoRoot '.env')
$script:DiagLog  = New-Object System.Collections.ArrayList

function Write-Diag([string]$m) { [void]$script:DiagLog.Add($m); Write-Host $m }
function Save-Diag {
  ($script:DiagLog -join [Environment]::NewLine) |
    Set-Content -LiteralPath (Join-Path $script:RepoRoot 'usage-diagnostics.txt') -Encoding UTF8
}
function Report-Err($e, [string]$stage, $sw) {
  $sw.Stop()
  Write-Diag ("  ERROR in {0} after {1} ms" -f $stage, $sw.ElapsedMilliseconds)
  Write-Diag ("    Message: {0}" -f $e.Exception.Message)
  Write-Diag ("    Type:    {0}" -f $e.Exception.GetType().FullName)
  Write-Diag ("    At:      {0}" -f ($e.InvocationInfo.PositionMessage -replace "`r?`n", ' '))
  Write-Diag ("    Stack:   {0}" -f ($e.ScriptStackTrace -replace "`r?`n", ' | '))
  Save-Diag
  Write-Host "Wrote usage-diagnostics.txt" -ForegroundColor Yellow
  exit 1
}

Write-Diag "===== meridian-briefing usage diagnostics ====="
Write-Diag ("time:        {0}" -f (Get-Date).ToString('s'))
Write-Diag ("PSVersion:   {0}" -f $PSVersionTable.PSVersion)
Write-Diag ("RepoRoot:    {0}" -f $script:RepoRoot)
Write-Diag ("DbPath:      {0}" -f (Get-DbPath))
$udir = if ($UsageDir) { $UsageDir } else { Get-UsageDir }
Write-Diag ("UsageDir:    {0}" -f $udir)
Write-Diag ("UsageDir exists: {0}" -f (Test-Path -LiteralPath $udir))

if (Test-Path -LiteralPath $udir) {
  $files = @(Get-ChildItem -LiteralPath $udir -Filter 'usage-*.jsonl' -File -ErrorAction SilentlyContinue)
  Write-Diag ("log files:   {0}" -f $files.Count)
  foreach ($f in $files) { Write-Diag ("  {0}  {1} bytes" -f $f.Name, $f.Length) }

  $total = 0; $bad = 0; $users = @{}; $types = @{}
  $samples = New-Object System.Collections.ArrayList
  foreach ($f in $files) {
    $raw = @()
    try { $raw = [System.IO.File]::ReadAllLines($f.FullName, [System.Text.Encoding]::UTF8) }
    catch { Write-Diag ("  READ FAIL {0}: {1}" -f $f.Name, $_.Exception.Message); continue }
    foreach ($ln in $raw) {
      if (-not $ln) { continue }
      $total++
      if ($samples.Count -lt 3) { [void]$samples.Add($ln) }
      $obj = $null
      try { $obj = $ln | ConvertFrom-Json }
      catch { $bad++; if ($bad -le 5) { Write-Diag ("  BAD JSON LINE: {0}" -f $ln) }; continue }
      $u = [string]($obj.user); if (-not $u) { $u = '(empty)' }
      $t = [string]($obj.type)
      $users[$u] = [int]$users[$u] + 1
      $types[$t] = [int]$types[$t] + 1
    }
  }
  Write-Diag ("raw lines:   {0}   parse failures: {1}" -f $total, $bad)
  Write-Diag "sample lines:"
  foreach ($s in $samples) { Write-Diag ("  {0}" -f $s) }
  Write-Diag "distinct users (in [brackets] to expose odd chars):"
  foreach ($k in $users.Keys) { Write-Diag ("  [{0}] x{1}" -f $k, $users[$k]) }
  Write-Diag "distinct types:"
  foreach ($k in $types.Keys) { Write-Diag ("  {0} x{1}" -f $k, $types[$k]) }
}

Write-Diag ""
Write-Diag "--- Stage A: Read-UsageEvents '' ''  (hang here => the read loop) ---"
Save-Diag
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try { $events = Read-UsageEvents '' '' } catch { Report-Err $_ 'Read-UsageEvents' $sw }
$sw.Stop(); Write-Diag ("  OK: {0} events in {1} ms" -f $events.Count, $sw.ElapsedMilliseconds)

Write-Diag ""
Write-Diag "--- Stage B: Summarize-Usage  (hang here => summarize/sort) ---"
Save-Diag
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try { $summary = Summarize-Usage $events $Recent } catch { Report-Err $_ 'Summarize-Usage' $sw }
$sw.Stop(); Write-Diag ("  OK in {0} ms (total={1} unique_users={2})" -f $sw.ElapsedMilliseconds, $summary['total'], $summary['unique_users'])

Write-Diag ""
Write-Diag "--- Stage C: Write-BriefingJson(summary)  (hang here => the JSON serializer) ---"
Save-Diag
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try { $json = Write-BriefingJson $summary 0 } catch { Report-Err $_ 'Write-BriefingJson' $sw }
$sw.Stop(); Write-Diag ("  OK: {0} chars in {1} ms" -f $json.Length, $sw.ElapsedMilliseconds)

Write-Diag ""
Write-Diag "--- JSON preview (first 1500 chars) ---"
Write-Diag ($json.Substring(0, [Math]::Min(1500, $json.Length)))

Write-Diag ""
Write-Diag "--- Stage D: re-parse the serializer output ---"
try { [void]($json | ConvertFrom-Json); Write-Diag "  OK: server output is valid JSON" }
catch { Write-Diag ("  INVALID JSON OUTPUT: {0}" -f $_.Exception.Message) }

Write-Diag ""
Write-Diag "If every stage is OK and the JSON is valid, the usage COMPUTATION is fine -- the"
Write-Diag "hang is in the live HTTP/auth/proxy layer or the browser; also send server-error.log."
Save-Diag
Write-Host ""
Write-Host ("Wrote {0}" -f (Join-Path $script:RepoRoot 'usage-diagnostics.txt')) -ForegroundColor Green
