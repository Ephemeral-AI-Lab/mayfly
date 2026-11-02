#!/usr/bin/env bash
# mayfly-remote.sh — launch the independent Mayfly TUI against a running Host.
#
# The TUI process owns no Agent, model, tool, or Session state: it connects to
# the dsh Host over the authenticated /connect handshake, then talks HTTP Remote
# and the /api/remote.mux WebSocket. The startup URL carries a bearer token, so
# it travels only in the environment — never in argv, where `ps` would expose it.
#
# Usage:
#   MAYFLY_DSH_STARTUP_URL='<host url>' script/mayfly-remote.sh [--resume <sessionId>]
#   MAYFLY_DSH_STARTUP_URL='<host url>' script/mayfly-remote.sh [args...]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_BIN="$REPO_ROOT/packages/remote/lib/remote-bin.js"

if [ ! -f "$REMOTE_BIN" ]; then
  printf 'error: no built Remote entry at %s; run pnpm run build first\n' "$REMOTE_BIN" >&2
  exit 1
fi

case "${1:-}" in
  http://*|https://*)
    printf 'error: pass authenticated Host URLs through MAYFLY_DSH_STARTUP_URL, never argv\n' >&2
    exit 1
    ;;
esac

if [ -z "${MAYFLY_DSH_STARTUP_URL:-}" ]; then
  cat >&2 <<'EOF'
error: no Host URL.

  Start the Host first:   dsh --profile mayfly-host
  It prints:              mayfly host: http://127.0.0.1:3080/?token=...

  Then:                   export MAYFLY_DSH_STARTUP_URL='<that url>'
                          script/mayfly-remote.sh
EOF
  exit 1
fi

exec node "$REMOTE_BIN" "$@"
