import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createScreen } from '../scenarios/screen.mjs'
import { captureSplitTerminal, settleSplitScreen, splitStartupReadiness } from '../scenarios/split-terminal.mjs'

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
  assert.deepEqual(splitStartupReadiness(), conversation)
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
  await settleSplitScreen({ ...state, ready: splitStartupReadiness() })
  assert.equal(earlyEditorStable, true)
  assert.equal(bannerOnlyStable, true)
  assert.ok(state.now() >= 1060)
  assert.ok(state.now() < 1100)
})

test('a native model alone cannot admit the still hidden startup banner', async t => {
  const state = fixture(t)
  state.screen.feed(editor + footer)
  state.tick(time => { if (time === 600) state.screen.feed(banner) })
  await settleSplitScreen({ ...state, ready: splitStartupReadiness() })
  assert.ok(state.now() >= 860)
})

test('the common startup barrier admits the wordmark and model in both narrow and regular splash layouts', async t => {
  for (const cols of [40, 80]) {
    const state = fixture(t, cols, 16)
    state.screen.feed(banner)
    state.tick(time => { if (time === 600) state.screen.feed('\u001b[16;1Hdeepseek-official/deepseek-flash') })
    await settleSplitScreen({ ...state, ready: splitStartupReadiness() })
    assert.ok(state.now() >= 860)
    assert.deepEqual(state.screen.wrappedRows(), [])
  }
})

test('readiness must be present in the same final visible frame, not in earlier terminal output', async t => {
  const state = fixture(t)
  state.screen.feed(banner)
  state.tick(time => {
    if (time === 200) state.screen.feed('\u001b[2J' + footer)
    if (time === 800) state.screen.feed(banner)
  })
  await settleSplitScreen({ ...state, ready: splitStartupReadiness() })
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
  await settleSplitScreen({ ...state, ready: splitStartupReadiness() })
  assert.equal(state.now(), 900)
})

test('a missing native ready marker fails at the 30 second deadline instead of capturing a partial startup', async t => {
  const state = fixture(t)
  state.screen.feed(editor + banner)
  await assert.rejects(settleSplitScreen({ ...state, ready: splitStartupReadiness(), timeoutMs: 30_000 }), /startup did not become ready within 30000ms; missing visible text: deepseek-official\/deepseek-flash/u)
  assert.equal(state.now(), 30_000)
})

test('native process exit or an unsettled frame remains a failure after ready text', async t => {
  const state = fixture(t)
  state.screen.feed(banner + footer)
  state.screen.state.openSync = 1
  await assert.rejects(settleSplitScreen({ ...state, ready: splitStartupReadiness(), timeoutMs: 400 }), /Terminal did not settle/u)
  await assert.rejects(settleSplitScreen({ ...state, check: () => { throw new Error('Host exited') } }), /Host exited/u)
})

test('the real PTY sends the second Ctrl+C inside the confirmation window then waits for its actual drain', { timeout: 10_000 }, async t => {
  const dir = join(tmpdir(), `mayfly-terminal-test-${randomUUID()}`)
  mkdirSync(dir)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const record = join(dir, 'ctrl-c.json')
  const result = await captureSplitTerminal({
    bin: process.execPath,
    args: ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs'
      let presses = 0
      let first
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdout.write('\\u001b[?2026h\\u001b[2J\\u001b[Hdriver ready\\u001b[?2026l')
      process.stdin.on('data', data => {
        for (const byte of data) {
          if (byte !== 3) continue
          presses += 1
          if (presses === 1) {
            first = performance.now()
            process.stdout.write('\\r\\nPress Ctrl+C again to exit')
          } else if (presses === 2) {
            const elapsed = performance.now() - first
            writeFileSync(process.env.MAYFLY_TEST_CTRL_C_RECORD, JSON.stringify({ presses, elapsed }))
            if (elapsed > 900) process.exit(71)
            // As in the real runtime, the input handler is gone while terminal drain continues.
            process.stdin.setRawMode(false)
            process.stdin.pause()
            setTimeout(() => process.exit(0), 800)
          } else process.exit(72)
        }
      })
    `],
    cwd: dir,
    env: { ...process.env, MAYFLY_TEST_CTRL_C_RECORD: record },
    cols: 80, rows: 24,
    steps: [{ step: 'until', text: 'driver ready' }, { step: 'checkpoint', name: 'ready' }],
    stub: { inFlight: () => 0 },
  })
  assert.deepEqual(result.failures, [])
  assert.equal(result.exitCode, 0)
  const observed = JSON.parse(readFileSync(record, 'utf8'))
  assert.equal(observed.presses, 2)
  assert.ok(observed.elapsed >= 250 && observed.elapsed < 900)
})
