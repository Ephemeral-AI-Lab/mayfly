/**
 * Run a catalog scenario against the real product: a `dsh` under node-pty with the replay driver, the scenario clock,
 * reduced motion, and the stub model, its bytes parsed by the scenario screen. The runner drives the driver over a
 * control socket (play to a mark, stop at a prompt), sends keys and SGR mouse reports, resizes, and captures named
 * checkpoints as cell grids after the screen settles. Every run also checks what no scenario may do: wrap a row,
 * write the overflow or crash log, fail a driver action, or refuse a clean exit. @module script/scenarios/runner
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureThrowawayProfile } from '../workbench/profile.mjs'
import { scenarioNamed } from './catalog.mjs'
import { openBrowserTerminal } from './browser.mjs'
import { click as clickReport, keyBytes, mouseReport } from './input.mjs'
import { processCpuMs, processMemoryKb, spanMetrics } from './metrics.mjs'
import { createScreen } from './screen.mjs'
import { WORKSPACE, prepareSession } from './session.mjs'

const require = createRequire(import.meta.url)
const CLOCK = fileURLToPath(new URL('./clock.mjs', import.meta.url))

/**
 * The settings every scenario runs with, by composition row: no motion between frames and no network check at boot,
 * and a banner version that stays the same across releases (the Website's app shots paint the released one).
 */
export const RUNNER_CONFIG = Object.freeze({
  'mayfly': Object.freeze({ reducedMotion: true, updateCheck: false }),
  'mayfly-banner': Object.freeze({ displayVersion: 'scenario' }),
})
/** Rows the scenario overlay disables: a generated session title would land at a different moment on every run. */
export const RUNNER_DISABLED = Object.freeze(['session-title-llm'])

/**
 * Mask what differs between machines and runs without changing a row's width: the workspace tag, the session ids the
 * product mints (UUIDs), and the per-process token of command ids (`cmd-<token>-<n>`).
 * @param {string} grid - a serialized grid.
 */
export function maskGrid(grid) {
  return grid
    .replace(WORKSPACE, match => match.replace(/[0-9a-f]{8}$/u, 'xxxxxxxx'))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
    .replace(/\bcmd-[0-9a-f]{8}-/gu, 'cmd-xxxxxxxx-')
    // A session id the terminal cuts at the right edge keeps only its head.
    .replace(/session-[0-9a-f]{8}-[0-9a-f-]*/gu, 'session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
}

/** The runner's end of the control socket: JSON lines, one connection (the driver). */
async function listenControl(path) {
  rmSync(path, { force: true })
  const messages = []
  const waiting = []
  let socket
  const server = createServer((connection) => {
    socket = connection
    let buffer = ''
    connection.setEncoding('utf8')
    connection.on('data', (data) => {
      buffer += data
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        const waiter = waiting.shift()
        if (waiter === undefined) messages.push(message)
        else waiter(message)
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  return {
    send: message => socket.write(`${JSON.stringify(message)}\n`),
    next: async (timeoutMs, what) => {
      if (messages.length > 0) return messages.shift()
      let timer
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs) })
      try { return await Promise.race([new Promise(done => waiting.push(done)), timeout]) } finally { clearTimeout(timer) }
    },
    close: () => new Promise(resolve => { socket?.destroy(); server.close(() => resolve()); rmSync(path, { force: true }) }),
  }
}

const sizeOf = path => existsSync(path) ? statSync(path).size : 0

/**
 * One boot at a time: `dsh` rewrites the profile's composition file as it starts, and a second boot reading it then
 * fails. A run holds the turn from its spawn until its driver reports ready; playback still overlaps.
 */
let bootTurn = Promise.resolve()
function takeBootTurn() {
  let release
  const previous = bootTurn
  bootTurn = new Promise(resolve => { release = resolve })
  return previous.then(() => release)
}

/**
 * Link and install the throwaway profiles the scenarios need. The install blocks the event loop, so callers that run
 * scenarios side by side prepare the profiles first.
 * @param {{ root: string, dshBin: string, names: readonly string[] }} options
 */
export function prepareProfiles({ root, dshBin, names }) {
  for (const gallery of new Set(names.map(name => scenarioNamed(name)?.source.gallery === true))) {
    ensureThrowawayProfile({ repo: root, gallery, dshBin, artifacts: join(root, '.artifacts/bench') })
  }
}

/**
 * Run a scenario.
 * @param {string} name - a catalog scenario.
 * @param {object} options
 * @param {string} options.root - the checkout whose build the profile links.
 * @param {string} options.dshBin - the dsh executable.
 * @param {number} [options.cols] - columns (default: the scenario's first size).
 * @param {number} [options.rows] - rows.
 * @param {string[]} [options.keys] - key names sent after the script, captured as the checkpoint `keys`.
 * @param {(name: string, screen: ReturnType<typeof createScreen>) => Promise<void> | void} [options.onCheckpoint] - awaited
 *   at each checkpoint with the settled screen (to paint it).
 * @param {Record<string, string>} [options.env] - more environment for the product (`NO_COLOR`, a locale).
 * @param {string} [options.profileDir] - write a CPU profile of the product here (`--cpu-prof`).
 * @param {'headless' | 'browser'} [options.backend] - `browser` renders the product in xterm.js in headless Chrome too:
 *   keys and the mouse go through the browser, the page answers the terminal's queries, and each checkpoint also
 *   captures a PNG (`png` on the checkpoint, and the third argument of `onCheckpoint`). The grid still comes from the
 *   headless screen fed the same bytes.
 * @returns {Promise<{ name: string, cols: number, rows: number, checkpoints: { name: string, grid: string }[], failures: string[],
 *   frames: number, bootMs: number, durationMs: number, screen: ReturnType<typeof createScreen> }>} the screen is disposed by the caller.
 */
export async function runScenario(name, { root, dshBin, cols, rows, keys = [], onCheckpoint, env: extraEnv = {}, profileDir, backend = 'headless' }) {
  const scenario = scenarioNamed(name)
  if (scenario === undefined) throw new Error(`unknown scenario "${name}"`)
  const [width, height] = [cols ?? scenario.sizes[0][0], rows ?? scenario.sizes[0][1]]
  const started = performance.now()
  const profile = ensureThrowawayProfile({ repo: root, gallery: scenario.source.gallery === true, dshBin, artifacts: join(root, '.artifacts/bench') })
  const socketPath = `/tmp/mayfly-replay-${randomBytes(6).toString('hex')}.sock`
  const control = await listenControl(socketPath)
  const session = await prepareSession({ scenario, dir: join(root, '.artifacts/scenarios', `${name}-${String(width)}x${String(height)}`), control: socketPath, config: RUNNER_CONFIG, disabled: RUNNER_DISABLED, isolate: true, dshHome: profile.dshHome })
  const logs = ['mayfly-overflow.log', 'pi-crash.log'].map(file => join(profile.env.PI_CODING_AGENT_DIR, file))
  const logSizes = logs.map(sizeOf)
  const env = { ...profile.env, ...session.env, TZ: 'UTC', NODE_OPTIONS: `--import=${pathToFileURL(CLOCK).href}${profileDir === undefined ? '' : ` --cpu-prof --cpu-prof-dir=${profileDir}`}`, ...extraEnv }
  // The page is ready before the product starts: its first bytes are the terminal queries the page answers.
  let pty
  const browser = backend === 'browser' ? await openBrowserTerminal({ cols: width, rows: height, write: data => pty?.write(data) }) : undefined
  const releaseBoot = await takeBootTurn()
  pty = require('node-pty').spawn(dshBin, ['--profile', 'bench', '--patch', session.patch], { name: 'xterm-256color', cols: width, rows: height, cwd: session.cwd, env })
  // With a browser, xterm.js answers the queries; the headless screen only reads.
  const screen = createScreen({ cols: width, rows: height, reply: data => { if (browser === undefined) pty.write(data) } })
  let exitCode = null
  const exited = new Promise(resolve => pty.onExit(({ exitCode: code }) => { exitCode = code; resolve(code) }))
  // The last bytes the product wrote, for a failure report.
  let tail = ''
  pty.onData((data) => { screen.feed(data); browser?.feed(data); tail = (tail + data).slice(-6000) })

  const failures = []
  const checkpoints = []
  const metrics = []
  let driver = 'booting'
  let bootMs = 0
  let syncs = 0
  const pending = []

  /**
   * Wait until nothing changes: the screen's content (text, styles, cursor) stays the same for `quiet` ms with no frame
   * open and no stub request in flight. Content, not bytes: pi-tui writes an empty frame (a cursor move) on every
   * render it is asked for, which a running spinner asks for even under reduced motion.
   */
  async function settle(quiet = 150, timeoutMs = 20_000, tick = false) {
    const begin = performance.now()
    // The work the product queued before now runs first, then the screen must stand still.
    const id = ++syncs
    control.send({ type: 'sync', id, ...(tick ? { tick } : {}) })
    for (;;) {
      const message = await control.next(timeoutMs, 'the driver to sync')
      if (message.type === 'synced' && message.id === id) break
      if (message.type !== 'synced') pending.push(message)
    }
    let seen = -1
    let content
    let since = performance.now()
    for (;;) {
      if (screen.state.bytes !== seen) {
        seen = screen.state.bytes
        await screen.flush()
        const next = screen.serialize()
        if (next !== content) { content = next; since = performance.now() }
      }
      if (performance.now() - since >= quiet && screen.state.openSync === 0 && session.stub.inFlight() === 0) return
      if (performance.now() - begin > timeoutMs) throw new Error(`the screen did not settle in ${String(timeoutMs)} ms (open frames ${String(screen.state.openSync)}, stub requests ${String(session.stub.inFlight())})`)
      await sleep(10)
    }
  }
  /** The next driver report, tracking where playback stands; reports set aside while syncing come first. */
  async function report(timeoutMs, what) {
    const message = pending.shift() ?? await control.next(timeoutMs, what)
    if (message.type === 'mark') driver = 'paused'
    else if (message.type === 'ask') driver = 'asking'
    else if (message.type === 'finished') driver = 'finished'
    else if (message.type === 'ready') driver = 'paused'
    return message
  }
  const cellOf = (at) => {
    if (at === undefined) return { row: Math.floor(screen.terminal.rows / 2), col: Math.floor(screen.terminal.cols / 2) }
    if (at.text === undefined) return at
    const found = screen.find(at.text)
    if (found === undefined) throw new Error(`no visible "${at.text}" to point at`)
    return found
  }
  const mouseOn = () => { if (screen.state.mouse === 'none' || !screen.state.sgr) throw new Error('mouse reporting is off: the product would not see this event') }
  const mouse = (bytes) => { mouseOn(); pty.write(bytes) }
  /** A key or text, through the browser when there is one. */
  const press = async (keyName) => { if (browser === undefined) pty.write(keyBytes(keyName)); else await browser.key(keyName) }
  const capture = async (checkpointName, tick = false) => {
    await settle(150, 20_000, tick || scenario.tick === true)
    const wrapped = screen.wrappedRows()
    if (wrapped.length > 0) failures.push(`${checkpointName}: rows ${wrapped.join(', ')} are wider than the terminal`)
    const png = browser === undefined ? undefined : await browser.screenshot()
    checkpoints.push({ name: checkpointName, grid: maskGrid(screen.serialize()), ...(png === undefined ? {} : { png }) })
    await onCheckpoint?.(checkpointName, screen, png)
  }

  /** One timed input: written, then timed to the end of the next frame, then left until the bytes stop for 25 ms. */
  async function timedInput(bytes, samples) {
    const frames = screen.state.frames.length
    const at = performance.now()
    pty.write(bytes)
    await timedFrame(frames, at, samples)
  }
  /** One timed resize: applied, then timed to the end of the next frame like a key. */
  async function timedResize(cols, rows, samples) {
    const frames = screen.state.frames.length
    const at = performance.now()
    pty.resize(cols, rows)
    screen.resize(cols, rows)
    await timedFrame(frames, at, samples)
  }
  async function timedFrame(frames, at, samples) {
    while (screen.state.frames.length === frames && performance.now() - at < 3000) await sleep(1)
    const frame = screen.state.frames[frames]
    if (frame !== undefined) samples.push(frame.at - at)
    while (performance.now() - screen.state.lastData < 25 && performance.now() - at < 3000) await sleep(1)
  }
  /** Run the steps of a perf span, with nothing waiting on the driver. */
  async function span(spanName, steps) {
    if (browser !== undefined) throw new Error('perf spans measure the product alone: run them without the browser')
    await settle()
    const samples = []
    const [cpu0, frames0, bytes0, begin] = [processCpuMs(pty.pid), screen.state.frames.length, screen.state.bytes, performance.now()]
    for (const step of steps) {
      if (step.step === 'key') for (let count = 0; count < step.repeat; count += 1) await timedInput(keyBytes(step.name), samples)
      else if (step.step === 'type') for (const char of step.text) await timedInput(char, samples)
      else if (step.step === 'wheel') {
        const cell = cellOf(step.at)
        if (screen.state.mouse === 'none' || !screen.state.sgr) throw new Error('mouse reporting is off: the product would not see this event')
        for (let count = 0; count < step.count; count += 1) await timedInput(mouseReport({ type: 'wheel', direction: step.direction, ...cell }), samples)
      } else if (step.step === 'play') {
        if (driver === 'paused') { control.send({ type: 'play', until: step.until ?? null, timed: step.timed === true }); driver = 'running' }
        if (driver !== 'finished') await report(300_000, 'the replay to play')
      } else if (step.step === 'resize') await timedResize(step.cols, step.rows, samples)
      else if (step.step === 'wait') await sleep(step.ms)
      else throw new Error(`a perf span cannot hold the step ${String(step.step)}`)
    }
    const cpu1 = processCpuMs(pty.pid)
    metrics.push(spanMetrics({
      name: spanName, wallMs: performance.now() - begin, cpuMs: cpu0 === null || cpu1 === null ? null : cpu1 - cpu0,
      frames: screen.state.frames.length - frames0, bytes: screen.state.bytes - bytes0, keys: samples, memory: processMemoryKb(pty.pid),
    }))
  }

  try {
    try { await report(90_000, 'the replay driver') } finally { releaseBoot() }
    bootMs = Math.round(performance.now() - started)
    await settle()
    for (const step of scenario.script) {
      switch (step.step) {
        case 'play':
          if (driver === 'paused') { control.send({ type: 'play', until: step.until ?? null }); driver = 'running' }
          if (driver !== 'finished') await report(120_000, step.until === undefined ? 'the end of the replay' : `the mark ${step.until}`)
          await settle()
          break
        case 'checkpoint': await capture(step.name, step.tick === true); break
        case 'key':
          for (let count = 0; count < step.repeat; count += 1) { await press(step.name); await settle(80) }
          break
        case 'type':
          for (const char of step.text) { await press(char); await settle(40) }
          break
        case 'paste': pty.write(`\u001b[200~${step.text}\u001b[201~`); await settle(); break
        case 'click': {
          const cell = cellOf(step.at)
          if (browser === undefined) mouse(clickReport(cell.row, cell.col))
          else { mouseOn(); await browser.click(cell.row, cell.col) }
          await settle()
          break
        }
        case 'wheel': {
          const cell = cellOf(step.at)
          for (let count = 0; count < step.count; count += 1) {
            if (browser === undefined) mouse(mouseReport({ type: 'wheel', direction: step.direction, ...cell }))
            else { mouseOn(); await browser.wheel(cell.row, cell.col, step.direction) }
          }
          await settle()
          break
        }
        case 'resize': pty.resize(step.cols, step.rows); screen.resize(step.cols, step.rows); await browser?.resize(step.cols, step.rows); await settle(); break
        case 'wait': await sleep(step.ms); await settle(); break
        case 'until': {
          const begin = performance.now()
          for (;;) {
            await screen.flush()
            if (screen.find(step.text) !== undefined) break
            if (performance.now() - begin > 20_000) throw new Error(`"${step.text}" did not appear in 20 s`)
            await sleep(25)
          }
          await settle()
          break
        }
        case 'idle': await span('idle', [{ step: 'wait', ms: step.ms }]); break
        case 'measure': await span(step.name, step.steps); break
        default: throw new Error(`unknown step ${String(step.step)}`)
      }
    }
    if (keys.length > 0) {
      for (const keyName of keys) { await press(keyName); await settle(80) }
      await capture('keys')
    }
  } catch (error) {
    const text = tail.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '').replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '').replace(/\r/gu, '').split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-12).join('\n')
    failures.push(`${String(error.message ?? error)}${text === '' ? '' : `\n--- the product's last output ---\n${text}`}`)
  }

  // The invariants of every run, then a clean exit.
  const driverLog = existsSync(session.log) ? readFileSync(session.log, 'utf8') : ''
  for (const line of driverLog.split('\n')) if (/action failed|replay failed/u.test(line)) failures.push(`driver: ${line.slice(25, 400)}`)
  logs.forEach((file, index) => { if (sizeOf(file) > logSizes[index]) failures.push(`${file.split('/').at(-1)} was written`) })
  // Esc closes what is open; Ctrl+C interrupts a running turn first, so it is pressed until the product exits.
  pty.write('\u001b')
  await sleep(150)
  let code
  for (let press = 0; press < 5 && code === undefined; press += 1) {
    pty.write('\u0003')
    code = await Promise.race([exited, sleep(press < 4 ? 400 : 6000).then(() => undefined)])
  }
  if (code === undefined) { failures.push('the product did not exit on Ctrl+C'); pty.kill() } else if (exitCode !== 0) failures.push(`the product exited with ${String(exitCode)}`)
  await control.close()
  await session.close()
  await browser?.close()
  return { name, cols: width, rows: height, checkpoints, metrics, failures, frames: screen.state.frames.length, bootMs, durationMs: Math.round(performance.now() - started), screen }
}
