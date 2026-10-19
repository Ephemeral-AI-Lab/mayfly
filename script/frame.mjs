#!/usr/bin/env node
/**
 * Paint a catalog scenario from the real product: the runner boots `dsh` under a PTY with the replay driver, plays the
 * scenario's script, and each checkpoint is written to `.artifacts/frames/<scenario>-<cols>x<rows>/` as a cell grid
 * (`<checkpoint>.grid`), its text (`.txt`), and an SVG (`.svg`). `--png` also renders the product in xterm.js in
 * headless Chrome (keys and the mouse through the browser) and writes the real look as `<checkpoint>.png`. `--keys`
 * sends keys after the script and captures the checkpoint `keys`.
 *
 *   pnpm run frame <scenario> [--width N] [--height N] [--keys enter,down,ctrl+c,...] [--png] [--no-color]
 *
 * @module script/frame
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenarioNamed } from './scenarios/catalog.mjs'
import { maskGrid, runScenario } from './scenarios/runner.mjs'
import { paintTerminalSvg } from './shots/svg.mjs'
import { assertDshVersion, resolveDshBin, root } from './smoke-lib.mjs'

/**
 * Parse the command line into a frame run.
 * @param argv - arguments after the script name.
 * @returns the run description (`keys` as names; write a literal comma as `comma`), or an error message.
 */
export function parseFrameArgs(argv) {
  const run = { env: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--width') run.cols = Number(argv[++index])
    else if (value === '--height') run.rows = Number(argv[++index])
    else if (value === '--keys') run.keys = (argv[++index] ?? '').split(',').filter(Boolean).map(token => (token === 'comma' ? ',' : token))
    else if (value === '--no-color') run.env.NO_COLOR = '1'
    else if (value === '--png') run.png = true
    else if (value.startsWith('--')) return { error: `unknown option ${value}` }
    else if (run.scenario === undefined) run.scenario = value
    else return { error: `unexpected argument ${value}` }
  }
  if (run.scenario === undefined) return { error: 'usage: pnpm run frame <scenario> [--width N] [--height N] [--keys a,b] [--png] [--no-color]' }
  for (const key of ['cols', 'rows']) if (run[key] !== undefined && !(Number.isInteger(run[key]) && run[key] > 0)) return { error: `--${key === 'cols' ? 'width' : 'height'} needs a positive integer` }
  return { run }
}

/** The text rows of a serialized grid. */
const gridText = grid => `${grid.split('\n').filter(line => line.startsWith('|')).map(line => line.slice(1)).join('\n')}\n`

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseFrameArgs(process.argv.slice(2))
  if (parsed.error !== undefined) { console.error(parsed.error); process.exit(2) }
  const { env, ...run } = parsed.run
  if (scenarioNamed(run.scenario) === undefined) { console.error(`unknown scenario "${run.scenario}"; try pnpm run scenario --list`); process.exit(2) }
  const dshBin = resolveDshBin()
  assertDshVersion(dshBin)
  const scenario = scenarioNamed(run.scenario)
  const [cols, rows] = [run.cols ?? scenario.sizes[0][0], run.rows ?? scenario.sizes[0][1]]
  const dir = join(root, '.artifacts/frames', `${run.scenario}-${String(cols)}x${String(rows)}`)
  mkdirSync(dir, { recursive: true })
  const result = await runScenario(run.scenario, {
    root, dshBin, cols, rows, keys: run.keys, env, backend: run.png === true ? 'browser' : 'headless',
    onCheckpoint: async (name, screen, png) => {
      if (png !== undefined) writeFileSync(join(dir, `${name}.png`), png)
      const grid = maskGrid(screen.serialize())
      writeFileSync(join(dir, `${name}.grid`), `${grid}\n`)
      writeFileSync(join(dir, `${name}.txt`), gridText(grid))
      writeFileSync(join(dir, `${name}.svg`), await paintTerminalSvg(screen.terminal, { cols: screen.terminal.cols, rows: screen.terminal.rows }))
      console.log(`${name}: ${relative(root, join(dir, `${name}.grid`))} (.txt, .svg${png === undefined ? '' : ', .png'})`)
    },
  })
  result.screen.dispose()
  console.log(`${run.scenario} at ${String(cols)}x${String(rows)}: booted in ${String(result.bootMs)} ms, ${String(result.frames)} frames, ${String(result.durationMs)} ms`)
  for (const failure of result.failures) console.error(`FAIL: ${failure}`)
  process.exit(result.failures.length > 0 ? 1 : 0)
}
