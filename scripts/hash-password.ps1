# ==================================================================
# meridian-briefing - admin password hasher (PowerShell / no-Node boxes).
#
#   powershell -ExecutionPolicy Bypass -File scripts\hash-password.ps1
#
# Prompts for a password (hidden), derives a PBKDF2-HMAC-SHA256 hash + random
# salt, and prints the two lines to paste into .env:
#
#   ADMIN_PASSWORD_HASH=<hex>
#   ADMIN_PASSWORD_SALT=<hex>
#
# Produces the SAME hash as scripts/hash-password.mjs and the same one
# deploy/server.ps1 + lib/auth.js verify - the PBKDF2 params below are the
# cross-runtime contract (keep them in lockstep with lib/auth.js):
#   iterations=600000  key=32 bytes  salt=16 bytes  digest=SHA256  pw=UTF-8
#
# The plaintext never touches disk. Run wherever convenient (Linux dev box via
# `npm run hash-password`, or here on a Windows box with no Node); paste the
# output into .env on each machine. ASCII-only source (no encoding deps).
# ==================================================================

$ErrorActionPreference = 'Stop'

$ITERATIONS = 600000
$KEYLEN = 32

# Hidden prompt. .trim() matches hash-password.mjs so the same typed password
# yields the same hash from either generator (don't use surrounding spaces).
$secure = Read-Host -AsSecureString 'Admin password'
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $pw = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
$pw = $pw.Trim()

if (-not $pw) {
  Write-Host 'No password entered. Aborting.' -ForegroundColor Red
  exit 1
}
if ($pw.Length -lt 8) {
  Write-Host "Warning: password is only $($pw.Length) chars. 8+ recommended." -ForegroundColor Yellow
}

$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
$salt = [byte[]]::new(16)
$rng.GetBytes($salt)

$kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
  [string]$pw, $salt, [int]$ITERATIONS, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
$hash = $kdf.GetBytes($KEYLEN)
$kdf.Dispose()

$hashHex = ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
$saltHex = ([System.BitConverter]::ToString($salt) -replace '-', '').ToLowerInvariant()

Write-Host ''
Write-Host 'Paste these two lines into .env (replace any existing pair):'
Write-Host ''
Write-Host "ADMIN_PASSWORD_HASH=$hashHex"
Write-Host "ADMIN_PASSWORD_SALT=$saltHex"
Write-Host ''
