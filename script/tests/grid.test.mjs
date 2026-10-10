import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { readGrid, serializeGrid } from '../scenarios/grid.mjs'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')

/** A parsed headless terminal of `cols` by the rows written. */
async function screen(rows, cols = 12) {
  const terminal = new Terminal({ cols, rows: rows.length, scrollback: 0, allowProposedApi: true })
  await new Promise(resolve => terminal.write(rows.join('\r\n'), resolve))
  return terminal
}

test('a grid keeps the text right-trimmed and records only styled runs, merged across equal cells', async () => {
  const terminal = await screen(['\u001b[1;38;2;1;2;3mab\u001b[0m c  ', '\u001b[2mdim\u001b[0m'])
  const grid = readGrid(terminal, { colorName: rgb => rgb === 0x010203 ? 'primary' : undefined })
  assert.deepEqual(grid.lines, ['ab c', 'dim'])
  assert.deepEqual(grid.styles, [[{ from: 0, to: 1, style: 'fg:primary b' }], [{ from: 0, to: 2, style: 'd' }]])
  terminal.dispose()
})

test('a trailing styled blank is kept in the runs, palette colors and unnamed truecolors are spelled out', async () => {
  const terminal = await screen(['\u001b[31mr\u001b[39;48;2;16;32;48m  \u001b[0m'])
  const grid = readGrid(terminal)
  assert.equal(grid.lines[0], 'r')
  assert.deepEqual(grid.styles[0], [{ from: 0, to: 0, style: 'fg:p1' }, { from: 1, to: 2, style: 'bg:#102030' }])
  terminal.dispose()
})

test('a wide character is one character of text and two columns of style', async () => {
  const terminal = await screen(['\u001b[7m界\u001b[0mx'])
  const grid = readGrid(terminal)
  assert.equal(grid.lines[0], '界x')
  assert.deepEqual(grid.styles[0], [{ from: 0, to: 1, style: 'r' }])
  terminal.dispose()
})

test('the serialized grid names its size and cursor, prefixes rows, and lists the runs of styled rows', async () => {
  const terminal = await screen(['\u001b[3;4mhi\u001b[0m', '', ' x'], 8)
  assert.equal(serializeGrid(readGrid(terminal, { cursor: [2, 1] })), ['grid 8x3 cursor 2,1', '|hi', '|', '| x', 'styles', '0: 0-1 i u'].join('\n'))
  assert.match(serializeGrid(readGrid(terminal)), /^grid 8x3 cursor none\n/u)
  terminal.dispose()
})
