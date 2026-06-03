# meridian-briefing — orange-device test (operator guide)

This runs the Briefing publisher on the enterprise ("orange") box as a local
app that auto-starts at logon. It's the **test** rung of the lifecycle: prove
the editor + publish flow works against a real Node install before the CR DEV
server deploy.

## The model

meridian-briefing is a small local web app. One Node process serves both the
provider read view (`/`) and the password-gated editor (`/admin`), backed by a
single `state.json` file. No database, no runtime npm dependencies — just Node.

```
  orange box
  node --env-file=.env server.js   →   http://127.0.0.1:8788/        (read)
                                       http://127.0.0.1:8788/admin    (editor)
  state lives in .\data\state.json
```

## Prerequisites (one-time)

- **Node 20.6+** on PATH (`node --version`). 20.6+ is required for the
  `--env-file` flag the scheduled task uses. No `npm install` is needed — the
  server has zero runtime dependencies.

## Install (git clone + Sync — preferred)

The repo is cloned via GitHub Desktop (e.g.
`C:\Users\<you>\Documents\GitHub\meridian-briefing\`). Run it **in place**;
"update" later is just *Sync* in GitHub Desktop.

1. **Sync** in GitHub Desktop so the clone has the latest `main`.
2. Open **PowerShell** in the clone and register the auto-start task:
   ```powershell
   cd C:\Users\<you>\Documents\GitHub\meridian-briefing
   powershell -ExecutionPolicy Bypass -File deploy\register-task.ps1
   ```
   It creates `.env` from `.env.example` (if missing), registers the
   `BriefingServer` logon task pointing at the clone, and starts it.
3. **Set the admin password.** On the **Linux dev box**, run `npm run hash-password`,
   type a password, and copy the two printed lines. Paste them into `.env` in
   the orange clone (replacing the empty `ADMIN_PASSWORD_HASH=` /
   `ADMIN_PASSWORD_SALT=` lines), then restart:
   ```powershell
   Stop-ScheduledTask -TaskName BriefingServer ; Start-ScheduledTask -TaskName BriefingServer
   ```
4. Open `http://127.0.0.1:8788/` (read view) and `http://127.0.0.1:8788/admin`
   (sign in with the password you hashed).

**Just want to see it run once (no scheduled task)?**
```powershell
cd C:\Users\<you>\Documents\GitHub\meridian-briefing
copy .env.example .env       # then edit .env (paste the hash+salt)
node --env-file=.env server.js
```
Browse to `http://127.0.0.1:8788/`; Ctrl+C to stop.

**To update later:** GitHub Desktop → *Sync*, then the restart line from step 3.
`.env` and `data\` are gitignored, so a Sync never touches your password or your
editions.

> `register-task.ps1` requires **Node 20.6+** (the task launches with
> `--env-file`). It checks and tells you if Node is too old.

## Smoke test (do this once on orange)

1. Open `/admin`, sign in.
2. **+ New draft** → "Blank starter" → Create.
3. Click a headline, edit it; pick a tint from a card's dropdown; add an
   advisory with **+ Add advisory**. Edits save automatically (watch the
   "Saved" indicator in the top bar).
4. Tick **Published**, confirm.
5. Open `/` in another tab → the edition you just published is the landing page.
6. Click the masthead date → the past-editions menu lists your published
   editions.

## Managing the task

```powershell
# Restart (after editing .env)
Stop-ScheduledTask -TaskName BriefingServer ; Start-ScheduledTask -TaskName BriefingServer

# Status / last run result
Get-ScheduledTaskInfo -TaskName BriefingServer

# Uninstall the task (your data in .\data\ is untouched)
Unregister-ScheduledTask -TaskName BriefingServer -Confirm:$false
```

## Troubleshooting

- **Port 8788 didn't come up.** Check `Get-ScheduledTaskInfo -TaskName BriefingServer`.
  Common cause: a `BRIEFING_DB` path whose parent folder doesn't exist — create
  it first, or leave the default `.\data\state.json` (the server creates `data\`).
- **/admin says "not configured".** `.env` is missing the `ADMIN_PASSWORD_HASH` /
  `ADMIN_PASSWORD_SALT` pair — generate them on the Linux box with
  `npm run hash-password` and paste both in, then restart the task.
- **Seeing placeholder content?** That's a published edition full of starter
  text — edit it in `/admin`, or publish a different edition.
