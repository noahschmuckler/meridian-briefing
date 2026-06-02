# meridian-briefing — Tickets

Running list of ideas, follow-ups, and bugs from building/using the app. Newest
or highest-value near the top. Trim when shipped.

## v1.1 candidates (from the plan's deferrals)

- [ ] **Git-versioned editions** — auto-commit `state.json` on publish (+ optional
      push to a private remote) for an audit trail + offsite DR. ~20 lines around
      `writeState`/the publish handler.
- [ ] **Draft "preview as provider"** — an admin-only link that renders a draft
      exactly as the published read view, so Noah can eyeball before publishing.
      (Server already returns drafts on `GET /api/admin/editions/:id`; needs a
      read-view route that accepts an admin cookie + `?edition=<id>`.)
- [ ] **Multi-editor accounts** — `users.json` with per-user scrypt hashes +
      "last edited by" on drafts. Do this when a second author appears.
- [ ] **Image attachments** — mirror throughline's `/api/attachments/<id>/<file>`
      pattern; store under `data/attachments/<edition_id>/`. (v1 icons are emoji.)
- [ ] **Edition templates** — save a draft as a named template; "+ New draft" can
      copy from a template, not just current/blank/any-edition.
- [ ] **Search across editions** — "every briefing that mentioned PREVENT" — once
      there are 20+ editions.
- [ ] **Audit log** — `data/audit.log`, line per login/edit/publish. Mostly
      useful once multi-user lands (so "who" is meaningful).
- [ ] **Argon2id KDF** — if a security review prefers it over scrypt. Self-contained
      to `lib/auth.js`, but reintroduces a native dep — weigh against zero-deps.

## UX polish

- [ ] Editor: a small "Delete edition" button in the top bar (currently delete is
      API-only / drafts-only). Confirm + un-publish-first guard already server-side.
- [ ] Editor: warn on navigating away with an unsaved (in-flight debounce) edit.
- [ ] Read view: deep-link an initiative open via `?initiative=<key>` for sharing.
- [ ] Icon picker: group emoji by category; remember recently used.

## Decisions to revisit with real usage

- [ ] `current_edition_id` rule = latest `published_at`. If Noah wants to publish
      ahead or backdate, switch to "latest `date` among published".
- [ ] Allow publishing an edition with placeholder/blank cards? Currently yes
      (no min-content gate). Add a soft warning if it causes accidents.
- [ ] Session TTL default 7 days + restart-logs-everyone-out. Fine for one admin;
      reconsider if editors complain about re-login after server restarts.

## Ops

- [ ] Decide Windows Service (nssm) vs scheduled task on the CR DEV server with
      Billy (README-server.md documents both).
- [ ] Confirm real footer-link targets (HEDIS Dashboard / Epic Learning Portal /
      Quality Dashboard / Submit Feedback) — seed uses `#` placeholders.
- [ ] Confirm the in-network hostname/port Billy assigns; update README examples.
