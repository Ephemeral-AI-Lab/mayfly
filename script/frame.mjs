#!/usr/bin/env node
/**
 * Paint a workbench scenario through the real renderer (no PTY, no model) and write text, ANSI, and SVG frames to
 * `.artifacts/frames/<scenario>-<cols>x<rows>/`. The painting runs in `packages/mayfly/tests/workbench/frame.spec.ts`
 * (the boot helpers need vitest), the way `script/shots/sync.mjs` runs the app shots.
 *
 *   pnpm run frame <scenario> [--width N] [--height N] [--keys enter,down,ctrl+c,...] [--no-color]
 *
 * @module script/frame
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseKeys } from './workbench/keys.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Parse the command line into a frame run.
 * @param argv - arguments after the script name.
 * @returns the run description, or an error message.
 */
export function parseFrameArgs(argv) {
  const run = { env: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--width') run.cols = Number(argv[++index])
    else if (value === '--height') run.rows = Number(argv[++index])
    else if (value === '--keys') run.keys = parseKeys(argv[++index])
    else if (value === '--no-color') run.env.NO_COLOR = '1'
    else if (value.startsWith('--')) return { error: `unknown option ${value}` }
    else if (run.scenario === undefined) run.scenario = value
    else return { error: `unexpected argument ${value}` }
  }
  if (run.scenario === undefined) return { error: 'usage: pnpm run frame <scenario> [--width N] [--height N] [--keys a,b] [--no-color]' }
  for (const key of ['cols', 'rows']) if (run[key] !== undefined && !(Number.isInteger(run[key]) && run[key] > 0)) return { error: `--${key === 'cols' ? 'width' : 'height'} needs a positive integer` }
  return { run }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseFrameArgs(process.argv.slice(2))
  if (parsed.error !== undefined) {
    console.error(parsed.error)
    process.exit(2)
  }
  const { env, ...description } = parsed.run
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run', 'packages/mayfly/tests/workbench/frame.spec.ts',
  ], {
    cwd: root,
    // The C locale keeps formatting deterministic; its UTF-8 charset keeps the design's glyphs.
    env: { ...process.env, ...env, MAYFLY_FRAME: JSON.stringify(description), LANG: 'C', LC_ALL: 'C.UTF-8', TZ: 'UTC' },
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}
