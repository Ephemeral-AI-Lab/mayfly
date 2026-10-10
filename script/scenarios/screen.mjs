/**
 * The scenario runner's terminal: the bytes of a real `dsh` parsed into `@xterm/headless`, plus what a test needs
 * that the emulator does not expose. pi-tui wraps every paint in synchronized output (`?2026h … ?2026l`), so a frame
 * ends at each `?2026l`, timed as it arrives. The mouse modes (`?1000/1002/1003`, SGR `?1006`) and the cursor
 * visibility (`?25`) are tracked from the stream. The emulator's own replies (DA1, cursor reports) go back to the
 * product, and the colour queries (OSC 10/11) get pinned dark colours, so the product sees the same terminal on every
 * machine. @module script/scenarios/screen
 */

import { createRequire } from 'node:module'
import { readGrid, serializeGrid } from './grid.mjs'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')

/** The colours the scenario terminal reports: a dark background, as the default theme expects. */
export const TERMINAL_COLORS = { foreground: 'rgb:d4d4/d4d4/d4d4', background: 'rgb:1e1e/1e1e/1e1e' }

const SYNC = /\u001b\[\?2026([hl])/gu
const MOUSE_TRACKING = new Map([[1000, 'vt200'], [1002, 'drag'], [1003, 'any']])

/**
 * A screen fed by a PTY.
 * @param {{ cols: number, rows: number, reply: (data: string) => void, scrollback?: number }} options - `reply` writes to the
 *   product's input.
 */
export function createScreen({ cols, rows, reply, scrollback = 2000 }) {
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
  const state = { frames: [], openSync: 0, lastData: 0, bytes: 0, mouse: 'none', sgr: false, cursorVisible: true }
  let carry = ''

  const decset = (params, on) => {
    for (const param of params) {
      const mode = typeof param === 'number' ? param : param[0]
      if (MOUSE_TRACKING.has(mode)) state.mouse = on ? MOUSE_TRACKING.get(mode) : 'none'
      else if (mode === 1006) state.sgr = on
      else if (mode === 25) state.cursorVisible = on
    }
    return false
  }
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => decset(params, true))
  terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => decset(params, false))
  for (const [code, color] of [[10, TERMINAL_COLORS.foreground], [11, TERMINAL_COLORS.background]]) {
    terminal.parser.registerOscHandler(code, (data) => {
      if (data !== '?') return false
      reply(`\u001b]${String(code)};${color}\u001b\\`)
      return true
    })
  }
  terminal.onData(data => reply(data))

  return {
    terminal,
    state,
    /** Bytes from the product: frame boundaries are timed on arrival, then the emulator parses them. */
    feed(data) {
      const now = performance.now()
      state.lastData = now
      state.bytes += data.length
      // A sequence split across chunks is matched with the tail of the chunk before.
      const text = carry + data
      for (const match of text.matchAll(SYNC)) {
        if (match.index + match[0].length <= carry.length) continue
        if (match[1] === 'h') state.openSync += 1
        else { state.openSync = Math.max(0, state.openSync - 1); state.frames.push({ at: now, bytes: state.bytes }) }
      }
      carry = text.slice(-8)
      terminal.write(data)
    },
    /** Resolve once every byte fed so far is parsed. */
    flush: () => new Promise(resolve => terminal.write('', resolve)),
    resize(nextCols, nextRows) { terminal.resize(nextCols, nextRows) },
    /** The visible screen as a grid; the cursor counts only while it is shown. */
    grid(colorName) {
      const buffer = terminal.buffer.active
      return readGrid(terminal, { cursor: state.cursorVisible ? [buffer.cursorY, buffer.cursorX] : null, colorName })
    },
    /** The serialized visible screen. */
    serialize(colorName) { return serializeGrid(this.grid(colorName)) },
    /** Visible rows the emulator wrapped: a row wider than the terminal. */
    wrappedRows() {
      const buffer = terminal.buffer.active
      const rows = []
      for (let row = 0; row < terminal.rows; row += 1) if (buffer.getLine(buffer.viewportY + row)?.isWrapped === true) rows.push(row)
      return rows
    },
    /** The cell position of the first visible occurrence of `text`, as `{ row, col }`. */
    find(text) {
      const buffer = terminal.buffer.active
      for (let row = 0; row < terminal.rows; row += 1) {
        const col = buffer.getLine(buffer.viewportY + row)?.translateToString(true).indexOf(text) ?? -1
        if (col >= 0) return { row, col }
      }
      return undefined
    },
    dispose: () => terminal.dispose(),
  }
}
