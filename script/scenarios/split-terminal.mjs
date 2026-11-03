/** Shared keyboard, settling and grid capture for published-reference and split-candidate PTYs. @module script/scenarios/split-terminal */

import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { keyBytes } from './input.mjs'
import { createScreen } from './screen.mjs'
import { normalizeSplitGrid, redactSplitOutput, SPLIT_REFERENCE } from './split-reference.mjs'

const require = createRequire(import.meta.url)

/** The native model can appear in the banner or responsive footer of either isolated fixture. */
export function splitStartupReadiness() {
  return [
    { text: `mayfly v${SPLIT_REFERENCE.version}` },
    { text: 'deepseek-flash' },
  ]
}

/** An unchanged editor can precede native attachment; startup also needs the configured visible state. */
export async function settleSplitScreen({ screen, stub, check, ready = [], timeoutMs = 20_000, now = () => performance.now(), pause = sleep }) {
  let previous
  let since = now()
  const begin = since
  let missing = ready
  do {
    check()
    await screen.flush()
    const next = screen.serialize()
    if (next !== previous) { previous = next; since = now() }
    missing = ready.filter(marker => screen.find(marker.text) === undefined)
    if (screen.state.bytes > 0 && now() - since >= 250 && screen.state.openSync === 0 && stub.inFlight() === 0 && missing.length === 0) return
    await pause(20)
  } while (now() - begin < timeoutMs)
  if (missing.length > 0) throw new Error(`Terminal startup did not become ready within ${timeoutMs}ms; missing visible text: ${missing.map(marker => marker.text).join('; ')}`)
  throw new Error('Terminal did not settle')
}

/** Confirm the current visible exit warning; an interrupt may first clear a draft or cancel a turn. */
export async function exitSplitTerminal({ terminal, screen, isExited, timeoutMs = 30_000, now = () => performance.now(), pause = sleep }) {
  const begin = now()
  const interrupts = []
  const acknowledgmentMs = 2000
  const maxInterrupts = 6
  let phase = 'interrupt'
  let previous
  let changedAt = begin
  let sentGrid
  let sentFrames = 0
  let confirmedAt = begin
  let sentAt = begin
  let unacknowledgedRetries = 0
  let warningObserved = false
  const send = (grid, confirm, reason) => {
    if (interrupts.length >= maxInterrupts) return false
    sentGrid = grid
    sentFrames = screen.state.frames.length
    sentAt = now()
    phase = confirm ? 'drain' : 'acknowledge'
    if (confirm) confirmedAt = sentAt
    interrupts.push({ atMs: Math.round(sentAt - begin), reason, frames: sentFrames, bytes: screen.state.bytes })
    terminal.write('\u0003')
    return true
  }
  while (!isExited() && now() - begin < timeoutMs) {
    await screen.flush()
    if (isExited()) break
    const grid = screen.serialize()
    if (grid !== previous) { previous = grid; changedAt = now() }
    const warning = screen.state.openSync === 0 && screen.find('press Ctrl+C again to exit') !== undefined
    if (warning) warningObserved = true
    const active = screen.state.mouse !== 'none' && !screen.state.cursorVisible
    const painted = screen.state.frames.length > sentFrames && grid !== sentGrid
      && screen.state.openSync === 0 && now() - changedAt >= 250
    if (phase === 'interrupt') send(grid, warning, warning ? 'confirm-warning' : 'initial')
    else if (phase === 'acknowledge') {
      if (warning) {
        if (!send(grid, true, 'confirm-warning')) break
      }
      // A completed visible change acknowledges a clear/cancel; do not queue
      // another interrupt until that paint settles or the bounded no-ack wait.
      else if (active && painted) {
        if (!send(grid, false, 'acknowledged-change')) break
      } else if (now() - sentAt >= acknowledgmentMs) {
        // PTYs can lose the first input without producing a new frame. Retry
        // once after a full acknowledgment interval, never indefinitely and
        // never while draining an already confirmed shutdown.
        if (unacknowledgedRetries >= 1 || !active || screen.state.openSync !== 0) break
        unacknowledgedRetries += 1
        if (!send(grid, false, 'unacknowledged-retry')) break
      }
    } else if (!warning && active && painted && now() - confirmedAt >= 5000) {
      // Only a still-interactive, newly painted UI can start another pair.
      // Restored terminal modes mean the real process is draining input.
      if (!send(grid, false, 'interactive-after-confirmation')) break
    }
    await pause(20)
  }
  await screen.flush()
  const exited = isExited()
  const modesRestored = screen.state.cursorVisible && screen.state.mouse === 'none' && !screen.state.sgr
  const failure = !exited
    ? { code: warningObserved ? 'confirmation-not-exited' : 'warning-not-observed', message: warningObserved ? 'Exit warning was observed but the confirmed interrupt did not terminate the process' : 'Interrupt did not produce a visible exit warning within the bounded acknowledgment attempts' }
    : !modesRestored ? { code: 'modes-not-restored', message: 'Exited process did not restore terminal cursor/mouse modes' } : undefined
  return {
    exited, failure, phase, durationMs: Math.round(now() - begin), interrupts,
    terminal: { frames: screen.state.frames.length, bytes: screen.state.bytes, openSync: screen.state.openSync, cursorVisible: screen.state.cursorVisible, mouse: screen.state.mouse, sgr: screen.state.sgr },
  }
}

/** Drive identical semantic steps through either real executable. Never inject renderer state. */
export async function captureSplitTerminal({ bin, args, cwd, env, cols, rows, steps, stub, alive = () => {}, startupUrl, startupReady, onCheckpoint = () => {}, beforeExit = async () => {}, audit, network }) {
  const terminal = require('node-pty').spawn(bin, args, { name: 'xterm-256color', cols, rows, cwd, env })
  const screen = createScreen({ cols, rows, reply: data => terminal.write(data) })
  let output = ''
  let exitCode
  let exitSignal
  let exit
  const checkpoints = []
  const failures = []
  terminal.onData(data => { output += data; screen.feed(data) })
  const exited = new Promise(resolve => terminal.onExit(event => { exitCode = event.exitCode; exitSignal = event.signal; resolve(event.exitCode) }))
  const check = () => { alive(); if (exitCode !== undefined) throw new Error(`Terminal exited early with ${exitCode}`) }
  const settle = (timeoutMs = 20_000, ready) => settleSplitScreen({ screen, stub, check, ready, timeoutMs })
  try {
    const boot = performance.now()
    while (screen.state.frames.length === 0) {
      check()
      if (performance.now() - boot > 30_000) throw new Error('Product did not paint a terminal frame')
      await sleep(20)
    }
    await settle(startupReady === undefined ? 20_000 : Math.max(0, 30_000 - (performance.now() - boot)), startupReady)
    for (const step of steps) {
      check()
      switch (step.step) {
        case 'type': terminal.write(step.text); await settle(); break
        case 'key': terminal.write(keyBytes(step.name)); await settle(); break
        case 'resize': terminal.resize(step.cols, step.rows); screen.resize(step.cols, step.rows); await settle(); break
        case 'wait': await sleep(step.ms); await settle(); break
        case 'audit':
          if (audit === undefined) throw new Error('Audit step requires the real native probe fixture')
          await audit(step)
          await settle()
          break
        case 'network':
          if (network === undefined) throw new Error('Network step requires the real forwarding fixture')
          await network(step.action)
          break
        case 'until':
        case 'until-gone': {
          const begin = performance.now()
          for (;;) {
            check()
            await screen.flush()
            if ((screen.find(step.text) !== undefined) === (step.step === 'until')) break
            if (performance.now() - begin > 30_000) throw new Error(`Expected text did not ${step.step === 'until' ? 'appear' : 'disappear'}: ${step.text}`)
            await sleep(25)
          }
          await settle()
          break
        }
        case 'checkpoint': {
          await settle()
          if (screen.wrappedRows().length > 0) failures.push(`${step.name}: rows wider than terminal: ${screen.wrappedRows().join(', ')}`)
          const raw = normalizeSplitGrid(screen.serialize())
          const grid = redactSplitOutput(raw, startupUrl)
          if (grid !== raw) failures.push(`${step.name}: credentials reached the terminal`)
          const checkpoint = { name: step.name, grid, cols: screen.terminal.cols, rows: screen.terminal.rows }
          checkpoints.push(checkpoint)
          await onCheckpoint(checkpoint)
          break
        }
        default: throw new Error(`Unsupported split scenario step: ${step.step}`)
      }
    }
    await beforeExit()
    terminal.write('\u001b')
    await sleep(100)
    exit = await exitSplitTerminal({ terminal, screen, isExited: () => exitCode !== undefined })
    if (exitCode === undefined) failures.push(`Product did not exit on Ctrl+C (${exit.failure.code}: ${exit.failure.message}; interrupts=${exit.interrupts.length}, phase=${exit.phase}, frames=${exit.terminal.frames})`)
    else if (exitCode !== 0 || exitSignal !== 0) failures.push(`Product exit was not clean (code=${exitCode}, signal=${exitSignal})`)
    await screen.flush()
    if (!screen.state.cursorVisible || screen.state.mouse !== 'none' || screen.state.sgr) failures.push('Product did not restore terminal cursor/mouse modes')
  } catch (error) {
    failures.push(redactSplitOutput(error instanceof Error ? error.stack ?? error.message : String(error), startupUrl))
  } finally {
    // A failed startup may already be draining input in Core's finally block.
    // Release the frozen presentation clock so its real exception can reach
    // stderr before the verification process kills an otherwise stuck PTY.
    await beforeExit()
    if (exitCode === undefined) await Promise.race([exited, sleep(250)])
    if (exitCode === undefined) terminal.kill()
    screen.dispose()
  }
  if (/ERR_MODULE_NOT_FOUND|StartupError|failed to import:|action failed|replay failed/u.test(output)) failures.push('Product emitted a loader or scenario failure; inspect the PTY log')
  return { checkpoints, failures, output: redactSplitOutput(output, startupUrl), exitCode, exit }
}
