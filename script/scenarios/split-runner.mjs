/** Real HTTP/WebSocket Host plus an independently spawned Remote terminal. @module script/scenarios/split-runner */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchSplitHost } from './split-profile.mjs'
import { compareSplitReference, redactSplitOutput, SPLIT_REFERENCE } from './split-reference.mjs'
import { startStubModel } from './stub-model.mjs'
import { awaitProbeAudit } from './split-audit.mjs'
import { startSplitNetwork } from './split-network.mjs'

import { captureSplitTerminal } from './split-terminal.mjs'

/** Baseline and candidate must execute these same semantic steps and checkpoints. */
export const SPLIT_SMOKE_STEPS = Object.freeze([
  { step: 'until', text: 'Ask anything' },
  { step: 'checkpoint', name: 'startup' },
  { step: 'type', text: '/help' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'Commands' }, { step: 'checkpoint', name: 'help' },
  { step: 'key', name: 'esc' },
  { step: 'type', text: '中文 draft 🪰' }, { step: 'checkpoint', name: 'unicode-draft' },
  { step: 'key', name: 'ctrl+u' },
  { step: 'type', text: 'Say one line about this isolated replay.' }, { step: 'key', name: 'enter' },
  { step: 'until', text: 'the model is a stub' }, { step: 'checkpoint', name: 'settled-turn' },
  { step: 'type', text: '/new' }, { step: 'key', name: 'enter' }, { step: 'checkpoint', name: 'new-session' },
])

/** No mocks or injected Remote state: every UI operation runs through the built product and its real transport. */
export async function runSplitScenario({ root, dshBin, artifacts, cols = 80, rows = 24, referenceDir, steps = SPLIT_SMOKE_STEPS, probe = false, network = false, startup, scenario = 'smoke' }) {
  mkdirSync(artifacts, { recursive: true })
  const stub = await startStubModel({ probe })
  let host
  let forwarding
  let checkpoints = []
  const failures = []
  const started = performance.now()
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  try {
    host = await launchSplitHost({ root, dshBin, artifacts, baseURL: stub.baseURL, probe, startup })
    if (network) forwarding = await startSplitNetwork(host.startupUrl)
    const startupUrl = forwarding?.startupUrl ?? host.startupUrl
    const env = { ...host.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TZ: 'UTC', MAYFLY_DSH_STARTUP_URL: startupUrl, MAYFLY_CWD: host.cwd, MAYFLY_SPLIT_CLOCK_RELEASE: host.clockRelease, NODE_OPTIONS: `--import=${new URL('./split-clock.mjs', import.meta.url).href}` }
    for (const name of ['CI', 'COLUMNS', 'LINES', 'NO_COLOR', 'FORCE_COLOR', 'MAYFLY_SESSION_ID', 'MAYFLY_TASK']) delete env[name]
    const captured = await captureSplitTerminal({
      bin: process.execPath, args: [join(root, 'packages/remote/lib/remote-bin.js')], cwd: host.cwd,
      env, cols, rows, steps, stub, startupUrl,
      audit: step => awaitProbeAudit(host.auditLog, step),
      network: action => {
        if (forwarding === undefined || !['drop', 'restore'].includes(action)) throw new Error(`Invalid network action ${action}`)
        forwarding[action]()
      },
      alive: () => { if (host.child.exitCode !== null || host.child.signalCode !== null) throw new Error('Host exited while Remote was attached') },
      onCheckpoint: checkpoint => writeFileSync(join(artifacts, `${checkpoint.name}-${checkpoint.cols}x${checkpoint.rows}.grid`), checkpoint.grid),
      beforeExit: async () => { writeFileSync(host.clockRelease, 'release'); await sleep(30) },
    })
    checkpoints = captured.checkpoints
    failures.push(...captured.failures)
    writeFileSync(join(artifacts, 'remote.ansi'), captured.output)
    if (host.child.exitCode !== null || host.child.signalCode !== null) failures.push('Detaching Remote stopped the Host')
    if (referenceDir !== undefined) failures.push(...compareSplitReference(referenceDir, checkpoints, { cols, rows, steps, startup }))
  } catch (error) {
    failures.push(redactSplitOutput(error instanceof Error ? error.stack ?? error.message : String(error), host?.startupUrl))
  } finally {
    if (host !== undefined) writeFileSync(join(artifacts, 'host.log'), host.diagnostics())
    await forwarding?.close()
    await host?.stop()
    await stub.close()
  }
  const report = {
    status: failures.length > 0 ? 'failed' : referenceDir === undefined ? 'smoke-only' : 'passed',
    parityVerified: referenceDir !== undefined && failures.length === 0,
    reference: SPLIT_REFERENCE,
    candidate: revision,
    scenario,
    dsh: host?.version,
    cols, rows,
    checkpoints: checkpoints.map(checkpoint => checkpoint.name),
    durationMs: Math.round(performance.now() - started),
    failures,
  }
  writeFileSync(join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  return report
}
