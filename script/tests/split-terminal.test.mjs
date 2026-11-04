import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createScreen } from '../scenarios/screen.mjs'
import { SPLIT_REFERENCE } from '../scenarios/split-reference.mjs'
import { captureSplitTerminal, exitSplitTerminal, settleSplitScreen, splitStartupReadiness } from '../scenarios/split-terminal.mjs'

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
  const conversation = [{ text: 'mayfly v0.1.4-rc.2' }, { text: 'deepseek-flash' }]
  assert.deepEqual(splitStartupReadiness(SPLIT_REFERENCE.version), conversation)
})

test('a candidate release settles against its own banner while the reference remains fixed', async t => {
  const state = fixture(t)
  const candidateVersion = '0.1.5'
  assert.notEqual(candidateVersion, SPLIT_REFERENCE.version)
  state.screen.feed(`\u001b[2;1Hmayfly v${candidateVersion}${footer}${editor}`)
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(candidateVersion) })
  await assert.rejects(settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version), timeoutMs: 400 }), /missing visible text: mayfly v0\.1\.4-rc\.2/u)
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
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version) })
  assert.equal(earlyEditorStable, true)
  assert.equal(bannerOnlyStable, true)
  assert.ok(state.now() >= 1060)
  assert.ok(state.now() < 1100)
})

test('a native model alone cannot admit the still hidden startup banner', async t => {
  const state = fixture(t)
  state.screen.feed(editor + footer)
  state.tick(time => { if (time === 600) state.screen.feed(banner) })
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version) })
  assert.ok(state.now() >= 860)
})

test('the startup barrier accepts the real abbreviated model footer at 40 columns and with a long 80-column workspace', async t => {
  for (const cols of [40, 80]) {
    const state = fixture(t, cols, 16)
    state.screen.feed(banner)
    state.tick(time => { if (time === 600) state.screen.feed('\u001b[16;1Hdeepseek-flash  ~/workspace') })
    await settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version) })
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
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version) })
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
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version) })
  assert.equal(state.now(), 900)
})

test('a missing native ready marker fails at the 30 second deadline instead of capturing a partial startup', async t => {
  const state = fixture(t)
  state.screen.feed(editor + banner)
  await assert.rejects(settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version), timeoutMs: 30_000 }), /startup did not become ready within 30000ms; missing visible text: deepseek-flash/u)
  assert.equal(state.now(), 30_000)
})

test('native process exit or an unsettled frame remains a failure after ready text', async t => {
  const state = fixture(t)
  state.screen.feed(banner + footer)
  state.screen.state.openSync = 1
  await assert.rejects(settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version), timeoutMs: 400 }), /Terminal did not settle/u)
  await assert.rejects(settleSplitScreen({ ...state, check: () => { throw new Error('Host exited') } }), /Host exited/u)
})

test('the real long-workspace frame needs native model facts while the responsive footer sheds the entire model', async t => {
  const actual = JSON.parse(readFileSync(new URL('./fixtures/split-native-startup-long-workspace.json', import.meta.url), 'utf8'))
  const state = fixture(t, actual.cols, actual.rows)
  assert.equal(actual.lines.at(-1).includes('deepseek-flash'), false)
  assert.ok(actual.lines.some(line => line.includes('deepseek-flash · deepseek-official')))
  const paint = lines => state.screen.feed('\u001b[2J\u001b[H' + lines.map((line, row) => `\u001b[${row + 1};1H${line}`).join(''))
  // Before native attach, the banner's model/provider facts are both default.
  paint(actual.lines.map(line => line.replace('deepseek-flash · deepseek-official', 'default · default')))
  await assert.rejects(settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version), timeoutMs: 400 }), /deepseek-flash/u)
  state.tick(time => { if (time === 800) paint(actual.lines) })
  await settleSplitScreen({ ...state, ready: splitStartupReadiness(SPLIT_REFERENCE.version) })
  assert.ok(state.now() >= 1060)
  assert.equal(state.screen.grid().lines.at(-1), actual.lines.at(-1))
})

async function realExitFixture(t, options) {
  const dir = join(tmpdir(), `mayfly-terminal-test-${randomUUID()}`)
  mkdirSync(dir)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const record = join(dir, 'ctrl-c.json')
  const result = await captureSplitTerminal({
    bin: process.execPath,
    args: ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs'
      const options = JSON.parse(process.env.MAYFLY_TEST_EXIT_OPTIONS)
      const events = []
      let consumed = false
      let handling = false
      let armed
      const record = (kind, extra = {}) => {
        events.push({ kind, at: performance.now(), ...extra })
        writeFileSync(process.env.MAYFLY_TEST_CTRL_C_RECORD, JSON.stringify(events))
      }
      const paint = text => process.stdout.write('\\u001b[?2026h\\u001b[2;1H\\u001b[2K' + text + '\\u001b[?2026l')
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdout.write('\\u001b[?25l\\u001b[?1000h\\u001b[?2026h\\u001b[2J\\u001b[Hdriver ready\\u001b[?2026l')
      process.stdin.on('data', data => {
        for (const byte of data) {
          if (byte !== 3) continue
          record('received')
          if (handling) { record('unacknowledged-input'); process.exit(73) }
          if (options.consume && !consumed) {
            consumed = true
            handling = true
            setTimeout(() => {
              record(options.consume)
              paint(options.consume)
              handling = false
            }, options.firstDelay ?? 0)
          } else if (armed === undefined || performance.now() - armed >= 1000) {
            armed = performance.now()
            handling = true
            setTimeout(() => {
              record('warning')
              paint('press Ctrl+C again to exit')
              handling = false
            }, options.ackDelay ?? 0)
          } else {
            record('confirmed', { elapsed: performance.now() - armed })
            // The real input handler may be gone for much longer than one
            // confirmation window while the process restores and drains.
            process.stdin.setRawMode(false)
            process.stdin.pause()
            process.stdout.write('\\u001b[?2026h\\u001b[2J\\u001b[?1000l\\u001b[?25h\\u001b[?2026l')
            setTimeout(() => {
              record('drained')
              if (options.signal) process.kill(process.pid, 'SIGTERM')
              else process.exit(0)
            }, options.drain ?? 800)
          }
        }
      })
    `],
    cwd: dir,
    env: { ...process.env, MAYFLY_TEST_CTRL_C_RECORD: record, MAYFLY_TEST_EXIT_OPTIONS: JSON.stringify(options) },
    cols: 80, rows: 24,
    steps: [{ step: 'until', text: 'driver ready' }, { step: 'checkpoint', name: 'ready' }],
    stub: { inFlight: () => 0 },
  })
  return { result, events: JSON.parse(readFileSync(record, 'utf8')) }
}

for (const options of [
  { label: 'clearDraft before arming, with delayed first processing', consume: 'draft cleared', firstDelay: 600 },
  { label: 'cancel before arming, with a late warning acknowledgment', consume: 'turn cancelled', ackDelay: 600 },
  { label: 'late warning acknowledgment inside the real double-press window', ackDelay: 600 },
  { label: 'a slow terminal drain beyond the old five-second retry', drain: 6000 },
]) {
  test(`the real PTY handles ${options.label}`, { timeout: 15_000 }, async t => {
    const { result, events } = await realExitFixture(t, options)
    assert.deepEqual(result.failures, [])
    assert.equal(result.exitCode, 0)
    assert.equal(events.filter(event => event.kind === 'received').length, options.consume ? 3 : 2)
    assert.equal(events.some(event => event.kind === 'unacknowledged-input'), false)
    assert.equal(events.at(-1).kind, 'drained')
    const confirmation = events.find(event => event.kind === 'confirmed')
    const warning = events.find(event => event.kind === 'warning')
    assert.ok(confirmation.at >= warning.at)
    assert.ok(confirmation.elapsed < 1000)
  })
}

test('a real nonzero PTY termination remains a failure after acknowledged confirmation', { timeout: 10_000 }, async t => {
  const { result } = await realExitFixture(t, { signal: true, drain: 20 })
  assert.match(result.failures.join('\n'), /Product exit was not clean.*signal=15/u)
})

test('a disappeared warning can start a fresh pair only in a still interactive UI, within a bounded deadline', async t => {
  const state = fixture(t)
  state.screen.feed('\u001b[?25l\u001b[?1000h\u001b[?2026hdriver ready\u001b[?2026l')
  const writes = []
  let exited = false
  const terminal = { write: bytes => {
    assert.equal(bytes, '\u0003')
    writes.push(state.now())
    if (writes.length === 1 || writes.length === 3) state.screen.feed('\u001b[?2026h\u001b[2;1Hpress Ctrl+C again to exit\u001b[?2026l')
    if (writes.length === 2) state.screen.feed('\u001b[?2026h\u001b[2;1H\u001b[2Kdriver ready again\u001b[?2026l')
    if (writes.length === 4) exited = true
  } }
  assert.equal((await exitSplitTerminal({ ...state, terminal, isExited: () => exited })).exited, true)
  assert.equal(writes.length, 4)
  assert.ok(writes[2] - writes[1] >= 5000)
  assert.ok(writes[1] - writes[0] < 1000)
  assert.ok(writes[3] - writes[2] < 1000)
})

test('a missing interrupt acknowledgment does not queue extra signals before its bounded retry interval', async t => {
  const state = fixture(t)
  state.screen.feed('\u001b[?25l\u001b[?1000h\u001b[?2026hdriver ready\u001b[?2026l')
  const writes = []
  const result = await exitSplitTerminal({ ...state, terminal: { write: bytes => writes.push(bytes) }, isExited: () => false, timeoutMs: 1000 })
  assert.equal(result.exited, false)
  assert.equal(result.failure.code, 'warning-not-observed')
  assert.equal(state.now(), 1000)
  assert.deepEqual(writes, ['\u0003'])
})

test('a lost first interrupt with no new frame gets one bounded retry and completes the normal confirmation', async t => {
  const state = fixture(t)
  state.screen.feed('\u001b[?25l\u001b[?1000h\u001b[?2026hdriver ready\u001b[?2026l')
  const writes = []
  let exited = false
  const terminal = { write: bytes => {
    assert.equal(bytes, '\u0003')
    writes.push(state.now())
    if (writes.length === 2) state.screen.feed('\u001b[?2026h\u001b[2;1Hpress Ctrl+C again to exit\u001b[?2026l')
    if (writes.length === 3) {
      state.screen.feed('\u001b[?1000l\u001b[?25h')
      exited = true
    }
  } }
  const result = await exitSplitTerminal({ ...state, terminal, isExited: () => exited })
  assert.equal(result.exited, true)
  assert.equal(result.failure, undefined)
  assert.equal(writes.length, 3)
  assert.ok(writes[1] - writes[0] >= 2000)
  assert.ok(writes[2] - writes[1] < 1000)
  assert.equal(result.interrupts[1].reason, 'unacknowledged-retry')
  assert.equal(result.terminal.cursorVisible, true)
})

test('a terminal that never paints or acknowledges exits the driver after one retry with useful diagnostics', async t => {
  const state = fixture(t)
  state.screen.feed('\u001b[?25l\u001b[?1000h\u001b[?2026hdriver ready\u001b[?2026l')
  const writes = []
  const result = await exitSplitTerminal({ ...state, terminal: { write: bytes => writes.push(bytes) }, isExited: () => false })
  assert.equal(result.exited, false)
  assert.equal(result.failure.code, 'warning-not-observed')
  assert.equal(state.now(), 4000)
  assert.deepEqual(writes, ['\u0003', '\u0003'])
  assert.equal(result.interrupts.length, 2)
  assert.equal(result.terminal.frames, 1)
  assert.equal(result.terminal.openSync, 0)
  assert.equal(result.terminal.mouse, 'vt200')
})

test('an acknowledged confirmation that never exits is distinguished from a missing first warning', async t => {
  const state = fixture(t)
  state.screen.feed('\u001b[?25l\u001b[?1000h\u001b[?2026hdriver ready\u001b[?2026l')
  const writes = []
  const terminal = { write: bytes => {
    writes.push(bytes)
    if (writes.length === 1) state.screen.feed('\u001b[?2026h\u001b[2;1Hpress Ctrl+C again to exit\u001b[?2026l')
  } }
  const result = await exitSplitTerminal({ ...state, terminal, isExited: () => false, timeoutMs: 6000 })
  assert.equal(result.exited, false)
  assert.equal(result.failure.code, 'confirmation-not-exited')
  assert.equal(state.now(), 6000)
  assert.equal(writes.length, 2)
  assert.equal(result.interrupts.at(-1).reason, 'confirm-warning')
})

test('repeated acknowledged cancellation paints have a fixed interrupt budget', async t => {
  const state = fixture(t)
  state.screen.feed('\u001b[?25l\u001b[?1000h\u001b[?2026hdriver ready\u001b[?2026l')
  let count = 0
  const terminal = { write: () => {
    count += 1
    state.screen.feed(`\u001b[?2026h\u001b[2;1Hcancelled ${count}\u001b[?2026l`)
  } }
  const result = await exitSplitTerminal({ ...state, terminal, isExited: () => false })
  assert.equal(result.exited, false)
  assert.equal(result.failure.code, 'warning-not-observed')
  assert.equal(count, 6)
  assert.ok(state.now() < 30_000)
})

test('an unfinished synchronized paint prevents a blind missing-ack retry', async t => {
  const state = fixture(t)
  state.screen.feed('\u001b[?25l\u001b[?1000h\u001b[?2026hdriver ready\u001b[?2026l')
  let count = 0
  const terminal = { write: () => {
    count += 1
    state.screen.feed('\u001b[?2026h')
  } }
  const result = await exitSplitTerminal({ ...state, terminal, isExited: () => false })
  assert.equal(result.exited, false)
  assert.equal(result.failure.code, 'warning-not-observed')
  assert.equal(result.terminal.openSync, 1)
  assert.equal(count, 1)
})

test('normal two-interrupt exit preserves terminal restoration checks and diagnoses each unrecovered mode', async t => {
  for (const mode of ['none', 'cursor', 'mouse', 'sgr']) {
    const state = fixture(t)
    state.screen.feed('\u001b[?25l\u001b[?1000h\u001b[?1006h\u001b[?2026hdriver ready\u001b[?2026l')
    let count = 0
    let exited = false
    const terminal = { write: () => {
      count += 1
      if (count === 1) state.screen.feed('\u001b[?2026h\u001b[2;1Hpress Ctrl+C again to exit\u001b[?2026l')
      else {
        state.screen.feed('\u001b[?1000l\u001b[?1006l\u001b[?25h')
        if (mode === 'cursor') state.screen.feed('\u001b[?25l')
        if (mode === 'mouse') state.screen.feed('\u001b[?1000h')
        if (mode === 'sgr') state.screen.feed('\u001b[?1006h')
        exited = true
      }
    } }
    const result = await exitSplitTerminal({ ...state, terminal, isExited: () => exited })
    assert.equal(result.exited, true)
    assert.equal(count, 2)
    assert.equal(result.failure?.code, mode === 'none' ? undefined : 'modes-not-restored')
  }
})
