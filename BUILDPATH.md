# meridian-briefing — Build Path

High-density status for picking up work in a fresh session. Pairs with CLAUDE.md
(conventions/locked decisions) and `~/.claude/plans/meridian-briefing-v1.md`
(original plan).

## 🚢 SHIPPED + LIVE (2026-06-03): PowerShell server in production on the CR DEV box

PR #1 (`noah/powershell-server`) squash-merged to `main`. The briefing is **live in-network at
`cdseastdev.ms.ds.uhc.com:8080`** via Path 1 (retired the `meridian-os-saw` POC IIS site, ran
`server.ps1` directly on :8080 as a SYSTEM startup task — no Billy, no ARR, HTTP same as saw).
Save/create/publish all confirmed working. Temp diagnostics reverted (kept the real fixes + the
hardened 0/1/2-edition `-SelfTest` + the exception-only `server-error.log` handler). Branding updated
to **Optum NY/NJ** (region-wide; replaced "Crystal Run Healthcare" in masthead/footer); the `&amp;`
entity fix shipped in `2bb0c08`.

**On Noah's return:** resync the server's working copy from `noah/powershell-server` → `main`
(`git fetch origin && git checkout main && git pull`) and restart the `BriefingServer` task so the
live box runs the merged, diagnostics-free build (this also picks up the `&amp;` + Optum NY/NJ fixes).
Then clear the test editions from the live `state.json` (via `/admin`) before wider announcement.
Remaining roadmap: Phase 2 (orange device) if still wanted; otherwise the v1 deploy is done.

The detailed debugging history below (edition-drop + File.Replace) is retained for reference.

## 🔧 IN FLIGHT (2026-06-03): per-user usage tracking + admin analytics — branch `noah/usage-tracking`

Goal: log who reads what / how long for QI, without an app login (decisions +
design in `~/.claude/plans/meridian-briefing-usage-tracking.md`). Built on a fresh
branch off `main`. **Status: Node side validated (41/41 tests + a real headless-
Chrome run confirming pageview/dwell beacons write to the JSONL store with the
server-stamped identity), PS port written + ASCII/brace-checked, client +
analytics page done, docs done. DRAFT PR #2 — pending on-box verification of the
PowerShell Windows-auth path only** (no PS on the Linux dev box). The analytics
page renders the admin login clean headless; its logged-in view wants a quick
click-through on the orange device.

What's in: `lib/usage.js` (JSONL store: sanitize/append/read/summarize) + Node
`server.js` (`POST /api/track` public, `GET /api/admin/usage` gated) mirrored
faithfully into `deploy/server.ps1`. Identity = **soft Windows auth**: an
`AuthenticationSchemeSelectorDelegate` challenges Negotiate **only** on
`/api/track` (everything else anonymous → app never prompts/breaks); main loop
stamps `$script:ReqUser`; degrades to anonymous if the selector can't be set.
Client (`public/briefing.js`): `track()` beacon (keepalive + credentials),
pageview + page-dwell + per-initiative open/dwell, `window.mbTrack` hook for the
future CS-module links, and an **Analytics** view behind `/admin` (summary +
by user/area/module/day, date filter). `USAGE_LOG` + `DEV_USER` documented in
`.env.example`; README "Usage tracking" section added.

**Verify on the box (after the main resync):** check `-SelfTest` still PASSes,
then from a domain workstation browse the site and confirm
`usage/usage-YYYY-MM.jsonl` lines show `"user":"DOMAIN\\name"` (not `anonymous`).
Decisions locked: soft auth; keep shared admin password (AD-group later, after the
credential migration); CS modules host-on-enterprise (phase B) is the real target,
this is its tracking foundation; log everything with names, surface selectively.

## ✅ FOLLOW-ON FIXED (2026-06-03): writes over an existing state.json threw `File.Replace` "path not of a legal form"

After the `@(To-Array …)` data fix landed (confirmed: `-DataTest` A–G green, `-SelfTest` PASS,
`server-debug.log` shows `wroteIds`/`persistedIds`/`LIST`/`PATCH matchIdx=0` all correct), the live
editor still showed "Save failed". `server-error.log` named the real cause:
`Exception calling "Replace" with "3" argument(s): "The path is not of a legal form."` at
`Write-State` line 313 — i.e. **`[System.IO.File]::Replace($tmp, $path, $null)`**. A `$null` backup
arg makes `File.Replace` throw on this box's .NET. The earlier log entries show
`Handle-AdminCreate` threw the *same* exception whenever `state.json` already existed — so this
silently broke **every write over an existing file** (CREATE-of-2nd-edition, publish, delete,
autosave-PATCH). The only write that ever worked was the very first CREATE on a freshly-deleted
store, because that took the `Move` (new-file) branch.

**Fix (commit pending):** `Write-State` now calls `File.Replace($tmp, $path, $bak)` with a REAL
backup path (preserving atomic-on-NTFS) and removes the `.bak` after; if `Replace` throws (volume
doesn't support it), it falls back to delete-then-`Move` — safe because the server is single-
threaded (one request at a time). Not the data layer, not auth — purely the temp-file promotion.

**CONFIRMED ON THE BOX (2026-06-03):** save works ("Saved"), 2nd-edition create persists, no new
`server-error.log` entries. **The PowerShell-server blocker is fully resolved** (three fixes:
`@(To-Array)` double-wrap `830b3ca`, `File.Replace` null-backup `31b2878`, plus the earlier
`e98f1a3` key-fix).

**Cosmetics fixed (`2bb0c08`):** `&amp;` rendered literally (htm doesn't decode entities → use a
literal `&`); dark admin-bar `<select>` dropdown options were white-on-light-popup (only hovered row
legible → explicit dark `option` popup). The earlier "top-events card renders vertically" was the
single-narrow-column state and renders fine with content; left as-is.

**In-network access (`deploy/web.config` + README "two paths"):** added a real IIS reverse-proxy
config (ARR/URL-Rewrite → `127.0.0.1:8788`, server stays localhost) as the recommended path, with
the zero-module `HOST=0.0.0.0` + firewall fallback. This is Phase 3 (CR DEV server) deploy material;
needs Billy to install ARR + create the IIS site.

**REMAINING before PR #1 merge:** revert the temp diagnostics per the "AFTER CONFIRMATION" note below
(keep all real fixes + hardened SelfTest). Then Phase 2 (orange) / Phase 3 (CR DEV) deploys.

**Phase 3 standup decision (2026-06-03): reuse saw's `:8080`, no Billy.** The retired-POC
`meridian-os-saw` already owns the in-network endpoint `cdseastdev.ms.ds.uhc.com:8080` — verified
**plain HTTP** (`Get-WebBinding` → `protocol http`, `sslFlags 0`) and **ARR not installed**
(`Get-WebGlobalModule` empty). So the no-Billy route is **Path 1 (retire saw, run server.ps1
directly on :8080)** — the firewall/host is already open, we're just changing what listens. Noah has
local admin; repo is already cloned + working at `E:\noahs\meridian-briefing`, `BRIEFING_DB` +
admin hash set. Recipe: (1) `Remove-Website` the saw site to free :8080; (2) `.env` → `HOST=0.0.0.0
PORT=8080`; (3) `deploy\install-server.ps1` (reserves URL ACL + SYSTEM startup task); (4) verify
from another machine. Clear the test editions from `state.json` before announcing. Path 2 (IIS
reverse-proxy, keeps TLS) was ruled out only because ARR isn't installed (that install is the one
step that would need Billy). Do the diagnostics revert right AFTER the :8080 cutover is confirmed.

---

## ✅ RESOLVED (2026-06-03): PowerShell edition-drop bug — root cause was the `@(To-Array …)` double-wrap

Branch `noah/powershell-server` (PR #1). The PowerShell port (`deploy/server.ps1`) wouldn't persist
edition writes: `POST /api/admin/editions` returned a real id but `WRITE … wroteIds=[]`, a phantom 2nd
edition appeared, and autosave `PATCH` 404'd with `matchIdx=-1 availIds=[]`. `-SelfTest` passed; auth /
static / read all worked. **Found via the `-DataTest` probe; fixed; pending on-box confirmation.**

**ROOT CAUSE (confirmed by `-DataTest` on PS 5.1.26100, screenshot 2026-06-03).** `To-Array` is correct —
it returns a comma-protected array as a *single* pipeline item (`return , @($v)`). But almost every call
site wrapped it again: `@(To-Array (Get-Prop … 'editions'))`. That `@(…)` adds a second layer, producing
a one-element array whose only element is the real array — so **`@(To-Array X).Count` is ALWAYS 1**,
regardless of the real contents. The probe nailed it: `@(To-Array 2-elem)` → 1 (want 2); `@(To-Array
empty)` → 1 (want 0); the 1-element case → 1 only *by luck* (which is why the single-edition `-SelfTest`
never caught it). Cascade:
- **Empty editions** → `$eds` = `[ @() ]` → `@($eds + ,$draft)` = `[ @(), $draft ]`; the empty-array
  element becomes a **phantom edition** (gets a fresh id in `Normalize-Edition`).
- **PATCH `matchIdx=-1`** → `$eds[0]` was the inner array, not an edition, so `Get-Prop $_ 'id'` = null,
  never matched.
- **`wroteIds=[]`** → the WRITE log line itself used `@(To-Array X) | ForEach` (same bug), piping the
  array as one item → ids resolved to null. The log was lying; the write wasn't actually empty.
- **`-SelfTest` passed** → it only round-tripped ONE edition, the one case where `@(To-Array)`→1 is right.

Earlier hypotheses (OrderedDictionary `@()` enumeration, function single-element unwrap, drive/AV/DLP,
auth, zombies) were all correctly ruled out — none was the cause.

**THE FIX (commit pending push):** the bare form `$eds = To-Array (…)` is correct everywhere (the comma
already protects it). Changes in `deploy/server.ps1`:
- Removed the `@()` wrapper from all four product call sites (Create/Patch/Publish/Delete).
- Added `Get-EdIds $container` (bare-`To-Array` + `foreach` join) and used it in the WRITE/CREATE logs so
  the diagnostics tell the truth.
- Loud "**CALL IT BARE — never `@(To-Array …)`**" warning on `To-Array`.
- `-SelfTest` now round-trips **0 / 1 / 2** editions (the 0 and 2 cases are the permanent regression
  guard; the old test only checked 1).
- `-DataTest` rewritten as a fix-confirmation tool (A–G): a BUG-vs-FIX demo line, the create path, a
  second-edition (phantom/PATCH) boundary, and a JSON round-trip — all should be green except the
  intentional `BUG` line (stays 1 by design).

**CONFIRM ON THE BOX (Noah, next session):**
```
git pull
powershell -ExecutionPolicy Bypass -File deploy\server.ps1 -DataTest    # expect A-G all green
powershell -ExecutionPolicy Bypass -File deploy\server.ps1 -SelfTest    # expect SELFTEST PASS
# then real server: remove state.json* + server-debug.log, run foreground, InPrivate /admin,
# log in, + New draft -> Create draft, edit a field; LIST should show ONE id, autosave should 200.
```

**AFTER CONFIRMATION — revert the temp diagnostics** (keep the real fix). Remove: the `-DataTest` switch +
`Invoke-DataTest`, the `Log-Debug` calls + `WRITE/CREATE/PATCH/LIST/AUTH` lines + `server-error.log`
(added in `f9da5fb`→`5fb0947`→`a334fb5`→`bf1e74a`). **KEEP:** the `e98f1a3` key-fix, the `@()`-removal
call-site fixes, `Get-EdIds`, the hardened 0/1/2 `-SelfTest`, and the `To-Array` warning comment.

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
