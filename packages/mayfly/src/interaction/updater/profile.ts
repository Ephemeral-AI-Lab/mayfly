/**
 * Profile facts and snapshots for the updater (D52): a dsh profile is a
 * self-contained pnpm workspace under `$DSH_HOME/profiles/<name>` —
 * package.json, pnpm-lock.yaml, cordis.patch.yml, node_modules. The
 * updater reads its facts (which specs, which versions, any `link:`
 * pollution), snapshots the three manifest files before a swap, and
 * restores them on rollback. The profile *name* is a launcher-level
 * flag the app tree cannot see through `cmdlineArgs` (it carries only
 * the inner arguments), so — exactly like the exit epitaph — the
 * shared internal profile helper scans `process.argv` for both commands
 * and the app's exit resume line.
 *
 * @module @ephemeral-ai/mayfly/interaction/updater/profile
 */

import { join } from 'node:path'
import { updaterInternals } from './io.ts'

/** `$DSH_HOME` (default `~/.dsh`) — the attachments module's resolution. */
export function dshHome(): string {
  const home = updaterInternals.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(updaterInternals.homedir(), '.dsh')
}

