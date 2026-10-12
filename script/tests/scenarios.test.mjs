import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../package-contract.mjs'
import { reviewProblems } from '../scenarios/brief.mjs'
import { APP_SHOTS, CATALOG } from '../scenarios/catalog.mjs'
import { goldenPath } from '../scenarios/golden.mjs'
import { parseGrid, serializeGrid, styleSgr } from '../scenarios/grid.mjs'
import { click, mouseReport } from '../scenarios/input.mjs'
import { timelineNamed } from '../scenarios/replays.mjs'
import { maskGrid } from '../scenarios/runner.mjs'
import { TERMINAL_COLORS, createScreen } from '../scenarios/screen.mjs'
import { compile, seed, step, turn } from '../scenarios/timeline.mjs'
import { withVersion } from '../shots/app.mjs'
import { existsSync } from 'node:fs'
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

test('a grid masks the workspace tag, minted ids, and command tokens without changing a row width', () => {
  const grid = '|Directory: /tmp/mayfly-scenario-1a2b3c4d\n| …/mayfly-scenario-9f8e7d6c  cache\n|Trace · session-a8539930-a85f-4f77-8e59-fae7095de23b\n|cmd-3f9a0c1e-2 done'
  assert.equal(maskGrid(grid), '|Directory: /tmp/mayfly-scenario-xxxxxxxx\n| …/mayfly-scenario-9f8e7d6c  cache\n|Trace · session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\n|cmd-xxxxxxxx-2 done')
})

test('every scenario has a known source, real sizes, its marks, and covers globs that name files', () => {
  const files = repositoryGraph(ROOT).files
  const matches = (glob) => {
    const pattern = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*')}${glob.endsWith('/') ? '' : '$'}`, 'u')
    return files.some(file => pattern.test(file))
  }
  for (const [name, scenario] of Object.entries(CATALOG)) {
    assert.ok(scenario.summary.length > 0, name)
    if (scenario.review !== undefined) {
      assert.deepEqual(reviewProblems(scenario.review), [], `${name}: review`)
      const checkpoints = new Set(scenario.script.filter(step => step.step === 'checkpoint').map(step => step.name))
      for (const { how } of scenario.review.focus) assert.ok([...checkpoints].some(point => how.includes(point)), `${name}: focus walk "${how}" names none of its checkpoints`)
    }
    assert.ok(scenario.sizes.length > 0 && scenario.sizes.every(([cols, rows]) => Number.isInteger(cols) && Number.isInteger(rows) && cols >= 20 && rows >= 10), name)
    for (const glob of scenario.covers) assert.ok(matches(glob), `${name}: ${glob} names no file`)
    if (scenario.source.replay !== undefined) {
      const replay = timelineNamed(scenario.source.replay)
      assert.ok(replay !== undefined, name)
      const marks = new Set(compile(replay.items, replay.options).filter(action => action.op === 'mark').map(action => action.name))
      for (const step of scenario.script) if (step.step === 'play' && step.until !== undefined) assert.ok(marks.has(step.until), `${name}: no mark ${step.until}`)
    }
    assert.ok(scenario.script.some(step => step.step === (scenario.perf === undefined ? 'checkpoint' : 'measure') || step.step === 'idle'), `${name} captures nothing`)
  }
})

test('the scenario clock holds its epoch until moved, stands at a timeline time, and runs again on flow', () => {
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
  // Until a driver moves it, the clock stands at its epoch: what the product writes at boot has the same time on every run.
  assert.equal(start, '2026-01-01T09:00:00.000Z')
  assert.deepEqual(rest, ['2026-01-01T09:01:30.000Z', true, true, 'string', 0, true])
})

test('a turn that names its start stands the clock there without making playback wait', () => {
  const actions = compile([
    turn('first', [step({ text: 'a', stream: false })], { startAt: '10:02' }),
    turn('second', [step({ text: 'b', stream: false })], { startAt: '10:09' }),
    turn('third', [step({ text: 'c', stream: false })]),
  ])
  const starts = actions.filter(action => action.type === 'turn/start')
  // The clock reads the named time at each start (the epoch is 09:00 UTC), and playback times stay a few seconds apart.
  assert.deepEqual(starts.map(action => action.at + action.skew), [62 * 60_000, 69 * 60_000, 69 * 60_000 + (starts[2].at - starts[1].at)])
  assert.ok(starts.at(-1).at < 30_000)
  assert.throws(() => compile([turn('x', [], { startAt: 'ten past' })]), /startAt must be/u)
})

test('every Website app shot is a checkpoint its scenario captures at its first size, with a golden', () => {
  assert.deepEqual(APP_SHOTS.map(shot => shot.id).sort(), ['app-agents', 'app-conversation', 'app-permission', 'app-session-workspace', 'app-sessions', 'app-trace'])
  for (const shot of APP_SHOTS) {
    const scenario = CATALOG[shot.scenario]
    assert.ok(scenario.script.some(step => step.step === 'checkpoint' && step.name === shot.checkpoint), shot.id)
    assert.deepEqual([shot.cols, shot.rows], scenario.sizes[0], shot.id)
    assert.ok(existsSync(goldenPath(shot.scenario, shot.checkpoint, shot.cols, shot.rows)), `${shot.id}: no golden`)
  }
})

test('a grid reads back as it was written, and its styles write back as SGR', () => {
  const text = 'grid 12x2 cursor 1,3\n|a 世界 b\n|\nstyles\n0: 0 fg:#9a86e6 b; 2-5 bg:p236 u r'
  const grid = parseGrid(text)
  assert.deepEqual(grid.styles[0], [{ from: 0, to: 0, style: 'fg:#9a86e6 b' }, { from: 2, to: 5, style: 'bg:p236 u r' }])
  assert.deepEqual(grid.cursor, [1, 3])
  assert.equal(serializeGrid(grid), text)
  assert.equal(styleSgr('fg:#9a86e6 bg:p236 b d i u s r h k o'), '\u001b[38;2;154;134;230;48;5;236;1;2;3;4;9;7;8;5;53m')
  assert.equal(styleSgr(''), '')
})

test('an app shot shows the released version where the scenario pinned its placeholder', () => {
  const grid = parseGrid('grid 40x1 cursor none\n|  Version:   scenario\nstyles\n0: 2-9 fg:#6c5bbf; 12-30 fg:#ededf2; 35 b')
  const shown = withVersion(grid, '0.1.3-rc.2')
  assert.equal(shown.lines[0], '  Version:   0.1.3-rc.2')
  assert.deepEqual(shown.styles[0], [{ from: 2, to: 9, style: 'fg:#6c5bbf' }, { from: 12, to: 30, style: 'fg:#ededf2' }, { from: 37, to: 37, style: 'b' }])
  assert.equal(withVersion(parseGrid('grid 4x1 cursor none\n|none\nstyles'), '1.0.0').lines[0], 'none')
})

test('a seeded session compiles to its own events at its own times, without streaming, then its title', () => {
  const [action] = compile([seed([{ id: 's1', at: -86_400_000, cwd: 'docs', parent: 's0', title: 'Earlier', items: [turn('q', [step({ text: 'a' })])] }])])
  assert.equal(action.op, 'seed')
  const [session] = action.sessions
  assert.deepEqual([session.id, session.createdAt, session.cwd, session.parent], ['s1', -86_400_000, 'docs', 's0'])
  assert.ok(session.events.every((event, index) => event.at < 0 && (index === 0 || event.at >= session.events[index - 1].at)))
  assert.deepEqual(session.events.at(-1), { at: session.events.at(-2).at + 100, type: 'session/title', data: { title: 'Earlier', messageSeqs: [], source: { kind: 'user' } } })
  assert.ok(session.events.some(event => event.type === 'assistant/message'))
  assert.throws(() => compile([seed([{ id: 's2', at: 0, items: [turn('q', [{ kind: 'job', label: 'j' }])] }])]), /holds turns only/u)
})
