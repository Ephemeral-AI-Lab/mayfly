#!/usr/bin/env node
/** Validate release metadata before building or publishing. @module script/release-preflight */

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_PACKAGE_DIRS, ROOT } from './package-contract.mjs'
import { advertisedVersionFiles } from './release-line.mjs'

/** Check the exact version advertised by each release input and the current changelog entry. */
export function checkReleaseReadiness(root, version, { requireChangelog = true } = {}) {
  const problems = []
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) return [`invalid release version: ${version}`]
  for (const directory of [...RELEASE_PACKAGE_DIRS, 'website']) {
    const relativePath = `${directory}/package.json`
    const manifest = JSON.parse(readFileSync(join(root, relativePath), 'utf8'))
    if (manifest.version !== version) problems.push(`${relativePath}: expected ${version}, got ${manifest.version}`)
  }
  for (const relativePath of advertisedVersionFiles) {
    if (!readFileSync(join(root, relativePath), 'utf8').includes(version)) problems.push(`${relativePath}: does not advertise ${version}`)
  }
  const markers = new Map([
    ['packages/mayfly/src/transcript/banner-content.ts', `MAYFLY_VERSION = '${version}'`],
    ['packages/cli/tests/main.spec.ts', `const PIN = '${version}'`],
    ['packages/cli/tests/runtime.spec.ts', `const VERSION = '${version}'`],
  ])
  for (const [relativePath, marker] of markers) {
    if (!readFileSync(join(root, relativePath), 'utf8').includes(marker)) problems.push(`${relativePath}: expected ${marker}`)
  }
  const changelog = readFileSync(join(root, 'packages/mayfly/src/interaction/changelog-content.ts'), 'utf8')
  const first = /export const CHANGELOG_ENTRIES:[^=]+=\s*\[\s*\{\s*version:\s*'([^']+)',\s*summary:\s*'((?:\\.|[^'\\])*)',\s*highlights:\s*\[([\s\S]*?)\]/u.exec(changelog)
  if (requireChangelog && (first?.[1] !== version || (first?.[2]?.trim().length ?? 0) < 20 || !/^\s*'[^']{20,}'/mu.test(first?.[3] ?? ''))) {
    problems.push(`changelog: first entry must describe ${version} with a summary and highlights`)
  }
  return problems
}

/** Check a packed artifact index against the same immutable release line. */
export function checkReleaseIndex(root, index, version, { requireFiles = false } = {}) {
  const problems = []
  const packages = index?.packages
  if (!Array.isArray(packages) || packages.length !== RELEASE_PACKAGE_DIRS.length) return ['pack index: release package count differs']
  for (const [position, directory] of RELEASE_PACKAGE_DIRS.entries()) {
    const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'))
    const pkg = packages[position]
    if (pkg?.name !== manifest.name) problems.push(`pack index: expected ${manifest.name} at position ${position}`)
    if (pkg?.version !== version || manifest.version !== version) problems.push(`pack index: ${manifest.name} version differs from ${version}`)
    const expectedFilename = `${manifest.name.slice(1).replace('/', '-')}-${version}.tgz`
    if (typeof pkg?.filename !== 'string' || basename(pkg.filename) !== pkg.filename || pkg.filename !== expectedFilename) {
      problems.push(`pack index: ${manifest.name} has an unexpected filename`)
    } else if (requireFiles && !existsSync(join(root, '.artifacts', 'pack', pkg.filename))) {
      problems.push(`pack index: ${manifest.name} tarball is missing`)
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifact = process.argv.includes('--artifact')
  const args = process.argv.slice(2).filter(arg => arg !== '--artifact')
  if (args.length !== 1) throw new Error('usage: release-preflight [--artifact] <version>')
  const version = args[0].replace(/^v/u, '')
  const problems = checkReleaseReadiness(ROOT, version, { requireChangelog: !version.includes('-test.') })
  if (artifact) {
    const index = JSON.parse(readFileSync(join(ROOT, '.artifacts', 'pack', 'index.json'), 'utf8'))
    problems.push(...checkReleaseIndex(ROOT, index, version, { requireFiles: true }))
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`release preflight: ${problem}`)
    process.exitCode = 1
  } else {
    console.log(`release preflight: ${version}${artifact ? ' and packed artifacts' : ''} are consistent`)
  }
}
