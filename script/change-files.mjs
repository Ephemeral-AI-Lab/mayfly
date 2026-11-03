/**
 * Git-backed change collection shared by local verification commands.
 *
 * @module script/change-files
 */

import { execFileSync } from 'node:child_process'
import { posix } from 'node:path'

/** Normalize and de-duplicate repository-relative paths. */
export function normalizeChangedFiles(files) {
  return [...new Set(files
    .map(file => posix.normalize(String(file).replaceAll('\\', '/')).replace(/^\.\//u, ''))
    .filter(file => file !== '' && file !== '.'))].sort()
}

/** The workspace package directory owning a path, when any. */
export function owningPackage(file) {
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
export function defaultBase() {
  if (git(['rev-parse', '--verify', 'origin/main'], true).trim() !== '') return 'origin/main'
  return 'main'
}

/** Collect committed, staged, unstaged, and untracked paths; deleted paths are included. */
export function collectChangedFiles(base = defaultBase()) {
  return normalizeChangedFiles([
    ...paths(['diff', '--name-only', '--diff-filter=ACMRD', `${base}...HEAD`]),
    ...paths(['diff', '--name-only', '--diff-filter=ACMRD']),
    ...paths(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']),
    ...paths(['ls-files', '--others', '--exclude-standard']),
  ])
}
