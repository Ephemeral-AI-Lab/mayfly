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

/** npm registry failures that are worth retrying inside one release step. */
const RETRYABLE_NPM = /\b(?:E503|EAI_AGAIN|ETIMEDOUT|ECONNRESET)\b|503 Service Unavailable|network/u

/** Block one release step between registry attempts without an async refactor. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function npmView(spec, field) {
  let last
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = spawnSync('npm', ['view', spec, field, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
    const failure = `${result.stderr ?? ''}${result.error?.message ?? ''}`
    const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal !== null
    if (result.status === 0 || (!timedOut && !RETRYABLE_NPM.test(failure))) return readNpmView(result, spec, field)
    last = new Error(`npm view ${spec} ${field} failed during a registry outage (attempt ${attempt}/4)`)
    if (attempt < 4) sleepSync(attempt * 3_000)
  }
  throw last
}

/**
 * Run npm with captured output so a staged-publish E409 reaches the release
 * controller; stream the output back so the workflow log stays identical.
 */
function runNpm(args) {
  const result = spawnSync('npm', args, { cwd: ROOT, encoding: 'utf8' })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `npm ${args[0]} failed with status ${result.status}`).trim())
}

const registry = {
  view: npmView,
  publish: (pkg, tag) => runNpm(['publish', pkg.filename, '--tag', tag, '--access', 'public', '--provenance']),
  addTag: (pkg, tag) => execFileSync('npm', ['dist-tag', 'add', `${pkg.name}@${pkg.version}`, tag], { cwd: ROOT, stdio: 'inherit' }),
  removeTag: (pkg, tag) => execFileSync('npm', ['dist-tag', 'rm', pkg.name, tag], { cwd: ROOT, stdio: 'inherit' }),
}

await releaseRegistry(mode, packages, {
  registry,
  integrity: pkg => `sha512-${createHash('sha512').update(readFileSync(pkg.filename)).digest('base64')}`,
  sleep: delay => new Promise(resolve => setTimeout(resolve, delay)),
  publishTag: process.env.RELEASE_TAG,
})
