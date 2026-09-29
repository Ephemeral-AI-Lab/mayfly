#!/usr/bin/env bash
# demo-fresh-onboarding.sh — boot Mayfly in a fully isolated, zero-credential
# DSH_HOME to demonstrate the first-run connection guide.
#
# Usage: script/demo-fresh-onboarding.sh [dsb-home-dir]
#   The directory defaults to a fresh mktemp dir; pass the same path back to
#   reuse the installed profile instead of reinstalling.
#
# Isolation:
#   - DSH_HOME is forced to the target dir (own profiles, credentials,
#     sessions), so the production ~/.dsh never mixes in.
#   - DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL are unset for the child, so a
#     key exported in the caller's shell cannot count as "already
#     connected" through the credential service's environment source —
#     without this, the guide is correctly skipped for that shell.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [[ "$TARGET" == "" ]]; then
  TARGET="$(mktemp -d /tmp/mayfly-fresh-XXXXXX)"
  echo "==> Fresh DSH_HOME at $TARGET (pass it as the argument to reuse this install)"
fi
mkdir -p "$TARGET"

PROFILE=mayfly-fresh
if [[ ! -d "$TARGET/profiles/$PROFILE" ]]; then
  echo "==> Installing Mayfly into isolated profile '$PROFILE'"
  (cd "$REPO_ROOT" && DSH_HOME="$TARGET" PROFILE="$PROFILE" script/install-dev.sh)
fi

echo "==> Booting isolated Mayfly (DSH_HOME=$TARGET, DEEPSEEK_* env unset)"
exec env -u DEEPSEEK_API_KEY -u DEEPSEEK_BASE_URL DSH_HOME="$TARGET" \
  dsh --profile "$PROFILE"
