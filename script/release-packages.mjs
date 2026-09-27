/**
 * Idempotent registry controller for prebuilt Mayfly tarballs.
 *
 * Usage: node script/release-packages.mjs publish|verify|promote
 *
 * @module script/release-packages
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RELEASE_PACKAGE_DIRS, ROOT, readManifest } from './package-contract.mjs'
import { checkReleaseIndex, checkReleaseReadiness } from './release-preflight.mjs'
import { readNpmView, releaseRegistry } from './registry-release.mjs'

const mode = process.argv[2]
if (!['publish', 'verify', 'promote'].includes(mode)) throw new Error('usage: release-packages.mjs publish|verify|promote')

const index = JSON.parse(readFileSync(join(ROOT, '.artifacts', 'pack', 'index.json'), 'utf8'))
const packages = index.packages
const expected = process.env.RELEASE_VERSION?.replace(/^v/u, '') ?? readManifest(RELEASE_PACKAGE_DIRS[0]).version
const problems = [
  ...checkReleaseReadiness(ROOT, expected, { requireChangelog: !expected.includes('-test.') }),
  ...checkReleaseIndex(ROOT, index, expected, { requireFiles: true }),
]
if (problems.length > 0) throw new Error(`release preflight failed: ${problems.join('; ')}`)
for (const pkg of packages) pkg.filename = join(ROOT, '.artifacts', 'pack', pkg.filename)

function npmView(spec, field) {
  const result = spawnSync('npm', ['view', spec, field, '--json'], { cwd: ROOT, encoding: 'utf8' })
  return readNpmView(result, spec, field)
}

const registry = {
  view: npmView,
  publish: (pkg, tag) => execFileSync('npm', ['publish', pkg.filename, '--tag', tag, '--access', 'public', '--provenance'], { cwd: ROOT, stdio: 'inherit' }),
  addTag: (pkg, tag) => execFileSync('npm', ['dist-tag', 'add', `${pkg.name}@${pkg.version}`, tag], { cwd: ROOT, stdio: 'inherit' }),
  removeTag: (pkg, tag) => execFileSync('npm', ['dist-tag', 'rm', pkg.name, tag], { cwd: ROOT, stdio: 'inherit' }),
}

await releaseRegistry(mode, packages, {
  registry,
  integrity: pkg => `sha512-${createHash('sha512').update(readFileSync(pkg.filename)).digest('base64')}`,
  sleep: delay => new Promise(resolve => setTimeout(resolve, delay)),
  publishTag: process.env.RELEASE_TAG,
})
