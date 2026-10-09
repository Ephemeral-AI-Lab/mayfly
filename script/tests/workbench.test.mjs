import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { debounceFiles, parseDevArgs } from '../dev.mjs'
import { parseFrameArgs } from '../frame.mjs'
import { keyBytes, parseKeys } from '../workbench/keys.mjs'
import { resolveScenario } from '../workbench/live-scenarios.mjs'
import { apply as applyDriver } from '../workbench/replay-driver.mjs'
import { REPLAYS } from '../workbench/replays.mjs'
import { startStubModel } from '../workbench/stub-model.mjs'
import { approval, btw, compile, edit, goal, image, job, notify, pause, question, queue, raw, step, subagent, todos, tool, turn } from '../workbench/timeline.mjs'
import { newestSessionId, presentationEnv, sessionSlug } from '../workbench/supervisor.mjs'
import { parseScenarioArgs } from '../scenario.mjs'

test('key lists decode names, control chords, alt chords, and text', () => {
  assert.deepEqual(parseKeys('down,enter,ctrl+c,alt+f,hi,comma'), ['\u001b[B', '\r', '\u0003', '\u001bf', 'hi', ','])
  assert.deepEqual(parseKeys(undefined), [])
  assert.equal(keyBytes('Esc'), '\u001b')
})

test('frame arguments name one scenario and validate sizes', () => {
  assert.deepEqual(parseFrameArgs(['app-trace', '--width', '60', '--keys', 'down']).run, { env: {}, scenario: 'app-trace', cols: 60, keys: ['\u001b[B'] })
  assert.equal(parseFrameArgs(['--no-color', 'app-trace']).run.env.NO_COLOR, '1')
  assert.match(parseFrameArgs([]).error, /usage/u)
  assert.match(parseFrameArgs(['a', 'b']).error, /unexpected/u)
  assert.match(parseFrameArgs(['a', '--width', '0']).error, /width/u)
  assert.match(parseFrameArgs(['a', '--bogus']).error, /unknown option/u)
})

test('scenario names resolve to live, fixture, or unknown', () => {
  assert.equal(resolveScenario('gallery').gallery, true)
  assert.equal(resolveScenario('app-trace').kind, 'fixture')
  assert.equal(resolveScenario('toString').kind, 'unknown')
  assert.deepEqual(parseScenarioArgs(['stream', '--ascii']).options.ascii, true)
  assert.match(parseScenarioArgs([]).error, /usage/u)
  assert.equal(parseScenarioArgs(['--list']).options.list, true)
})

test('dev refuses the production profile and requires one', () => {
  const saved = process.env.PROFILE
  delete process.env.PROFILE
  try {
    assert.match(parseDevArgs([]).error, /usage/u)
    assert.match(parseDevArgs(['--profile', 'mayfly']).error, /production/u)
    const { options } = parseDevArgs(['--profile', 'mayfly-x', '--width', '70', '--', 'task'])
    assert.deepEqual([options.profile, options.cols, options.args], ['mayfly-x', 70, ['task']])
    process.env.PROFILE = 'mayfly-env'
    assert.equal(parseDevArgs([]).options.profile, 'mayfly-env')
  } finally {
    if (saved === undefined) delete process.env.PROFILE
    else process.env.PROFILE = saved
  }
})

test('watch events collapse into one sorted batch', async () => {
  const batches = []
  const push = debounceFiles(20, batch => batches.push(batch))
  push('b.ts')
  push('a.ts')
  push('b.ts')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.deepEqual(batches, [['a.ts', 'b.ts']])
})

test('sessions resume from the newest directory of the working directory', () => {
  assert.equal(sessionSlug('/home/mint/dev/mayfly-workbench'), '--home-mint-dev-mayfly-workbench--')
  const home = mkdtempSync(join(tmpdir(), 'workbench-test-'))
  try {
    assert.equal(newestSessionId(home, '/work/x'), undefined)
    const dir = join(home, 'sessions', sessionSlug('/work/x'))
    for (const [name, at] of [['session-old', 1000], ['session-new', 2000], ['other', 3000]]) {
      mkdirSync(join(dir, name), { recursive: true })
      utimesSync(join(dir, name), at, at)
    }
    assert.equal(newestSessionId(home, '/work/x'), 'session-new')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('degraded presentation sets only what was asked', () => {
  assert.deepEqual(presentationEnv(), {})
  assert.deepEqual(presentationEnv({ noColor: true }), { NO_COLOR: '1' })
  assert.equal(presentationEnv({ ascii: true }).LC_ALL, 'C')
})

const readFileSyncSafe = file => { try { return readFileSync(file, 'utf8') } catch { return '' } }
const types = actions => actions.filter(action => action.op === 'append').map(action => action.type)

test('a turn compiles to the chronological events the agent loop writes', () => {
  const actions = compile([turn('hi', [step({ text: 'reading', tools: [tool('read', { file_path: 'a' }, { result: 'x', runMs: 100 })] }), step({ text: 'done' })])])
  assert.deepEqual(types(actions), ['turn/start', 'user/message', 'step/start', 'request/header', 'request/context', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'step/start', 'assistant/message', 'step/end', 'turn/end'])
  assert.deepEqual(actions.map(action => action.at), [...actions.map(action => action.at)].sort((left, right) => left - right))
  const first = actions.find(action => action.type === 'assistant/message').data
  assert.deepEqual(first.message.content.map(block => block.type), ['text', 'tool-call'])
  assert.deepEqual(first.stream, [])
  const call = actions.find(action => action.type === 'tool/call').data
  assert.equal(actions.find(action => action.type === 'tool/result').data.message.toolCallId, call.callId)
  assert.equal(actions.find(action => action.type === 'user/message').surface, 'append')
})

test('streamed text is framed before its message commits, and committed steps are not streamed', () => {
  const streamed = compile([turn('q', [step({ reasoning: 'think', text: 'answer', chunk: 3 })])])
  const frames = streamed.filter(action => action.op === 'stream')
  assert.equal(frames[0].frame, 'start')
  assert.equal(frames.at(-1).frame, 'end')
  assert.deepEqual([...new Set(frames.filter(frame => frame.frame === 'delta').map(frame => frame.channel))], ['reasoning-delta', 'text-delta'])
  assert.equal(frames.filter(frame => frame.channel === 'text-delta').map(frame => frame.text).join(''), 'answer')
  assert.ok(streamed.findIndex(action => action.op === 'stream' && action.frame === 'delta') < streamed.findIndex(action => action.type === 'assistant/message'))
  assert.equal(compile([turn('q', [step({ text: 'x', stream: false })])]).some(action => action.op === 'stream'), false)
})

test('outcomes, todos, edits, compaction, subagents, and asks compile to their events', () => {
  assert.equal(compile([turn('q', [step({ text: 'x' })], { outcome: { error: { message: 'boom', code: 'E' } } })]).at(-1).data.reason.error.message, 'boom')
  assert.equal(compile([turn('q', [step({ text: 'x' })], { outcome: 'interrupted' })]).at(-1).data.reason.kind, 'interrupted')
  assert.equal(types(compile([turn('q', [step({ text: 'x' })], { outcome: 'open' })])).includes('turn/end'), false)
  const todo = compile([turn('q', [step({ tools: [todos([['pending', 'a']])] })])])
  assert.deepEqual(todo.find(action => action.type === 'todo/write').data.todos, [{ status: 'pending', content: 'a' }])
  const edited = compile([turn('q', [step({ tools: [edit('f.txt', 'a', 'b')] })])]).find(action => action.type === 'tool/result')
  assert.deepEqual(edited.data.meta.diffs, [{ path: 'f.txt', oldText: 'a', newText: 'b' }])
  const compacted = compile([turn('q', [step({ text: 'x' }), { kind: 'compaction', ms: 100 }])])
  assert.deepEqual(compacted.filter(action => action.op.startsWith('compact')).map(action => action.op), ['compact-start', 'compact-finish'])
  const spawned = compile([turn('q', [step({ tools: [subagent('d', 'child prompt', { items: [step({ stream: false, text: 'c' })] })] })])])
  const child = spawned.find(action => action.op === 'child')
  assert.ok(spawned.some(action => action.session === child.id && action.type === 'user/message'))
  assert.match(spawned.find(action => action.type === 'tool/result' && action.session === undefined).data.message.content[0].text, new RegExp(child.id, 'u'))
  const asked = compile([turn('q', [step({ tools: [tool('bash', {}, { ask: approval('bash', 'why') }), tool('ask_user_question', {}, { ask: question([]) })] })])]).filter(action => action.op === 'ask')
  assert.deepEqual(asked.map(action => action.kind), ['approval', 'question'])
  assert.ok(asked.every(action => action.callId !== undefined))
})

/** A fake `ctx` for the driver: a recording session, children, emitted frames, and answerers. */
function fakeContext() {
  const log = { appended: [], frames: [], children: [], asked: [], goals: [], jobs: [], inbox: [], agents: [], opened: [], closed: [], disposed: [], notices: [] }
  let seq = 0
  const session = id => ({ id, header: { cwd: '/work' }, requestHeader: () => undefined, snapshotEvents: () => log.appended.filter(entry => entry.id === id).map(entry => ({ type: entry.type, seq: entry.seq, surfaceOp: entry.options?.surfaceOp })), append(type, data, options) { seq += 1; log.appended.push({ id, type, data, options, seq }); return { seq } } })
  const main = session('main')
  main.header = { cwd: '/work', agentPreset: 'default' }
  const agent = { id: 'main', session: main, inbox: { append: (target, message) => log.inbox.push(['append', target, message.content[0].text, message.id]), remove: id => log.inbox.push(['remove', id]) } }
  const answer = kind => async request => { log.asked.push({ kind, request }); return 'ok' }
  const ctx = {
    mayflyCurrentAgent: { current: () => agent },
    sessions: { create: (id, options) => { log.children.push({ id, options }); return session(id) } },
    on: () => {},
    emit: (name, payload) => log.frames.push({ name, frame: payload.frame }),
    get: name => ({
      approval: { request: answer('approval') },
      userQuestions: { ask: answer('question') },
      goals: {
        get: () => ({ id: 'g', revision: 1 }),
        create: (_agent, request) => log.goals.push(['create', request.objective]),
        block: (_agent, _view, reason) => log.goals.push(['block', reason.code]),
        complete: () => log.goals.push(['complete']),
        disarm: () => log.goals.push(['disarm']),
      },
      agents: { create: async options => { const created = { id: options.sessionId, session: session(options.sessionId) }; log.agents.push({ options, agent: created }); return { agent: created, dispose: async () => { log.disposed.push(options.sessionId) } } } },
      agentPresets: { mount: async () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      mayflyUiInteraction: { createNotificationOwner: label => ({ report: (id, scope, feedback) => log.notices.push(['report', label, id, scope.sessionId, feedback.severity, feedback.message, feedback.purpose]), clear: id => log.notices.push(['clear', id]) }) },
      mayflyConversations: { open: view => { log.opened.push(view); return `session:${view.sessionId}` }, close: id => log.closed.push(id) },
      jobs: { start: spec => { const handle = { appended: [], progress: [], append: text => handle.appended.push(text), updateProgress: line => handle.progress.push(line) }; const hooks = spec.run(handle); log.jobs.push({ spec, handle, hooks }) } },
    })[name],
  }
  return { ctx, log }
}

test('the driver plays a replay into the session and waits for answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'driver-test-'))
  const saved = { file: process.env.MAYFLY_REPLAY_FILE, speed: process.env.MAYFLY_REPLAY_SPEED, log: process.env.MAYFLY_REPLAY_LOG }
  try {
    const actions = compile([turn('q', [step({ reasoning: 'r', text: 't', tools: [
      subagent('d', 'p', { items: [step({ stream: false, text: 'c' })] }),
      tool('bash', {}, { ask: approval('bash', 'why'), result: 'ok' }),
      tool('ask_user_question', {}, { ask: question([{ id: 'a' }]), result: 'ok' }),
    ] })])])
    writeFileSync(join(dir, 'replay.json'), JSON.stringify([...actions, { at: 99_999, op: 'bogus' }, { at: 99_999, op: 'append', session: 'nowhere', type: 'turn/start', data: {} }]))
    Object.assign(process.env, { MAYFLY_REPLAY_FILE: join(dir, 'replay.json'), MAYFLY_REPLAY_SPEED: '1000000', MAYFLY_REPLAY_LOG: join(dir, 'driver.log') })
    const { ctx, log } = fakeContext()
    applyDriver(ctx)
    for (let tries = 0; tries < 200 && !readFileSyncSafe(join(dir, 'driver.log')).includes('replay finished'); tries += 1) await new Promise(resolve => setTimeout(resolve, 10))
    const text = readFileSyncSafe(join(dir, 'driver.log'))
    assert.match(text, /replay finished/u)
    assert.match(text, /unknown op bogus/u)
    assert.match(text, /no session nowhere/u)
    assert.deepEqual(log.appended.filter(entry => entry.id === 'main').map(entry => entry.type).slice(0, 5), ['turn/start', 'user/message', 'step/start', 'request/header', 'request/context'])
    assert.equal(log.appended.find(entry => entry.type === 'user/message').options.surfaceOp, 'append')
    assert.deepEqual(log.frames.map(entry => entry.frame.type).filter((type, index, all) => all.indexOf(type) === index), ['start', 'chunk', 'end'])
    assert.equal(log.children.length, 1)
    assert.equal(log.children[0].options.meta.origin, 'subagent')
    assert.ok(log.appended.some(entry => entry.id === log.children[0].id && entry.type === 'turn/start'))
    assert.deepEqual(log.asked.map(entry => entry.kind), ['approval', 'question'])
    assert.equal(log.asked[0].request.toolName, 'bash')
  } finally {
    for (const [key, name] of [['file', 'MAYFLY_REPLAY_FILE'], ['speed', 'MAYFLY_REPLAY_SPEED'], ['log', 'MAYFLY_REPLAY_LOG']]) {
      if (saved[key] === undefined) delete process.env[name]
      else process.env[name] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the driver does nothing without a replay and skips a session that already has turns', async () => {
  const saved = process.env.MAYFLY_REPLAY_FILE
  delete process.env.MAYFLY_REPLAY_FILE
  try {
    const { ctx, log } = fakeContext()
    assert.equal(applyDriver(ctx), undefined)
    assert.deepEqual(log.appended, [])
    const dir = mkdtempSync(join(tmpdir(), 'driver-skip-'))
    try {
      writeFileSync(join(dir, 'replay.json'), JSON.stringify(compile([turn('q', [step({ text: 'x' })])])))
      Object.assign(process.env, { MAYFLY_REPLAY_FILE: join(dir, 'replay.json'), MAYFLY_REPLAY_LOG: join(dir, 'driver.log') })
      const second = fakeContext()
      second.log.appended.push({ id: 'main', type: 'turn/start' })
      applyDriver(second.ctx)
      for (let tries = 0; tries < 100 && !readFileSyncSafe(join(dir, 'driver.log')).includes('skipped'); tries += 1) await new Promise(resolve => setTimeout(resolve, 10))
      assert.match(readFileSyncSafe(join(dir, 'driver.log')), /replay skipped/u)
      assert.equal(second.log.appended.length, 1)
    } finally {
      delete process.env.MAYFLY_REPLAY_LOG
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    if (saved === undefined) delete process.env.MAYFLY_REPLAY_FILE
    else process.env.MAYFLY_REPLAY_FILE = saved
  }
})

test('the stub model titles sessions and notices prompts, and every replay compiles', async () => {
  const stub = await startStubModel()
  const post = async body => {
    const response = await fetch(`${stub.baseURL}/v1/messages`, { method: 'POST', body: JSON.stringify(body) })
    return response.status === 200 ? (await response.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))).filter(event => event.delta?.type === 'text_delta').map(event => event.delta.text).join('') : response.status
  }
  try {
    assert.equal(await post({ messages: [] }), 'Replay session')
    assert.match(await post({ tools: [{ name: 'read' }] }), /replay session/u)
    assert.equal(await post({}), 'Replay session')
    assert.equal((await fetch(`${stub.baseURL}/v1/messages`)).status, 404)
  } finally {
    await stub.close()
  }
  for (const [name, replay] of Object.entries(REPLAYS)) {
    assert.ok(replay.summary && replay.items.length > 0, name)
    const actions = compile(replay.items)
    assert.ok(actions.length > 5, name)
    assert.ok(actions.every((action, index) => index === 0 || action.at >= actions[index - 1].at), `${name} is chronological`)
    const calls = actions.filter(action => action.type === 'tool/call').map(action => action.data.callId)
    const results = new Set(actions.filter(action => action.type === 'tool/result').map(action => action.data.message.toolCallId))
    assert.ok(calls.every(callId => results.has(callId)), `${name}: every call settles`)
  }
})

test('prepared tool calls, a first-token wait, and small gaps compile in order', () => {
  const actions = compile([turn('q', [
    step({ firstTokenMs: 2000, text: 'hello', prepareMs: 600, tools: [tool('read', { file_path: 'a' }, { result: 'x' })], gapMs: 10 }),
    step({ stream: false, text: 'next' }),
  ])])
  const start = actions.find(action => action.frame === 'start')
  const firstText = actions.find(action => action.channel === 'text-delta')
  assert.ok(firstText.at - start.at >= 2000)
  const prepare = actions.filter(action => action.channel === 'tool-call-delta')
  assert.equal(prepare[0].name, 'read')
  assert.equal(prepare.map(action => action.text).join(''), JSON.stringify({ file_path: 'a' }))
  assert.ok(prepare.at(-1).at <= actions.find(action => action.type === 'assistant/message').at)
  const stepEnd = actions.find(action => action.type === 'step/end')
  assert.ok(actions.filter(action => action.type === 'step/start')[1].at > stepEnd.at)
})

test('raw events, goals, jobs, images, and manual compaction compile to their actions', () => {
  const actions = compile([
    turn([{ type: 'text', text: 'see' }, image('a.png')], [raw('plan/mode', { active: true }), goal('create', { objective: 'o' }), job('j', { lines: [[10, 'x']], endMs: 20 }), step({ text: 'x' })]),
    { kind: 'compaction', manual: true, summary: 's' },
  ])
  assert.equal(actions.find(action => action.type === 'user/message').data.content[1].attachment.attachmentId, 'replay-a.png')
  assert.deepEqual(actions.find(action => action.type === 'plan/mode').data, { active: true })
  assert.equal(actions.find(action => action.op === 'goal').action, 'create')
  assert.equal(actions.find(action => action.op === 'job').label, 'j')
  const start = actions.find(action => action.op === 'compact-start')
  assert.ok(start.commandId !== undefined)
  assert.deepEqual(actions.filter(action => action.type === 'command/run' || action.type === 'command/done').map(action => action.type), ['command/run', 'command/done'])
  assert.equal(actions.find(action => action.op === 'compact-finish').commandId, start.commandId)
  assert.equal(compile([pause(100), turn('q', [step({ text: 'x' })])]).some(action => action.type === 'turn/start'), true)
})

test('the driver runs goals, jobs, compaction, and tool preparation against the services', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'driver-ops-'))
  const saved = { file: process.env.MAYFLY_REPLAY_FILE, speed: process.env.MAYFLY_REPLAY_SPEED, log: process.env.MAYFLY_REPLAY_LOG }
  try {
    const actions = compile([turn('q', [
      goal('create', { objective: 'o' }),
      goal('block', { code: 'c', message: 'm' }),
      job('j', { lines: [[1, 'out']], progress: [[1, 'p']], endMs: 5, status: 'failed', detail: 'boom' }),
      job('forever', {}),
      step({ text: 'a', prepareMs: 50, tools: [tool('read', {}, { result: 'x' })] }),
      { kind: 'compaction', summary: 'sum', ms: 20 },
      goal('complete'),
    ])])
    writeFileSync(join(dir, 'replay.json'), JSON.stringify(actions))
    Object.assign(process.env, { MAYFLY_REPLAY_FILE: join(dir, 'replay.json'), MAYFLY_REPLAY_SPEED: '1000000', MAYFLY_REPLAY_LOG: join(dir, 'driver.log') })
    const { ctx, log } = fakeContext()
    applyDriver(ctx)
    for (let tries = 0; tries < 300 && !readFileSyncSafe(join(dir, 'driver.log')).includes('replay finished'); tries += 1) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(log.goals.filter(entry => entry[0] !== 'disarm'), [['create', 'o'], ['block', 'c'], ['complete']])
    assert.equal(log.goals.filter(entry => entry[0] === 'disarm').length, 3)
    assert.equal(log.jobs[0].spec.label, 'j')
    assert.equal(log.jobs[0].spec.owner, 'main')
    assert.deepEqual(await log.jobs[0].hooks.done, { status: 'failed', detail: 'boom' })
    assert.deepEqual(log.jobs[0].handle.appended, ['out\n'])
    log.jobs[1].hooks.cancel('stop')
    assert.deepEqual(await log.jobs[1].hooks.done, { status: 'killed', detail: 'stop' })
    assert.ok(log.frames.some(entry => entry.frame.chunk?.type === 'tool-call-delta' && entry.frame.chunk.name === 'read'))
    const types = log.appended.filter(entry => entry.id === 'main').map(entry => entry.type)
    assert.ok(types.indexOf('compaction/start') < types.indexOf('compaction/summary'))
    const summary = log.appended.find(entry => entry.type === 'compaction/summary').data
    assert.equal(summary.shadowedRange.start, summary.shadowedSeqs[0])
    assert.deepEqual(log.appended.find(entry => entry.data?.source?.kind === 'compact-checkpoint').options.surfaceOp.op, 'replace')
  } finally {
    for (const [key, name] of [['file', 'MAYFLY_REPLAY_FILE'], ['speed', 'MAYFLY_REPLAY_SPEED'], ['log', 'MAYFLY_REPLAY_LOG']]) {
      if (saved[key] === undefined) delete process.env[name]
      else process.env[name] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('queued messages, failed attempts, side questions, and live children compile to their actions', () => {
  const queued = compile([turn('q', [queue(['next turn', { steer: 'next step' }], { holdMs: 500 }), step({ text: 'x' })])]).find(action => action.op === 'queue')
  assert.deepEqual(queued.rows, ['next turn', { steer: 'next step' }])
  assert.equal(queued.holdMs, 500)

  const noticed = compile([turn('q', [notify('warning', 'careful', { holdMs: 200, detail: 'more' }), step({ text: 'x' })])])
  const notice = noticed.find(action => action.op === 'notify')
  assert.deepEqual([notice.severity, notice.message, notice.detail], ['warning', 'careful', 'more'])
  assert.ok(noticed.find(action => action.type === 'step/start').at >= notice.at + 200)

  const retried = compile([turn('q', [step({ failedAttempts: [{ text: 'partial', delayMs: 100 }, { reasoning: 'again', delayMs: 100 }], text: 'done' })])])
  const retries = retried.filter(action => action.type === 'llm/retry')
  assert.deepEqual(retries.map(action => action.data.retry), [1, 2])
  assert.equal(new Set(retries.map(action => action.data.retryId)).size, 1)
  assert.deepEqual(retried.filter(action => action.type === 'llm/retry-started').map(action => action.data.retry), [1, 2])
  assert.equal(retried.filter(action => action.op === 'attempt').length, 2)
  assert.equal(retried.filter(action => action.eventType === 'assistant/attempt').length, 2)
  assert.ok(retried.findIndex(action => action.op === 'attempt') < retried.findIndex(action => action.type === 'assistant/message'))

  const side = compile([turn('q', [step({ text: 'x' })]), btw('why?', [step({ text: 'because' })], { label: 'short', closeAfterMs: 500 })])
  assert.equal(side.find(action => action.op === 'btw-open').label, 'short')
  assert.ok(side.some(action => action.session === 'btw' && action.type === 'user/message'))
  assert.ok(side.some(action => action.session === 'btw' && action.op === 'stream'))
  assert.equal(side.at(-1).op, 'btw-close')

  const spawned = compile([turn('q', [step({ tools: [subagent('d', 'p', { mode: 'continuable', live: true, items: [step({ text: 'c' })] })] })])])
  const child = spawned.find(action => action.op === 'child')
  assert.deepEqual([child.mode, child.live, child.label], ['continuable', true, 'd'])
  assert.ok(spawned.some(action => action.session === child.id && action.op === 'stream'))
})

test('the driver queues input without waking the agent, fails attempts, and runs side and live children', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'driver-agents-'))
  const saved = { file: process.env.MAYFLY_REPLAY_FILE, speed: process.env.MAYFLY_REPLAY_SPEED, log: process.env.MAYFLY_REPLAY_LOG }
  try {
    const actions = compile([
      turn('q', [
        queue(['later', { steer: 'now' }], { holdMs: 20 }),
        notify('error', 'broke', { holdMs: 20, purpose: 'progress' }),
        step({ failedAttempts: [{ text: 'partial', delayMs: 10, ms: 20 }], text: 'done' }),
        step({ stream: false, tools: [subagent('d', 'p', { mode: 'continuable', live: true, items: [step({ text: 'c' })] })] }),
      ]),
      btw('why?', [step({ text: 'because' })], { closeAfterMs: 10 }),
    ])
    writeFileSync(join(dir, 'replay.json'), JSON.stringify(actions))
    Object.assign(process.env, { MAYFLY_REPLAY_FILE: join(dir, 'replay.json'), MAYFLY_REPLAY_SPEED: '1000', MAYFLY_REPLAY_LOG: join(dir, 'driver.log') })
    const { ctx, log } = fakeContext()
    applyDriver(ctx)
    for (let tries = 0; tries < 400 && !readFileSyncSafe(join(dir, 'driver.log')).includes('replay finished'); tries += 1) await new Promise(resolve => setTimeout(resolve, 10))
    assert.match(readFileSyncSafe(join(dir, 'driver.log')), /replay finished/u)
    assert.deepEqual(log.inbox.filter(entry => entry[0] === 'append').map(entry => entry.slice(1, 3)), [['next-turn', 'later'], ['next-step', 'now']])
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.deepEqual(log.inbox.filter(entry => entry[0] === 'remove').map(entry => entry[1]).sort(), log.inbox.filter(entry => entry[0] === 'append').map(entry => entry[3]).sort())
    assert.deepEqual(log.notices[0], ['report', 'replay', 'replay-notice-' + log.notices[0][2].split('-').at(-1), 'main', 'error', 'broke', 'progress'])
    assert.deepEqual(log.notices[1], ['clear', log.notices[0][2]])
    const attempt = log.appended.find(entry => entry.type === 'assistant/attempt')
    assert.deepEqual(attempt.data.stream.map(record => record.type), ['text-chunks'])
    assert.equal(attempt.data.stream[0].texts.join(''), 'partial')
    assert.ok(log.frames.some(entry => entry.frame.type === 'end' && entry.frame.outcome.eventType === 'assistant/attempt' && entry.frame.outcome.seq === attempt.seq))
    assert.equal(log.agents.length, 2)
    const [liveChild, side] = log.agents.map(entry => entry.options)
    assert.equal(liveChild.meta.origin, 'subagent')
    assert.match(liveChild.sessionId, /^replay-child-1-/u)
    assert.ok(log.appended.some(entry => entry.type === 'subagent/catalog' && entry.data.mode === 'continuable' && entry.data.childId === liveChild.sessionId))
    assert.match(side.sessionId, /^btw-replay-/u)
    assert.deepEqual([log.opened[0].kind, log.opened[0].parentSessionId, log.opened[0].label], ['btw', 'main', 'why?'])
    assert.deepEqual(log.closed, [`session:${side.sessionId}`])
    // Each agent counts its own frames from 1: interleaved agents never share a sequence.
    const firstRevision = id => log.frames.find(entry => entry.frame.type === 'start' && entry.frame.attemptId.includes(id)).frame.revision
    assert.deepEqual([firstRevision('main'), firstRevision(liveChild.sessionId), firstRevision(side.sessionId)], [1, 1, 1])
  } finally {
    for (const [key, name] of [['file', 'MAYFLY_REPLAY_FILE'], ['speed', 'MAYFLY_REPLAY_SPEED'], ['log', 'MAYFLY_REPLAY_LOG']]) {
      if (saved[key] === undefined) delete process.env[name]
      else process.env[name] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
