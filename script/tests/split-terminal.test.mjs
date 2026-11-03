import assert from 'node:assert/strict'
import test from 'node:test'
import { createScreen } from '../scenarios/screen.mjs'
import { settleSplitScreen, splitStartupReadiness } from '../scenarios/split-terminal.mjs'

function fixture(t, cols = 80, rows = 24) {
  const screen = createScreen({ cols, rows, reply() {} })
  t.after(() => screen.dispose())
  let time = 0
  let pending = 0
  let tick = () => {}
  return {
    screen,
    now: () => time,
    stub: { inFlight: () => pending },
    check() {},
    pause: async ms => { time += ms; tick(time) },
    tick: next => { tick = next },
    pending: next => { pending = next },
  }
}

const banner = '\u001b[2;1Hmayfly v0.1.4-rc.2'
const footer = '\u001b[24;1Hdeepseek-official/deepseek-flash'
const editor = '\u001b[22;1HAsk anything'

test('the isolated native startup needs both the release banner and the configured default model', () => {
  const conversation = [['mayfly v0.1.4-rc.2'], ['deepseek-official/deepseek-flash']]
  assert.deepEqual(splitStartupReadiness(undefined), conversation)
  assert.deepEqual(splitStartupReadiness('conversation'), conversation)
  assert.deepEqual(splitStartupReadiness('splash'), [...conversation, ['No sessions here yet', 'Recent sessions']])
})

test('a stable early editor and banner do not admit semantic input before the native model arrives', async t => {
  const state = fixture(t)
  state.screen.feed(editor)
  let earlyEditorStable = false
  let bannerOnlyStable = false
  state.tick(time => {
    if (time === 300) earlyEditorStable = true
    if (time === 400) state.screen.feed(banner)
    if (time === 700) bannerOnlyStable = true
    if (time === 800) state.screen.feed(footer)
  })
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(undefined) })
  assert.equal(earlyEditorStable, true)
  assert.equal(bannerOnlyStable, true)
  assert.ok(state.now() >= 1060)
  assert.ok(state.now() < 1100)
})

test('a native model alone cannot admit the still hidden startup banner', async t => {
  const state = fixture(t)
  state.screen.feed(editor + footer)
  state.tick(time => { if (time === 600) state.screen.feed(banner) })
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(undefined) })
  assert.ok(state.now() >= 860)
})

test('splash additionally waits for the actual empty or recent native catalog at both supported initial widths', async t => {
  for (const cols of [40, 80]) {
    for (const text of ['No sessions here yet', 'Recent sessions']) {
      const state = fixture(t, cols, 16)
      state.screen.feed(banner + '\u001b[16;1Hdeepseek-official/deepseek-flash')
      state.tick(time => { if (time === 600) state.screen.feed(`\u001b[8;1H${text}`) })
      await settleSplitScreen({ ...state, ready: splitStartupReadiness('splash') })
      assert.ok(state.now() >= 860)
      assert.deepEqual(state.screen.wrappedRows(), [])
    }
  }
})

test('readiness must be present in the same final visible frame, not in earlier terminal output', async t => {
  const state = fixture(t)
  state.screen.feed(banner)
  state.tick(time => {
    if (time === 200) state.screen.feed('\u001b[2J' + footer)
    if (time === 800) state.screen.feed(banner)
  })
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(undefined) })
  assert.ok(state.now() >= 1060)
})

test('synchronized paints and native model work must drain after all ready text is visible', async t => {
  const state = fixture(t)
  state.screen.feed('\u001b[?2026h' + banner + footer)
  state.pending(1)
  state.tick(time => {
    if (time === 500) state.screen.feed('\u001b[?2026l')
    if (time === 900) state.pending(0)
  })
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(undefined) })
  assert.equal(state.now(), 900)
})

test('a missing native ready marker fails at the 30 second deadline instead of capturing a partial startup', async t => {
  const state = fixture(t)
  state.screen.feed(editor + banner)
  await assert.rejects(settleSplitScreen({ ...state, ready: splitStartupReadiness(undefined), timeoutMs: 30_000 }), /startup did not become ready within 30000ms; missing visible text: deepseek-official\/deepseek-flash/u)
  assert.equal(state.now(), 30_000)
})

test('native process exit or an unsettled frame remains a failure after ready text', async t => {
  const state = fixture(t)
  state.screen.feed(banner + footer)
  state.screen.state.openSync = 1
  await assert.rejects(settleSplitScreen({ ...state, ready: splitStartupReadiness(undefined), timeoutMs: 400 }), /Terminal did not settle/u)
  await assert.rejects(settleSplitScreen({ ...state, check: () => { throw new Error('Host exited') } }), /Host exited/u)
})
