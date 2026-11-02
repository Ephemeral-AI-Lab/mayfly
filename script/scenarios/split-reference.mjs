/** Immutable published reference and strict split-screen comparison. @module script/scenarios/split-reference */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffGrids, parseGrid } from './grid.mjs'

export const SPLIT_REFERENCE = Object.freeze({
  package: '@ephemeral-ai/mayfly',
  version: '0.1.4-rc.2',
  integrity: 'sha512-KsNwfM4EN2rizHkPKVoHUXrRH2+WppR7zor6VnEhAJrO11AY6h/02tt5I0BOX04r8+CUfbqTvh5zmLoXl9kj8w==',
  commit: 'f148e7045cc22a66e62c0cd5203f8eeca1368081',
})

/** Check the downloaded npm tarball itself, rather than trusting its filename or package version. */
export function verifyReferenceTarball(bytes) {
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (actual !== SPLIT_REFERENCE.integrity) throw new Error('Reference tarball does not match the frozen npm integrity')
}

/** Redact authenticated URLs and known token encodings from all stored diagnostics. */
export function redactSplitOutput(text, startupUrl) {
  let result = text
  if (startupUrl !== undefined) {
    const parsed = new URL(startupUrl)
    const secrets = [startupUrl, parsed.href, ...parsed.searchParams.getAll('token').flatMap(token => [token, encodeURIComponent(token), new URLSearchParams({ token }).toString().slice(6)])]
    for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, '<redacted>')
  }
  return result.replace(/([?&]token=)[^\s\u001b"'<>]+/giu, '$1<redacted>')
}

/** Only explicit machine fields are normalized; colors, spacing, cursor and ordering stay exact. */
export function normalizeSplitGrid(grid) {
  return grid
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
    .replace(/^(\| {2}Trace · session-)([0-9a-f-]{8,})…([ ]*)$/gmu, (_match, prefix, id, suffix) => `${prefix}${id.replace(/[0-9a-f]/gu, 'x')}…${suffix}`)
    .replace(/\bcmd-[0-9a-f]{8}-/gu, 'cmd-xxxxxxxx-')
}

/** Fail closed if any checkpoint is absent or its reference digest/provenance has changed. Never write references. */
export function compareSplitReference(referenceDir, checkpoints, { cols, rows, steps, startup }) {
  const manifest = JSON.parse(readFileSync(join(referenceDir, 'reference.json'), 'utf8'))
  if (manifest.package !== SPLIT_REFERENCE.package || manifest.version !== SPLIT_REFERENCE.version || manifest.integrity !== SPLIT_REFERENCE.integrity || manifest.commit !== SPLIT_REFERENCE.commit) {
    throw new Error('Reference manifest does not identify the frozen published rc.2 baseline')
  }
  if (steps !== undefined && manifest.stepsSha256 !== undefined && manifest.stepsSha256 !== createHash('sha256').update(JSON.stringify(steps)).digest('hex')) throw new Error('Reference semantic steps differ from the candidate scenario')
  if (manifest.startup !== startup) throw new Error('Reference startup preference differs from the candidate scenario')
  const failures = []
  for (const checkpoint of checkpoints) {
    const width = checkpoint.cols ?? cols
    const height = checkpoint.rows ?? rows
    const file = `${checkpoint.name}-${width}x${height}.grid`
    const expectedHash = manifest.checkpoints?.[file]
    if (typeof expectedHash !== 'string') { failures.push(`${checkpoint.name}: no frozen reference checkpoint (${file})`); continue }
    const expected = readFileSync(join(referenceDir, file), 'utf8')
    if (createHash('sha256').update(expected).digest('hex') !== expectedHash) throw new Error(`Reference checksum mismatch: ${file}`)
    const parsed = parseGrid(expected)
    if (parsed.cols !== width || parsed.lines.length !== height) throw new Error(`Reference dimensions mismatch: ${file}`)
    const differences = diffGrids(normalizeSplitGrid(expected), normalizeSplitGrid(checkpoint.grid))
    if (differences.length > 0) failures.push(`${checkpoint.name}:\n${differences.join('\n')}`)
  }
  if (checkpoints.length === 0) failures.push('No candidate checkpoints were captured')
  return failures
}
