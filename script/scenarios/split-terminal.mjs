/** Shared keyboard, settling and grid capture for published-reference and split-candidate PTYs. @module script/scenarios/split-terminal */

import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { keyBytes } from './input.mjs'
import { createScreen } from './screen.mjs'
import { normalizeSplitGrid, redactSplitOutput } from './split-reference.mjs'

const require = createRequire(import.meta.url)

/** Drive identical semantic steps through either real executable. Never inject renderer state. */
export async function captureSplitTerminal({ bin, args, cwd, env, cols, rows, steps, stub, alive = () => {}, startupUrl, onCheckpoint = () => {}, beforeExit = async () => {}, audit, network }) {
  const terminal = require('node-pty').spawn(bin, args, { name: 'xterm-256color', cols, rows, cwd, env })
  const screen = createScreen({ cols, rows, reply: data => terminal.write(data) })
  let output = ''
  let exitCode
  let exitSignal
  const checkpoints = []
  const failures = []
  terminal.onData(data => { output += data; screen.feed(data) })
  const exited = new Promise(resolve => terminal.onExit(event => { exitCode = event.exitCode; exitSignal = event.signal; resolve(event.exitCode) }))
  const check = () => { alive(); if (exitCode !== undefined) throw new Error(`Terminal exited early with ${exitCode}`) }
  const settle = async (timeoutMs = 20_000) => {
    let previous
    let since = performance.now()
    const begin = since
    do {
      check()
      await screen.flush()
      const next = screen.serialize()
      if (next !== previous) { previous = next; since = performance.now() }
      if (screen.state.bytes > 0 && performance.now() - since >= 250 && screen.state.openSync === 0 && stub.inFlight() === 0) return
      await sleep(20)
    } while (performance.now() - begin < timeoutMs)
    throw new Error('Terminal did not settle')
  }
  try {
    const boot = performance.now()
    while (screen.state.frames.length === 0) {
      check()
      if (performance.now() - boot > 30_000) throw new Error('Product did not paint a terminal frame')
      await sleep(20)
    }
    await settle()
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
    for (let attempt = 0; attempt < 5 && exitCode === undefined; attempt += 1) {
      terminal.write('\u0003')
      await Promise.race([exited, sleep(attempt === 4 ? 5000 : 300)])
    }
    if (exitCode === undefined) failures.push('Product did not exit on Ctrl+C')
    else if (exitCode !== 0 || exitSignal !== 0) failures.push(`Product exit was not clean (code=${exitCode}, signal=${exitSignal})`)
    await screen.flush()
    if (!screen.state.cursorVisible || screen.state.mouse !== 'none' || screen.state.sgr) failures.push('Product did not restore terminal cursor/mouse modes')
  } catch (error) {
    failures.push(redactSplitOutput(error instanceof Error ? error.stack ?? error.message : String(error), startupUrl))
  } finally {
    if (exitCode === undefined) terminal.kill()
    screen.dispose()
  }
  if (/ERR_MODULE_NOT_FOUND|StartupError|failed to import:|action failed|replay failed/u.test(output)) failures.push('Product emitted a loader or scenario failure; inspect the PTY log')
  return { checkpoints, failures, output: redactSplitOutput(output, startupUrl), exitCode }
}
