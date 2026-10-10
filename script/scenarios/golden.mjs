/**
 * Scenario goldens: the accepted cell grid of each checkpoint at each size, under
 * `script/scenarios/golden/<scenario>/<checkpoint>@<cols>x<rows>.grid`. A checkpoint is the same, differs (with the
 * rows that differ), or is new. @module script/scenarios/golden
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diffGrids } from './grid.mjs'

/** Where the goldens live. */
export const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url))

/** The golden file of one checkpoint at one size. */
export const goldenPath = (scenario, checkpoint, cols, rows) => join(GOLDEN_DIR, scenario, `${checkpoint}@${String(cols)}x${String(rows)}.grid`)

/**
 * Compare a captured grid with its golden.
 * @returns {{ status: 'same' | 'differs' | 'new', diff: string[] }}
 */
export function compareGolden(scenario, checkpoint, cols, rows, grid) {
  const file = goldenPath(scenario, checkpoint, cols, rows)
  if (!existsSync(file)) return { status: 'new', diff: [] }
  const diff = diffGrids(readFileSync(file, 'utf8'), `${grid}\n`)
  return { status: diff.length === 0 ? 'same' : 'differs', diff }
}

/** Accept a captured grid as the golden. */
export function writeGolden(scenario, checkpoint, cols, rows, grid) {
  const file = goldenPath(scenario, checkpoint, cols, rows)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${grid}\n`)
}

/** Golden files no current checkpoint writes, relative to the repository. */
export function orphanGoldens(expected, root) {
  if (!existsSync(GOLDEN_DIR)) return []
  return readdirSync(GOLDEN_DIR, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .filter(file => !expected.has(file))
    .map(file => relative(root, file))
    .sort()
}

/** Remove golden files. */
export const removeGoldens = (files, root) => { for (const file of files) rmSync(join(root, file), { force: true }) }
