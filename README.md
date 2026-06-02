# meridian-briefing

A standalone editor/publisher for the **Optum NY/NJ Provider Briefing** — the
weekly one-page briefing for primary & urgent care providers. One small Node
service serves a read-only provider landing page and a password-gated editor
where the medical director writes drafts and chooses which editions are
published.

It is a self-hosted alternative to the shelved SharePoint port: same Briefing
layout and palette, but the content lives in a single JSON file the app owns, so
editing + publishing don't depend on SharePoint custom-code clearance.

```
  /        provider read view  — newest published edition; landscape/portrait; print;
                                 click the date for a menu of past published editions
  /admin   editor              — single shared password; create/edit/publish editions
                                 in place (click any text to edit; dropdowns for tints,
                                 status dots; add/remove/reorder cards); publish toggle
```

## Design at a glance

- **Zero runtime dependencies.** The server is `node:` builtins only (`node:http`,
  `node:crypto`). No `npm install` to deploy — just Node 20.6+.
- **One JSON document.** All editions live in `state.json` (atomic writes). No DB.
- **`node:crypto.scrypt`** for the admin password (hash + salt in `.env`).
- **Preact + htm, vendored** (`public/vendor/`) — no build step, works offline.
- **Three-rung lifecycle** (same as the throughline project): develop on Linux →
  push to GitHub → clone on the orange device to test → clone on the CR DEV
  server to deploy.

## Quick start (local dev)

```sh
# 1. Set an admin password (prints two lines to paste into .env)
npm run hash-password

# 2. Create .env
cp .env.example .env
#    …paste the ADMIN_PASSWORD_HASH / ADMIN_PASSWORD_SALT lines from step 1

# 3. Seed one published edition so the read view has content
npm run seed

# 4. Run it
npm run dev          # node --env-file=.env server.js  → http://127.0.0.1:8787
```

- Provider view: <http://127.0.0.1:8787/>
- Editor: <http://127.0.0.1:8787/admin>

```sh
npm test             # store + auth + end-to-end API tests (node:test)
```

## Storage shape

A single document (`BRIEFING_DB`, default `./data/state.json`):

```jsonc
{
  "schema_version": 1,
  "current_edition_id": "ed_20260602_a4f1",   // newest published; the / landing
  "editions": [
    {
      "id": "ed_20260602_a4f1",
      "date": "2026-06-02",
      "title": "Provider Briefing — June 2026",
      "published": true,
      "published_at": "2026-06-02T13:14:00Z",
      "issue":          { "masthead_label": "...", "issue_label": "..." },
      "leftAdvisories": [ { "tint","icon","headline","body","tag" } ],
      "topEvents":      [ { "area","tint","icon","headline","body","tag" } ],
      "initiatives":    [ { "key","title","tag","dot","statusLead","statusBody","why","how","what" } ],
      "footerLinks":    [ { "label","href" } ]
    }
  ]
}
```

An edition is visible to providers only when `published: true`. The current
landing edition is the published one with the most recent `published_at`,
recomputed on every publish/unpublish.

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/editions/current` | public | newest published edition (404 if none) |
| GET | `/api/editions` | public | `[{id,date,title}]` of published editions |
| GET | `/api/editions/:id` | public | one published edition (404 if draft/missing) |
| POST | `/api/admin/login` | — | `{password}` → session cookie |
| POST | `/api/admin/logout` | — | clear session |
| GET | `/api/admin/editions` | cookie | all editions incl. drafts |
| GET | `/api/admin/editions/:id` | cookie | one edition incl. drafts |
| POST | `/api/admin/editions` | cookie | create draft (`template_from`: `current`\|`blank`\|`<id>`) |
| PATCH | `/api/admin/editions/:id` | cookie | merge edition fields |
| POST | `/api/admin/editions/:id/publish` | cookie | `{published}` toggle |
| DELETE | `/api/admin/editions/:id` | cookie | delete (drafts only; 409 if published) |

## Deploy

- **Orange device (test):** `deploy/README-orange.md`
- **CR DEV server (production):** `deploy/README-server.md`

## Project docs

- `CLAUDE.md` — context + conventions for AI-assisted work in this repo.
- `BUILDPATH.md` — high-density status / what's built / what's next.
- `TICKETS.md` — running list of ideas and follow-ups.

## Lineage

Pivot from `meridian-os/sharepoint-port/` (a SharePoint-Lists + single-file
renderer approach, shelved when the regional SharePoint team couldn't carry the
deployment). The Briefing visual language is shared with the `meridian-os`
Briefing app, which stays as the design canvas for new card types/layouts;
schema changes are promoted here deliberately. There is no runtime coupling
between the two.
