#!/usr/bin/env bash
# install-dev.sh — one-shot local development install of split Mayfly:
# a dsh Host profile carrying the Mayfly Host bundle, plus the independent
# Remote TUI launcher.
#
# The split deployment needs two things the single-process installer never did:
#
#   1. A profile that composes the Web Host bundle AND the Mayfly Host bundle.
#      `dsh plugin add` maintains `dsh.profile.bundles` itself, but its install
#      step hard-fails on unreviewed dependency build scripts, so the denied
#      list must exist before the first install.
#   2. A launcher for the TUI process. `packages/remote/lib/remote-bin.js` is
#      the real entry; the published `mayfly` bin is only a hand-off to it.
#
# Environment overrides:
#   DSH_BIN     dsh executable to use            (default: dsh from PATH)
#   PROFILE     target Host profile name         (default: mayfly-dev)
#   DSH_HOME    dsh home directory               (default: dsh's own resolution)
#   DSH_VERSION dsh line to install              (default: the Host manifest's)
#   MAYFLY_SKIP_BUILD=1  link the existing lib/ build instead of building first
#
# After it finishes:
#   terminal 1:  dsh --profile <PROFILE>            # prints "mayfly host: <url>"
#   terminal 2:  MAYFLY_DSH_STARTUP_URL='<url>' <REPO>/script/mayfly-remote.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_BIN="${DSH_BIN:-dsh}"
PROFILE="${PROFILE:-mayfly-dev}"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
case "$PROFILE" in
  mayfly-*) ;;
  *) printf 'error: use a dedicated mayfly-<tag> profile\n' >&2; exit 1 ;;
esac
HOST_PKG="$REPO_ROOT/packages/host"
REMOTE_BIN="$REPO_ROOT/packages/remote/lib/remote-bin.js"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v "$DSH_BIN" >/dev/null 2>&1 \
  || die "'$DSH_BIN' not found on PATH. Install dsh or set DSH_BIN=/path/to/dsh"

# The Host bundle pins one exact dsh line; a mismatched runtime refuses the
# install, and a half-matched one boots half the service graph.
DSH_VERSION="${DSH_VERSION:-$(node -e "
  const m = require('$HOST_PKG/package.json')
  process.stdout.write(m.peerDependencies['@deepseek-ai/dsh-session'])
")}"
RUNNING="$("$DSH_BIN" --version 2>/dev/null | tr -d '[:space:]')"
if [ "$RUNNING" != "$DSH_VERSION" ]; then
  say "dsh $RUNNING does not match the Host's pinned line $DSH_VERSION"
  die "use an isolated dsh $DSH_VERSION executable and set DSH_BIN; this installer never changes global packages"
fi

if [ "${MAYFLY_SKIP_BUILD:-}" = "1" ]; then
  say "Linking the existing build (MAYFLY_SKIP_BUILD=1)"
  [ -f "$REMOTE_BIN" ] || die "no built Remote entry; run pnpm run build first"
else
  say "Building the workspace"
  pnpm --dir "$REPO_ROOT" run build
fi

# A fresh profile inherits the shipped web template, which already lists
# `dsh-base` and `dsh-web-app` as bundles; an existing one is reused so
# repeated runs stay cheap and the reviewer keeps its settings.
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  say "Creating profile '$PROFILE' from the shipped web template"
  "$DSH_BIN" --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null \
    || die "creating the web profile template failed"
fi

# `dsh plugin add` runs its own pnpm install, which hard-fails on any dependency
# build script it has not reviewed. koffi is the Windows-only native boundary
# and node-pty is not needed by the Host rows, so both are denied up front.
say "Denying the profile's optional native build scripts"
node - "$PROFILE_DIR/pnpm-workspace.yaml" <<'NODE'
const { appendFileSync, readFileSync } = require('node:fs')
const path = process.argv[2]
const workspace = readFileSync(path, 'utf8')
if (!/^allowBuilds:/mu.test(workspace)) {
  appendFileSync(path, '\nallowBuilds:\n  koffi: false\n  node-pty: false\n')
}
NODE

say "Installing the Mayfly Host bundle into the profile"
"$DSH_BIN" plugin --profile "$PROFILE" add "link:$HOST_PKG" \
  || die "linking $HOST_PKG failed (see the diagnostics path above)"

say "Verifying the profile registered every bundle layer"
node - "$PROFILE_DIR/package.json" <<'NODE'
const { readFileSync } = require('node:fs')
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []
for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@ephemeral-ai/mayfly-host']) {
  if (!bundles.includes(name)) {
    console.error(`error: ${name} is not a profile bundle (got ${JSON.stringify(bundles)})`)
    process.exit(1)
  }
}
NODE

say "Ensuring harness loader entries resolve from the profile"
node "$REPO_ROOT/script/ensure-loader-entries.mjs" "$HOST_PKG" "$PROFILE_DIR" "$DSH_BIN"

say "Verifying the composed profile carries the Web runtime and the Mayfly rows"
COMPOSED="$("$DSH_BIN" --profile "$PROFILE" --dump-config 2>/dev/null)"
for row in 'id: web-runtime' 'id: connection' 'id: mayfly-host' 'id: mayfly-host-startup'; do
  [[ "$COMPOSED" == *"$row"* ]] \
    || die "composed profile is missing '$row' — the bundle layer did not apply"
done

chmod 755 "$REPO_ROOT/script/mayfly-remote.sh"

cat <<EOF

Done. The split Mayfly is installed as profile '$PROFILE'.

  terminal 1 (Host):   $DSH_BIN --profile $PROFILE
                       it prints:  mayfly host: http://127.0.0.1:3080/?token=...

  terminal 2 (TUI):    MAYFLY_DSH_STARTUP_URL='<that url>' $REPO_ROOT/script/mayfly-remote.sh

  or export it once:   export MAYFLY_DSH_STARTUP_URL='<that url>'
                       $REPO_ROOT/script/mayfly-remote.sh

  Iterate: edit src -> pnpm run build -> restart both processes.
EOF
