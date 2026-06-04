// Usage tracking: the lib (sanitize/append/read/summarize) over a temp store,
// then the live endpoints (POST /api/track public, GET /api/admin/usage gated).
// node --test runs files in separate processes, so env set here is isolated.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { hashPassword } from '../lib/auth.js';

const PW = 'usage-test-pw';
let dir;
let baseUrl;
let server;
let cookie = '';
let usage; // lib module (imported after env is set)

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mb-usage-'));
  process.env.BRIEFING_DB = join(dir, 'state.json');
  process.env.USAGE_LOG = join(dir, 'usage');
  process.env.DEV_USER = 'TESTDOMAIN\\jdoe';
  const { hashHex, saltHex } = hashPassword(PW);
  process.env.ADMIN_PASSWORD_HASH = hashHex;
  process.env.ADMIN_PASSWORD_SALT = saltHex;
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';
  usage = await import('../lib/usage.js');
  ({ server } = await import('../server.js'));
  if (!server.listening) await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
  for (const k of ['BRIEFING_DB', 'USAGE_LOG', 'DEV_USER', 'ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD_SALT', 'PORT', 'HOST'])
    delete process.env[k];
});

test('sanitizeEvent drops bad type, whitelists + clamps, stamps server fields', () => {
  assert.equal(usage.sanitizeEvent({ type: 'nope' }), null);
  assert.equal(usage.sanitizeEvent('garbage'), null);
  const ev = usage.sanitizeEvent(
    { type: 'area', area: 'x'.repeat(500), evil: 'drop-me', dur_ms: -5 },
    { user: 'D\\u', ip: '1.2.3.4', ua: 'UA', ts: '2026-06-01T00:00:00.000Z' },
  );
  assert.equal(ev.type, 'area');
  assert.equal(ev.user, 'D\\u');
  assert.equal(ev.ip, '1.2.3.4');
  assert.equal(ev.area.length, 200); // clamped
  assert.equal('evil' in ev, false); // not whitelisted
  assert.equal('dur_ms' in ev, false); // negative dropped
  assert.equal(ev.ts, '2026-06-01T00:00:00.000Z');
});

test('append + read + summarize aggregate correctly', async () => {
  const evs = [
    { type: 'pageview', user: 'A', area: undefined, ts: '2026-06-01T10:00:00.000Z' },
    { type: 'dwell', user: 'A', area: 'initiatives', dur_ms: 4000, ts: '2026-06-01T10:01:00.000Z' },
    { type: 'dwell', user: 'B', area: 'initiatives', dur_ms: 6000, ts: '2026-06-02T09:00:00.000Z' },
    { type: 'module', user: 'B', module_id: 'cs-opioids', dur_ms: 30000, ts: '2026-06-02T09:05:00.000Z' },
  ];
  for (const e of evs) await usage.appendEvent(e);

  const all = await usage.readEvents();
  assert.equal(all.length, 4);

  const s = usage.summarize(all);
  assert.equal(s.total, 4);
  assert.equal(s.unique_users, 2);
  const area = s.by_area.find((r) => r.key === 'initiatives');
  assert.equal(area.events, 2);
  assert.equal(area.dwell_ms, 10000);
  const mod = s.by_module.find((r) => r.key === 'cs-opioids');
  assert.equal(mod.dwell_ms, 30000);

  // date filter
  const onlyJun2 = await usage.readEvents({ since: '2026-06-02T00:00:00.000Z' });
  assert.equal(onlyJun2.length, 2);
});

test('POST /api/track is public, 204, and stamps the server identity', async () => {
  const res = await fetch(baseUrl + '/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'pageview', area: 'endpoint-marker', edition_id: 'ed_x' }),
  });
  assert.equal(res.status, 204);
  const events = await usage.readEvents();
  const marked = events.find((e) => e.area === 'endpoint-marker');
  assert.ok(marked, 'tracked event was written');
  assert.equal(marked.user, 'TESTDOMAIN\\jdoe'); // from DEV_USER, server-stamped
});

test('GET /api/admin/usage requires auth, then returns the summary', async () => {
  const noAuth = await fetch(baseUrl + '/api/admin/usage');
  assert.equal(noAuth.status, 401);

  const login = await fetch(baseUrl + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  });
  const setCookie = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  cookie = `briefing_session=${/briefing_session=([^;]*)/.exec(setCookie.join(';'))[1]}`;

  const res = await fetch(baseUrl + '/api/admin/usage', { headers: { cookie } });
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.ok(summary.total >= 5); // 4 lib + 1 endpoint
  assert.ok(summary.by_user.some((r) => r.key === 'TESTDOMAIN\\jdoe'));
  assert.ok(summary.by_area.some((r) => r.key === 'endpoint-marker'));
});
