// Store: atomic roundtrip + normalization + current-pointer recompute.
// Each test points BRIEFING_DB at a unique temp file so they don't collide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withTempDb(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mb-store-'));
  process.env.BRIEFING_DB = join(dir, 'state.json');
  // Fresh import each time so dbPath() re-reads the env (it reads at call time,
  // so a single import is fine, but this keeps tests independent).
  const store = await import('../lib/store.js?store=' + encodeURIComponent(dir));
  try {
    await fn(store);
  } finally {
    delete process.env.BRIEFING_DB;
    await rm(dir, { recursive: true, force: true });
  }
}

test('readState returns empty state when no file exists', async () => {
  await withTempDb(async (store) => {
    const s = await store.readState();
    assert.equal(s.schema_version, 1);
    assert.equal(s.current_edition_id, null);
    assert.deepEqual(s.editions, []);
  });
});

test('writeState → readState roundtrips an edition', async () => {
  await withTempDb(async (store) => {
    const ed = store.normalizeEdition({ id: 'ed_x', title: 'T', date: '2026-01-01', published: true, published_at: '2026-01-01T00:00:00Z' });
    await store.writeState({ schema_version: 1, current_edition_id: 'ed_x', editions: [ed] });
    const s = await store.readState();
    assert.equal(s.editions.length, 1);
    assert.equal(s.editions[0].title, 'T');
    assert.equal(s.current_edition_id, 'ed_x');
  });
});

test('writeState produces valid JSON on disk (atomic rename leaves no .tmp)', async () => {
  await withTempDb(async (store) => {
    await store.writeState({ editions: [store.blankEdition('2026-02-02', 'Draft')] });
    const raw = await readFile(process.env.BRIEFING_DB, 'utf8');
    const parsed = JSON.parse(raw); // throws if not valid JSON
    assert.equal(parsed.schema_version, 1);
    await assert.rejects(readFile(process.env.BRIEFING_DB + '.tmp', 'utf8'));
  });
});

test('normalizeEdition fills defaults for a partial edition', async () => {
  await withTempDb(async (store) => {
    const ed = store.normalizeEdition({ title: 'Only title' });
    assert.ok(ed.id.startsWith('ed_'));
    assert.equal(ed.published, false);
    assert.equal(ed.published_at, null);
    assert.deepEqual(ed.leftAdvisories, []);
    assert.deepEqual(ed.topEvents, []);
    assert.deepEqual(ed.initiatives, []);
    assert.deepEqual(ed.footerLinks, []);
    assert.equal(typeof ed.issue.masthead_label, 'string');
  });
});

test('recomputeCurrentId picks the most-recently-published edition', async () => {
  await withTempDb(async (store) => {
    const state = {
      editions: [
        store.normalizeEdition({ id: 'a', published: true, published_at: '2026-01-01T00:00:00Z' }),
        store.normalizeEdition({ id: 'b', published: true, published_at: '2026-03-01T00:00:00Z' }),
        store.normalizeEdition({ id: 'c', published: false }),
      ],
    };
    assert.equal(store.recomputeCurrentId(state), 'b');
  });
});

test('recomputeCurrentId is null when nothing is published', async () => {
  await withTempDb(async (store) => {
    const state = { editions: [store.normalizeEdition({ id: 'a', published: false })] };
    assert.equal(store.recomputeCurrentId(state), null);
  });
});

test('normalizeState self-heals a stale current_edition_id', async () => {
  await withTempDb(async (store) => {
    // Points at an unpublished edition → should fall back to null (none published).
    const s = store.normalizeState({ current_edition_id: 'ghost', editions: [store.normalizeEdition({ id: 'a', published: false })] });
    assert.equal(s.current_edition_id, null);
  });
});

test('currentEdition returns the published current, not a draft', async () => {
  await withTempDb(async (store) => {
    const state = store.normalizeState({
      current_edition_id: 'a',
      editions: [store.normalizeEdition({ id: 'a', published: true, published_at: '2026-01-01T00:00:00Z' })],
    });
    assert.equal(store.currentEdition(state).id, 'a');
  });
});
