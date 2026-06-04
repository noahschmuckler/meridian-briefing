// ------------------------------------------------------------------
// meridian-briefing — usage log. Append-only, one JSON event per line
// (JSONL), split into monthly files so it's easy to back up and trivial to
// load into a notebook/Excel for QI. This is the wide raw store; names are
// kept by design and surfaced only via the admin-gated analytics endpoint.
//
// Mirrored in deploy/server.ps1 (Append-UsageEvent / Summarize-Usage) so the
// PowerShell production server writes the identical shape.
//
// USAGE_LOG may be a directory (absolute or repo-relative); default is a
// `usage/` folder beside BRIEFING_DB.
// ------------------------------------------------------------------

import { readFile, readdir, appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';

import { dbPath } from './store.js';

// Whitelisted client-supplied event fields (everything else is dropped). The
// server stamps ts/user/ip/ua itself — clients can never set those.
const EVENT_TYPES = ['pageview', 'area', 'dwell', 'link', 'module'];
const STR_FIELDS = ['path', 'area', 'edition_id', 'module_id', 'ref'];
const MAX_STR = 200;

export function usageDir() {
  const p = process.env.USAGE_LOG || join(dirname(dbPath()), 'usage');
  return isAbsolute(p) ? p : resolve(dirname(dbPath()), p);
}

function monthFile(d) {
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return join(usageDir(), `usage-${ym}.jsonl`);
}

function clampStr(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.slice(0, MAX_STR);
  return s.length ? s : undefined;
}

// Build a stored event from a raw client payload + server-stamped context.
// Returns null if the payload isn't a usable event (so callers can no-op).
export function sanitizeEvent(raw, ctx = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const type = EVENT_TYPES.includes(r.type) ? r.type : null;
  if (!type) return null;
  const ev = {
    ts: ctx.ts || new Date().toISOString(),
    user: clampStr(ctx.user) || 'anonymous',
    ip: clampStr(ctx.ip) || '',
    ua: clampStr(ctx.ua) || '',
    type,
  };
  for (const f of STR_FIELDS) {
    const v = clampStr(r[f]);
    if (v !== undefined) ev[f] = v;
  }
  // dur_ms: non-negative integer, capped at 24h to drop runaway timers.
  const dur = Number(r.dur_ms);
  if (Number.isFinite(dur) && dur >= 0) ev.dur_ms = Math.min(Math.round(dur), 86_400_000);
  return ev;
}

export async function appendEvent(ev) {
  await mkdir(usageDir(), { recursive: true });
  await appendFile(monthFile(new Date(ev.ts || Date.now())), JSON.stringify(ev) + '\n', 'utf8');
}

// Read events from all monthly files, optionally filtered by ISO since/until.
export async function readEvents({ since, until } = {}) {
  let files = [];
  try {
    files = (await readdir(usageDir())).filter((f) => /^usage-\d{4}-\d{2}\.jsonl$/.test(f));
  } catch {
    return []; // no usage dir yet
  }
  const out = [];
  for (const f of files.sort()) {
    let text = '';
    try {
      text = await readFile(join(usageDir(), f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // skip a torn final line
      }
      if (since && ev.ts < since) continue;
      if (until && ev.ts > until) continue;
      out.push(ev);
    }
  }
  return out;
}

function bump(map, key, ev) {
  if (key === undefined || key === null || key === '') return;
  const k = String(key);
  const row = map.get(k) || { key: k, events: 0, dwell_ms: 0 };
  row.events += 1;
  if (Number.isFinite(ev.dur_ms)) row.dwell_ms += ev.dur_ms;
  map.set(k, row);
}

function sorted(map) {
  return [...map.values()].sort((a, b) => b.events - a.events || b.dwell_ms - a.dwell_ms);
}

// Aggregate events into the analytics summary the admin page renders.
export function summarize(events, { recent = 0 } = {}) {
  const byUser = new Map();
  const byArea = new Map();
  const byModule = new Map();
  const byType = new Map();
  const byDay = new Map();
  const users = new Set();
  let from = null;
  let to = null;
  for (const ev of events) {
    users.add(ev.user || 'anonymous');
    if (!from || ev.ts < from) from = ev.ts;
    if (!to || ev.ts > to) to = ev.ts;
    bump(byUser, ev.user || 'anonymous', ev);
    bump(byType, ev.type, ev);
    bump(byDay, String(ev.ts).slice(0, 10), ev);
    if (ev.area) bump(byArea, ev.area, ev);
    if (ev.module_id) bump(byModule, ev.module_id, ev);
  }
  const summary = {
    total: events.length,
    unique_users: users.size,
    range: { from, to },
    by_user: sorted(byUser),
    by_area: sorted(byArea),
    by_module: sorted(byModule),
    by_type: sorted(byType),
    by_day: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
  if (recent > 0) summary.recent = events.slice(-recent).reverse();
  return summary;
}
