/** Independent native two-turn changes RPC and real Remote browser verification. @module */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { launchSplitHost } from './split-profile.mjs'
import { startStubModel } from './stub-model.mjs'
import { builtSplitRuntime, persistedSplitEvidence } from './split-evidence.mjs'
import { captureSplitTerminal } from './split-terminal.mjs'

function value(result) {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Record two actual file-tool turns, compare their exact seqs, and drive /changes plus /files. */
export async function runSplitWorkspaceChanges({ root, dshBin = 'dsh', artifacts }) {
  mkdirSync(artifacts, { recursive: true })
  const before = builtSplitRuntime(root)
  const stub = await startStubModel()
  let host, client
  const report = { status: 'failed', runtimeBefore: before, cases: {}, failures: [] }
  try {
    host = await launchSplitHost({ root, dshBin, artifacts, baseURL: stub.baseURL, fixture: 'native-files' })
    const { createHostClient, HostKey } = await import(pathToFileURL(join(root, 'packages/remote/lib/client.js')).href)
    const { default: mayflyHost } = await import(pathToFileURL(join(root, 'packages/host/lib/typert.remote-client.js')).href)
    client = await createHostClient({ key: HostKey('native-workspace-changes'), startupUrl: host.startupUrl, mayflyHost })
    const sessionId = await client.sessions.create({ cwd: host.cwd })
    report.sessionId = sessionId
    const journal = async () => value(await client.remote.session.events({ address: { kind: 'session', sessionId }, maxMessages: 500 })).records.map(record => record.event)
    const prompt = async text => {
      await client.sessions.using(sessionId, { source: 'controllerOperation' }, async reference => {
        const session = reference.binding.session
        const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] })
        try { value(await session.prompt([{ type: 'text', text }], 'queue', undefined, submission.requestId)) }
        catch (error) { submission.abandon(); throw error }
        value(await client.remote.session.wait({ sessionId, timeoutMs: 30_000 }))
      })
    }
    await prompt('native:files:first')
    const firstEvents = await journal()
    const first = firstEvents.findLast(event => event.type === 'workspace/changes')
    assert.ok(first, 'First native turn must announce workspace changes')
    // Seed a distinct context before the next real tool turn. The native edit
    // still performs before -> after, and each seq must keep its own context.
    writeFileSync(join(host.cwd, 'parity-change.txt'), 'before parity change\nsecond turn context\n')
    await prompt('native:files:second')
    const events = await journal()
    const second = events.findLast(event => event.type === 'workspace/changes')
    assert.ok(second.seq > first.seq, 'Two native turns must have different change seqs')
    const remote = client.remote.mayflyHost
    const read = async event => {
      const summary = value(await remote.workspaceChangesSummary({ sessionId, seq: event.seq }))
      assert.ok(summary, 'Recorded native seq must have its own summary')
      const index = summary.files.findIndex(file => file.path === 'parity-change.txt')
      assert.ok(index >= 0, 'Native summary must include the edited file')
      const diff = value(await remote.workspaceChangesDiff({ sessionId, seq: event.seq, index }))
      assert.equal(diff?.kind, 'text')
      return { seq: event.seq, summary, diff }
    }
    const firstRead = await read(first)
    const secondRead = await read(second)
    assert.notEqual(firstRead.summary.turn, secondRead.summary.turn)
    assert.ok(JSON.stringify(firstRead.diff).includes('unchanged line'))
    assert.ok(JSON.stringify(secondRead.diff).includes('second turn context'))
    assert.ok(!JSON.stringify(firstRead.diff).includes('second turn context'))
    const latest = value(await remote.latestWorkspaceChanges({ sessionId }))
    assert.deepEqual(latest, { seq: second.seq, summary: secondRead.summary })
    assert.equal(value(await remote.workspaceChangesSummary({ sessionId, seq: Number.MAX_SAFE_INTEGER })), null)
    assert.equal(value(await remote.workspaceChangesDiff({ sessionId, seq: first.seq, index: firstRead.summary.files.length })), null)
    report.events = events
    report.cases.exactRecordedSeqs = { first: firstRead, second: secondRead, latest }
    const send = text => [{ step: 'type', text }, { step: 'key', name: 'enter' }]
    const checkpoint = name => ({ step: 'checkpoint', name })
    const firstGroup = `Changed · turn ${firstRead.summary.turn}`
    const secondGroup = `Changed · turn ${secondRead.summary.turn}`
    // Two complete native tool turns scroll the initial version banner out of
    // view. The responsive native model footer and ready editor remain visible.
    const startupReady = [{ text: 'deepseek-flash' }, { text: 'Ask anything' }]
    const env = {
      ...host.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TZ: 'UTC',
      MAYFLY_DSH_STARTUP_URL: host.startupUrl, MAYFLY_CWD: host.cwd, MAYFLY_SESSION_ID: sessionId,
      MAYFLY_SPLIT_CLOCK_RELEASE: host.clockRelease,
      NODE_OPTIONS: `--import=${new URL('./split-clock.mjs', import.meta.url).href}`,
    }
    for (const key of ['CI', 'COLUMNS', 'LINES', 'NO_COLOR', 'FORCE_COLOR', 'MAYFLY_TASK']) delete env[key]
    const captured = await captureSplitTerminal({
      bin: process.execPath, args: [join(root, 'packages/remote/lib/remote-bin.js')], cwd: host.cwd,
      env, cols: 100, rows: 40, stub, startupUrl: host.startupUrl, startupReady,
      steps: [
        ...send(`/changes ${first.seq}`), { step: 'until', text: firstGroup }, { step: 'until', text: 'unchanged line' }, checkpoint('changes-first-seq'),
        { step: 'key', name: 'esc' }, ...send(`/changes ${second.seq}`), { step: 'until', text: secondGroup }, { step: 'until', text: 'second turn context' }, checkpoint('changes-second-seq'),
        { step: 'resize', cols: 40, rows: 16 }, checkpoint('changes-narrow-list'),
        { step: 'key', name: 'enter' }, checkpoint('changes-narrow-detail'), { step: 'key', name: 'esc' }, checkpoint('changes-narrow-back'),
        { step: 'key', name: 'esc' }, { step: 'resize', cols: 100, rows: 40 }, ...send('/changes'), { step: 'until', text: secondGroup }, checkpoint('changes-latest'),
        { step: 'key', name: 'esc' }, ...send('/files'), { step: 'until', text: 'Delivered' }, { step: 'until', text: secondGroup }, checkpoint('files-latest-regression'),
        { step: 'key', name: 'esc' }, ...send('/changes -1'), { step: 'until', text: 'Usage: /changes [seq]' }, checkpoint('changes-invalid-seq'),
      ],
      alive: () => { assert.equal(host.child.exitCode, null, 'Host must outlive the TUI') },
      onCheckpoint: item => writeFileSync(join(artifacts, `${item.name}-${item.cols}x${item.rows}.grid`), item.grid),
      beforeExit: async () => { writeFileSync(host.clockRelease, 'release') },
    })
    writeFileSync(join(artifacts, 'remote.ansi'), captured.output)
    writeFileSync(join(artifacts, 'exit.json'), `${JSON.stringify(captured.exit ?? null, null, 2)}\n`)
    report.cases.tui = { checkpoints: captured.checkpoints.map(item => item.name), exitCode: captured.exitCode, exit: captured.exit }
    assert.deepEqual(captured.failures, [])
    assert.equal(host.child.exitCode, null)

    // Native comparisons are resident, while events remain persisted. Restart
    // the exact isolated profile to verify honest cold nulls and passive reads.
    await client.detach()
    await host.stop()
    writeFileSync(join(artifacts, 'warm-host.log'), host.diagnostics())
    report.warmNativeEvidence = persistedSplitEvidence(host.runDir)
    host = await launchSplitHost({ root, dshBin, artifacts, baseURL: stub.baseURL, workspace: host.cwd, resumeRunDir: host.runDir })
    client = await createHostClient({ key: HostKey('native-workspace-changes-cold'), startupUrl: host.startupUrl, mayflyHost })
    const coldBefore = value(await client.remote.session.state({ sessionId }))
    const coldEventsBefore = await journal()
    assert.equal(coldBefore.active, false, 'Persisted cold Session must have no Agent')
    assert.equal(coldBefore.running, false)
    for (const seq of [first.seq, second.seq]) {
      assert.equal(value(await client.remote.mayflyHost.workspaceChangesSummary({ sessionId, seq })), null)
      assert.equal(value(await client.remote.mayflyHost.workspaceChangesDiff({ sessionId, seq, index: 0 })), null)
    }
    assert.equal(value(await client.remote.mayflyHost.latestWorkspaceChanges({ sessionId })), null)
    const coldAfterReads = value(await client.remote.session.state({ sessionId }))
    assert.equal(coldAfterReads.active, false, 'Cold comparison RPCs must not activate an Agent')
    assert.equal(coldAfterReads.running, false)
    assert.deepEqual(await journal(), coldEventsBefore, 'Cold comparison RPCs must append no Session events')
    assert.deepEqual(coldEventsBefore, events, 'Restart must preserve native history exactly')
    report.cases.coldNoComparison = {
      seqs: [first.seq, second.seq], before: coldBefore, after: coldAfterReads,
      behavior: 'Native resident comparisons are unavailable after restart; readonly RPCs return null without Agent activation or writes.',
    }
    const coldDir = join(artifacts, 'cold')
    mkdirSync(coldDir, { recursive: true })
    let resumedState, resumedEvents
    const coldCaptured = await captureSplitTerminal({
      bin: process.execPath, args: [join(root, 'packages/remote/lib/remote-bin.js')], cwd: host.cwd,
      env: { ...env, MAYFLY_DSH_STARTUP_URL: host.startupUrl, MAYFLY_SPLIT_CLOCK_RELEASE: host.clockRelease },
      cols: 100, rows: 40, stub, startupUrl: host.startupUrl, startupReady,
      steps: [
        checkpoint('changes-cold-resumed-before'),
        ...send(`/changes ${first.seq}`), { step: 'until', text: 'No files' }, checkpoint('changes-cold-no-comparison'),
        { step: 'resize', cols: 40, rows: 16 }, checkpoint('changes-cold-narrow'),
        { step: 'key', name: 'esc' }, { step: 'resize', cols: 100, rows: 40 },
        ...send('/changes'), { step: 'until', text: 'No files' }, checkpoint('changes-cold-latest-empty'),
      ],
      alive: () => { assert.equal(host.child.exitCode, null, 'Cold reads must leave Host alive') },
      onCheckpoint: async item => {
        writeFileSync(join(coldDir, `${item.name}-${item.cols}x${item.rows}.grid`), item.grid)
        if (item.name === 'changes-cold-resumed-before') {
          // Selecting an ordinary stored Session in the TUI legitimately resumes
          // its Agent. Browser commands must preserve that already-set state.
          resumedState = value(await client.remote.session.state({ sessionId }))
          resumedEvents = await journal()
        }
      },
      beforeExit: async () => { writeFileSync(host.clockRelease, 'release') },
    })
    writeFileSync(join(coldDir, 'remote.ansi'), coldCaptured.output)
    writeFileSync(join(coldDir, 'exit.json'), `${JSON.stringify(coldCaptured.exit ?? null, null, 2)}\n`)
    assert.deepEqual(coldCaptured.failures, [])
    const coldAfter = value(await client.remote.session.state({ sessionId }))
    assert.ok(resumedState)
    assert.equal(coldAfter.active, resumedState.active, 'Browser reads must preserve the selected Session activation state')
    assert.equal(coldAfter.running, false)
    assert.deepEqual(await journal(), resumedEvents, 'Changes browser reads must append no Session events')
    report.cases.resumedWithoutComparison = {
      before: resumedState, after: coldAfter,
      checkpoints: coldCaptured.checkpoints.map(item => item.name), exitCode: coldCaptured.exitCode, exit: coldCaptured.exit,
      behavior: 'After explicitly resuming the stored Session, unavailable native comparisons stay empty and browser reads append no events.',
    }
    report.status = 'passed'
  } catch (error) {
    report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
  } finally {
    await client?.detach()
    if (host !== undefined) writeFileSync(join(artifacts, 'host.log'), host.diagnostics())
    await host?.stop()
    await stub.close()
    report.nativeEvidence = persistedSplitEvidence(host?.runDir)
    report.runtimeAfter = builtSplitRuntime(root)
    if (before.sha256 !== report.runtimeAfter.sha256) {
      report.status = 'failed'
      report.failures.push('Built runtime changed during workspace-changes verification')
    }
    writeFileSync(join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: 'string' }, artifacts: { type: 'string' }, 'dsh-bin': { type: 'string' } } })
  const root = resolve(values.root ?? fileURLToPath(new URL('../..', import.meta.url)))
  const artifacts = resolve(values.artifacts ?? join(root, '.artifacts/native-workspace-changes'))
  const report = await runSplitWorkspaceChanges({ root, artifacts, dshBin: values['dsh-bin'] ?? process.env.DSH_BIN ?? 'dsh' })
  console.log(`${report.status}: ${join(artifacts, 'report.json')}`)
  if (report.status !== 'passed') process.exitCode = 1
}
