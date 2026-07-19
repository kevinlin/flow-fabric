#!/bin/sh
# launchd entrypoint: run the built daemon with the repo .env.
# launchd gives a minimal PATH, so resolve node explicitly — set NODE_BIN
# in the plist EnvironmentVariables if `command -v node` can't find it.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /opt/homebrew/bin/node)}"
mkdir -p "${FF_DATA_DIR:-$HOME/.flow-fabric}/logs"
exec "$NODE_BIN" --env-file-if-exists=.env packages/server/dist/daemon.js
