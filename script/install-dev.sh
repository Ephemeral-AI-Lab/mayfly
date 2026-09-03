#!/usr/bin/env bash
# install-dev.sh — one-shot local development install of Mayfly into a dsh profile.
#
# Builds the Mayfly workspace and link-installs the product plugin closure into
# a dev profile (no npm publish).
# Code changes take effect after `pnpm run build`;
# re-run this script only when the dependency graph changes.
#
# Environment overrides:
#   DSH_BIN    dsh executable to use        (default: dsh from PATH)
#   PROFILE    target profile name          (default: mayfly-dev)
#   DSH_HOME   dsh home directory           (default: dsh's own resolution)
#   PROFILE_INSTALL_FLAGS
#              extra flags for the profile's `pnpm install` (default: none).
#              CI consumers pass --no-frozen-lockfile: CI=true flips pnpm's
#              frozen-lockfile default on, and ensure-loader-entries' package
#              additions then read as lockfile violations.
#
# Lane rule (D51 aftermath): `mayfly` is the production profile — npm
# installs only, never link:; `mayfly-dev` links this checkout; a worktree
# gets its own `mayfly-<tag>`. Never link into `mayfly`: a later npm upgrade
# half-overwrites the links and boots a Frankenstein tree.
#
# Worktree effect testing: run this from a feature worktree with
# PROFILE=mayfly-<short-branch-tag> to give that checkout its own dogfood
# profile (packages link from this script's checkout). Remove the profile
# directory (~/.dsh/profiles/mayfly-<tag>) when the branch merges.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_BIN="${DSH_BIN:-dsh}"
PROFILE="${PROFILE:-mayfly-dev}"

if ! command -v "$DSH_BIN" >/dev/null 2>&1; then
  echo "error: '$DSH_BIN' not found on PATH. Install dsh or set DSH_BIN=/path/to/dsh" >&2
  exit 1
fi

echo "==> Building Mayfly workspace"
pnpm --dir "$REPO_ROOT" run build

echo "==> Link-installing Mayfly packages into profile '$PROFILE'"
"$DSH_BIN" plugin --profile "$PROFILE" add \
  "link:$REPO_ROOT/packages/mayfly" \
  "link:$REPO_ROOT/packages/ui"

# Harness packages the bundle patch references as loader entries resolve from
# the profile root at boot; the global CLI bundles only what dsh-base needs.
# Without this step a fresh profile boot-crashes on entries outside that
# closure (first hit: dsh-session-title-all-prompts-llm).
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE"
echo "==> Ensuring harness loader entries resolve from profile '$PROFILE'"
node "$REPO_ROOT/script/ensure-loader-entries.mjs" \
  "$REPO_ROOT/packages/mayfly" "$PROFILE_DIR" "$DSH_BIN"
# shellcheck disable=SC2086 — PROFILE_INSTALL_FLAGS is a word-split flag list
pnpm --dir "$PROFILE_DIR" install ${PROFILE_INSTALL_FLAGS:-} >/dev/null

cat <<EOF

Done. Mayfly is linked into profile '$PROFILE'.

  Run:      $DSH_BIN --profile $PROFILE [task]
  Resume:   $DSH_BIN --profile $PROFILE --resume <sessionId>
  Iterate:  edit src -> pnpm --dir "$REPO_ROOT" run build -> re-run dsh

Note: package-level "declares no dsh.bundle" warnings during install are expected —
only @ephemeral-ai/mayfly contributes a bundle layer.
EOF
