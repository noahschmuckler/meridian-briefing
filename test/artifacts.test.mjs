// Gated artifact endpoint: GET /api/admin/artifacts/:id serves a per-box,
// gitignored JSON file from <dataDir>/artifacts/ to an authenticated admin only.
// Boots the real server on an ephemeral port with a temp DB + a fixture artifact.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { hashPassword } from '../lib/auth.js';

const PW = 'test-password-123';
const FIXTURE = { id: 'painpoints', header: { title: 'Fixture' }, sections: [{ id: 's1', label: 'One' }], todos: [] };
let baseUrl;
let server;
let dir;
let cookie = '';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mb-art-'));
  process.env.BRIEFING_DB = join(dir, 'state.json');
  await mkdir(join(dir, 'artifacts'), { recursive: true });
  await writeFile(join(dir, 'artifacts', 'painpoints.json'), JSON.stringify(FIXTURE), 'utf8');
  const { hashHex, saltHex } = hashPassword(PW);
  process.env.ADMIN_PASSWORD_HASH = hashHex;
  process.env.ADMIN_PASSWORD_SALT = saltHex;
  process.env.PORT = '0';
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

async function get(path, withCookie) {
  const headers = {};
  if (withCookie && cookie) headers.cookie = cookie;
  const res = await fetch(baseUrl + path, { headers });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* none */
  }
  return { res, status: res.status, json };
}

test('artifact without a session → 401', async () => {
  const { status } = await get('/api/admin/artifacts/painpoints', false);
  assert.equal(status, 401);
});

test('login → session cookie', async () => {
  const res = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  });
  assert.equal(res.status, 200);
  cookie = sessionFrom(res);
  assert.match(cookie, /^briefing_session=/);
});

test('authed → 200 with the fixture content (served raw, unmodified)', async () => {
  const { status, json } = await get('/api/admin/artifacts/painpoints', true);
  assert.equal(status, 200);
  assert.deepEqual(json, FIXTURE);
});

test('missing artifact → 404', async () => {
  const { status } = await get('/api/admin/artifacts/does-not-exist', true);
  assert.equal(status, 404);
});

test('bad id (dots) → 400, no traversal', async () => {
  const dotted = await get('/api/admin/artifacts/foo.bar', true);
  assert.equal(dotted.status, 400);
  // Encoded traversal toward the state file must be rejected by id validation.
  const traversal = await get('/api/admin/artifacts/..%2F..%2Fstate', true);
  assert.equal(traversal.status, 400);
});
