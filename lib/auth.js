// ------------------------------------------------------------------
// meridian-briefing — auth. Single shared admin password, hashed with
// PBKDF2-HMAC-SHA256 (zero-deps; no bcrypt/argon native module to compile).
//
//   - hashPassword(plain)              → { hashHex, saltHex }   (for setup)
//   - verifyPassword(plain, hash, salt) → bool                  (timing-safe)
//   - makeSessions(ttlMs)              → in-memory session store
//   - cookie helpers (parse / build / clear)
//
// PBKDF2 (not scrypt) is the load-bearing choice: it lets BOTH this Node server
// AND the PowerShell production server (deploy/server.ps1, .NET Framework
// Rfc2898DeriveBytes) verify the SAME hash from one .env. The params below are
// the contract between the two runtimes — change them in lockstep on both sides
// (and in scripts/hash-password.{mjs,ps1}) or every login breaks:
//
//   algorithm  = PBKDF2-HMAC-SHA256
//   iterations = 600000
//   key length = 32 bytes
//   salt       = 16 random bytes (stored hex)
//   password   = UTF-8 bytes  (Node default; .NET Rfc2898DeriveBytes(string,…)
//                              also encodes UTF-8 → byte-identical derived key)
//
// Sessions live in process memory only. A restart logs everyone out — fine for
// a single-admin tool; documented in .env.example.
// ------------------------------------------------------------------

import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { newSessionId } from './id.js';

const ITERATIONS = 600000; // PBKDF2 rounds  — MUST match deploy/server.ps1
const KEYLEN = 32; // derived-key bytes      — MUST match deploy/server.ps1
const DIGEST = 'sha256'; // HMAC digest      — MUST match deploy/server.ps1

function derive(plain, salt) {
  return pbkdf2Sync(String(plain), salt, ITERATIONS, KEYLEN, DIGEST);
}

export function hashPassword(plain, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(16);
  const hash = derive(plain, salt);
  return { hashHex: hash.toString('hex'), saltHex: salt.toString('hex') };
}

// Constant-time comparison. Returns false (never throws) on any malformed input
// so a bad cookie or env value can't crash the request path.
export function verifyPassword(plain, hashHex, saltHex) {
  if (!hashHex || !saltHex) return false;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;
  let actual;
  try {
    actual = derive(plain, Buffer.from(saltHex, 'hex'));
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

// ---------- session store ----------

export function makeSessions(ttlMs) {
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 7 * 24 * 60 * 60 * 1000;
  const map = new Map(); // sessionId → { expires: epochMs }

  function create() {
    const id = newSessionId();
    map.set(id, { expires: Date.now() + ttl });
    return id;
  }

  // Validates and, on success, rolls the expiry forward (sliding window).
  function validate(id) {
    if (!id) return false;
    const entry = map.get(id);
    if (!entry) return false;
    if (entry.expires <= Date.now()) {
      map.delete(id);
      return false;
    }
    entry.expires = Date.now() + ttl;
    return true;
  }

  function destroy(id) {
    if (id) map.delete(id);
  }

  function size() {
    return map.size;
  }

  return { create, validate, destroy, size, _ttl: ttl };
}

// ---------- cookie helpers ----------

export const SESSION_COOKIE = 'briefing_session';

export function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function readSessionCookie(req) {
  const cookies = parseCookies(req.headers?.cookie);
  return cookies[SESSION_COOKIE] || null;
}

export function sessionCookieHeader(id, ttlDays) {
  const maxAge = Math.round((Number(ttlDays) || 7) * 24 * 60 * 60);
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
