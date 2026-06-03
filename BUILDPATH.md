# meridian-briefing — Build Path

High-density status for picking up work in a fresh session. Pairs with CLAUDE.md
(conventions/locked decisions) and `~/.claude/plans/meridian-briefing-v1.md`
(original plan).

## ⚠️ ACTIVE BLOCKER (2026-06-03): PowerShell server doesn't persist edition writes on the E: dev box

Branch `noah/powershell-server` (PR #1). The PowerShell port (`deploy/server.ps1`)
runs on Noah's enterprise Windows box (drive `E:`, `BRIEFING_DB=E:\meridian-briefing-data\state.json`,
`HOST=127.0.0.1 PORT=8788`, foreground via `powershell -File deploy\server.ps1`).
`-SelfTest` PASSES. Login/auth/static all work. **But creating/saving an edition never persists.**

**Symptom (from the temp `server-debug.log` instrumentation, still in the code):**
on `POST /api/admin/editions` the create returns a real id but `WRITE … wroteIds=[] reReadIds=[]`
— i.e. `Normalize-State` produced an empty `editions` and the file re-read right after the
atomic write is also empty. Then milliseconds later, same single-threaded process, `LIST returns
ids=[ed_…X, ed_…Y]` — **a phantom 2nd edition appears that no logged `WRITE` created** — and the
subsequent autosave `PATCH` gets `matchIdx=-1 availIds=[]` → **404 "save failed."** The file's
contents differ between two reads ms apart with no writer between them.

**Ruled OUT (each verified, don't re-chase):**
- Auth/session/cookie — `AUTH … known=True sessions=1` after login; PATCH passes the gate (404, not 401).
- OrderedDictionary member-vs-key assignment — fixed in `e98f1a3` (all writes use `$state['editions']=`),
  confirmed running (`git log` HEAD = `e98f1a3`); `wroteIds=[]` STILL occurs.
- Multiple/zombie servers — killed all `server.ps1` procs + removed any `BriefingServer` scheduled
  task; `Get-NetTCPConnection -LocalPort 8788` confirmed empty before starting exactly one server.
- Stale browser — reproduced in a fresh InPrivate tab.
- Corrupt/malformed `state.json` — file is valid JSON; reads parse fine (read view + LIST work).
- Filesystem permissions / admin rights — writes succeed (state.json is created with content); a perms
  block would throw → 500 in `server-error.log`, which does NOT exist (no exceptions thrown).

**Drive bisect DONE (2026-06-03):** moved `BRIEFING_DB` to `C:\ProgramData\meridian-briefing\state.json`
— **identical failure.** So it is **NOT the `E:` volume / AV / DLP / sync** — the environmental
hypothesis is dead. The bug is **drive-independent → it's in the PowerShell data logic** (or a
Windows-PowerShell-5.1 value-semantics behavior). `wroteIds=[]` is computed from the in-memory `$next`
(= `Normalize-State $state`) BEFORE any disk read, so the editions are being lost **in memory**, not on disk.

**Leading hypothesis (now):** a PowerShell 5.1 value-semantics bug in the editions array handling —
`Normalize-State` / `Get-Prop` / `To-Array` / the `@($eds + , $draft)` build, around
`OrderedDictionary` + single-element-array + **function-return unwrapping** (PS unwraps a 1-element
array returned from a function to a scalar; `Get-Prop` returns `$o['editions']` which may unwrap; and
`@($orderedDict)` vs enumeration behaves differently for `OrderedDictionary` than `[hashtable]`). The
in-memory `-SelfTest` passes because its final assert reads JSON-round-tripped **PSCustomObject**
editions, NOT the raw `OrderedDictionary` editions the create path uses — so it doesn't exercise the
broken path. (Can't be confirmed from the Linux dev box — no Windows PowerShell 5.1 to run it.)

**KILLER next diagnostic (do FIRST next session, needs Windows PS 5.1):** an isolated repro that tests
the data logic with NO HTTP/server/browser — build state exactly as `Handle-AdminCreate` does and watch
where the edition vanishes. Sketch:
```powershell
# from the repo; extract the helpers or add a `-DataTest` switch to server.ps1 that runs this:
$state = Read-State                                   # fresh/empty store
"A getProp:    " + (@(To-Array (Get-Prop $state 'editions')).Count)      # expect 0
$eds = @(To-Array (Get-Prop $state 'editions'))
$draft = Blank-Edition '2026-06-03' 'T'
"B draft id:   " + $draft['id']
$state['editions'] = @($eds + , $draft)
"C set dot:    " + (@($state['editions']).Count)                          # expect 1  <-- if 0, the build/assign is the bug
"D getProp:    " + (@(To-Array (Get-Prop $state 'editions')).Count)       # expect 1  <-- if 0, Get-Prop/To-Array unwrap is the bug
$next = Normalize-State $state
"E normalized: " + (@(To-Array (Get-Prop $next 'editions')).Count)        # expect 1  <-- if 0, Normalize-State is the bug
```
Whichever letter first prints 0 names the exact broken operation. This bisects in <2 min without the
browser/port/FS in the picture.

**Then research** PS-5.1-specific pitfalls: "PowerShell OrderedDictionary `@()` enumerates DictionaryEntry",
"PowerShell function return unwraps single-element array", "PowerShell ConvertTo-Json single element array",
"`$dict['key'] = @(...)` value lost". **Candidate fixes:** (a) switch the in-memory model from `[ordered]`
to `[hashtable]` (special-cased by PS, doesn't enumerate) or to PSCustomObjects throughout; (b) make every
array-returning helper use `Write-Output -NoEnumerate` / `, $arr` consistently AND re-wrap with `@()` at
every call site; (c) if PS value-semantics keep biting, reconsider the runtime entirely — getting Node
onto the box, or a tiny self-contained static binary, may be less total effort than hardening PS.

**Resume recipe:** read this section + `deploy/server.ps1` (esp. `Write-State`, `Read-State`,
`Normalize-State`, `Handle-AdminCreate`, and the `Log-Debug` lines). To reproduce on the box:
`git pull` → remove `state.json*` + `server-debug.log` → run the server foreground → InPrivate
`/admin` → log in → **+ New draft → Create draft** → edit a field → `Get-Content …\server-debug.log -Raw`.
The temp diagnostics (`Log-Debug`, the `WRITE/CREATE/PATCH/LIST/AUTH` lines, `server-error.log`)
are intentionally still in `server.ps1` — **leave them until this is resolved, then revert** (commits
`f9da5fb`→`5fb0947`→`a334fb5`→`bf1e74a` added them; the `e98f1a3` key-fix should stay).

---

## Status: v1 Phase 1 complete (Linux scaffold + GitHub); PS deploy blocked (see above)

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
