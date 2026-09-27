/**
 * Update the Mayfly release line without touching the independent Harness line.
 * Package manifests are validated as structured data; source constants and
 * advertised Website versions are narrow textual replacements.
 *
 * Usage: pnpm release:version <version>
 * @module script/release-version
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gt, valid } from 'semver'
import { PACKAGE_DIRS, ROOT } from './package-contract.mjs'
import { advertisedVersionFiles } from './release-line.mjs'

/** Validate every input and compute all replacements before writing any release file. */
export function releaseVersionChanges(root, next) {
  if (valid(next) !== next) throw new Error('usage: release:version <semver>')
  const old = JSON.parse(readFileSync(join(root, 'packages/mayfly/package.json'), 'utf8')).version
  if (!gt(next, old)) throw new Error(`release line must advance from ${old} to ${next}`)
  const changes = new Map()
  for (const directory of [...PACKAGE_DIRS, 'website']) {
    const relativePath = `${directory}/package.json`
    const source = readFileSync(join(root, relativePath), 'utf8')
    const manifest = JSON.parse(source)
    if (manifest.version !== old) throw new Error(`${relativePath}: expected ${old}, got ${manifest.version}`)
    const updated = source.replace(/("version"\s*:\s*")[^"]+(")/u, `$1${next}$2`)
    if (updated === source) throw new Error(`${relativePath}: top-level version not found`)
    changes.set(relativePath, updated)
  }
  const replacements = new Map([
    ['packages/mayfly/src/transcript/banner-content.ts', [`MAYFLY_VERSION = '${old}'`, `MAYFLY_VERSION = '${next}'`]],
    ['packages/cli/tests/main.spec.ts', [`const PIN = '${old}'`, `const PIN = '${next}'`]],
    ['packages/cli/tests/runtime.spec.ts', [`const VERSION = '${old}'`, `const VERSION = '${next}'`]],
    ['packages/mayfly/tests/transcript/banner.spec.ts', [`expect(MAYFLY_VERSION).toBe('${old}')`, `expect(MAYFLY_VERSION).toBe('${next}')`]],
  ])
  for (const [relativePath, [from, to]] of replacements) {
    const source = readFileSync(join(root, relativePath), 'utf8')
    if (!source.includes(from)) throw new Error(`${relativePath}: release marker not found: ${from}`)
    changes.set(relativePath, source.replace(from, to))
  }
  for (const relativePath of advertisedVersionFiles) {
    const source = readFileSync(join(root, relativePath), 'utf8')
    if (!source.includes(old)) throw new Error(`${relativePath}: release marker not found: ${old}`)
    changes.set(relativePath, source.replaceAll(old, next))
  }
  return { old, changes }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = process.argv[2]
  if (next === undefined || process.argv.slice(3).some(arg => arg !== '--dry-run')) throw new Error('usage: release:version <semver> [--dry-run]')
  const { old, changes } = releaseVersionChanges(ROOT, next)
  if (!process.argv.includes('--dry-run')) {
    for (const [relativePath, source] of changes) writeFileSync(join(ROOT, relativePath), source)
  }
  const changelogPath = join(ROOT, 'packages/mayfly/src/interaction/changelog-content.ts')
  if (!readFileSync(changelogPath, 'utf8').includes(`version: '${next}'`)) {
    console.warn(`release line: add a changelog entry for ${next} in packages/mayfly/src/interaction/changelog-content.ts`)
  }
  console.log(`release line: ${old} -> ${next}; ${process.argv.includes('--dry-run') ? 'would update' : 'updated'} ${changes.size} files`)
}
