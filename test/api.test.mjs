// End-to-end API: boot the real server on an ephemeral port with a temp DB +
// a configured admin password, then drive the full publish lifecycle over HTTP.
// node:test runs top-level tests sequentially, so shared state flows downward.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { hashPassword } from '../lib/auth.js';

const PW = 'test-password-123';
let baseUrl;
let server;
let dir;
let cookie = '';
let draftId = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mb-api-'));
  process.env.BRIEFING_DB = join(dir, 'state.json');
  const { hashHex, saltHex } = hashPassword(PW);
  process.env.ADMIN_PASSWORD_HASH = hashHex;
  process.env.ADMIN_PASSWORD_SALT = saltHex;
  process.env.PORT = '0'; // OS-assigned ephemeral port
  process.env.HOST = '127.0.0.1';
  ({ server } = await import('../server.js'));
  if (!server.listening) await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
  for (const k of ['BRIEFING_DB', 'ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD_SALT', 'PORT', 'HOST']) delete process.env[k];
});

function sessionFrom(res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of all) {
    const m = /briefing_session=([^;]*)/.exec(c);
    if (m) return `briefing_session=${m[1]}`;
  }
  return '';
}

async function req(method, path, body, withCookie = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (withCookie && cookie) headers.cookie = cookie;
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* none */
  }
  return { res, status: res.status, json };
}

test('current is 404 before anything is published', async () => {
  const { status } = await req('GET', '/api/editions/current', undefined, false);
  assert.equal(status, 404);
});

test('login with wrong password → 401, no cookie', async () => {
  const { res, status } = await req('POST', '/api/admin/login', { password: 'nope' }, false);
  assert.equal(status, 401);
  assert.equal(sessionFrom(res), '');
});

test('login with correct password → 200 + session cookie', async () => {
  const { res, status } = await req('POST', '/api/admin/login', { password: PW }, false);
  assert.equal(status, 200);
  cookie = sessionFrom(res);
  assert.match(cookie, /^briefing_session=/);
});

test('admin list without cookie → 401', async () => {
  const { status } = await req('GET', '/api/admin/editions', undefined, false);
  assert.equal(status, 401);
});

test('admin list with cookie → 200, empty array', async () => {
  const { status, json } = await req('GET', '/api/admin/editions');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.editions));
  assert.equal(json.editions.length, 0);
});

test('create a blank draft → 201 with id', async () => {
  const { status, json } = await req('POST', '/api/admin/editions', { template_from: 'blank', title: 'My Draft', date: '2026-06-02' });
  assert.equal(status, 201);
  assert.ok(json.id);
  draftId = json.id;
  assert.equal(json.edition.published, false);
});

test('patch the draft → 200, title updated', async () => {
  const { status, json } = await req('PATCH', '/api/admin/editions/' + draftId, { title: 'Edited Title' });
  assert.equal(status, 200);
  assert.equal(json.title, 'Edited Title');
});

test('draft is not visible on the public endpoint yet', async () => {
  const { status } = await req('GET', '/api/editions/' + draftId, undefined, false);
  assert.equal(status, 404);
});

test('publish the draft → 200, becomes current', async () => {
  const { status, json } = await req('POST', '/api/admin/editions/' + draftId + '/publish', { published: true });
  assert.equal(status, 200);
  assert.equal(json.current_edition_id, draftId);
  assert.equal(json.edition.published, true);
  assert.ok(json.edition.published_at);
});

test('current now reflects the published edition', async () => {
  const { status, json } = await req('GET', '/api/editions/current', undefined, false);
  assert.equal(status, 200);
  assert.equal(json.id, draftId);
  assert.equal(json.title, 'Edited Title');
});

test('public edition list includes the published edition', async () => {
  const { status, json } = await req('GET', '/api/editions', undefined, false);
  assert.equal(status, 200);
  assert.ok(json.some((e) => e.id === draftId));
});

test('deleting a published edition is refused (409)', async () => {
  const { status } = await req('DELETE', '/api/admin/editions/' + draftId);
  assert.equal(status, 409);
});

test('un-publish then delete succeeds; current falls back to null', async () => {
  const unpub = await req('POST', '/api/admin/editions/' + draftId + '/publish', { published: false });
  assert.equal(unpub.status, 200);
  assert.equal(unpub.json.current_edition_id, null);
  const del = await req('DELETE', '/api/admin/editions/' + draftId);
  assert.equal(del.status, 200);
  const cur = await req('GET', '/api/editions/current', undefined, false);
  assert.equal(cur.status, 404);
});

test('logout clears the session', async () => {
  const out = await req('POST', '/api/admin/logout');
  assert.equal(out.status, 200);
  cookie = sessionFrom(out.res) || cookie;
  // The cleared cookie has Max-Age=0; subsequent admin call with the old id fails.
  const { status } = await req('GET', '/api/admin/editions');
  assert.equal(status, 401);
});

test('create-from-current copies content into a fresh draft', async () => {
  // Re-login (we just logged out).
  const login = await req('POST', '/api/admin/login', { password: PW }, false);
  cookie = sessionFrom(login.res);
  // Seed a published edition to copy from.
  const seed = await req('POST', '/api/admin/editions', { template_from: 'blank', title: 'Base', date: '2026-06-01' });
  await req('POST', '/api/admin/editions/' + seed.json.id + '/publish', { published: true });
  await req('PATCH', '/api/admin/editions/' + seed.json.id, { leftAdvisories: [{ tint: 'teal', icon: '📋', headline: 'Carried over', body: 'b', tag: 't' }] });
  const copy = await req('POST', '/api/admin/editions', { template_from: 'current', title: 'Copy' });
  assert.equal(copy.status, 201);
  assert.notEqual(copy.json.id, seed.json.id);
  assert.equal(copy.json.edition.published, false);
  assert.equal(copy.json.edition.leftAdvisories[0].headline, 'Carried over');
});
