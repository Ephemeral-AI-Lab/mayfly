/** Verify a calibrated profile contains one exact Mayfly release. @module script/verify-installed-mayfly */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const expected = process.argv[2]
if (expected === undefined) throw new Error('usage: verify-installed-mayfly.mjs <version>')
const home = process.env.DSH_HOME
if (home === undefined || home === '') throw new Error('DSH_HOME is required')

// The profile receives the bundle and its public UI dependency; mayfly-cli
// itself is installed globally and is checked by the release workflow.
const PROFILE_PACKAGES = [
  'mayfly-ui',
  'mayfly',
]

for (const name of PROFILE_PACKAGES) {
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'mayfly', 'node_modules', '@ephemeral-ai', name, 'package.json'), 'utf8'))
  if (manifest.version !== expected) throw new Error(`@ephemeral-ai/${name}: expected ${expected}, got ${manifest.version}`)
}
console.log(`installed Mayfly set: ${PROFILE_PACKAGES.length} profile packages at ${expected}`)
