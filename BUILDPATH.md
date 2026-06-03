# meridian-briefing — Build Path

High-density status for picking up work in a fresh session. Pairs with CLAUDE.md
(conventions/locked decisions) and `~/.claude/plans/meridian-briefing-v1.md`
(original plan).

## Status: v1 Phase 1 complete (Linux scaffold + GitHub)

Built, tested locally, pushed to GitHub. **Not yet deployed** to orange device
(Phase 2) or CR DEV server (Phase 3) — those need Noah's physical access.

### What works (verified)

- **Server** (`server.js`, zero runtime deps): all routes implemented —
  public read (`/api/editions/current|editions|editions/:id`), admin auth
  (`login`/`logout`), admin CRUD (`GET/POST/PATCH/DELETE editions`,
  `publish`), static SPA serving with `/admin` → shell.
- **Store** (`lib/store.js`): atomic JSON writes, normalize-on-read,
  current-pointer recompute, blank-edition factory.
- **Auth** (`lib/auth.js`): PBKDF2-HMAC-SHA256 hash/verify (timing-safe;
  iterations=600000/key=32/salt=16/UTF-8 — shared with the PowerShell server),
  in-memory sliding sessions, HttpOnly+SameSite cookies.
- **Frontend** (`public/briefing.js`, Preact+htm vendored): read view (fetch
  current, landscape/portrait, expandable initiatives, date-menu of past
  editions, print) + admin (login gate, edition picker, +New draft dialog,
  in-place contentEditable text, enum dropdowns, icon picker, add/remove/reorder,
  debounced autosave, publish toggle, logout). One `<Briefing>` renders both.
- **Tests** (`npm test`): 37 passing — store roundtrip/normalize/recompute,
  auth PBKDF2/cookie/session (incl. a Node↔.NET known-answer vector),
  end-to-end API lifecycle over HTTP.
- **Smoke**: 8/8 curl checks (the success-criteria set) + headless-chrome render
  of `/` (seeded content) and `/admin` (login form) both pass.
- **Deploy scripts** written (not runnable here — Windows): `register-task.ps1`
  (orange), `install-server.ps1` (server, SYSTEM @ startup, launches server.ps1),
  `bundle.sh`.

### No-Node production runtime (`deploy/server.ps1`) — written, Windows-verify pending

Faithful PowerShell/.NET `HttpListener` port of `server.js` for the CR DEV
server, which can't run Node. Same routes / `state.json` / `.env` / PBKDF2 hash.
Reimplements store+id+auth; hand-rolled `Write-BriefingJson` (PS 5.1
`ConvertTo-Json` can't be trusted with the doc); ASCII-only source. Companion
`scripts/hash-password.ps1` generates the same hash on a no-Node box.
**Cannot be run on the Linux dev box (no PowerShell).** Verify on Windows:
`server.ps1 -SelfTest` (asserts the PBKDF2 vector + JSON array invariants +
normalize round-trip) then the smoke recipe in `deploy/README-server.md`.

### Known good content

`npm run seed` writes one published edition mirroring the meridian-os Briefing
(4 advisories, 3 events, 6 initiatives, masthead, 5 footer links).

## Open design choices the plan left to build-time (decided)

- **Vendored Preact/htm** (not CDN import map) — offline-capable enterprise
  deploy. `public/vendor/{preact,hooks,htm}.module.js` via unpkg pins
  (preact 10.24.3, htm 3.1.1).
- **`current_edition_id` = latest `published_at`** among published (not latest
  `date`). Simple invariant; revisit if Noah wants publish-ahead/backdating.
- **Blank-template drafts publish-able with placeholder content** — no
  min-content gate. Revisit if it bites.
- **Server scheduled-task runs as SYSTEM at startup** (vs nssm service). nssm
  path documented in `deploy/README-server.md` as the upgrade.
- **TICKETS.md is committed** (not gitignored as in throughline) — useful as a
  living backlog in a fresh repo.

## Next steps

### Phase 2 — orange device (Noah)
1. GitHub Desktop: clone `meridian-briefing`.
2. `powershell -ExecutionPolicy Bypass -File deploy\register-task.ps1`
3. `npm run hash-password` on Linux → paste hash+salt into orange `.env` → restart task.
4. Smoke per `deploy/README-orange.md` (create draft → edit → publish → see on `/`).

### Phase 3 — CR DEV server (Noah + Billy) — NO NODE, PowerShell runtime
0. `powershell -File deploy\server.ps1 -SelfTest` → expect `SELFTEST PASS`
   (confirms .NET is new enough + the PBKDF2 vector + JSON invariants hold).
1. `git clone` to `D:\meridian-briefing`; `deploy\install-server.ps1` (registers
   the SYSTEM startup task that launches `deploy\server.ps1` — no Node needed).
2. Edit `.env`: `HOST=0.0.0.0`, `PORT=<billy>`, `BRIEFING_DB=<persistent>`,
   hash+salt (from `scripts\hash-password.ps1` on the box, or `npm run
   hash-password` on Linux). Restart the task.
3. Run the PowerShell smoke recipe in `README-server.md` (login → draft → patch
   → publish → public GET → delete) on the box.
4. Billy: firewall the port and/or IIS reverse-proxy (sketch in README-server.md).
5. Smoke from an in-network browser; Noah authors the first real edition.

### v1.1+ candidates
See `TICKETS.md`. Highest-value: git-versioned editions (audit/DR), draft
"preview as provider" link, multi-editor accounts.

## Gotchas / notes

- `node:test` runs each test file in its own process, so `api.test.mjs` setting
  env + importing `server.js` doesn't leak into the other suites.
- The server self-heals `current_edition_id` on every read, so a hand-edited
  `state.json` with a stale pointer won't 500 — it falls back to the right
  published edition (or 404 if none).
- contentEditable injects NBSPs; `EditableText.commit` normalizes ` `→space.
- Headless smoke caveat: the read view shows whatever is *currently published*.
  If a smoke run publishes a blank draft, re-run `npm run seed` to reset.
