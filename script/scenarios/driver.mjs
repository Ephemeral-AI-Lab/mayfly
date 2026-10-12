/**
 * The replay driver: a Cordis plugin loaded into a running `dsh` through a `--patch` overlay. It plays a compiled
 * replay (see `timeline.mjs`) into the live session: session events, streamed assistant frames, child sessions, jobs,
 * notices, and approval or question prompts that wait for an answer. No model is called and no tool runs. Inert unless
 * `MAYFLY_REPLAY_FILE` names a replay.
 *
 * Without a control channel it plays on its timeline for a person watching (`MAYFLY_REPLAY_SPEED`, default 1). With
 * `MAYFLY_REPLAY_CONTROL` naming a Unix socket, a runner drives it with JSON lines: the driver reports `ready`, each
 * `mark` it pauses at, a pending `ask`, and `finished`; the runner sends `play` (`until` a mark, or to the end), which
 * plays as fast as the session takes the actions. When the scenario clock is loaded (`clock.mjs`), every action runs at
 * its timeline time and the clock stands still while playback is paused. `MAYFLY_REPLAY_LOG` receives one line per
 * action and every failure.
 * @module script/scenarios/driver
 */

import { randomBytes } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const name = 'mayfly-replay-driver'
export const inject = ['mayflyCurrentAgent', 'sessions']

/**
 * The session's current surface: the seqs of its appended surface events, with each replaced span collapsed into the
 * replacement that took its place, the way the compaction invariants count them.
 */
function surfaceNodes(session) {
  let nodes = []
  for (const event of session.snapshotEvents()) {
    const op = event.surfaceOp
    if (op === 'append') nodes.push(event.seq)
    else if (op !== undefined && op !== null && op.op === 'replace') {
      const from = nodes.indexOf(op.startSeq)
      const to = nodes.indexOf(op.endSeq)
      if (from >= 0 && to >= from) nodes = [...nodes.slice(0, from), event.seq, ...nodes.slice(to + 1)]
    }
  }
  return nodes
}

/** Start a job in the real registry with nothing behind it; its output and outcome arrive as later actions. */
function startJob(jobs, agent, action) {
  let job
  jobs.start({
    kind: action.jobKind ?? 'bash',
    label: action.label,
    owner: agent.id,
    run(handle) {
      let settle
      const done = new Promise(resolve => { settle = resolve })
      job = { handle, settle }
      return { cancel(reason) { settle({ status: 'killed', ...(reason === undefined ? {} : { detail: reason }) }) }, done }
    },
  })
  return job
}

/**
 * The runner's channel: JSON lines over a Unix socket. `next()` resolves with the next message from the runner; a
 * `sync` goes to `onSync` whenever it arrives, even after playback ended.
 * @returns {Promise<{ send(message: object): void, next(): Promise<object>, close(): void }>}
 */
function connectControl(path, onSync) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const queue = []
    const waiting = []
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (data) => {
      buffer += data
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (message.type === 'sync') { onSync(message.id); continue }
        const waiter = waiting.shift()
        if (waiter === undefined) queue.push(message)
        else waiter(message)
      }
    })
    socket.once('error', reject)
    socket.once('connect', () => resolve({
      send: message => { socket.write(`${JSON.stringify(message)}\n`) },
      next: () => queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise(done => waiting.push(done)),
      close: () => socket.end(),
    }))
  })
}

/** The compact stream records of a settled step: its reasoning (and answer) timed so the projection can read how long it thought. */
function settledStream({ reasoning, text, reasoningMs }) {
  const now = Date.now()
  const half = Math.ceil(reasoning.length / 2)
  const records = [{ type: 'reasoning-chunks', time0: now - reasoningMs, index: 0, dt: [reasoningMs], texts: [reasoning.slice(0, half), reasoning.slice(half)] }]
  if (text !== undefined && text !== '') records.push({ type: 'text-chunks', time0: now, index: 1, dt: [], texts: [text] })
  return records
}

export function apply(ctx) {
  const file = process.env.MAYFLY_REPLAY_FILE
  if (file === undefined || file === '') return
  const speed = Number(process.env.MAYFLY_REPLAY_SPEED ?? '1') || 1
  const controlPath = process.env.MAYFLY_REPLAY_CONTROL
  /** The scenario clock (`clock.mjs`), when the runner loaded it. */
  const clock = globalThis.__mayflyClock
  const logFile = process.env.MAYFLY_REPLAY_LOG
  const log = (message) => { if (logFile !== undefined && logFile !== '') appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`) }
  const abort = new AbortController()
  ctx.on('dispose', () => abort.abort())
  run().catch(error => log(`replay failed: ${String(error?.stack ?? error)}`))

  async function currentAgent() {
    while (!abort.signal.aborted) {
      let agent
      // A reload disposes this context; reading a service from it then throws, which ends this run.
      try { agent = ctx.mayflyCurrentAgent.current() } catch { return undefined }
      if (agent !== null && agent !== undefined) return agent
      await sleep(100).catch(() => {})
    }
    return undefined
  }

  async function run() {
    const actions = JSON.parse(readFileSync(file, 'utf8'))
    // A `sync` is answered once the work queued before it has run and a render is requested, so a runner that waits
    // for the screen to go quiet afterwards sees everything played so far.
    const control = controlPath === undefined || controlPath === '' ? undefined : await connectControl(controlPath, (id) => {
      void (async () => {
        for (let turn = 0; turn < 3; turn += 1) await sleep(0)
        try { ctx.get('mayflyScreen')?.requestRender() } catch { /* the context was disposed */ }
        control?.send({ type: 'synced', id })
      })()
    })
    if (control !== undefined) abort.signal.addEventListener('abort', () => control.close(), { once: true })
    const agent = await currentAgent()
    if (agent === undefined) return
    const main = agent.session
    // A restart resumes the session with its history: play only into a session that has not started a turn.
    if (main.snapshotEvents().some(event => event.type === 'turn/start')) { log('session already has turns; replay skipped'); control?.send({ type: 'finished', skipped: true }); return }
    clock?.freeze()
    // Under a runner, playback waits for `play` and pauses at the mark it names (or plays to the end), as fast as the
    // session takes it or, `timed`, at the replay's own pace.
    let until
    let timed = false
    const awaitPlay = async () => {
      clock?.freeze()
      const message = await control.next()
      if (message.type !== 'play') throw new Error(`unexpected control message ${JSON.stringify(message)}`)
      until = message.until ?? null
      timed = message.timed === true
    }
    if (control !== undefined) { control.send({ type: 'ready', actions: actions.length }); await awaitPlay() }
    const children = new Map()
    // Sessions that have a live Agent (a side question) stream through it; the others only receive events.
    const liveAgents = new Map()
    const handles = []
    abort.signal.addEventListener('abort', () => { for (const handle of handles) void handle.dispose().catch(() => {}) }, { once: true })
    const target = (action) => action.session === undefined || action.session === null ? main : children.get(action.session)
    const streamAgent = (action) => action.session === undefined || action.session === null ? agent : liveAgents.get(action.session)
    const lastSeqs = new Map()
    const streams = new Map()
    const jobsById = new Map()
    let notifier
    // Persisted sessions need new ids on every run, and the scenario clock repeats Date.now(), so the tag is random.
    const runTag = randomBytes(4).toString('hex')
    let previous = 0
    log(`replay start: ${String(actions.length)} actions at ${String(speed)}x`)

    for (const action of actions) {
      if (abort.signal.aborted) return
      if (control === undefined) {
        const wait = (action.at - previous) / speed
        previous = action.at
        if (wait > 0) await sleep(wait, undefined, { signal: abort.signal }).catch(() => {})
      } else {
        // As fast as the session takes it (yielding so the action before is painted), or at the replay's pace; either
        // way at the action's timeline time.
        const wait = timed ? action.at - previous : 0
        previous = action.at
        await sleep(wait, undefined, { signal: abort.signal }).catch(() => {})
        clock?.at(action.at + (action.skew ?? 0))
      }
      try {
        switch (action.op) {
          case 'mark': {
            log(`mark ${action.name}`)
            if (control !== undefined && action.name === until) { control.send({ type: 'mark', name: action.name }); await awaitPlay() }
            break
          }
          case 'append': {
            const session = target(action)
            if (session === undefined) { log(`no session ${action.session} for ${action.type}`); break }
            // The settled message carries the stream's own timing, so its reasoning keeps the duration it took.
            const data = action.streamTiming === undefined ? action.data : { ...action.data, stream: settledStream(action.streamTiming) }
            const event = action.surface === undefined ? session.append(action.type, data) : session.append(action.type, data, { surfaceOp: action.surface })
            lastSeqs.set(session, event.seq)
            log(`${action.session ?? 'main'} ${action.type}`)
            break
          }
          case 'stream': {
            const agent = streamAgent(action)
            if (agent === undefined) { log(`no live agent for ${action.session}`); break }
            const lastSeq = lastSeqs.get(agent.session) ?? 0
            // Each Agent counts its own attempts, revisions, and frames, so interleaved agents never share a sequence.
            const counters = streams.get(agent) ?? { attempt: 0, revision: 0, frameIndex: 0 }
            streams.set(agent, counters)
            const attemptId = `replay-${String(agent.id)}-attempt-${String(counters.attempt + (action.frame === 'start' ? 1 : 0))}`
            if (action.frame === 'start') {
              counters.attempt += 1
              counters.revision = 1
              counters.frameIndex = 0
              ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId, revision: counters.revision, turn: action.turn, step: action.step } })
            } else if (action.frame === 'delta') {
              counters.revision += 1
              const chunk = action.channel === 'tool-call-delta'
                ? { type: 'tool-call-delta', index: action.block ?? 0, id: action.callId, ...(action.name === undefined ? {} : { name: action.name }), argumentsDelta: action.text }
                : { type: action.channel, index: action.block, text: action.text }
              ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId, revision: counters.revision, index: counters.frameIndex, time: Date.now(), chunk } })
              counters.frameIndex += 1
            } else {
              counters.revision += 1
              ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId, revision: counters.revision, index: counters.frameIndex, outcome: { kind: 'committed', eventType: action.eventType ?? 'assistant/message', seq: lastSeq } } })
            }
            break
          }
          case 'attempt': {
            // A failed provider attempt commits no message; its partial output is embedded as compact stream records.
            const now = Date.now()
            const records = []
            const total = action.ms
            const record = (type, index, text) => {
              const pieces = text.match(/[\s\S]{1,14}/g) ?? []
              records.push({ type, time0: now - total, index, dt: pieces.map((_, i) => (i === 0 ? 0 : Math.round(total / pieces.length))), texts: pieces })
            }
            let index = 0
            if (action.reasoning !== undefined) record('reasoning-chunks', index++, action.reasoning)
            if (action.text !== undefined) record('text-chunks', index++, action.text)
            const session = target(action)
            const event = session.append('assistant/attempt', { turn: action.turn, step: action.step, stream: records })
            lastSeqs.set(session, event.seq)
            log('main assistant/attempt')
            break
          }
          case 'compact-start': {
            const session = target(action)
            session.append('compaction/start', { compactionId: action.compactionId, turn: action.turn, ...(action.commandId === undefined ? {} : { sourceCommandId: action.commandId }) })
            log(`compaction ${action.compactionId} started`)
            break
          }
          case 'compact-finish': {
            const session = target(action)
            const nodes = surfaceNodes(session)
            if (nodes.length === 0) { log('compaction has nothing to replace'); break }
            const start = nodes[0]
            const end = nodes.at(-1)
            session.append('compaction/summary', { compactionId: action.compactionId, ...(action.commandId === undefined ? {} : { sourceCommandId: action.commandId }), summary: [{ type: 'text', text: action.summary }], shadowedRange: { start, end }, shadowedSeqs: nodes, shadowedTokenCount: action.shadowedTokens, provider: action.provider, model: action.model })
            session.append('user/message', { id: `replay-checkpoint-${action.compactionId}`, role: 'user', content: [{ type: 'text', text: action.summary }], source: { kind: 'compact-checkpoint', compactionId: action.compactionId, ...(action.commandId === undefined ? {} : { sourceCommandId: action.commandId }) } }, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: nodes })
            session.append('compaction/end', { compactionId: action.compactionId, turn: action.turn, ...(action.commandId === undefined ? {} : { sourceCommandId: action.commandId }) })
            log(`compaction ${action.compactionId} replaced ${String(nodes.length)} nodes`)
            break
          }
          case 'goal': {
            const goals = ctx.get('goals')
            if (goals === undefined) { log('no goal service'); break }
            const view = goals.get(agent)
            if (action.action === 'create') goals.create(agent, { objective: action.objective, ...(action.maxGoalRounds === undefined ? {} : { maxGoalRounds: action.maxGoalRounds }) })
            else if (action.action === 'block') goals.block(agent, view, { code: action.code ?? 'needs-input', message: action.message ?? 'Blocked' })
            else goals[action.action](agent, view)
            // The service arms a goal for continuation; a replay only shows the state, so nothing may continue it.
            try { goals.disarm(agent) } catch { /* cleared goals have nothing to disarm */ }
            log(`goal ${action.action}`)
            break
          }
          case 'job': {
            const jobs = ctx.get('jobs')
            if (jobs === undefined) { log('no job service'); break }
            jobsById.set(action.jobId, startJob(jobs, agent, action))
            log(`job ${action.label} started`)
            break
          }
          case 'job-line': {
            jobsById.get(action.jobId)?.handle.append(`${action.text}\n`)
            break
          }
          case 'job-progress': {
            jobsById.get(action.jobId)?.handle.updateProgress(action.line)
            break
          }
          case 'job-end': {
            jobsById.get(action.jobId)?.settle({ status: action.status, ...(action.detail === undefined ? {} : { detail: action.detail }) })
            log(`job ${action.jobId} ${action.status}`)
            break
          }
          case 'queue': {
            // Pending input enters the inbox without waking the agent (`followup` would start a turn).
            action.rows.forEach((row, index) => {
              const steer = typeof row === 'object' && row !== null
              agent.inbox.append(steer ? 'next-step' : 'next-turn', { id: action.ids[index], role: 'user', content: [{ type: 'text', text: steer ? row.steer : row }], source: { kind: 'user' } })
            })
            log(`queue ${String(action.ids.length)} messages`)
            break
          }
          case 'queue-clear': {
            for (const id of action.ids) agent.inbox.remove(id)
            log(`queue cleared ${String(action.ids.length)} messages`)
            break
          }
          case 'notify': {
            const interaction = ctx.get('mayflyUiInteraction')
            if (interaction === undefined) { log('no notification lane'); break }
            notifier ??= interaction.createNotificationOwner('replay')
            notifier.report(action.noticeId, { kind: 'session', sessionId: String(agent.id) }, { message: action.message, severity: action.severity, ...(action.purpose === undefined ? {} : { purpose: action.purpose }), ...(action.detail === undefined ? {} : { detail: action.detail }) }, action.noticeId)
            log(`notice ${action.severity}: ${action.message}`)
            break
          }
          case 'notify-clear': {
            notifier?.clear(action.noticeId)
            break
          }
          case 'btw-open': {
            const agents = ctx.get('agents')
            const conversations = ctx.get('mayflyConversations')
            const presets = ctx.get('agentPresets')
            const defaultModel = ctx.get('agentDefaultModel')
            if (agents === undefined || conversations === undefined || presets === undefined || defaultModel === undefined) { log('no side conversation services'); break }
            const selected = main.requestHeader()?.config ?? defaultModel.currentSelection()
            const preset = main.header.agentPreset
            const handle = await agents.create({
              sessionId: `btw-replay-${runTag}`,
              meta: { cwd: main.header.cwd ?? process.cwd(), parentSession: agent.id },
              seed: [],
              signal: abort.signal,
              agentOptions: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) },
              setup: async agentCtx => { await presets.mount(agentCtx, preset) },
            })
            handles.push(handle)
            children.set(action.id, handle.agent.session)
            liveAgents.set(action.id, handle.agent)
            conversations.open({ kind: 'btw', sessionId: String(handle.agent.id), parentSessionId: String(agent.id), label: action.label })
            log(`btw ${action.id} opened as ${String(handle.agent.id)}`)
            break
          }
          case 'btw-close': {
            const conversations = ctx.get('mayflyConversations')
            const live = liveAgents.get(action.id)
            if (conversations !== undefined && live !== undefined) conversations.close(`session:${String(live.id)}`)
            log(`btw ${action.id} closed`)
            break
          }
          case 'child': {
            const parent = action.parent === undefined || action.parent === null ? main : children.get(action.parent)
            // A live child is persisted, so its id must be new on every run.
            const sessionId = `${action.id}-${runTag}`
            const meta = { cwd: main.header.cwd, createdAt: Date.now(), origin: 'subagent', parentSession: parent.id, delegationDepth: 1 }
            let session
            if (action.live === true) {
              // A continuable child with a live Agent: its view streams and takes replies, like the product's own.
              const agents = ctx.get('agents')
              const presets = ctx.get('agentPresets')
              const defaultModel = ctx.get('agentDefaultModel')
              if (agents === undefined || presets === undefined || defaultModel === undefined) { log('no agent services for a live child'); break }
              const selected = main.requestHeader()?.config ?? defaultModel.currentSelection()
              const preset = main.header.agentPreset
              const handle = await agents.create({
                sessionId,
                meta,
                seed: [],
                signal: abort.signal,
                agentOptions: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) },
                setup: async agentCtx => { await presets.mount(agentCtx, preset) },
              })
              handles.push(handle)
              session = handle.agent.session
              liveAgents.set(action.id, handle.agent)
            } else {
              session = ctx.sessions.create(sessionId, { meta })
            }
            children.set(action.id, session)
            // The child's own descriptor is what follow addresses and views identify it by.
            session.append('subagent/descriptor', { version: 3, mode: action.mode ?? 'one-shot', provider: main.requestHeader()?.config?.provider ?? 'deepseek-official', ...(action.label === undefined && action.mode !== 'continuable' ? {} : { label: action.label ?? action.id }) })
            // The parent's catalog is what `/agents` lists, and it fixes the child's mode.
            parent.append('subagent/catalog', { version: 0, childId: sessionId, childCreatedAt: meta.createdAt, mode: action.mode ?? 'one-shot', ...(action.label === undefined && action.mode !== 'continuable' ? {} : { label: action.label ?? action.id }) })
            log(`child ${action.id} created (${action.mode ?? 'one-shot'}${action.live === true ? ', live' : ''})`)
            break
          }
          case 'seed': {
            // Each seeded session is built outside the store (so nothing treats it as live or checkpoints it while it
            // is written), its events stamped at their own times, then written to the session persistence and
            // folded once by the projection cache: the listing shows it as stored, with its title, usage, and times.
            const persistence = ctx.get('sessionPersistence')
            const cache = ctx.get('sessionProjectionCache')
            if (persistence === undefined || cache === undefined) { log('no session persistence or projection cache to seed'); break }
            const ids = new Map()
            for (const spec of action.sessions) {
              const cwd = spec.cwd === undefined ? main.header.cwd : join(dirname(main.header.cwd), spec.cwd)
              const parentSession = spec.parent === undefined ? undefined : ids.get(spec.parent)
              clock?.at(spec.createdAt)
              const session = ctx.sessions.prepare(spec.id, { meta: { cwd, createdAt: Date.now(), ...(parentSession === undefined ? {} : { parentSession }) } })
              for (const event of spec.events) {
                clock?.at(event.at)
                if (event.surface === undefined) session.append(event.type, event.data)
                else session.append(event.type, event.data, { surfaceOp: event.surface })
              }
              const events = session.snapshotEvents()
              const handle = await persistence.create(session.header)
              await handle.append(events)
              await handle.flush()
              await handle.close()
              cache.coldSnapshot(session.header, 0, events)
              ids.set(spec.id, session.id)
              log(`seeded ${spec.id} (${String(events.length)} events)`)
            }
            clock?.at(action.at + (action.skew ?? 0))
            break
          }
          case 'ask': {
            log(`ask ${action.kind} waits for an answer`)
            const owner = action.session === undefined || action.session === null ? agent : undefined
            if (owner === undefined) break
            // The clock runs while an answer is awaited, as it does for a person; the runner answers with keys.
            clock?.flow()
            control?.send({ type: 'ask', kind: action.kind })
            if (action.kind === 'approval') await ctx.get('approval').request({ agent: owner, toolName: action.toolName, callId: action.callId, reason: action.reason, signal: abort.signal })
            else await ctx.get('userQuestions').ask({ agent: owner, questions: action.questions, signal: abort.signal })
            log('ask answered')
            break
          }
          default:
            log(`unknown op ${String(action.op)}`)
        }
      } catch (error) {
        log(`action failed: ${action.op} ${action.type ?? ''}: ${String(error?.stack ?? error)}`)
      }
    }
    log('replay finished')
    clock?.freeze()
    control?.send({ type: 'finished' })
  }
}
