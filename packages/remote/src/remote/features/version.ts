/**
 * This package's own version read from its manifest, resolving identically
 * from the source tree and the published flat lib layout.
 * @module @ephemeral-ai/mayfly/remote/features/version
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const DEPTHS = ['../package.json', '../../package.json', '../../../package.json'] as const
const PACKAGE_NAME = '@ephemeral-ai/mayfly-remote'

let cached: string | undefined

/** Read the Remote package version, or '' when no manifest depth resolves it. */
export function remoteClientVersion(): string {
  if (cached !== undefined) return cached
  for (const path of DEPTHS) {
    try {
      const manifest: unknown = require(path)
      if (manifest !== null && typeof manifest === 'object'
        && Reflect.get(manifest, 'name') === PACKAGE_NAME
        && typeof Reflect.get(manifest, 'version') === 'string') {
        cached = Reflect.get(manifest, 'version') as string
        return cached
      }
    } catch {
      // Try the next manifest depth.
    }
  }
  cached = ''
  return cached
}
