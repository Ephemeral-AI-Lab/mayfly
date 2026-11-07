/**
 * Shared helpers for the real-process scripts: the pinned Harness line, a
 * sleep, and node-pty loading. @module script/smoke-lib
 */

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readManifest } from './package-contract.mjs'

export const root = fileURLToPath(new URL('..', import.meta.url))

/** The Harness line Mayfly pins: the Host's exact peer on the native Session package. */
export const harnessLine = readManifest('packages/host').peerDependencies?.['@deepseek-ai/dsh-session']

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Load node-pty, first restoring the spawn-helper's execute bit where a pnpm
 * store dropped it (the kimi-code fix-node-pty-perms pattern). The repair is a
 * no-op on Linux; probing stays silent so the smoke reports its own failures.
 */
export function loadPty() {
  try {
    const store = join(root, 'node_modules', '.pnpm')
    if (existsSync(store)) {
      for (const entry of readdirSync(store)) {
        if (!entry.startsWith('node-pty@')) continue
        const helper = join(store, entry, 'node_modules', 'node-pty', 'spawn-helper')
        if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
          chmodSync(helper, 0o755)
          console.log(`==> Restored spawn-helper execute bit under ${entry}`)
        }
      }
    }
  } catch {
    // The smoke reports its own failures; permission probing stays silent.
  }
  return createRequire(import.meta.url)('node-pty')
}
