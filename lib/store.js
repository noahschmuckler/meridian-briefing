// ------------------------------------------------------------------
// meridian-briefing — store. The whole world is one JSON document:
//
//   { schema_version, current_edition_id, editions: [ <edition>, ... ] }
//
// Writes are atomic (stringify → state.json.tmp → rename), so a crashed or
// concurrent reader never sees a half-written file. Single-writer (the Node
// service owns the file), so no lock is needed.
//
// BRIEFING_DB may be absolute (a server path) or relative to the repo root
// (the local default ./data/state.json).
// ------------------------------------------------------------------

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newEditionId } from './id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

export const SCHEMA_VERSION = 1;

export function dbPath() {
  const p = process.env.BRIEFING_DB || './data/state.json';
  return resolve(REPO_ROOT, p);
}

// The shape of a single edition. `make` fills defaults; `normalizeEdition`
// repairs a possibly-partial edition read from disk or sent over the wire.
const LEFT_TINTS = ['teal', 'coral', 'sage', 'lavender'];
const TOP_TINTS = ['sky', 'gold', 'warm'];
const DOTS = ['green', 'yellow', 'blue', 'purple'];
const TOP_AREAS = ['top-b1', 'top-b2', 'top-b3'];

export { LEFT_TINTS, TOP_TINTS, DOTS, TOP_AREAS };

export function emptyState() {
  return { schema_version: SCHEMA_VERSION, current_edition_id: null, editions: [] };
}

function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

export function normalizeEdition(e) {
  const o = e && typeof e === 'object' ? e : {};
  const issue = o.issue && typeof o.issue === 'object' ? o.issue : {};
  return {
    ...o,
    id: str(o.id) || newEditionId(),
    date: str(o.date),
    title: str(o.title, 'Untitled edition'),
    published: o.published === true,
    published_at: typeof o.published_at === 'string' ? o.published_at : null,
    issue: {
      masthead_label: str(issue.masthead_label),
      issue_label: str(issue.issue_label),
    },
    leftAdvisories: arr(o.leftAdvisories),
    topEvents: arr(o.topEvents),
    initiatives: arr(o.initiatives),
    footerLinks: arr(o.footerLinks),
  };
}

export function normalizeState(d) {
  const o = d && typeof d === 'object' ? d : {};
  const editions = arr(o.editions).map(normalizeEdition);
  const next = {
    ...o,
    schema_version: SCHEMA_VERSION,
    current_edition_id: typeof o.current_edition_id === 'string' ? o.current_edition_id : null,
    editions,
  };
  // Self-heal the current pointer: it must reference a published edition.
  next.current_edition_id = recomputeCurrentId(next);
  return next;
}

// The current edition is the published one with the most recent `published_at`.
// Returns the id, or null if nothing is published. Pure — operates on a state
// object, mutates nothing.
export function recomputeCurrentId(state) {
  const published = arr(state.editions).filter((e) => e.published);
  if (published.length === 0) return null;
  published.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));
  return published[0].id;
}

export function currentEdition(state) {
  const id = state.current_edition_id;
  if (!id) return null;
  return arr(state.editions).find((e) => e.id === id && e.published) || null;
}

// A blank draft with placeholder content the admin can edit in place.
export function blankEdition(date, title) {
  const today = date || new Date().toISOString().slice(0, 10);
  return normalizeEdition({
    id: newEditionId(),
    date: today,
    title: title || 'New edition',
    published: false,
    published_at: null,
    issue: {
      masthead_label: `Week of ${today}`,
      issue_label: 'Vol. 1 · Issue 1 · Distribution: All Providers',
    },
    leftAdvisories: [
      { tint: 'teal', icon: '📋', headline: 'New advisory', body: 'Advisory body text.', tag: 'Clinical Reminder' },
    ],
    topEvents: [
      { area: 'top-b1', tint: 'sky', icon: '📅', headline: 'New event', body: 'Event body text.', tag: 'Event' },
    ],
    initiatives: [
      {
        key: 'k1',
        title: 'New initiative',
        tag: 'Quality',
        dot: 'blue',
        statusLead: 'Status.',
        statusBody: ' Status detail.',
        why: 'Why this matters.',
        how: 'How it affects your workflow.',
        what: 'What you need to do.',
      },
    ],
    footerLinks: [{ label: 'Meridian Home', href: 'https://meridian-os.pages.dev/' }],
  });
}

export async function readState() {
  try {
    const txt = await readFile(dbPath(), 'utf8');
    return normalizeState(JSON.parse(txt));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

export async function writeState(state) {
  const next = normalizeState(state);
  const path = dbPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmp, path); // atomic on the same filesystem
  return next;
}
