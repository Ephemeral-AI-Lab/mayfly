/** Real HTTP/WebSocket Host plus an independently spawned Remote terminal. @module script/scenarios/split-runner */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { keyBytes } from './input.mjs'
import { createScreen } from './screen.mjs'
import { launchSplitHost } from './split-profile.mjs'
import { compareSplitReference, normalizeSplitGrid, redactSplitOutput, SPLIT_REFERENCE } from './split-reference.mjs'
import { startStubModel } from './stub-model.mjs'

const require = createRequire(import.meta.url)

/** Baseline and candidate must execute these same semantic steps and checkpoints. */
export const SPLIT_SMOKE_STEPS = Object.freeze([
  { step: 'checkpoint', name: 'startup' },
  { step: 'type', text: '/help' }, { step: 'key', name: 'enter' },
  { step: 'until', text: '/quit' }, { step: 'checkpoint', name: 'help' },
  { step: 'key', name: 'esc' },
  { step: 'type', text: '中文 draft 🪰' }, { step: 'checkpoint', name: 'unicode-draft' },
  { step: 'key', name: 'ctrl+u' },
  { step: 'type', text: 'Say one line about this isolated replay.' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'the model is a stub' }, { step: 'checkpoint', name: 'settled-turn' },
  { step: 'type', text: '/new' }, { step: 'key', name: 'enter' }, { step: 'checkpoint', name: 'new-session' },
])

/** No mocks or injected Remote state: every UI operation runs through the built product and its real transport. */
export async function runSplitScenario({ root, dshBin, artifacts, cols = 80, rows = 24, referenceDir, steps = SPLIT_SMOKE_STEPS }) {
  mkdirSync(artifacts, { recursive: true })
  const stub = await startStubModel()
  let host
  let terminal
  let screen
  let output = ''
  let exitCode
  let exitSignal
  let exited
  const checkpoints = []
  const failures = []
  const started = performance.now()
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  try {
    host = await launchSplitHost({ root, dshBin, artifacts, baseURL: stub.baseURL })
    const env = { ...host.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TZ: 'UTC', MAYFLY_DSH_STARTUP_URL: host.startupUrl, MAYFLY_CWD: host.cwd, NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'script/scenarios/clock.mjs')).href}` }
    for (const name of ['CI', 'COLUMNS', 'LINES', 'NO_COLOR', 'FORCE_COLOR', 'MAYFLY_SESSION_ID', 'MAYFLY_TASK']) delete env[name]
    terminal = require('node-pty').spawn(process.execPath, [join(root, 'packages/remote/lib/remote-bin.js')], { name: 'xterm-256color', cols, rows, cwd: host.cwd, env })
    screen = createScreen({ cols, rows, reply: data => terminal.write(data) })
    // Redact the complete stream before storing it so a token split across PTY chunks cannot escape.
    terminal.onData(data => { output += data; screen.feed(data) })
    exited = new Promise(resolve => terminal.onExit(event => { exitCode = event.exitCode; exitSignal = event.signal; resolve(event.exitCode) }))
    const alive = () => {
      if (exitCode !== undefined) throw new Error(`Remote exited early with ${exitCode}`)
      if (host.child.exitCode !== null || host.child.signalCode !== null) throw new Error('Host exited while Remote was attached')
    }
    const settle = async (timeoutMs = 20_000) => {
      let previous
      let since = performance.now()
      const begin = since
      do {
        alive()
        await screen.flush()
        const next = screen.serialize()
        if (next !== previous) { previous = next; since = performance.now() }
        if (screen.state.bytes > 0 && performance.now() - since >= 250 && screen.state.openSync === 0 && stub.inFlight() === 0) return
        await sleep(20)
      } while (performance.now() - begin < timeoutMs)
      throw new Error('Remote terminal did not settle')
    }
    // Wait for the actual terminal frame rather than a fixed startup sleep.
    const boot = performance.now()
    while (screen.state.frames.length === 0) {
      alive()
      if (performance.now() - boot > 30_000) throw new Error('Remote did not paint a terminal frame')
      await sleep(20)
    }
    await settle()
    for (const step of steps) {
      alive()
      switch (step.step) {
        case 'type': terminal.write(step.text); await settle(); break
        case 'key': terminal.write(keyBytes(step.name)); await settle(); break
        case 'resize': terminal.resize(step.cols, step.rows); screen.resize(step.cols, step.rows); await settle(); break
        case 'until': {
          const begin = performance.now()
          for (;;) {
            alive()
            await screen.flush()
            if (screen.find(step.text) !== undefined) break
            if (performance.now() - begin > 30_000) throw new Error(`Expected text did not appear: ${step.text}`)
            await sleep(25)
          }
          await settle()
          break
        }
        case 'checkpoint': {
          await settle()
          const wrapped = screen.wrappedRows()
          if (wrapped.length > 0) failures.push(`${step.name}: rows wider than terminal: ${wrapped.join(', ')}`)
          const rawGrid = normalizeSplitGrid(screen.serialize())
          const grid = redactSplitOutput(rawGrid, host.startupUrl)
          if (grid !== rawGrid) failures.push(`${step.name}: credentials reached the terminal`)
          checkpoints.push({ name: step.name, grid })
          writeFileSync(join(artifacts, `${step.name}-${cols}x${rows}.grid`), grid)
          break
        }
        default: throw new Error(`Unsupported split scenario step: ${step.step}`)
      }
    }
    terminal.write('\u001b')
    await sleep(100)
    for (let attempt = 0; attempt < 5 && exitCode === undefined; attempt += 1) {
      terminal.write('\u0003')
      await Promise.race([exited, sleep(attempt === 4 ? 5000 : 300)])
    }
    if (exitCode === undefined) failures.push('Remote did not exit on Ctrl+C')
    else if (exitCode !== 0 || exitSignal !== 0) failures.push(`Remote exit was not clean (code=${exitCode}, signal=${exitSignal})`)
    await screen.flush()
    if (!screen.state.cursorVisible || screen.state.mouse !== 'none' || screen.state.sgr) failures.push('Remote did not restore terminal cursor/mouse modes')
    if (host.child.exitCode !== null || host.child.signalCode !== null) failures.push('Detaching Remote stopped the Host')
    if (referenceDir !== undefined) failures.push(...compareSplitReference(referenceDir, checkpoints, { cols, rows }))
  } catch (error) {
    failures.push(redactSplitOutput(error instanceof Error ? error.stack ?? error.message : String(error), host?.startupUrl))
  } finally {
    if (terminal !== undefined && exitCode === undefined) terminal.kill()
    if (host !== undefined) writeFileSync(join(artifacts, 'host.log'), host.diagnostics())
    writeFileSync(join(artifacts, 'remote.ansi'), redactSplitOutput(output, host?.startupUrl))
    screen?.dispose()
    await host?.stop()
    await stub.close()
  }
  const report = {
    status: failures.length > 0 ? 'failed' : referenceDir === undefined ? 'smoke-only' : 'passed',
    parityVerified: referenceDir !== undefined && failures.length === 0,
    reference: SPLIT_REFERENCE,
    candidate: revision,
    dsh: host?.version,
    cols, rows,
    checkpoints: checkpoints.map(checkpoint => checkpoint.name),
    durationMs: Math.round(performance.now() - started),
    failures,
  }
  writeFileSync(join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}
