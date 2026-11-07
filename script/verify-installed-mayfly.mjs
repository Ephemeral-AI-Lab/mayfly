/** Verify the four-package graph actually resolved by the installed split CLI. @module script/verify-installed-mayfly */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installedCli, installedManifests } from './installed-cli.mjs'

const expected = process.argv[2]
if (!expected) throw new Error('usage: verify-installed-mayfly.mjs <version>')
const home = process.env.MAYFLY_HOME
if (!home) throw new Error('MAYFLY_HOME is required')
for (const file of installedManifests(installedCli())) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  if (manifest.version !== expected) throw new Error(`${manifest.name}: expected ${expected}, got ${manifest.version}`)
}
const profile = process.env.MAYFLY_SMOKE_PROFILE ?? 'mayfly-release'
const marker = JSON.parse(readFileSync(join(home, 'harness/profiles', profile, 'mayfly-install.json'), 'utf8'))
if (marker.version !== expected) throw new Error(`managed Host profile: expected ${expected}, got ${marker.version}`)
console.log(`installed Mayfly set: four resolved packages and managed Host profile at ${expected}`)
