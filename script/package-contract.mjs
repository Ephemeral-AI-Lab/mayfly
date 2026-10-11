/**
 * Shared package contract for build, pack verification, and release order.
 * Manifests are the source of truth: concrete JavaScript exports and bins map
 * to same-named TypeScript sources, so a new subpath cannot miss the build.
 *
 * @module script/package-contract
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPOSITORY_WEB_URL = 'https://github.com/Ephemeral-AI-Lab/mayfly'
export const REPOSITORY_URL = `git+${REPOSITORY_WEB_URL}.git`
export const HOMEPAGE_URL = 'https://may-fly.dev'
export const BUGS_URL = `${REPOSITORY_WEB_URL}/issues`
export const NODE_RANGE = '^22.19.0 || >=24.0.0'

/** Canonical npm provenance metadata for a publishable workspace package. */
export function releaseRepository(relativeDir) {
  return { type: 'git', url: REPOSITORY_URL, directory: relativeDir }
}

/** Final npm dist-tags for one verified release version. */
export function releaseDistTags(version) {
  return /-rc(?:\.|$)/u.test(version) ? ['rc', 'latest'] : ['latest']
}

/** Publish order is dependency order; the launcher is always last. */
export const RELEASE_PACKAGE_DIRS = [
  'packages/ui',
  'packages/mayfly',
  'packages/cli',
]

/** Packages validated independently but deliberately excluded from release. */
export const VALIDATION_PACKAGE_DIRS = []

/** Publish-shaped ecosystem examples built and validated outside the release set. */
export const ECOSYSTEM_PACKAGE_DIRS = [
  'examples/mayfly-user-kit',
  'examples/header',
  'examples/right-inspector',
  'examples/bottom-log',
  'examples/overlay',
  'examples/ui-gallery',
  'examples/mayfly-ecosystem',
]

/** Backward-compatible name used by release/check-pack callers. */
export const PACKAGE_DIRS = RELEASE_PACKAGE_DIRS

/** All packages with buildable runtime entries, including validation plugins. */
export const BUILD_PACKAGE_DIRS = [...RELEASE_PACKAGE_DIRS, ...VALIDATION_PACKAGE_DIRS, ...ECOSYSTEM_PACKAGE_DIRS]

/**
 * Parse manifest JSON after refusing duplicate object keys. `JSON.parse`
 * keeps the last value silently, so a repeated key in one object — a
 * copy-paste leftover in a dependency map — must be caught on the raw text
 * before parsing. `source` names the manifest in the error.
 */
export function parseManifestText(text, source) {
  const frames = []
  let expectingKey = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\') end++
        end++
      }
      const keys = frames[frames.length - 1]
      if (expectingKey && keys instanceof Set) {
        const key = JSON.parse(text.slice(index, end + 1))
        if (keys.has(key)) throw new Error(`${source}: duplicate key ${JSON.stringify(key)}`)
        keys.add(key)
        expectingKey = false
      }
      index = end
    } else if (char === '{') {
      frames.push(new Set())
      expectingKey = true
    } else if (char === '[') {
      frames.push(false)
      expectingKey = false
    } else if (char === '}' || char === ']') {
      frames.pop()
      expectingKey = false
    } else if (char === ',') {
      expectingKey = frames[frames.length - 1] instanceof Set
    }
  }
  return JSON.parse(text)
}

/** Read one package manifest. */
export function readManifest(relativeDir) {
  return parseManifestText(readFileSync(join(ROOT, relativeDir, 'package.json'), 'utf8'), `${relativeDir}/package.json`)
}

/** Return a condition-map export's runtime target. */
export function defaultTarget(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.default === 'string') return value.default
  return undefined
}

/** Concrete runtime entries declared by exports and bin. */
export function runtimeEntries(relativeDir, manifest = readManifest(relativeDir)) {
  const entries = new Map()
  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    if (subpath.includes('*')) continue
    const target = defaultTarget(value)
    if (target === undefined || !/^\.\/lib\/[^/]+\.js$/.test(target)) continue
    entries.set(target.slice('./lib/'.length, -'.js'.length), target)
  }
  const bins = typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : manifest.bin ?? {}
  for (const target of Object.values(bins)) {
    if (typeof target !== 'string' || !/^lib\/[^/]+\.js$/.test(target)) continue
    entries.set(target.slice('lib/'.length, -'.js'.length), `./${target}`)
  }
  return entries
}

/** tsdown input map derived from the public runtime contract. */
export function sourceEntries(relativeDir, manifest = readManifest(relativeDir)) {
  const inputs = {}
  for (const name of runtimeEntries(relativeDir, manifest).keys()) {
    const source = join(ROOT, relativeDir, 'src', `${name}.ts`)
    if (!existsSync(source)) throw new Error(`${manifest.name}: ${name} is exported/binned but ${source} does not exist`)
    inputs[name] = source
  }
  if (Object.keys(inputs).length === 0) throw new Error(`${manifest.name}: no runtime entries found`)
  return inputs
}

/** Absolute package directory. */
export function packageDir(relativeDir) {
  return join(ROOT, relativeDir)
}
