#!/usr/bin/env node
/** Incrementally emit declarations and bundle only packages with changed runtime source. @module script/build-changed */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { BUILD_PACKAGE_DIRS, ROOT, readManifest, runtimeEntries } from './package-contract.mjs'

/** A repository path that changes how a package is built rather than one implementation. */
const STRUCTURAL = /^(?:(?:packages|examples)\/[^/]+\/(?:package\.json|tsconfig\.json)|script\/(?:clean-lib|prune-types)\.mjs)$/u

const isStructuralBuildPath = file => STRUCTURAL.test(file)

/** Normalize and de-duplicate repository-relative paths. */
function normalizeChangedFiles(files) {
  return [...new Set(files
    .map(file => posix.normalize(String(file).replaceAll('\\', '/')).replace(/^\.\//u, ''))
    .filter(file => file !== '' && file !== '.'))].sort()
}

/** The workspace package directory owning a path, when any. */
function owningPackage(file) {
  const parts = normalizeChangedFiles([file])[0]?.split('/') ?? []
  if ((parts[0] === 'packages' || parts[0] === 'examples') && parts[1] !== undefined) return parts.slice(0, 2).join('/')
  return undefined
}

function git(args, optional = false) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', optional ? 'ignore' : 'inherit'],
    })
  } catch (error) {
    if (optional) return ''
    throw error
  }
}

function paths(args) {
  return git([...args, '-z']).split('\0').filter(Boolean)
}

/** Resolve the comparison branch without requiring a network fetch. */
function defaultBase() {
  if (git(['rev-parse', '--verify', 'origin/main'], true).trim() !== '') return 'origin/main'
  return 'main'
}

/** Collect committed, staged, unstaged, and untracked paths; deleted paths are included. */
function collectChangedFiles(base = defaultBase()) {
  return normalizeChangedFiles([
    ...paths(['diff', '--name-only', '--diff-filter=ACMRD', `${base}...HEAD`]),
    ...paths(['diff', '--name-only', '--diff-filter=ACMRD']),
    ...paths(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']),
    ...paths(['ls-files', '--others', '--exclude-standard']),
  ])
}

function run(command, args, env) {
  process.stdout.write(`> ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, { stdio: 'inherit', env: env === undefined ? process.env : { ...process.env, ...env } })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

let base
let explicitFiles
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (value === '--') continue
  if (value === '--base') base = process.argv[++index]
  else if (value === '--files-json') explicitFiles = JSON.parse(process.argv[++index] ?? '[]')
  else throw new Error(`unknown argument: ${value}`)
}
const files = normalizeChangedFiles(explicitFiles ?? collectChangedFiles(base ?? defaultBase()))
if (files.some(isStructuralBuildPath)) {
  run('pnpm', ['run', 'build'])
  process.exit(0)
}

const packages = [...new Set(files
  .filter(file => /^(?:packages|examples)\/.+\/src\/.+\.ts$/u.test(file))
  .map(owningPackage)
  .filter(value => value !== undefined))]
if (files.length === 0) {
  process.stdout.write('build:changed: no runtime package source changed\n')
  process.exit(0)
}

const missingBaseline = BUILD_PACKAGE_DIRS.flatMap(packageDir => [
  ...runtimeEntries(packageDir, readManifest(packageDir)).values(),
].filter(target => !existsSync(join(ROOT, packageDir, target))))
if (missingBaseline.length > 0) {
  process.stdout.write(`build:changed: ${missingBaseline.length} runtime entries are missing; creating a full build baseline\n`)
  run('pnpm', ['run', 'build'])
  process.exit(0)
}

if (packages.length === 0) {
  process.stdout.write('build:changed: no runtime package source changed\n')
  process.exit(0)
}

run('pnpm', ['exec', 'tsc', '-b', 'tsconfig.json'])
run('node', ['script/prune-types.mjs'])
const names = packages.map(packageDir => readManifest(packageDir).name)
process.stdout.write(`build:changed: bundling ${names.join(', ')}\n`)
run('pnpm', ['exec', 'tsdown'], { MAYFLY_BUILD_PACKAGES: packages.join(',') })
