# ==================================================================
# meridian-briefing - PowerShell HttpListener server.
#
# A faithful port of server.js for Windows boxes that CANNOT run Node.js.
# Uses only in-box Windows PowerShell 5.1 + .NET Framework (System.Net.
# HttpListener + Rfc2898DeriveBytes) - no modules, no npm, no Node. Serves the
# same public/ SPA in two modes (read at /, admin at /admin) and the same small
# JSON API over the single state.json document. The Node server (server.js)
# stays the dev + orange-device path; this is the no-Node production path.
#
# Requires: Windows PowerShell 5.1+ and .NET Framework 4.6.1+ (for the
#   Rfc2898DeriveBytes(string, byte[], int, HashAlgorithmName) overload -
#   present on every modern Windows Server; 4.7.2/4.8 ship in-box).
#
# Run (reads .env from the repo root, one dir up from this script):
#   powershell -ExecutionPolicy Bypass -File deploy\server.ps1
#
# Binding http://+:PORT/ (HOST=0.0.0.0) needs admin/SYSTEM, OR a URL ACL:
#   netsh http add urlacl url=http://+:PORT/ user="NT AUTHORITY\SYSTEM"
# The install-server.ps1 scheduled task runs as SYSTEM, which satisfies this.
#
# ---- Auth contract with Node (lib/auth.js) -----------------------
# PBKDF2-HMAC-SHA256, iterations=600000, key=32 bytes, salt=16 bytes (hex),
# password=UTF-8. These MUST match lib/auth.js or a hash made by either side
# won't verify on the other. Known-answer vector (also pinned in
# test/auth.test.mjs) - password "meridian-briefing-test-vector",
# salt 0123456789abcdef0123456789abcdef ->
#   3200cac5c739d530f811c800e184b012c4e25b0b24de8ac8930a9f1e5ed5bb59
# Run with -SelfTest to assert this vector before serving.
#
# ---- Why a hand-rolled JSON serializer ---------------------------
# Windows PowerShell 5.1's ConvertTo-Json defaults to depth 2 (truncates the
# edition tree) AND unwraps single-element arrays to a bare object; its
# ConvertFrom-Json likewise reads `[{..}]` back as a lone object. Both would
# silently corrupt state.json. So output goes through Write-BriefingJson
# (arrays always render as [ ... ]) and every known-array field is re-wrapped
# with To-Array on read in Normalize-Edition / Normalize-State.
# ==================================================================

param(
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# Non-ASCII glyphs are built from code points so this file stays pure ASCII
# (Windows PowerShell 5.1 decodes BOM-less .ps1 as the ANSI codepage, which
# would mangle literal emoji / middot). Runtime strings are correct UTF-8.
$GLYPH_CLIPBOARD = [char]::ConvertFromUtf32(0x1F4CB) # clipboard
$GLYPH_CALENDAR  = [char]::ConvertFromUtf32(0x1F4C5) # tear-off calendar
$GLYPH_MIDDOT    = [string][char]0x00B7              # middle dot separator

$SCHEMA_VERSION = 1
$SESSION_COOKIE = 'briefing_session'
$PBKDF2_ITERATIONS = 600000
$PBKDF2_KEYLEN = 32

# ---------- tiny helpers ----------

function Str($v, $fallback = '') {
  if ($v -is [string]) { return $v }
  return $fallback
}

# Always returns an array (object[]); $null/empty -> empty array, scalar ->
# one-element array. The unary comma keeps PS from unwrapping on return.
function To-Array($v) {
  if ($null -eq $v) { return , @() }
  if ($v -is [string]) { return , @($v) }
  return , @($v)
}

function Has-Prop($o, [string]$name) {
  if ($null -eq $o) { return $false }
  if ($o -is [System.Collections.IDictionary]) { return $o.Contains($name) }
  if ($o -is [psobject]) { return [bool]$o.PSObject.Properties[$name] }
  return $false
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

# Shallow-copy any object's own properties into an ordered dictionary (handles
# both ConvertFrom-Json PSCustomObjects and our own [ordered] editions). This is
# the "...o spread" the JS normalizers rely on to preserve unknown fields.
function Clone-Props($o) {
  $d = [ordered]@{}
  if ($o -is [System.Collections.IDictionary]) {
    foreach ($k in @($o.Keys)) { $d[[string]$k] = $o[$k] }
  } elseif ($o -is [psobject]) {
    foreach ($p in $o.PSObject.Properties) { $d[$p.Name] = $p.Value }
  }
  return $d
}

# ---------- JSON ----------

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

# Pretty-prints with 2-space indent (matches JSON.stringify(x, null, 2)).
# Arrays ALWAYS render as [ ... ] (the whole point - see header).
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

# ---------- id generation (lib/id.js) ----------

$script:Rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider

function New-HexBytes([int]$n) {
  $b = [byte[]]::new($n)
  $script:Rng.GetBytes($b)
  return (([System.BitConverter]::ToString($b)) -replace '-', '').ToLowerInvariant()
}

function New-EditionId {
  $d = (Get-Date).ToString('yyyyMMdd')
  return "ed_${d}_$(New-HexBytes 2)"
}

function New-SessionId { return (New-HexBytes 32) }

# ---------- store (lib/store.js) ----------

function Empty-State {
  return [ordered]@{ schema_version = [int]$SCHEMA_VERSION; current_edition_id = $null; editions = @() }
}

function Normalize-Edition($e) {
  $out = Clone-Props $e

  $issueIn = Get-Prop $e 'issue'
  $mast = Str (Get-Prop $issueIn 'masthead_label')
  $iss = Str (Get-Prop $issueIn 'issue_label')

  $idv = Str $out['id']
  if (-not $idv) { $idv = New-EditionId }
  $out['id'] = $idv
  $out['date'] = Str $out['date']
  $out['title'] = Str $out['title'] 'Untitled edition'
  $out['published'] = ($out['published'] -eq $true)
  $pa = $out['published_at']
  if ($pa -is [string]) { $out['published_at'] = $pa } else { $out['published_at'] = $null }
  $out['issue'] = [ordered]@{ masthead_label = $mast; issue_label = $iss }
  $out['leftAdvisories'] = To-Array $out['leftAdvisories']
  $out['topEvents'] = To-Array $out['topEvents']
  $out['initiatives'] = To-Array $out['initiatives']
  $out['footerLinks'] = To-Array $out['footerLinks']
  return $out
}

# The current edition is the published one with the most recent published_at.
function Recompute-CurrentId($state) {
  $eds = To-Array (Get-Prop $state 'editions')
  $pub = @($eds | Where-Object { (Get-Prop $_ 'published') -eq $true })
  if ($pub.Count -eq 0) { return $null }
  $sorted = $pub | Sort-Object -Property @{ Expression = { [string](Get-Prop $_ 'published_at') } } -Descending
  return [string](Get-Prop ($sorted | Select-Object -First 1) 'id')
}

function Normalize-State($d) {
  $eds = To-Array (Get-Prop $d 'editions')
  $normEds = New-Object System.Collections.ArrayList
  foreach ($e in $eds) { [void]$normEds.Add((Normalize-Edition $e)) }

  $out = Clone-Props $d
  $out['schema_version'] = [int]$SCHEMA_VERSION
  $cid = Get-Prop $d 'current_edition_id'
  if ($cid -is [string]) { $out['current_edition_id'] = $cid } else { $out['current_edition_id'] = $null }
  $out['editions'] = @($normEds.ToArray())
  # Self-heal the current pointer: it must reference a published edition.
  $out['current_edition_id'] = Recompute-CurrentId $out
  return $out
}

function Current-Edition($state) {
  $id = Get-Prop $state 'current_edition_id'
  if (-not $id) { return $null }
  $eds = To-Array (Get-Prop $state 'editions')
  foreach ($e in $eds) {
    if ((Get-Prop $e 'id') -eq $id -and (Get-Prop $e 'published') -eq $true) { return $e }
  }
  return $null
}

function Blank-Edition($date, $title) {
  $today = if ($date) { [string]$date } else { (Get-Date).ToString('yyyy-MM-dd') }
  $issueLabel = "Vol. 1 $GLYPH_MIDDOT Issue 1 $GLYPH_MIDDOT Distribution: All Providers"
  $ed = [ordered]@{
    id           = New-EditionId
    date         = $today
    title        = if ($title) { [string]$title } else { 'New edition' }
    published    = $false
    published_at = $null
    issue        = [ordered]@{ masthead_label = "Week of $today"; issue_label = $issueLabel }
    leftAdvisories = @(
      [ordered]@{ tint = 'teal'; icon = $GLYPH_CLIPBOARD; headline = 'New advisory'; body = 'Advisory body text.'; tag = 'Clinical Reminder' }
    )
    topEvents = @(
      [ordered]@{ area = 'top-b1'; tint = 'sky'; icon = $GLYPH_CALENDAR; headline = 'New event'; body = 'Event body text.'; tag = 'Event' }
    )
    initiatives = @(
      [ordered]@{ key = 'k1'; title = 'New initiative'; tag = 'Quality'; dot = 'blue'; statusLead = 'Status.'; statusBody = ' Status detail.'; why = 'Why this matters.'; how = 'How it affects your workflow.'; what = 'What you need to do.' }
    )
    footerLinks = @(
      [ordered]@{ label = 'Meridian Home'; href = 'https://meridian-os.pages.dev/' }
    )
  }
  return Normalize-Edition $ed
}

function Get-DbPath {
  $p = Get-EnvOr 'BRIEFING_DB' './data/state.json'
  if ([System.IO.Path]::IsPathRooted($p)) { return $p }
  return [System.IO.Path]::GetFullPath((Join-Path $script:RepoRoot $p))
}

function Read-State {
  $path = Get-DbPath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return (Normalize-State (Empty-State)) }
  $txt = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  if (-not $txt.Trim()) { return (Normalize-State (Empty-State)) }
  $obj = $txt | ConvertFrom-Json
  return (Normalize-State $obj)
}

function Write-State($state) {
  $next = Normalize-State $state
  $path = Get-DbPath
  $dir = [System.IO.Path]::GetDirectoryName($path)
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $json = (Write-BriefingJson $next 0) + "`n"
  $tmp = "$path.tmp"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    [System.IO.File]::Replace($tmp, $path, $null) # atomic on NTFS
  } else {
    [System.IO.File]::Move($tmp, $path)
  }
  # TEMP: verify the write actually stuck by re-reading the file immediately.
  $vIds = '<unread>'
  try {
    $vTxt = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
    $vIds = (@(To-Array (Get-Prop ($vTxt | ConvertFrom-Json) 'editions')) | ForEach-Object { Get-Prop $_ 'id' }) -join ','
  } catch { $vIds = "<reread-failed: $($_.Exception.Message)>" }
  Log-Debug ("WRITE path={0} exists={1} wroteIds=[{2}] reReadIds=[{3}]" -f $path, (Test-Path -LiteralPath $path), ((@(To-Array (Get-Prop $next 'editions')) | ForEach-Object { Get-Prop $_ 'id' }) -join ','), $vIds)
  return $next
}

# ---------- auth (lib/auth.js) ----------

function Convert-FromHex([string]$hex) {
  if ([string]::IsNullOrEmpty($hex) -or ($hex.Length % 2 -ne 0)) { throw 'bad hex' }
  $n = [int]($hex.Length / 2)
  $b = [byte[]]::new($n)
  for ($i = 0; $i -lt $n; $i++) { $b[$i] = [System.Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  return , $b
}

function Test-AdminPassword([string]$plain, [string]$hashHex, [string]$saltHex) {
  if (-not $hashHex -or -not $saltHex) { return $false }
  try { $expected = Convert-FromHex $hashHex } catch { return $false }
  if ($expected.Length -ne $PBKDF2_KEYLEN) { return $false }
  try {
    $salt = Convert-FromHex $saltHex
    $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
      [string]$plain, $salt, [int]$PBKDF2_ITERATIONS, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    $actual = $kdf.GetBytes($PBKDF2_KEYLEN)
    $kdf.Dispose()
  } catch { return $false }
  if ($actual.Length -ne $expected.Length) { return $false }
  $diff = 0
  for ($i = 0; $i -lt $actual.Length; $i++) { $diff = $diff -bor ($actual[$i] -bxor $expected[$i]) }
  return ($diff -eq 0)
}

# ---------- sessions (in-memory, sliding window) ----------

$script:Sessions = @{}

function Now-Ms { return [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }

function New-Session {
  $id = New-SessionId
  $script:Sessions[$id] = (Now-Ms) + $script:TtlMs
  return $id
}

function Test-Session([string]$id) {
  if (-not $id) { return $false }
  if (-not $script:Sessions.ContainsKey($id)) { return $false }
  if ($script:Sessions[$id] -le (Now-Ms)) { [void]$script:Sessions.Remove($id); return $false }
  $script:Sessions[$id] = (Now-Ms) + $script:TtlMs # slide expiry forward
  return $true
}

function Remove-Session([string]$id) {
  if ($id -and $script:Sessions.ContainsKey($id)) { [void]$script:Sessions.Remove($id) }
}

# ---------- cookies ----------

function Get-SessionCookie($req) {
  $header = $req.Headers['Cookie']
  if (-not $header) { return $null }
  foreach ($part in $header.Split(';')) {
    $i = $part.IndexOf('=')
    if ($i -lt 0) { continue }
    $k = $part.Substring(0, $i).Trim()
    if ($k -eq $SESSION_COOKIE) { return [System.Uri]::UnescapeDataString($part.Substring($i + 1).Trim()) }
  }
  return $null
}

function Cookie-SetHeader([string]$id, $ttlDays) {
  $maxAge = [int][math]::Round(([double]$ttlDays) * 86400)
  return "$SESSION_COOKIE=$([System.Uri]::EscapeDataString($id)); HttpOnly; SameSite=Lax; Path=/; Max-Age=$maxAge"
}

function Cookie-ClearHeader { return "$SESSION_COOKIE=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" }

# ---------- .env + config ----------

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

function Test-AdminConfigured { return ([bool]$script:AdminHash -and [bool]$script:AdminSalt) }

# TEMP diagnostic logging — appends to server-debug.log + echoes to console.
# Remove once the 401/404 cause is found.
function Log-Debug([string]$msg) {
  try {
    $line = '[{0}] {1}' -f (Get-Date).ToString('HH:mm:ss'), $msg
    Add-Content -LiteralPath (Join-Path $script:RepoRoot 'server-debug.log') -Value $line
    Write-Host $line -ForegroundColor DarkCyan
  } catch { }
}

# ---------- HTTP send helpers ----------

function Send-Bytes($res, [int]$status, [byte[]]$bytes, [string]$contentType, [string[]]$setCookie) {
  try {
    $res.StatusCode = $status
    $res.ContentType = $contentType
    if ($setCookie) { foreach ($c in $setCookie) { $res.AppendHeader('Set-Cookie', $c) } }
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } finally {
    $res.OutputStream.Close()
  }
}

function Send-Text($res, [int]$status, [string]$text, [string]$contentType = 'text/plain; charset=utf-8') {
  Send-Bytes $res $status ([System.Text.Encoding]::UTF8.GetBytes($text)) $contentType $null
}

function Send-Json($res, [int]$status, $obj, [string[]]$setCookie) {
  $json = Write-BriefingJson $obj 0
  $res.AddHeader('Cache-Control', 'no-store') # AddHeader replaces any existing value
  Send-Bytes $res $status ([System.Text.Encoding]::UTF8.GetBytes($json)) 'application/json; charset=utf-8' $setCookie
}

function Read-JsonBody($req) {
  if ($req.ContentLength64 -gt (2 * 1024 * 1024)) { throw 'body too large' }
  $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
  $text = $reader.ReadToEnd()
  $reader.Close()
  if (-not $text) { return @{} }
  return ($text | ConvertFrom-Json) # throws on malformed -> caller returns 400
}

# ---------- static / SPA ----------

$script:Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.woff2' = 'font/woff2'
}

function Send-Static($req, $res, [string]$pathname) {
  # `/` and `/admin` both serve the SPA shell; the front-end reads the path.
  $rel = if ($pathname -eq '/' -or $pathname -eq '/admin') { '/index.html' } else { $pathname }
  $safe = ($rel -replace '\\', '/').TrimStart('/')
  $publicFull = [System.IO.Path]::GetFullPath($script:PublicDir)
  $full = [System.IO.Path]::GetFullPath((Join-Path $script:PublicDir $safe))
  if (-not $full.StartsWith($publicFull)) { Send-Text $res 400 'bad path'; return }
  if (Test-Path -LiteralPath $full -PathType Leaf) {
    $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
    $ct = if ($script:Mime.ContainsKey($ext)) { $script:Mime[$ext] } else { 'application/octet-stream' }
    Send-Bytes $res 200 ([System.IO.File]::ReadAllBytes($full)) $ct $null
    return
  }
  # Unknown non-API path -> SPA shell (client-side routing).
  if (-not $pathname.StartsWith('/api/')) {
    $shell = Join-Path $script:PublicDir 'index.html'
    if (Test-Path -LiteralPath $shell -PathType Leaf) {
      Send-Bytes $res 200 ([System.IO.File]::ReadAllBytes($shell)) $script:Mime['.html'] $null
      return
    }
  }
  Send-Text $res 404 'not found'
}

# ---------- public edition endpoints ----------

function Handle-Current($req, $res) {
  $state = Read-State
  $ed = Current-Edition $state
  if (-not $ed) { Send-Json $res 404 ([ordered]@{ error = 'no published edition' }); return }
  Send-Json $res 200 $ed
}

function Handle-EditionList($req, $res) {
  $state = Read-State
  $eds = To-Array (Get-Prop $state 'editions')
  $list = @($eds | Where-Object { (Get-Prop $_ 'published') -eq $true } | ForEach-Object {
      [ordered]@{ id = (Get-Prop $_ 'id'); date = (Get-Prop $_ 'date'); title = (Get-Prop $_ 'title') }
    })
  $sorted = @($list | Sort-Object -Property @{ Expression = { [string]$_.date } } -Descending)
  Send-Json $res 200 @($sorted)
}

function Handle-PublicEdition($req, $res, [string]$id) {
  $state = Read-State
  $eds = To-Array (Get-Prop $state 'editions')
  $ed = $eds | Where-Object { (Get-Prop $_ 'id') -eq $id -and (Get-Prop $_ 'published') -eq $true } | Select-Object -First 1
  if (-not $ed) { Send-Json $res 404 ([ordered]@{ error = 'not found' }); return }
  Send-Json $res 200 $ed
}

# ---------- admin: auth ----------

function Handle-Login($req, $res) {
  if (-not (Test-AdminConfigured)) {
    Send-Json $res 503 ([ordered]@{ error = 'admin not configured - set ADMIN_PASSWORD_HASH + ADMIN_PASSWORD_SALT (hash-password.ps1)' })
    return
  }
  try { $body = Read-JsonBody $req } catch { Send-Json $res 400 ([ordered]@{ error = 'invalid JSON' }); return }
  $ok = Test-AdminPassword ([string](Get-Prop $body 'password')) $script:AdminHash $script:AdminSalt
  if (-not $ok) { Send-Json $res 401 ([ordered]@{ error = 'wrong password' }); return }
  $id = New-Session
  $cookieHdr = Cookie-SetHeader $id $script:TtlDays
  Log-Debug ("LOGIN ok sid={0} sessions={1} setCookie='{2}'" -f $id.Substring(0, 8), $script:Sessions.Count, $cookieHdr)
  Send-Json $res 200 ([ordered]@{ ok = $true }) @($cookieHdr)
}

function Handle-Logout($req, $res) {
  Remove-Session (Get-SessionCookie $req)
  Send-Json $res 200 ([ordered]@{ ok = $true }) @(Cookie-ClearHeader)
}

# ---------- admin: editions CRUD ----------

function Handle-AdminList($req, $res) {
  $state = Read-State
  $eds = To-Array (Get-Prop $state 'editions')
  # Drafts grouped on top (0 before 1), then by date desc within each group.
  $byGroup = @{ Expression = { if ((Get-Prop $_ 'published') -eq $true) { 1 } else { 0 } }; Ascending = $true }
  $byDate = @{ Expression = { [string](Get-Prop $_ 'date') }; Descending = $true }
  $sorted = @($eds | Sort-Object -Property $byGroup, $byDate)
  Log-Debug ("LIST returns ids=[{0}]" -f (($sorted | ForEach-Object { Get-Prop $_ 'id' }) -join ','))
  Send-Json $res 200 ([ordered]@{ current_edition_id = (Get-Prop $state 'current_edition_id'); editions = @($sorted) })
}

function Handle-AdminGet($req, $res, [string]$id) {
  $state = Read-State
  $eds = To-Array (Get-Prop $state 'editions')
  $ed = $eds | Where-Object { (Get-Prop $_ 'id') -eq $id } | Select-Object -First 1
  if (-not $ed) { Send-Json $res 404 ([ordered]@{ error = 'not found' }); return }
  Send-Json $res 200 $ed
}

function Handle-AdminCreate($req, $res) {
  try { $body = Read-JsonBody $req } catch { Send-Json $res 400 ([ordered]@{ error = 'invalid JSON' }); return }
  $state = Read-State
  $eds = @(To-Array (Get-Prop $state 'editions'))
  $from = Get-Prop $body 'template_from'
  $src = $null
  if ($from -and $from -ne 'blank' -and $from -ne 'current') {
    $src = $eds | Where-Object { (Get-Prop $_ 'id') -eq $from } | Select-Object -First 1
    if (-not $src) { Send-Json $res 400 ([ordered]@{ error = "template_from '$from' not found" }); return }
  } elseif ($from -eq 'current') {
    $src = Current-Edition $state # may be null on a fresh box
  }
  if ($src) {
    # Deep clone via re-serialize, then re-stamp as a fresh unpublished draft.
    $draft = Normalize-Edition ((Write-BriefingJson $src 0) | ConvertFrom-Json)
    $draft['id'] = New-EditionId
    $draft['published'] = $false
    $draft['published_at'] = $null
    $bd = Get-Prop $body 'date'; $draft['date'] = if ($bd) { [string]$bd } else { (Get-Date).ToString('yyyy-MM-dd') }
    $bt = Get-Prop $body 'title'; $draft['title'] = if ($bt) { [string]$bt } else { "$(Get-Prop $src 'title') (copy)" }
  } else {
    $draft = Blank-Edition (Get-Prop $body 'date') (Get-Prop $body 'title')
  }
  $state['editions'] = @($eds + , $draft)
  Write-State $state | Out-Null
  $persisted = (@(To-Array (Get-Prop (Read-State) 'editions')) | ForEach-Object { Get-Prop $_ 'id' }) -join ','
  Log-Debug ("CREATE template_from='{0}' returnedId={1} persistedIds=[{2}]" -f $from, $draft['id'], $persisted)
  Send-Json $res 201 ([ordered]@{ id = $draft['id']; edition = $draft })
}

$script:Patchable = @('date', 'title', 'issue', 'leftAdvisories', 'topEvents', 'initiatives', 'footerLinks')

function Handle-AdminPatch($req, $res, [string]$id) {
  try { $body = Read-JsonBody $req } catch { Send-Json $res 400 ([ordered]@{ error = 'invalid JSON' }); return }
  $state = Read-State
  $eds = @(To-Array (Get-Prop $state 'editions'))
  $idx = -1
  for ($i = 0; $i -lt $eds.Count; $i++) { if ((Get-Prop $eds[$i] 'id') -eq $id) { $idx = $i; break } }
  $availIds = ($eds | ForEach-Object { Get-Prop $_ 'id' }) -join ','
  Log-Debug ("PATCH reqId={0} matchIdx={1} availIds=[{2}]" -f $id, $idx, $availIds)
  if ($idx -lt 0) { Send-Json $res 404 ([ordered]@{ error = 'not found' }); return }
  $merged = Clone-Props $eds[$idx]
  foreach ($k in $script:Patchable) {
    if (Has-Prop $body $k) { $merged[$k] = (Get-Prop $body $k) }
  }
  $norm = Normalize-Edition $merged
  $eds[$idx] = $norm
  $state['editions'] = @($eds)
  Write-State $state | Out-Null
  Send-Json $res 200 $norm
}

function Handle-AdminPublish($req, $res, [string]$id) {
  try { $body = Read-JsonBody $req } catch { Send-Json $res 400 ([ordered]@{ error = 'invalid JSON' }); return }
  $wantPub = ((Get-Prop $body 'published') -ne $false) # default true
  $state = Read-State
  $eds = @(To-Array (Get-Prop $state 'editions'))
  $ed = $eds | Where-Object { (Get-Prop $_ 'id') -eq $id } | Select-Object -First 1
  if (-not $ed) { Send-Json $res 404 ([ordered]@{ error = 'not found' }); return }
  $ed['published'] = [bool]$wantPub
  if ($wantPub) { $ed['published_at'] = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffK") } else { $ed['published_at'] = $null }
  $state['editions'] = @($eds)
  $state['current_edition_id'] = Recompute-CurrentId $state
  $cid = $state['current_edition_id']
  Write-State $state | Out-Null
  Send-Json $res 200 ([ordered]@{ edition = $ed; current_edition_id = $cid })
}

function Handle-AdminDelete($req, $res, [string]$id) {
  $state = Read-State
  $eds = @(To-Array (Get-Prop $state 'editions'))
  $ed = $eds | Where-Object { (Get-Prop $_ 'id') -eq $id } | Select-Object -First 1
  if (-not $ed) { Send-Json $res 404 ([ordered]@{ error = 'not found' }); return }
  if ((Get-Prop $ed 'published') -eq $true) { Send-Json $res 409 ([ordered]@{ error = 'un-publish before deleting' }); return }
  $state['editions'] = @($eds | Where-Object { (Get-Prop $_ 'id') -ne $id })
  $state['current_edition_id'] = Recompute-CurrentId $state
  Write-State $state | Out-Null
  Send-Json $res 200 ([ordered]@{ ok = $true })
}

# ---------- router ----------

function Handle-Request($req, $res) {
  $pathname = $req.Url.AbsolutePath
  $method = $req.HttpMethod
  if ($pathname.StartsWith('/api/')) { Log-Debug ("REQ {0} {1}" -f $method, $pathname) }

  # public API
  if ($pathname -eq '/api/editions/current' -and $method -eq 'GET') { Handle-Current $req $res; return }
  if ($pathname -eq '/api/editions' -and $method -eq 'GET') { Handle-EditionList $req $res; return }
  $m = [regex]::Match($pathname, '^/api/editions/([^/]+)$')
  if ($m.Success -and $method -eq 'GET') { Handle-PublicEdition $req $res ([System.Uri]::UnescapeDataString($m.Groups[1].Value)); return }

  # admin auth (ungated)
  if ($pathname -eq '/api/admin/login' -and $method -eq 'POST') { Handle-Login $req $res; return }
  if ($pathname -eq '/api/admin/logout' -and $method -eq 'POST') { Handle-Logout $req $res; return }

  # everything else under /api/admin/ is gated
  if ($pathname.StartsWith('/api/admin/')) {
    $sidDbg = Get-SessionCookie $req
    $sidShort = if ($sidDbg) { $sidDbg.Substring(0, [Math]::Min(8, $sidDbg.Length)) } else { '<none>' }
    $rawCookie = $req.Headers['Cookie']
    $authOk = Test-Session $sidDbg
    Log-Debug ("AUTH {0} {1} rawCookie='{2}' sid={3} known={4} sessions={5}" -f $method, $pathname, $rawCookie, $sidShort, $authOk, $script:Sessions.Count)
    if (-not $authOk) { Send-Json $res 401 ([ordered]@{ error = 'unauthorized' }); return }
    if ($pathname -eq '/api/admin/editions' -and $method -eq 'GET') { Handle-AdminList $req $res; return }
    if ($pathname -eq '/api/admin/editions' -and $method -eq 'POST') { Handle-AdminCreate $req $res; return }
    $pub = [regex]::Match($pathname, '^/api/admin/editions/([^/]+)/publish$')
    if ($pub.Success -and $method -eq 'POST') { Handle-AdminPublish $req $res ([System.Uri]::UnescapeDataString($pub.Groups[1].Value)); return }
    $one = [regex]::Match($pathname, '^/api/admin/editions/([^/]+)$')
    if ($one.Success) {
      $eid = [System.Uri]::UnescapeDataString($one.Groups[1].Value)
      if ($method -eq 'GET') { Handle-AdminGet $req $res $eid; return }
      if ($method -eq 'PATCH') { Handle-AdminPatch $req $res $eid; return }
      if ($method -eq 'DELETE') { Handle-AdminDelete $req $res $eid; return }
    }
    Send-Json $res 404 ([ordered]@{ error = 'unknown admin route' }); return
  }

  if ($pathname.StartsWith('/api/')) { Send-Json $res 404 ([ordered]@{ error = 'unknown route' }); return }

  # static / SPA shell
  Send-Static $req $res $pathname
}

# ---------- self-test (no listener) ----------

function Invoke-SelfTest {
  $vecHash = Test-AdminPassword 'meridian-briefing-test-vector' '3200cac5c739d530f811c800e184b012c4e25b0b24de8ac8930a9f1e5ed5bb59' '0123456789abcdef0123456789abcdef'
  if (-not $vecHash) { Write-Host 'SELFTEST FAIL: PBKDF2 vector mismatch (Node<->.NET contract broken).' -ForegroundColor Red; exit 1 }

  # JSON: single-element + empty arrays must render as arrays, not bare/none.
  $j1 = Write-BriefingJson (To-Array ([ordered]@{ a = 1 })) 0
  if ($j1 -notmatch '^\[') { Write-Host "SELFTEST FAIL: single-element array did not render as []: $j1" -ForegroundColor Red; exit 1 }
  $j0 = Write-BriefingJson (To-Array $null) 0
  if ($j0 -ne '[]') { Write-Host "SELFTEST FAIL: empty array rendered as '$j0'" -ForegroundColor Red; exit 1 }

  # Round-trip a 1-edition / 1-advisory doc through normalize + serialize.
  $st = Empty-State
  $st['editions'] = @((Blank-Edition '2026-06-03' 'Self Test'))
  $norm = Normalize-State $st
  $json = Write-BriefingJson $norm 0
  $back = $json | ConvertFrom-Json
  $reNorm = Normalize-State $back
  $reEds = @(To-Array (Get-Prop $reNorm 'editions'))
  if ($reEds.Count -ne 1) { Write-Host 'SELFTEST FAIL: edition count changed on round-trip.' -ForegroundColor Red; exit 1 }
  if ((@(To-Array (Get-Prop $reEds[0] 'leftAdvisories'))).Count -ne 1) { Write-Host 'SELFTEST FAIL: single advisory lost on round-trip.' -ForegroundColor Red; exit 1 }

  Write-Host 'SELFTEST PASS: PBKDF2 vector + JSON array invariants + normalize round-trip.' -ForegroundColor Green
  exit 0
}

# ==================================================================
# main
# ==================================================================

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:PublicDir = Join-Path $script:RepoRoot 'public'
$script:DotEnv = Read-DotEnv (Join-Path $script:RepoRoot '.env')

$Port = [int](Get-EnvOr 'PORT' '8788')
$HostName = [string](Get-EnvOr 'HOST' '127.0.0.1')
$script:AdminHash = [string](Get-EnvOr 'ADMIN_PASSWORD_HASH' '')
$script:AdminSalt = [string](Get-EnvOr 'ADMIN_PASSWORD_SALT' '')
$script:TtlDays = [double](Get-EnvOr 'SESSION_TTL_DAYS' '7')
$script:TtlMs = [int64]($script:TtlDays * 86400 * 1000)

if ($SelfTest) { Invoke-SelfTest }

# HOST 0.0.0.0 / empty -> bind all interfaces via the '+' strong wildcard.
$prefixHost = if (-not $HostName -or $HostName -eq '0.0.0.0' -or $HostName -eq '+' -or $HostName -eq '*') { '+' } else { $HostName }
$prefix = "http://${prefixHost}:$Port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "ERROR: could not bind $prefix" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  Binding a non-localhost prefix needs admin/SYSTEM or a URL ACL:' -ForegroundColor Yellow
  Write-Host "    netsh http add urlacl url=$prefix user=`"NT AUTHORITY\SYSTEM`"" -ForegroundColor Yellow
  exit 1
}

Write-Host "meridian-briefing (PowerShell) -> $prefix"
Write-Host "  DB:    $(Get-DbPath)"
Write-Host "  Admin: $(if (Test-AdminConfigured) { 'configured' } else { 'NOT configured (set ADMIN_PASSWORD_* in .env)' })"

while ($listener.IsListening) {
  $context = $null
  try {
    $context = $listener.GetContext() # blocks until a request arrives
  } catch {
    break # listener stopped
  }
  try {
    Handle-Request $context.Request $context.Response
  } catch {
    $err = $_
    # Log the full error (message + PS line + stack) so failures are diagnosable
    # without a debugger. server-error.log sits in the repo root; tail it with
    #   Get-Content .\server-error.log -Tail 40
    try {
      $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
      $where = ''
      try { $where = "$($context.Request.HttpMethod) $($context.Request.Url.AbsolutePath)" } catch { }
      $detail = @(
        "[$stamp] $where",
        "  Message: $($err.Exception.Message)",
        "  Type:    $($err.Exception.GetType().FullName)",
        "  At:      $($err.InvocationInfo.PositionMessage -replace "`r?`n", ' ')",
        "  Stack:   $($err.ScriptStackTrace -replace "`r?`n", ' | ')",
        ''
      ) -join "`n"
      Add-Content -LiteralPath (Join-Path $script:RepoRoot 'server-error.log') -Value $detail
      Write-Host $detail -ForegroundColor Red
    } catch { }
    try { Send-Json $context.Response 500 ([ordered]@{ error = $err.Exception.Message }) } catch { }
  }
}
