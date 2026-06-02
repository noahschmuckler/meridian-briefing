#!/usr/bin/env bash
# meridian-briefing — Linux zip-bundle fallback. Noah's normal path is a git
# clone on each box (orange / server), so this is only for a machine with no
# git/GitHub Desktop. Produces dist/meridian-briefing-<sha>.zip containing the
# source (no .env, no data/, no node_modules — there are no runtime deps).
#
#   bash deploy/bundle.sh
#
# On the target box: unzip, then run deploy\register-task.ps1 (orange) or
# deploy\install-server.ps1 (server) from inside the unzipped folder.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
OUT="dist"
NAME="meridian-briefing-${SHA}"

mkdir -p "$OUT"
rm -f "$OUT/${NAME}.zip"

# Stage a clean tree (exclude secrets, local state, VCS, build output).
TMP="$(mktemp -d)"
STAGE="$TMP/${NAME}"
mkdir -p "$STAGE"
cp -r server.js package.json .env.example .gitignore README.md CLAUDE.md BUILDPATH.md TICKETS.md \
      lib public scripts test deploy "$STAGE/" 2>/dev/null || true
# Never ship secrets or local state.
rm -f "$STAGE/.env" 2>/dev/null || true
rm -rf "$STAGE/data" "$STAGE/node_modules" "$STAGE/dist" 2>/dev/null || true

( cd "$TMP" && zip -rq "$ROOT/$OUT/${NAME}.zip" "${NAME}" )
rm -rf "$TMP"

echo "Wrote $OUT/${NAME}.zip"
echo "On the target box: unzip it, then from inside ${NAME}\\ run:"
echo "  orange : powershell -ExecutionPolicy Bypass -File deploy\\register-task.ps1"
echo "  server : powershell -ExecutionPolicy Bypass -File deploy\\install-server.ps1"
