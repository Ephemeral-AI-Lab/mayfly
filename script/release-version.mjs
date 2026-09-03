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
import { PACKAGE_DIRS, ROOT } from './package-contract.mjs'

const next = process.argv[2]
if (next === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(next)) throw new Error('usage: release:version <semver>')
const mayflyManifestPath = join(ROOT, 'packages/mayfly/package.json')
const old = JSON.parse(readFileSync(mayflyManifestPath, 'utf8')).version
if (old === next) throw new Error(`release line is already ${next}`)

for (const directory of [...PACKAGE_DIRS, 'website']) {
  const path = join(ROOT, directory, 'package.json')
  const source = readFileSync(path, 'utf8')
  const manifest = JSON.parse(source)
  if (manifest.version !== old) throw new Error(`${directory}/package.json: expected ${old}, got ${manifest.version}`)
  const updated = source.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`)
  if (updated === source) throw new Error(`${directory}/package.json: top-level version not found`)
  writeFileSync(path, updated)
}

const replacements = new Map([
  ['packages/mayfly/src/transcript/banner-content.ts', [`MAYFLY_VERSION = '${old}'`, `MAYFLY_VERSION = '${next}'`]],
  ['packages/cli/tests/main.spec.ts', [`const PIN = '${old}'`, `const PIN = '${next}'`]],
  ['packages/cli/tests/runtime.spec.ts', [`const VERSION = '${old}'`, `const VERSION = '${next}'`]],
  ['packages/mayfly/tests/transcript/banner.spec.ts', [`expect(MAYFLY_VERSION).toBe('${old}')`, `expect(MAYFLY_VERSION).toBe('${next}')`]],
  ['packages/mayfly/tests/interaction/session-commands.spec.ts', [`expect(MAYFLY_VERSION).toBe('${old}')`, `expect(MAYFLY_VERSION).toBe('${next}')`]],
])
for (const [relativePath, [from, to]] of replacements) {
  const path = join(ROOT, relativePath)
  const source = readFileSync(path, 'utf8')
  if (!source.includes(from)) throw new Error(`${relativePath}: release marker not found: ${from}`)
  writeFileSync(path, source.replace(from, to))
}

const advertisedVersionFiles = [
  'README.md',
  'README.zh.md',
  'docs/package-release.md',
  'packages/mayfly/presets/mayfly-cordis/skills/mayfly-plugin-development/SKILL.md',
  'packages/mayfly/tests/transcript/version.spec.ts',
  'website/.vitepress/config.ts',
  'website/index.md',
  'website/en/index.md',
  'website/guide/index.md',
  'website/en/guide/index.md',
  'website/guide/faq.md',
  'website/en/guide/faq.md',
  'website/dsh/index.md',
  'website/en/dsh/index.md',
  'website/features/index.md',
  'website/en/features/index.md',
  'website/plugins/ui-reference.md',
  'website/en/plugins/ui-reference.md',
]
for (const relativePath of advertisedVersionFiles) {
  const path = join(ROOT, relativePath)
  const source = readFileSync(path, 'utf8')
  if (!source.includes(old)) throw new Error(`${relativePath}: release marker not found: ${old}`)
  writeFileSync(path, source.replaceAll(old, next))
}

console.log(`release line: ${old} -> ${next}; updated ${PACKAGE_DIRS.length} packages, Website, constants, tests, and advertised versions`)
