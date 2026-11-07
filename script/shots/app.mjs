/**
 * The Website's app shots, painted from accepted cell grids under `script/shots/grids/`: each grid is written back
 * into a headless terminal, text and styles, and painted by the SVG painter of the component shots. The grids pin the
 * banner's version to a placeholder, which a shot shows as the released version. Needs no build. @module script/shots/app
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseManifestText } from '../package-contract.mjs'
import { parseGrid, styleSgr } from '../scenarios/grid.mjs'
import { paintTerminalSvg } from './svg.mjs'

const require = createRequire(import.meta.url)
// @xterm/headless@6 ships CJS-only; the ESM namespace lacks named exports.
const { Terminal } = require('@xterm/headless')

/** The placeholder the accepted grids show where the banner's version goes. */
const PINNED_VERSION = 'scenario'

/** Each shot under `website/public/shots/`, and the accepted grid it is painted from. */
export const APP_SHOTS = Object.freeze([
  { id: 'app-conversation', scene: 'app-conversation', checkpoint: 'end', cols: 80, rows: 24 },
  { id: 'app-trace', scene: 'app-trace', checkpoint: 'detail', cols: 80, rows: 24 },
  { id: 'app-permission', scene: 'app-permission', checkpoint: 'picker', cols: 80, rows: 24 },
  // Six rows taller, so the agents pane is not cut to its overflow row; the width keeps the shots' scale.
  { id: 'app-agents', scene: 'app-agents', checkpoint: 'running', cols: 80, rows: 30 },
  { id: 'app-sessions', scene: 'app-sessions', checkpoint: 'workspaces', cols: 80, rows: 24 },
  { id: 'app-session-workspace', scene: 'app-sessions', checkpoint: 'workspace', cols: 80, rows: 24 },
].map(Object.freeze))

/** The accepted grid of one shot. */
export function gridPath(shot) {
  return fileURLToPath(new URL(`./grids/${shot.scene}/${shot.checkpoint}@${String(shot.cols)}x${String(shot.rows)}.grid`, import.meta.url))
}

/** The released version a shot's banner shows. */
export const RELEASED_VERSION = parseManifestText(readFileSync(new URL('../../packages/mayfly/package.json', import.meta.url), 'utf8'), 'packages/mayfly/package.json').version

const write = (terminal, data) => new Promise(resolve => { terminal.write(data, resolve) })

/**
 * Show the banner's pinned placeholder (`mayfly scenario`, beside the mark) as the release `v<version>`: the row's
 * text changes, and the runs after it move with it.
 * @param {import('../scenarios/grid.mjs').Grid} grid
 * @param {string} version
 */
export function withVersion(grid, version) {
  const pinned = PINNED_VERSION
  const placeholder = `mayfly ${pinned}`
  const versionPlaceholder = `Version:   ${pinned}`
  const row = grid.lines.findIndex(line => line.trimEnd().endsWith(placeholder) || line.trimEnd().endsWith(versionPlaceholder))
  if (row < 0) return grid
  const line = grid.lines[row]
  const titleRow = line.trimEnd().endsWith(versionPlaceholder)
  const shown = titleRow ? version : `v${version}`
  const start = titleRow ? line.lastIndexOf(pinned) : line.lastIndexOf(placeholder) + placeholder.length - pinned.length
  const end = start + pinned.length - 1
  const delta = shown.length - (end - start + 1)
  const lines = grid.lines.with(row, `${grid.lines[row].slice(0, start)}${shown}${grid.lines[row].slice(end + 1)}`)
  const runs = grid.styles[row].map((run) => {
    if (run.from > end) return { ...run, from: run.from + delta, to: run.to + delta }
    if (run.to >= end) return { ...run, to: Math.max(run.to + Math.min(delta, 0), start + shown.length - 1) }
    return run
  })
  return { ...grid, lines, styles: grid.styles.with(row, runs) }
}

/**
 * A headless terminal holding a grid: its rows are written once as plain text to learn where each character sits (a
 * wide character takes two columns), then again with each cell's style.
 * @param {import('../scenarios/grid.mjs').Grid} grid
 */
export async function gridTerminal(grid) {
  const rows = grid.lines.length
  const terminal = new Terminal({ cols: grid.cols, rows, scrollback: 0, allowProposedApi: true })
  await write(terminal, grid.lines.map((line, row) => `\u001b[${String(row + 1)};1H${line}`).join(''))
  const buffer = terminal.buffer.active
  const cell = buffer.getNullCell()
  const painted = grid.lines.map((line, row) => {
    const width = Math.max(0, ...grid.styles[row].map(run => run.to + 1))
    const styleAt = col => grid.styles[row].find(run => run.from <= col && col <= run.to)?.style ?? ''
    let out = `\u001b[${String(row + 1)};1H`
    let current = ''
    for (let col = 0; col < grid.cols; col += 1) {
      buffer.getLine(row)?.getCell(col, cell)
      if (cell.getWidth() === 0) continue
      const chars = cell.getChars()
      if (chars === '' && col >= width) break
      const style = styleAt(col)
      if (style !== current) { out += `\u001b[0m${styleSgr(style)}`; current = style }
      out += chars === '' ? ' ' : chars
    }
    return `${out}\u001b[0m`
  })
  terminal.reset()
  await write(terminal, painted.join(''))
  return terminal
}

/**
 * Paint one app shot from its accepted grid.
 * @param {{ id: string, scene: string, checkpoint: string, cols: number, rows: number }} shot - an entry of `APP_SHOTS`.
 * @param {string} [version] - the version the banner shows.
 * @returns {Promise<string>} the SVG document.
 */
export async function paintAppShot(shot, version = RELEASED_VERSION) {
  const grid = withVersion(parseGrid(readFileSync(gridPath(shot), 'utf8')), version)
  const terminal = await gridTerminal(grid)
  try {
    return await paintTerminalSvg(terminal, { cols: shot.cols, rows: shot.rows })
  } finally {
    terminal.dispose()
  }
}

