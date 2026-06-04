#!/usr/bin/env node
// ------------------------------------------------------------------
// meridian-briefing — Node HTTP server (zero runtime deps; node: builtins only).
//
// Serves the public/ SPA in two modes (read at /, admin at /admin) and a small
// JSON API over the single state.json document (see lib/store.js). The admin
// endpoints are gated by a single shared password (lib/auth.js); the public
// read endpoints expose published editions only.
//
// Boots at 127.0.0.1:8787 by default (override via HOST/PORT). Node 20.6+.
// Run with `node --env-file=.env server.js`  (or: npm run dev).
// ------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readState,
  writeState,
  currentEdition,
  recomputeCurrentId,
  normalizeEdition,
  blankEdition,
  dbPath,
} from './lib/store.js';
import {
  verifyPassword,
  makeSessions,
  readSessionCookie,
  sessionCookieHeader,
  clearCookieHeader,
} from './lib/auth.js';
import { sanitizeEvent, appendEvent, readEvents, summarize } from './lib/usage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(__dirname, 'public');
const TTL_DAYS = Number(process.env.SESSION_TTL_DAYS) || 7;

const sessions = makeSessions(TTL_DAYS * 24 * 60 * 60 * 1000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------- low-level send helpers ----------

function send(res, status, body, headers = {}) {
  const isRaw = typeof body === 'string' || Buffer.isBuffer(body);
  const payload = isRaw ? body : JSON.stringify(body);
  const ct = headers['content-type'] || (isRaw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  res.writeHead(status, { ...headers, 'content-type': ct });
  res.end(payload);
}

function sendJson(res, status, obj, extraHeaders = {}) {
  send(res, status, obj, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) reject(new Error('body too large')); // 2MB guard
      else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ---------- static files ----------

async function serveStatic(req, res, pathname) {
  // `/` and `/admin` both serve the SPA shell; the front-end reads the path.
  let rel = pathname === '/' || pathname === '/admin' ? '/index.html' : pathname;
  // Block traversal: normalize and ensure it stays under public/.
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 400, 'bad path');
  try {
    const data = await readFile(full);
    return send(res, 200, data, {
      'content-type': MIME[extname(full)] || 'application/octet-stream',
    });
  } catch {
    // Unknown non-API path → fall back to the SPA shell (client-side routing).
    if (!pathname.startsWith('/api/')) {
      try {
        const shell = await readFile(join(PUBLIC_DIR, 'index.html'));
        return send(res, 200, shell, { 'content-type': MIME['.html'] });
      } catch {
        /* fall through */
      }
    }
    return send(res, 404, 'not found');
  }
}

// ---------- auth guard ----------

function isAuthed(req) {
  return sessions.validate(readSessionCookie(req));
}

function adminConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD_HASH && process.env.ADMIN_PASSWORD_SALT);
}

// Node has no built-in Windows auth; identity comes from a proxy-set header
// (future IIS with Windows Auth) or DEV_USER, else anonymous. The PowerShell
// production server reads the real Negotiate identity instead (see server.ps1).
function currentUser(req) {
  return req.headers['x-remote-user'] || process.env.DEV_USER || 'anonymous';
}

// ---------- usage tracking ----------

async function handleTrack(req, res) {
  // Best-effort: tracking must never break the page, so swallow everything.
  try {
    const body = await readBody(req);
    const ev = sanitizeEvent(body, {
      user: currentUser(req),
      ip: req.socket?.remoteAddress || '',
      ua: req.headers['user-agent'] || '',
    });
    if (ev) await appendEvent(ev);
  } catch {
    /* ignore — never surface a tracking failure */
  }
  res.writeHead(204).end();
}

async function handleAdminUsage(req, res, url) {
  const since = url.searchParams.get('since') || undefined;
  const until = url.searchParams.get('until') || undefined;
  const recent = Math.min(parseInt(url.searchParams.get('raw') || '0', 10) || 0, 500);
  const events = await readEvents({ since, until });
  return sendJson(res, 200, summarize(events, { recent }));
}

// ---------- public edition endpoints ----------

async function handleCurrent(req, res) {
  const state = await readState();
  const ed = currentEdition(state);
  if (!ed) return sendJson(res, 404, { error: 'no published edition' });
  return sendJson(res, 200, ed);
}

async function handleEditionList(req, res) {
  const state = await readState();
  const list = state.editions
    .filter((e) => e.published)
    .map((e) => ({ id: e.id, date: e.date, title: e.title }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return sendJson(res, 200, list);
}

async function handlePublicEdition(req, res, id) {
  const state = await readState();
  const ed = state.editions.find((e) => e.id === id && e.published);
  if (!ed) return sendJson(res, 404, { error: 'not found' });
  return sendJson(res, 200, ed);
}

// ---------- admin: auth ----------

async function handleLogin(req, res) {
  if (!adminConfigured()) {
    return sendJson(res, 503, {
      error: 'admin not configured — set ADMIN_PASSWORD_HASH + ADMIN_PASSWORD_SALT (npm run hash-password)',
    });
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON' });
  }
  const ok = verifyPassword(body?.password, process.env.ADMIN_PASSWORD_HASH, process.env.ADMIN_PASSWORD_SALT);
  if (!ok) return sendJson(res, 401, { error: 'wrong password' });
  const id = sessions.create();
  return sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookieHeader(id, TTL_DAYS) });
}

function handleLogout(req, res) {
  sessions.destroy(readSessionCookie(req));
  return sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookieHeader() });
}

// ---------- admin: editions CRUD ----------

async function handleAdminList(req, res) {
  const state = await readState();
  const list = [...state.editions].sort((a, b) => {
    // Drafts grouped on top, then by date desc within each group.
    if (a.published !== b.published) return a.published ? 1 : -1;
    return String(b.date).localeCompare(String(a.date));
  });
  return sendJson(res, 200, { current_edition_id: state.current_edition_id, editions: list });
}

async function handleAdminGet(req, res, id) {
  const state = await readState();
  const ed = state.editions.find((e) => e.id === id);
  if (!ed) return sendJson(res, 404, { error: 'not found' });
  return sendJson(res, 200, ed);
}

async function handleAdminCreate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON' });
  }
  const state = await readState();
  let draft;
  const from = body?.template_from;
  // Resolve the source edition to copy, if any. 'current' with nothing published
  // (first-run) falls back to a blank starter rather than erroring.
  let src = null;
  if (from && from !== 'blank' && from !== 'current') {
    src = state.editions.find((e) => e.id === from);
    if (!src) return sendJson(res, 400, { error: `template_from '${from}' not found` });
  } else if (from === 'current') {
    src = currentEdition(state); // may be null on a fresh box
  }
  if (src) {
    // Deep clone via JSON, then re-stamp as a fresh unpublished draft.
    draft = normalizeEdition(JSON.parse(JSON.stringify(src)));
    draft.id = blankEdition().id; // fresh id
    draft.published = false;
    draft.published_at = null;
    draft.date = body?.date || new Date().toISOString().slice(0, 10);
    draft.title = body?.title || `${src.title} (copy)`;
  } else {
    draft = blankEdition(body?.date, body?.title);
  }
  state.editions.push(draft);
  await writeState(state);
  return sendJson(res, 201, { id: draft.id, edition: draft });
}

const PATCHABLE = ['date', 'title', 'issue', 'leftAdvisories', 'topEvents', 'initiatives', 'footerLinks'];

async function handleAdminPatch(req, res, id) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON' });
  }
  const state = await readState();
  const idx = state.editions.findIndex((e) => e.id === id);
  if (idx < 0) return sendJson(res, 404, { error: 'not found' });
  const merged = { ...state.editions[idx] };
  for (const key of PATCHABLE) {
    if (key in (body || {})) merged[key] = body[key];
  }
  state.editions[idx] = normalizeEdition(merged);
  await writeState(state);
  return sendJson(res, 200, state.editions[idx]);
}

async function handleAdminPublish(req, res, id) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON' });
  }
  const wantPublished = body?.published !== false; // default true
  const state = await readState();
  const ed = state.editions.find((e) => e.id === id);
  if (!ed) return sendJson(res, 404, { error: 'not found' });
  ed.published = wantPublished;
  ed.published_at = wantPublished ? new Date().toISOString() : null;
  state.current_edition_id = recomputeCurrentId(state);
  await writeState(state);
  return sendJson(res, 200, { edition: ed, current_edition_id: state.current_edition_id });
}

async function handleAdminDelete(req, res, id) {
  const state = await readState();
  const ed = state.editions.find((e) => e.id === id);
  if (!ed) return sendJson(res, 404, { error: 'not found' });
  if (ed.published) return sendJson(res, 409, { error: 'un-publish before deleting' });
  state.editions = state.editions.filter((e) => e.id !== id);
  state.current_edition_id = recomputeCurrentId(state);
  await writeState(state);
  return sendJson(res, 200, { ok: true });
}

// ---------- admin: restricted artifacts ----------
// Internal "explainer" artifacts (e.g. PainPoints) live as gitignored JSON in the
// data dir alongside state.json — never committed to this PUBLIC repo, placed
// per-box like .env. Served only to an authenticated admin session, raw (no
// re-serialization, so the artifact's free-form shape is preserved exactly).

const ARTIFACT_ID = /^[a-z0-9-]+$/;

async function handleArtifact(req, res, id) {
  if (!ARTIFACT_ID.test(id)) return sendJson(res, 400, { error: 'bad artifact id' });
  try {
    const file = join(dirname(dbPath()), 'artifacts', `${id}.json`);
    const data = await readFile(file, 'utf8');
    return send(res, 200, data, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
  } catch {
    return sendJson(res, 404, { error: 'artifact not found' });
  }
}

// ---------- router ----------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    const method = req.method || 'GET';

    // --- public API ---
    if (pathname === '/api/editions/current' && method === 'GET') return await handleCurrent(req, res);
    if (pathname === '/api/editions' && method === 'GET') return await handleEditionList(req, res);
    {
      const m = pathname.match(/^\/api\/editions\/([^/]+)$/);
      if (m && method === 'GET') return await handlePublicEdition(req, res, decodeURIComponent(m[1]));
    }

    // --- usage beacon (public; identity stamped server-side) ---
    if (pathname === '/api/track' && method === 'POST') return await handleTrack(req, res);

    // --- admin auth ---
    if (pathname === '/api/admin/login' && method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/admin/logout' && method === 'POST') return handleLogout(req, res);

    // --- everything else under /api/admin is gated ---
    if (pathname.startsWith('/api/admin/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });

      if (pathname === '/api/admin/usage' && method === 'GET') return await handleAdminUsage(req, res, url);

      {
        const art = pathname.match(/^\/api\/admin\/artifacts\/([^/]+)$/);
        if (art && method === 'GET') return await handleArtifact(req, res, decodeURIComponent(art[1]));
      }

      if (pathname === '/api/admin/editions' && method === 'GET') return await handleAdminList(req, res);
      if (pathname === '/api/admin/editions' && method === 'POST') return await handleAdminCreate(req, res);

      const pub = pathname.match(/^\/api\/admin\/editions\/([^/]+)\/publish$/);
      if (pub && method === 'POST') return await handleAdminPublish(req, res, decodeURIComponent(pub[1]));

      const one = pathname.match(/^\/api\/admin\/editions\/([^/]+)$/);
      if (one) {
        const id = decodeURIComponent(one[1]);
        if (method === 'GET') return await handleAdminGet(req, res, id);
        if (method === 'PATCH') return await handleAdminPatch(req, res, id);
        if (method === 'DELETE') return await handleAdminDelete(req, res, id);
      }
      return sendJson(res, 404, { error: 'unknown admin route' });
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown route' });

    // --- static / SPA shell ---
    return await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`meridian-briefing → http://${HOST}:${PORT}`);
  console.log(`  DB:    ${dbPath()}`);
  console.log(`  Admin: ${adminConfigured() ? 'configured' : 'NOT configured (set ADMIN_PASSWORD_* in .env)'}`);
});

export { server };
