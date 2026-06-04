# meridian-briefing — CR DEV server deploy (operator guide)

The production rung: clone the repo on the always-on CR DEV server (Windows),
run it as a startup service, and have Billy expose the port to in-network
providers. The provider read view is public on-network; editing stays behind
the admin password.

**This server cannot run Node.js, so the production runtime is PowerShell**
(`deploy\server.ps1`) on in-box Windows PowerShell 5.1 + .NET Framework — no
Node, no npm, no modules. The Node server (`server.js`) is byte-for-byte the
same API and stays the dev + orange-device path; if a box *does* have Node, you
may run it instead (see "Node option" below).

## The model

```
  In-network providers ──►  http://cdseastdev.ms.ds.uhc.com:<port>/        (read)
  Editors (Noah)       ──►  http://cdseastdev.ms.ds.uhc.com:<port>/admin   (password)

  CR DEV server:
    powershell -File deploy\server.ps1   (runs as SYSTEM at startup)
    HOST=0.0.0.0  PORT=<billy-port>
    state lives at BRIEFING_DB (a persistent path outside the clone)
```

The server speaks plain HTTP. TLS / a friendly hostname are Billy's layer
(IIS reverse-proxy, or a firewall rule on the port). Existing dev-server apps
are reached by port (e.g. `https://cdseastdev.ms.ds.uhc.com:8080/`); the same
shape works here until Billy provisions a nicer name.

## Prerequisites

- **Windows PowerShell 5.1+** (in-box on Windows Server) and **.NET Framework
  4.6.1+** (4.7.2/4.8 ship in-box — needed for `Rfc2898DeriveBytes` with
  `SHA256`). **No Node.** No `npm install` — there are no runtime deps either way.
- **git** (to clone + pull) — or use `deploy\bundle.sh` output on a no-git box.
- A persistent folder for state, e.g. `D:\meridian-briefing-data\`.
- The admin password hash+salt — generate it on **any** box:
  - Windows, no Node: `powershell -File scripts\hash-password.ps1`
  - Linux/Node dev box: `npm run hash-password`
  Both produce the identical PBKDF2 hash (same params), so either works.

## Install (scheduled-task path — simplest)

1. Clone the repo to a working folder, e.g.:
   ```powershell
   cd D:\
   git clone https://github.com/noahschmuckler/meridian-briefing.git
   cd D:\meridian-briefing
   ```
2. (Optional but recommended) sanity-check the runtime before installing:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\server.ps1 -SelfTest
   ```
   Expect `SELFTEST PASS` (asserts the PBKDF2 Node↔.NET vector + the JSON
   array invariants + a normalize round-trip). A FAIL means the .NET runtime
   is too old or a param drifted — stop and fix before serving.
3. Register the startup task:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\install-server.ps1
   ```
   It creates `.env` from `.env.example` (if missing), reserves the URL ACL for
   SYSTEM, and registers `BriefingServer` to run **as SYSTEM at startup**
   launching `deploy\server.ps1`.
4. Edit `.env`:
   ```dotenv
   HOST=0.0.0.0
   PORT=<port Billy assigned, e.g. 8090>
   BRIEFING_DB=D:\meridian-briefing-data\state.json
   ADMIN_PASSWORD_HASH=<paste from hash-password.ps1 or npm run hash-password>
   ADMIN_PASSWORD_SALT=<paste from the same>
   SESSION_TTL_DAYS=7
   ```
   Create the `BRIEFING_DB` parent folder if it doesn't exist.
5. Restart so the task picks up `.env`:
   ```powershell
   Stop-ScheduledTask -TaskName BriefingServer ; Start-ScheduledTask -TaskName BriefingServer
   ```
6. Local check on the box: `http://127.0.0.1:<port>/`.
7. **Billy:** open the firewall on `<port>` for the in-network range, and/or add
   an IIS reverse-proxy site (Application Request Routing) that forwards a
   hostname/path to `http://127.0.0.1:<port>/`. Then in-network providers reach
   the read view; Noah reaches `/admin`.

**To update later:**
```powershell
cd D:\meridian-briefing
git pull
Stop-ScheduledTask -TaskName BriefingServer ; Start-ScheduledTask -TaskName BriefingServer
```
`.env` and `data\` are gitignored — `git pull` never touches the password or
editions. (If `BRIEFING_DB` points outside the clone, as recommended, editions
live entirely apart from the code.)

## Smoke test (run on the box, or the orange device, after install)

Confirms the full admin lifecycle end-to-end against the running PowerShell
server. Run in PowerShell on the box; replace `$P` with your port. Uses a
`WebSession` cookie jar so the admin session survives across calls.

```powershell
$P = 8788
$base = "http://127.0.0.1:$P"
$sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# 1. login (sets the session cookie in $sess)
Invoke-RestMethod "$base/api/admin/login" -Method Post -WebSession $sess `
  -ContentType 'application/json' -Body '{"password":"<your-admin-password>"}'

# 2. create a draft from the current edition (or "blank" on a fresh box)
$draft = Invoke-RestMethod "$base/api/admin/editions" -Method Post -WebSession $sess `
  -ContentType 'application/json' -Body '{"template_from":"current","title":"Smoke test"}'
$id = $draft.id
"draft id: $id"

# 3. patch the title
Invoke-RestMethod "$base/api/admin/editions/$id" -Method Patch -WebSession $sess `
  -ContentType 'application/json' -Body '{"title":"Smoke test (edited)"}'

# 4. publish it
Invoke-RestMethod "$base/api/admin/editions/$id/publish" -Method Post -WebSession $sess `
  -ContentType 'application/json' -Body '{"published":true}'

# 5. public read view sees it as current (no auth)
(Invoke-RestMethod "$base/api/editions/current").title    # -> "Smoke test (edited)"

# 6. unpublish + delete to clean up
Invoke-RestMethod "$base/api/admin/editions/$id/publish" -Method Post -WebSession $sess `
  -ContentType 'application/json' -Body '{"published":false}'
Invoke-RestMethod "$base/api/admin/editions/$id" -Method Delete -WebSession $sess
```

Each step should return JSON without error; step 5 should echo the edited title.
Then open `http://127.0.0.1:$P/` (read) and `/admin` (login) in a browser to
confirm the SPA renders.

## Node option (only if the box happens to have Node 20.6+)

The PowerShell server is the default. If a particular box has Node and you'd
rather run `server.js`, register the task to launch it instead:
```powershell
$root = "D:\meridian-briefing"
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "--env-file=.env server.js" -WorkingDirectory $root
# ...same Trigger/Principal/Settings as install-server.ps1, then Register-ScheduledTask
```
Same `.env`, same `state.json`, same hash (PBKDF2 is shared) — the two runtimes
are interchangeable on the wire.

## nssm option (a real Windows Service)

A scheduled task is enough, but if Billy prefers a first-class service (cleaner
`services.msc` management, automatic restart semantics), use
[nssm](https://nssm.cc) to wrap the PowerShell server:

```powershell
# After install-server.ps1 (or instead of it), remove the task and use nssm:
Unregister-ScheduledTask -TaskName BriefingServer -Confirm:$false   # if present
$ps = (Get-Command powershell.exe).Source
nssm install BriefingServer "$ps" "-ExecutionPolicy Bypass -NoProfile -File D:\meridian-briefing\deploy\server.ps1"
nssm set BriefingServer AppDirectory D:\meridian-briefing
nssm set BriefingServer Start SERVICE_AUTO_START
nssm start BriefingServer
```
`server.ps1` reads `.env` from the repo root (one dir up from the script), so
configuration is identical to the scheduled-task path.

## In-network access: two paths

Providers/editors reach the briefing from their own machines — nobody signs onto
the server. Pick ONE of:

### A. Direct port (zero extra modules — fastest to stand up)
1. In `.env` set `HOST=0.0.0.0` (accept LAN connections) and a `PORT` Billy clears.
2. Billy opens the firewall on that port for the in-network range.
3. Providers go to `http://<server-host>:<port>/`, editors to `…/admin`.

Trade-off: the URL carries a port and it's plain HTTP. Good enough to pilot.

### B. IIS reverse-proxy (recommended for a clean hostname + TLS) — `deploy/web.config`
Fronts the PowerShell server with IIS so providers hit a normal
`https://<hostname>/` URL while `server.ps1` stays bound to `127.0.0.1` (never
directly reachable). Full step-by-step lives in the header of
[`deploy/web.config`](web.config); in brief:
1. **Billy, once per server:** install IIS **URL Rewrite** + **Application Request
   Routing (ARR)**, then enable proxying:
   `appcmd set config -section:system.webServer/proxy /enabled:"true" /commit:apphost`.
2. Create an IIS site bound to the hostname/port (+ TLS cert). Point its physical
   path at a folder that contains **`deploy/web.config`** (copy the file there —
   the folder needs nothing else; the PowerShell server serves the real content).
3. Open the firewall for the **IIS** binding only; do **not** expose `8788`.
4. Keep `HOST=127.0.0.1 PORT=8788` in `.env` — IIS is the only client.

The catch-all rewrite forwards path+query+cookies, so the SPA's absolute
`/api/...` paths and the HttpOnly `SameSite=Lax` admin session work unchanged.
(If you'd rather IIS serve the static assets itself and proxy only `/api/*`, that
also works but isn't needed — `server.ps1` already serves static fine.)

If ARR can't be installed in the environment, use path A.

## Usage tracking (QI analytics)

The server logs who reads what, for how long, to an append-only JSONL store
(monthly `usage-YYYY-MM.jsonl` under `USAGE_LOG`, default a `usage/` folder
beside `state.json`). View it at **`/admin` → 📊 Analytics** (behind the same
admin password): summary + by-user / area / module / day tables with a date
filter. Raw data keeps usernames by design; surface it selectively.

Identity is captured **without a login page**: the server challenges Negotiate
**only** on `POST /api/track`, so domain machines in the Local-Intranet zone
send their Windows identity silently while the app itself never prompts and
never blocks. To confirm transparent SSO on the box:

```powershell
# from a domain workstation (not the server), after browsing the site a bit:
Get-ChildItem <USAGE_LOG-or-state-folder>\usage\*.jsonl | Get-Content -Tail 5
# each line should show "user":"DOMAIN\\name" (not "anonymous")
```

If lines show `anonymous`, the site likely isn't in the browser's Local-Intranet
zone (Negotiate isn't being offered) — add the hostname to that zone (often a
GPO) or check with IT. Non-domain clients are simply not identified; the app
still works for them. Back up the `usage/` folder alongside `state.json`.

## Backup / DR

State is one JSON file at `BRIEFING_DB` (+ a transient `state.json.tmp` during
writes). Back it up with the server's normal file backup. To restore, drop the
JSON back in place and restart the task. No migrations, no schema steps.

## Troubleshooting

- **Port didn't come up.** `Get-ScheduledTaskInfo -TaskName BriefingServer`.
  To see the real error, run the server in the foreground:
  `powershell -ExecutionPolicy Bypass -File deploy\server.ps1`. Usual causes:
  `.env` not edited, `BRIEFING_DB` parent folder missing, the port already in
  use, or **.NET too old** (`Rfc2898DeriveBytes`/`SHA256` needs 4.6.1+ — run
  `-SelfTest`).
- **`HttpListenerException: Access is denied` on Start.** The wildcard prefix
  needs SYSTEM/admin or a URL ACL. The install script reserves it; to do it by
  hand: `netsh http add urlacl url=http://+:<port>/ user="NT AUTHORITY\SYSTEM"`.
- **Providers can't reach it but `127.0.0.1` works.** `HOST` is still `127.0.0.1`
  (localhost-only) or the firewall/proxy isn't forwarding. Set `HOST=0.0.0.0`
  (direct) or finish the IIS rule.
- **/admin rejects the password.** The hash+salt in `.env` must be the exact pair
  printed by `hash-password.ps1` / `npm run hash-password` **for that password**;
  regenerate and repaste. Note: a hash made with the *old scrypt* build no longer
  verifies — regenerate with the current (PBKDF2) hasher.
