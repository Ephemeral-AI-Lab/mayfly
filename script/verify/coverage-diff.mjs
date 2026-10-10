/**
 * The changed source lines no selected spec ran: the pr tier's coverage advice in CI. The lines a change adds or edits
 * come from `git diff -U0` against the merge base (a new file counts whole); the lines that ran come from the istanbul
 * `coverage-final.json` of the selected specs. A line with a statement that never ran is reported. @module script/verify/coverage-diff
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The line numbers each hunk header of a zero-context diff adds or edits.
 * @param {string} diff - `git diff -U0` output for one file.
 * @returns {Set<number>}
 */
export function addedLines(diff) {
  const lines = new Set()
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    for (let line = start; line < start + count; line += 1) lines.add(line)
  }
  return lines
}

/**
 * The changed lines of each source file against the merge base of `base` and HEAD, uncommitted edits included.
 * @param {string} root
 * @param {string} base
 * @param {readonly string[]} files
 * @returns {Map<string, Set<number>>}
 */
export function changedLines(root, base, files) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const mergeBase = git(['merge-base', base, 'HEAD']).trim()
  const tracked = new Set(git(['ls-files', '-z', ...files]).split('\0').filter(Boolean))
  const changed = new Map()
  for (const file of files) {
    if (tracked.has(file)) changed.set(file, addedLines(git(['diff', '-U0', mergeBase, '--', file])))
    else changed.set(file, new Set(readFileSync(join(root, file), 'utf8').split('\n').map((_, index) => index + 1)))
  }
  return changed
}

/**
 * The changed lines with a statement that never ran.
 * @param {Record<string, { statementMap: Record<string, { start: { line: number } }>, s: Record<string, number> }>} coverage
 *   - istanbul `coverage-final.json`, keyed by absolute path.
 * @param {Map<string, Set<number>>} changed - from {@link changedLines}.
 * @param {string} root
 * @returns {{ file: string, lines: number[] }[]}
 */
export function uncoveredChangedLines(coverage, changed, root) {
  const result = []
  for (const [path, entry] of Object.entries(coverage)) {
    const file = relative(root, path)
    const lines = changed.get(file)
    if (lines === undefined) continue
    const missed = new Set()
    for (const [id, location] of Object.entries(entry.statementMap)) {
      if (entry.s[id] === 0 && lines.has(location.start.line)) missed.add(location.start.line)
    }
    if (missed.size > 0) result.push({ file, lines: [...missed].sort((a, b) => a - b) })
  }
  return result.sort((a, b) => a.file.localeCompare(b.file))
}
