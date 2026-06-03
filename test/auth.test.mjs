// Auth: PBKDF2 hash/verify, cookie parse/build, session create/validate/expire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  makeSessions,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  readSessionCookie,
  SESSION_COOKIE,
} from '../lib/auth.js';

test('hashPassword + verifyPassword accepts the right password', () => {
  const { hashHex, saltHex } = hashPassword('correct horse');
  assert.equal(verifyPassword('correct horse', hashHex, saltHex), true);
});

// Cross-runtime contract anchor: this exact (password, salt) → hash must hold
// in BOTH Node (lib/auth.js) and PowerShell (deploy/server.ps1, .NET
// Rfc2898DeriveBytes). If the PS port computes a different hash for this vector,
// the two runtimes can't share one .env — params drifted. See deploy/server.ps1
// header for the matching PowerShell assertion.
test('PBKDF2 known-answer vector (Node↔.NET contract)', () => {
  const saltHex = '0123456789abcdef0123456789abcdef';
  const { hashHex } = hashPassword('meridian-briefing-test-vector', saltHex);
  assert.equal(hashHex, '3200cac5c739d530f811c800e184b012c4e25b0b24de8ac8930a9f1e5ed5bb59');
});

test('verifyPassword rejects the wrong password', () => {
  const { hashHex, saltHex } = hashPassword('correct horse');
  assert.equal(verifyPassword('battery staple', hashHex, saltHex), false);
});

test('verifyPassword returns false (no throw) on malformed inputs', () => {
  assert.equal(verifyPassword('x', '', ''), false);
  assert.equal(verifyPassword('x', 'nothex', 'nothex'), false);
  assert.equal(verifyPassword('x', 'ab', 'cd'), false); // wrong length
});

test('same password + same salt is deterministic; different salts differ', () => {
  const a = hashPassword('pw');
  const b = hashPassword('pw', a.saltHex);
  assert.equal(a.hashHex, b.hashHex);
  const c = hashPassword('pw'); // new random salt
  assert.notEqual(a.hashHex, c.hashHex);
});

test('parseCookies handles multiple cookies and decoding', () => {
  const c = parseCookies('a=1; briefing_session=ab%20cd; x=y');
  assert.equal(c.a, '1');
  assert.equal(c.briefing_session, 'ab cd');
  assert.equal(c.x, 'y');
});

test('parseCookies tolerates empty / missing header', () => {
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test('readSessionCookie extracts the session id from a request', () => {
  const req = { headers: { cookie: `${SESSION_COOKIE}=sid123; other=1` } };
  assert.equal(readSessionCookie(req), 'sid123');
});

test('sessionCookieHeader sets HttpOnly + SameSite + Max-Age', () => {
  const h = sessionCookieHeader('sid', 7);
  assert.match(h, /HttpOnly/);
  assert.match(h, /SameSite=Lax/);
  assert.match(h, /Max-Age=604800/); // 7 days
  assert.match(h, /^briefing_session=sid;/);
});

test('clearCookieHeader expires the cookie', () => {
  assert.match(clearCookieHeader(), /Max-Age=0/);
});

test('session create → validate → destroy', () => {
  const s = makeSessions(60 * 1000);
  const id = s.create();
  assert.equal(s.validate(id), true);
  assert.equal(s.size(), 1);
  s.destroy(id);
  assert.equal(s.validate(id), false);
  assert.equal(s.size(), 0);
});

test('validate rejects unknown + empty ids', () => {
  const s = makeSessions(60 * 1000);
  assert.equal(s.validate('nope'), false);
  assert.equal(s.validate(null), false);
  assert.equal(s.validate(undefined), false);
});

test('expired sessions are rejected and evicted', async () => {
  const s = makeSessions(5); // 5ms ttl
  const id = s.create();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.validate(id), false);
  assert.equal(s.size(), 0);
});

test('validate slides the expiry window forward', async () => {
  const s = makeSessions(40);
  const id = s.create();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.validate(id), true); // still alive, and rolls expiry
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.validate(id), true); // would have died at 40ms without the slide
});
