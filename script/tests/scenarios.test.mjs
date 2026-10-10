import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../package-contract.mjs'
import { CATALOG } from '../scenarios/catalog.mjs'
import { click, mouseReport } from '../scenarios/input.mjs'
import { REPLAYS } from '../scenarios/replays.mjs'
import { maskGrid } from '../scenarios/runner.mjs'
import { TERMINAL_COLORS, createScreen } from '../scenarios/screen.mjs'
import { compile } from '../scenarios/timeline.mjs'
import { repositoryGraph } from '../verify/select.mjs'

test('the screen ends a frame at each synchronized-output end, even split across chunks, and settles its open count', async () => {
  const screen = createScreen({ cols: 10, rows: 2, reply: () => {} })
  screen.feed('\u001b[?2026hab\u001b[?20')
  assert.equal(screen.state.openSync, 1)
  assert.equal(screen.state.frames.length, 0)
  screen.feed('26lc\u001b[?2026h\u001b[?2026l')
  assert.equal(screen.state.frames.length, 2)
  assert.equal(screen.state.openSync, 0)
  await screen.flush()
  assert.equal(screen.grid().lines[0], 'abc')
  screen.dispose()
})

test('the screen tracks the mouse and cursor modes, answers the colour queries, and forwards its own replies', async () => {
  const replies = []
  const screen = createScreen({ cols: 20, rows: 3, reply: data => replies.push(data) })
  screen.feed('\u001b[?1000h\u001b[?1003h\u001b[?1006h\u001b[?25l\u001b]11;?\u0007\u001b[c')
  await screen.flush()
  assert.deepEqual([screen.state.mouse, screen.state.sgr, screen.state.cursorVisible], ['any', true, false])
  assert.ok(replies.includes(`\u001b]11;${TERMINAL_COLORS.background}\u001b\\`))
  assert.ok(replies.some(reply => reply.startsWith('\u001b[?1;2')))
  assert.equal(screen.grid().cursor, null)
  screen.feed('\u001b[?1003l\u001b[?25hhello\r\nworld')
  await screen.flush()
  assert.equal(screen.state.mouse, 'none')
  assert.deepEqual(screen.grid().cursor, [1, 5])
  assert.deepEqual(screen.find('world'), { row: 1, col: 0 })
  assert.deepEqual(screen.wrappedRows(), [])
  screen.dispose()
})

test('mouse reports are SGR: buttons, drags, wheel notches, and modifiers at one-based cells', () => {
  assert.equal(mouseReport({ type: 'press', row: 0, col: 0 }), '\u001b[<0;1;1M')
  assert.equal(mouseReport({ type: 'release', row: 4, col: 9, button: 'right' }), '\u001b[<2;10;5m')
  assert.equal(mouseReport({ type: 'drag', row: 1, col: 1 }), '\u001b[<32;2;2M')
  assert.equal(mouseReport({ type: 'wheel', row: 2, col: 3, direction: 'down', modifiers: { ctrl: true } }), '\u001b[<81;4;3M')
  assert.equal(click(0, 1), '\u001b[<0;2;1M\u001b[<0;2;1m')
  assert.throws(() => mouseReport({ type: 'press', row: 0, col: 0, button: 'side' }), /unknown mouse button/u)
})

test('a grid masks the workspace tag and the version without changing a row width', () => {
  const grid = '|Directory: /tmp/mayfly-scenario-1a2b3c4d\n|Version:   0.1.3-rc.2\n| …/mayfly-scenario-9f8e7d6c  cache'
  assert.equal(maskGrid(grid), '|Directory: /tmp/mayfly-scenario-xxxxxxxx\n|Version:   ##########\n| …/mayfly-scenario-9f8e7d6c  cache')
})

test('every scenario has a known source, real sizes, its marks, and covers globs that name files', () => {
  const files = repositoryGraph(ROOT).files
  const matches = (glob) => {
    const pattern = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*')}${glob.endsWith('/') ? '' : '$'}`, 'u')
    return files.some(file => pattern.test(file))
  }
  for (const [name, scenario] of Object.entries(CATALOG)) {
    assert.ok(scenario.summary.length > 0, name)
    assert.ok(scenario.sizes.length > 0 && scenario.sizes.every(([cols, rows]) => Number.isInteger(cols) && Number.isInteger(rows) && cols >= 20 && rows >= 10), name)
    for (const glob of scenario.covers) assert.ok(matches(glob), `${name}: ${glob} names no file`)
    if (scenario.source.replay !== undefined) {
      const replay = REPLAYS[scenario.source.replay]
      assert.ok(replay !== undefined, name)
      const marks = new Set(compile(replay.items, replay.options).filter(action => action.op === 'mark').map(action => action.name))
      for (const step of scenario.script) if (step.step === 'play' && step.until !== undefined) assert.ok(marks.has(step.until), `${name}: no mark ${step.until}`)
    }
    assert.ok(scenario.script.some(step => step.step === (scenario.perf === undefined ? 'checkpoint' : 'measure') || step.step === 'idle'), `${name} captures nothing`)
  }
})

test('the scenario clock starts at its epoch, stands at a timeline time, and runs again on flow', () => {
  const clock = fileURLToPath(new URL('../scenarios/clock.mjs', import.meta.url))
  const out = execFileSync(process.execPath, ['--import', clock, '-e', `
    const c = globalThis.__mayflyClock
    const start = new Date().toISOString()
    c.at(90000)
    const at = Date.now()
    const busy = performance.now() + 30; while (performance.now() < busy) {}
    const still = Date.now() === at
    c.flow()
    const later = performance.now() + 30; while (performance.now() < later) {}
    console.log(JSON.stringify([start, new Date(at).toISOString(), still, Date.now() > at, typeof Date(), new Date(0).getTime(), new Date() instanceof Date]))
  `], { encoding: 'utf8' })
  const [start, ...rest] = JSON.parse(out)
  // Until a driver stands it somewhere, the clock runs from its epoch at process start.
  assert.match(start, /^2026-01-01T09:00:0\d\.\d{3}Z$/u)
  assert.deepEqual(rest, ['2026-01-01T09:01:30.000Z', true, true, 'string', 0, true])
})
