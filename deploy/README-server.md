# meridian-briefing — CR DEV server deploy (operator guide)

The production rung: clone the repo on the always-on CR DEV server (Windows),
run it as a startup service, and have Billy expose the port to in-network
providers. The provider read view is public on-network; editing stays behind
the admin password.

## The model

```
  In-network providers ──►  http://cdseastdev.ms.ds.uhc.com:<port>/        (read)
  Editors (Noah)       ──►  http://cdseastdev.ms.ds.uhc.com:<port>/admin   (password)

  CR DEV server:
    node --env-file=.env server.js   (runs as SYSTEM at startup)
    HOST=0.0.0.0  PORT=<billy-port>
    state lives at BRIEFING_DB (a persistent path outside the clone)
```

The server speaks plain HTTP. TLS / a friendly hostname are Billy's layer
(IIS reverse-proxy, or a firewall rule on the port). Existing dev-server apps
are reached by port (e.g. `https://cdseastdev.ms.ds.uhc.com:8080/`); the same
shape works here until Billy provisions a nicer name.

## Prerequisites

- **Node 20.6+** on PATH.
- **git** (to clone + pull). No `npm install` — zero runtime deps.
- A persistent folder for state, e.g. `D:\meridian-briefing-data\`.
- The admin password hash+salt (generate on the Linux dev box: `npm run hash-password`).

## Install (scheduled-task path — simplest)

1. Clone the repo to a working folder, e.g.:
   ```powershell
   cd D:\
   git clone https://github.com/noahschmuckler/meridian-briefing.git
   cd D:\meridian-briefing
   ```
2. Register the startup task:
   ```powershell
   powershell -ExecutionPolicy Bypass -File deploy\install-server.ps1
   ```
   It creates `.env` from `.env.example` (if missing) and registers
   `BriefingServer` to run **as SYSTEM at startup**.
3. Edit `.env`:
   ```dotenv
   HOST=0.0.0.0
   PORT=<port Billy assigned, e.g. 8090>
   BRIEFING_DB=D:\meridian-briefing-data\state.json
   ADMIN_PASSWORD_HASH=<paste from npm run hash-password>
   ADMIN_PASSWORD_SALT=<paste from npm run hash-password>
   SESSION_TTL_DAYS=7
   ```
   Create the `BRIEFING_DB` parent folder if it doesn't exist.
4. Restart so the task picks up `.env`:
   ```powershell
   Stop-ScheduledTask -TaskName BriefingServer ; Start-ScheduledTask -TaskName BriefingServer
   ```
5. Local check on the box: `http://127.0.0.1:<port>/`.
6. **Billy:** open the firewall on `<port>` for the in-network range, and/or add
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

## nssm option (a real Windows Service)

A scheduled task is enough, but if Billy prefers a first-class service (cleaner
`services.msc` management, automatic restart semantics), use
[nssm](https://nssm.cc):

```powershell
# After install-server.ps1 (or instead of it), remove the task and use nssm:
Unregister-ScheduledTask -TaskName BriefingServer -Confirm:$false   # if present
nssm install BriefingServer "C:\Program Files\nodejs\node.exe" "--env-file=.env server.js"
nssm set BriefingServer AppDirectory D:\meridian-briefing
nssm set BriefingServer Start SERVICE_AUTO_START
nssm start BriefingServer
```
`node --env-file` reads `.env` from `AppDirectory`, so configuration is
identical to the scheduled-task path.

## IIS reverse-proxy sketch (Billy)

If fronting with IIS + ARR:
1. Install **URL Rewrite** + **Application Request Routing**.
2. Create a site (or use an existing one) bound to the desired hostname/port and
   a TLS cert.
3. Add an inbound rewrite rule: match `(.*)` → rewrite to
   `http://127.0.0.1:<port>/{R:1}`, and enable "reverse proxy".
4. Keep `HOST=127.0.0.1` in `.env` in this case (IIS is the only client); use
   `HOST=0.0.0.0` only if exposing the Node port directly.

## Backup / DR

State is one JSON file at `BRIEFING_DB` (+ a transient `state.json.tmp` during
writes). Back it up with the server's normal file backup. To restore, drop the
JSON back in place and restart the task. No migrations, no schema steps.

## Troubleshooting

- **Port didn't come up.** `Get-ScheduledTaskInfo -TaskName BriefingServer`.
  Usual causes: `.env` not edited (no admin password set is fine for read-only,
  but a missing/!valid file path isn't), `BRIEFING_DB` parent folder missing, or
  the port already in use.
- **Providers can't reach it but `127.0.0.1` works.** `HOST` is still `127.0.0.1`
  (localhost-only) or the firewall/proxy isn't forwarding. Set `HOST=0.0.0.0`
  (direct) or finish the IIS rule.
- **/admin rejects the password.** The hash+salt in `.env` must be the exact pair
  printed by `npm run hash-password` for that password; regenerate and repaste.
