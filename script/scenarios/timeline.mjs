/**
 * Replay timelines: a conversation written as turns, steps, and tools, compiled into the flat, chronological list of
 * actions the replay driver plays inside a running `dsh`. Nothing here talks to a model or runs a tool; the actions
 * are the session events and stream frames the agent loop would have produced. Every effect that happens later (a
 * job's output, a queued message withdrawn, a notice cleared) is an action of its own, so a run played as fast as
 * possible reaches the same states in the same order. Pure and deterministic.
 * @module script/scenarios/timeline
 */

const DEFAULT_USAGE = { inputTokens: 3200, outputTokens: 120, cacheReadTokens: 2400 }
/**
 * The results the Harness stores for a call that did not settle: a live Esc or Ctrl+C while it ran (`ABORTED`, dsh-tools
 * `toolAbortedResult`), a call cancelled before it was dispatched (`ABORTED_BEFORE_DISPATCH`), and a started call whose
 * session ended with no durable result, closed on resume (`TOOL_OUTCOME_UNKNOWN`, dsh-session `CLOSER_TEXT`).
 */
const CUT_SHORT = {
  aborted: { text: 'Error: tool call aborted', error: { name: 'AbortError', code: 'ABORTED' } },
  'before-dispatch': { text: 'Error: tool call aborted before dispatch', error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' } },
  unknown: { text: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.', error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } },
}

/**
 * A user turn: `prompt`, then the steps (and compactions) the agent took, ending with `outcome`: `'completed'` (the
 * default), `'interrupted'`, `'aborted'`, `{ error: { message, code } }`, or `'open'` for a turn that never ends.
 * `startAt` (`'HH:MM'` on the scenario's day, UTC, or milliseconds from the scenario epoch) stands the scenario clock
 * there when the turn starts, and everything after it follows from that time. Playback does not wait for it: only the
 * clock the session events are stamped with jumps, so a run under the runner shows `10:04` and a live run shows the
 * wall clock.
 */
export const turn = (prompt, items, options = {}) => ({ kind: 'turn', prompt, items, ...options })
/**
 * One model step. `reasoning` and `text` stream by default (`stream: false` commits them at once);
 * `tools` run after the message is committed. `failedAttempts` are provider attempts that fail before the one that
 * succeeds: `{ text, reasoning, failure: { message, code, status }, delayMs }`, each leaving its partial output, an
 * `assistant/attempt`, and the `llm/retry` records of the retry policy.
 */
export const step = (options = {}) => ({ kind: 'step', ...options })
/**
 * A tool call. `runMs` is how long it shows as running; `result` is its output (`error: true` marks a failure,
 * `meta` is the presenter's metadata: read lines, search matches, the fetch status). `unanswered` is a call that did not
 * settle, which gets the error result the Harness stores for it: `true` (or `'aborted'`) for an Esc or Ctrl+C while it ran
 * (turn outcome `'aborted'`), `'before-dispatch'` for a call cancelled before it was dispatched, and `'unknown'` for a
 * session that ended while it ran (turn outcome `'interrupted'`, closed on resume with an unknown outcome).
 */
export const tool = (name, args, options = {}) => ({ name, args, ...options })
/**
 * A file edit as the `edit` tool reports it: the diff shows `before` and `after` (the changed lines with whatever
 * context you include, as the tool sends them: three lines around each hunk). The call arguments carry the same text.
 */
export const edit = (path, before, after, options = {}) => tool('edit', { file_path: path, old_string: before, new_string: after }, { result: `Edited ${path}`, runMs: 500, meta: { diffs: [{ path, oldText: before, newText: after }] }, ...options })
/** A `replace_all` edit that changed several places: one `[before, after]` hunk per place, as the tool reports them. */
export const editHunks = (path, hunks, options = {}) => tool('edit', { file_path: path, old_string: hunks[0][0], new_string: hunks[0][1], replace_all: true }, { result: `Edited ${path} (${String(hunks.length)} replacements)`, runMs: 600, meta: { diffs: hunks.map(([before, after]) => ({ path, oldText: before, newText: after })) }, ...options })
/**
 * A file written by the `write` tool. A new file reports `operation: 'create'` and no hunks; an overwrite
 * (`options.meta: { operation: 'update', diffs }`) reports the hunks against the old file.
 */
export const write = (path, content, options = {}) => tool('write', { file_path: path, content }, { result: `Wrote ${path}`, runMs: 500, meta: { operation: 'create', diffs: [] }, ...options })
/** A todo-list update, as the `todo_write` tool makes it. */
export const todos = (list, options = {}) => tool('todo_write', { todos: list.map(([status, content]) => ({ status, content })) }, { result: 'Todos updated', runMs: 200, todos: list, ...options })
/**
 * A subagent spawned by a tool call: the child session plays `child` (`prompt`, `items`, `outcome`, `startMs`).
 * `options.toolArgs` adds tool arguments, such as `run_in_background: true`, to the call.
 */
export const subagent = (description, prompt, child, options = {}) => {
  const { toolArgs, ...rest } = options
  return tool('subagent', { description, prompt, ...toolArgs }, { runMs: 400, child: { prompt, ...child }, ...rest })
}
/**
 * A compaction between steps (inside a turn): running for `ms`, then settled with `summary`. `manual: true` makes it the
 * result of a `/compact` command (the command row opens first and closes after).
 */
export const compaction = (options = {}) => ({ kind: 'compaction', ...options })
/**
 * Any session event the product reacts to (`plan/mode`, `permission/preset`, `goal/change`, `request/header`, ...),
 * appended where it stands in the timeline. `surface: true` marks a message-producing event as part of the surface.
 */
export const raw = (type, data, options = {}) => ({ kind: 'raw', type, data, ...options })
/**
 * A change to the session goal through the real goal service (`create`, `pause`, `resume`, `block`, `complete`,
 * `clear`), which writes the `goal/change` events itself. The goal is disarmed afterwards, so nothing continues it.
 * `ifNeeded` skips the verb when the goal is already active (the viewer pressed the panel's button first).
 */
export const goal = (action, options = {}) => ({ kind: 'goal', action, ...options })
/**
 * One autonomous goal round starting: the `user/message` the round driver would write for the current goal (attributed to
 * it, with the round prompt), so the stream shows its round marker. The replay never arms the goal, so the driver
 * itself writes nothing. `round` is the next admitted round of the goal.
 */
export const goalRound = (round) => ({ kind: 'goal-round', round })
/**
 * A background job in the real job registry, with no process behind it: it prints `lines` (`[afterMs, text]` pairs)
 * and settles after `endMs` as `completed`, `failed`, or `killed`; omit `endMs` for a job that keeps running.
 */
export const job = (label, options = {}) => ({ kind: 'job', label, ...options })
/**
 * Messages typed while the agent is busy, shown as rows at the end of the stream: `rows` are `text` for a `⏎ queued` row
 * (next turn) or `{ steer: text }` for a `⏎ steering` row (next step). They enter the inbox without waking the agent and
 * leave it after `holdMs` (the agent reading them: the session records each as a prompt), so the session never ends with pending input. `holdMs: null`
 * keeps them until a later `dequeue(name)` (the agent reading them), so a scenario's keys act on them first.
 */
export const queue = (rows, { holdMs = 4000, name } = {}) => ({ kind: 'queue', rows, holdMs, name })
/** The agent reads messages of a `queue(rows, { name })`: all of them, or those at the `indexes` (they leave the inbox and become prompts; one the reader already took out stays out). */
export const dequeue = (name, ...indexes) => ({ kind: 'dequeue', name, indexes })
/**
 * A side question (`/btw`) answered by a live Agent of its own: the replay opens it as the displayed side conversation
 * and plays `items` into it (dismiss it with F7 or `/btw`). `closeAfterMs` dismisses it by itself.
 */
export const btw = (question, items, { label = question, outcome, closeAfterMs } = {}) => ({ kind: 'btw', question, items, label, outcome, closeAfterMs })
/**
 * A notice in the notification pane above the editor (`info`, `success`, `warning`, or `error`), through the product's own
 * notification lane. `purpose: 'progress'` marks a running operation; the notice clears itself after `holdMs`.
 */
export const notify = (severity, message, { holdMs = 3500, detail, purpose, marks = [] } = {}) => ({ kind: 'notify', severity, message, holdMs, detail, purpose, marks })
/** An image in a prompt: `turn([text('see'), image('shot.png')], ...)`. */
export const text = value => ({ type: 'text', text: value })
export const image = (name, { width = 1280, height = 720, bytes = 84_000 } = {}) => ({ type: 'image', attachment: { attachmentId: `replay-${name}`, mediaType: 'image/png', bytes, width, height, name } })
/**
 * Earlier conversations in the session store, written where the item stands: each session `{ id, at, items, title,
 * cwd, parent, provider, model }` is created `at` milliseconds from the start of playback (negative for the past) in the
 * workspace, or in its sibling directory `cwd`, under the seeded session `parent`, holds the turns `items` (committed at
 * once, at their own times, by the replay's model unless `provider` and `model` name another) and an optional
 * user-given `title`, and is released afterwards: `/sessions` lists it as stored, not
 * live. Seeded sessions need an isolated session store (the scenario runner gives every run one).
 */
export const seed = sessions => ({ kind: 'seed', sessions })
/** Wait before the next item. */
export const pause = ms => ({ kind: 'pause', ms })
/** A named point of the timeline: a scenario plays up to it (`play({ until: name })`) and takes a checkpoint there. */
export const mark = name => ({ kind: 'mark', name })
/**
 * A permission question for a tool call (`tool(..., { ask: approval('bash', 'why') })`); the replay waits for the answer.
 * With `{ queued: true }` the ask is put at once and the replay waits for the answers of all the queued asks before it goes
 * on, so several calls of one step wait on the user together.
 */
export const approval = (toolName, reason, options = {}) => ({ kind: 'approval', toolName, reason, ...options })
/** Questions for the user during a tool call (`tool('ask_user_question', ..., { ask: question([...]) })`); the replay waits for the answer. */
export const question = questions => ({ kind: 'question', questions })

/** The scenario epoch is 09:00 UTC (`clock.mjs`); a `'HH:MM'` start is a time of that day. */
const EPOCH_MINUTES = 9 * 60
const clockMs = (at) => {
  if (typeof at === 'number') return at
  const match = /^(\d{1,2}):(\d{2})$/.exec(at)
  if (match === null) throw new Error(`startAt must be 'HH:MM' or milliseconds, not ${JSON.stringify(at)}`)
  return (Number(match[1]) * 60 + Number(match[2]) - EPOCH_MINUTES) * 60_000
}

const spread = (text, chunk) => {
  const points = Array.from(text)
  const out = []
  for (let at = 0; at < points.length; at += chunk) out.push(points.slice(at, at + chunk).join(''))
  return out
}

/**
 * Compile timeline items into actions.
 * @param items - the turns and standalone items of the replay.
 * @param options - `model` and `contextWindow` for the header; `cwd` for child sessions.
 * @returns actions `{ at, op, ... }` sorted by `at` (stable), `at` in milliseconds from the start of playback.
 */
export function compile(items, { provider = 'deepseek-official', model = 'deepseek-flash', contextWindow = 131072 } = {}) {
  const actions = []
  /** Milliseconds the scenario clock runs ahead of the playback time since the last `startAt`. */
  let skew = 0
  let messageSeq = 0
  let callSeq = 0
  let childSeq = 0
  /** Sessions with a live Agent, whose output also streams. */
  const live = new Set()
  const id = prefix => `replay-${prefix}-${String(++messageSeq)}`
  /** The ids of the named queues, for a later `dequeue`. */
  const queues = new Map()

  const push = (at, op) => actions.push({ at: Math.round(at), ...(skew === 0 ? {} : { skew }), ...op })

  /** A job starts, prints its lines and progress, and settles, each at its own time. */
  function scheduleJob(item, t) {
    const jobId = `replay-job-${String(++messageSeq)}`
    push(t, { op: 'job', jobId, label: item.label, jobKind: item.jobKind })
    for (const [ms, line] of item.lines ?? []) push(t + ms, { op: 'job-line', jobId, text: line })
    for (const [ms, line] of item.progress ?? []) push(t + ms, { op: 'job-progress', jobId, line })
    if (item.endMs !== undefined) push(t + item.endMs, { op: 'job-end', jobId, status: item.status ?? 'completed', detail: item.detail })
  }
  /** Queued messages enter the inbox, then leave it after their hold. */
  function scheduleQueue(item, t) {
    const ids = item.rows.map(() => id('queued'))
    const texts = item.rows.map(row => typeof row === 'object' && row !== null ? row.steer : row)
    push(t, { op: 'queue', ids, rows: item.rows })
    if (item.name !== undefined) queues.set(item.name, { ids, texts })
    if (item.holdMs !== null) push(t + item.holdMs, { op: 'queue-clear', ids, texts })
  }
  /** The agent reads queued messages: they leave the inbox and the session records them as prompts. */
  function scheduleDequeue(item, t) {
    const held = queues.get(item.name) ?? { ids: [], texts: [] }
    const picked = item.indexes.length === 0 ? held.ids.map((_, index) => index) : item.indexes
    push(t, { op: 'queue-clear', ids: picked.map(index => held.ids[index]), texts: picked.map(index => held.texts[index]) })
  }
  /** A notice shows, then clears after its hold. */
  function scheduleNotice(item, t) {
    const noticeId = id('notice')
    push(t, { op: 'notify', noticeId, severity: item.severity, message: item.message, detail: item.detail, purpose: item.purpose })
    push(t + item.holdMs, { op: 'notify-clear', noticeId })
    // A mark stops playback while the notice shows (`marks: [{ name, at: 0.5 }]`, `at` a share of `holdMs`).
    for (const point of item.marks ?? []) push(t + item.holdMs * point.at, { op: 'mark', name: point.name })
  }

  /** Compile one conversation (the main one or a child) into `session`; returns the clock at its end. */
  function conversation(list, start, session) {
    let t = start
    let turnNo = 0
    const sessionOp = session === null ? {} : { session }
    const event = (at, type, data, surface = false, extra = {}) => push(at, { op: 'append', ...sessionOp, type, data, ...(surface ? { surface: 'append' } : {}), ...extra })
    // A stored log only loads when the request header sits inside an open turn, so the first step writes it.
    let header = false
    const writeHeader = (at) => {
      if (header) return
      header = true
      event(at, 'request/header', { header: { config: { provider, model, reasoningEffort: 'high' } }, reason: 'initial' })
      // A provider that advertises no window (`contextWindow: null`) writes no route record; the footer then shows no meter.
      if (contextWindow !== null) event(at + 1, 'request/context', { provider, model, contextWindow })
    }
    t += 200
    for (const item of list) {
      if (item.kind === 'pause') { t += item.ms; continue }
      if (item.kind === 'raw') { event(t, item.type, item.data, item.surface === true); t += 100; continue }
      if (item.kind === 'goal') { push(t, { op: 'goal', ...item }); t += 200; continue }
      if (item.kind === 'goal-round') { push(t, { op: 'goal-round', round: item.round }); t += 200; continue }
      if (item.kind === 'mark') { push(t, { op: 'mark', name: item.name }); continue }
      if (item.kind === 'job') { scheduleJob(item, t); t += 100; continue }
      if (item.kind === 'queue') { scheduleQueue(item, t); t += 100; continue }
      if (item.kind === 'dequeue') { scheduleDequeue(item, t); t += 100; continue }
      if (item.kind === 'notify') { scheduleNotice(item, t); t += item.holdMs + 300; continue }
      if (item.kind === 'seed') { push(t, { op: 'seed', sessions: item.sessions.map(seeded) }); t += 100; continue }
      if (item.kind === 'btw') {
        // A side question: a live Agent of its own, opened as a side conversation and played like any other.
        live.add('btw')
        push(t, { op: 'btw-open', id: 'btw', label: item.label })
        t = conversation([turn(item.question, item.items, { outcome: item.outcome })], t + 300, 'btw')
        if (item.closeAfterMs !== undefined) { push(t + item.closeAfterMs, { op: 'btw-close', id: 'btw' }); t += item.closeAfterMs }
        continue
      }
      if (item.kind === 'compaction') { t = compact(item, t, session, null, event); continue }
      turnNo += 1
      t = runTurn(item, turnNo, t + (item.gapMs ?? 600), event, session, writeHeader)
    }
    return t
  }

  /**
   * A compaction replaces the current surface with a checkpoint, so it names real event seqs: the driver writes the
   * three events (`compact-start`, then `compact-finish` after `ms`) once it can read the session.
   */
  function compact(item, t, session, turnNo, event) {
    const compactionId = `replay-compaction-${String(++messageSeq)}`
    const sessionOp = session === null ? {} : { session }
    const commandId = item.manual === true ? `replay-command-${String(messageSeq)}` : undefined
    const ids = { ...sessionOp, compactionId, commandId, turn: turnNo }
    if (commandId !== undefined) event(t, 'command/run', { commandId, name: 'compact', source: { kind: 'user' } })
    push(t + 50, { op: 'compact-start', ...ids })
    // Summarizing lasts `ms`; the summary lands, and applying lasts `applyMs` until the end record. A mark stops playback part-way through a stage (`marks: [{ name, stage: 'summarize' | 'apply', at: 0.5 }]`).
    const summaryAt = t + 50 + (item.ms ?? 1800)
    const end = summaryAt + (item.applyMs ?? 20)
    for (const point of item.marks ?? []) push(point.stage === 'apply' ? summaryAt + (item.applyMs ?? 20) * point.at : t + 50 + (item.ms ?? 1800) * point.at, { op: 'mark', name: point.name })
    if (item.error !== undefined) {
      // A failed attempt records no summary: the end record carries the reason.
      push(summaryAt, { op: 'compact-end', ...ids, error: item.error })
      if (commandId !== undefined) event(summaryAt + 100, 'command/done', { commandId, kind: 'error', text: item.error })
      return summaryAt + 300
    }
    push(summaryAt, { op: 'compact-finish', ...ids, provider, model, summary: item.summary ?? 'Earlier work was summarised.', shadowedTokens: item.shadowedTokens ?? 18_000, summaryTokens: item.summaryTokens ?? 600 })
    push(end, { op: 'compact-end', ...ids })
    if (commandId !== undefined) event(end + 100, 'command/done', { commandId, kind: 'success', text: item.detail ?? 'Compacted the conversation.' })
    return end + 300
  }

  function runTurn(spec, turnNo, start, event, session, writeHeader) {
    let t = start
    if (spec.startAt !== undefined) skew = clockMs(spec.startAt) - Math.round(t)
    event(t, 'turn/start', { turn: turnNo })
    if (spec.prompt !== undefined) event(t + 100, 'user/message', { id: id('user'), role: 'user', content: typeof spec.prompt === 'string' ? [{ type: 'text', text: spec.prompt }] : spec.prompt, source: { kind: 'user' } }, true)
    t += 300
    let stepNo = 0
    for (const item of spec.items) {
      if (item.kind === 'pause') { t += item.ms; continue }
      if (item.kind === 'raw') { event(t, item.type, item.data, item.surface === true); t += 100; continue }
      if (item.kind === 'goal') { push(t, { op: 'goal', ...item }); t += 200; continue }
      if (item.kind === 'goal-round') { push(t, { op: 'goal-round', round: item.round }); t += 200; continue }
      if (item.kind === 'mark') { push(t, { op: 'mark', name: item.name }); continue }
      if (item.kind === 'job') { scheduleJob(item, t); t += 100; continue }
      if (item.kind === 'queue') { scheduleQueue(item, t); t += 100; continue }
      if (item.kind === 'dequeue') { scheduleDequeue(item, t); t += 100; continue }
      if (item.kind === 'notify') { scheduleNotice(item, t); t += item.holdMs + 300; continue }
      if (item.kind === 'compaction') { t = compact(item, t, session, turnNo, event); continue }
      stepNo += 1
      t = runStep(item, turnNo, stepNo, t, event, session, writeHeader)
    }
    const outcome = spec.outcome ?? 'completed'
    // An open turn never ends: a subagent that is still running, or waiting to start.
    if (outcome === 'open') return t + 200
    const reason = typeof outcome === 'string' ? { kind: outcome } : { kind: 'error', error: { message: outcome.error.message, code: outcome.error.code ?? '' } }
    event(t + 100, 'turn/end', { turn: turnNo, reason })
    return t + 200
  }

  function runStep(spec, turnNo, stepNo, start, event, session, writeHeader) {
    let t = start
    event(t, 'step/start', { turn: turnNo, step: stepNo })
    writeHeader(t + 20)
    t += 150
    const streamed = spec.stream !== false && (session === null || live.has(session))
    const via = session === null ? {} : { session }
    // One retry chain per step: every retry of a policy keeps the chain's id.
    const retryId = `replay-retry-${String(++messageSeq)}`
    ;(spec.failedAttempts ?? []).forEach((attempt, index) => {
      const partial = [...(attempt.reasoning === undefined ? [] : [{ channel: 'reasoning-delta', text: attempt.reasoning }]), ...(attempt.text === undefined ? [] : [{ channel: 'text-delta', text: attempt.text }])]
      const total = attempt.ms ?? 1200
      if (streamed) {
        push(t, { op: 'stream', ...via, frame: 'start', turn: turnNo, step: stepNo })
        partial.forEach((block, blockIndex) => {
          const parts = spread(block.text, spec.chunk ?? 14)
          parts.forEach((part, partIndex) => push(t + (total * partIndex) / parts.length, { op: 'stream', ...via, frame: 'delta', channel: block.channel, block: blockIndex, text: part }))
        })
      }
      t += total
      push(t, { op: 'attempt', ...via, turn: turnNo, step: stepNo, reasoning: attempt.reasoning, text: attempt.text, ms: total })
      if (streamed) push(t, { op: 'stream', ...via, frame: 'end', eventType: 'assistant/attempt' })
      const failure = { message: attempt.failure?.message ?? 'The provider is overloaded', code: attempt.failure?.code ?? 'overloaded', status: attempt.failure?.status ?? 529 }
      const delayMs = attempt.delayMs ?? 1500
      event(t + 100, 'llm/retry', { retryId, turn: turnNo, step: stepNo, provider, mode: 'normal', policyKey: 'replay-policy', retry: index + 1, maxRetries: 5, delayMs, failure })
      // A `retry` mark stops playback while the retry waits (`marks: [{ name, block: 'retry', attempt: 0, at: 0.3 }]`).
      for (const point of spec.marks ?? []) if (point.block === 'retry' && (point.attempt ?? 0) === index) push(t + 100 + delayMs * point.at, { op: 'mark', name: point.name })
      t += 100 + delayMs
      event(t, 'llm/retry-started', { retryId, turn: turnNo, step: stepNo, retry: index + 1 })
      t += 100
    })
    const blocks = []
    if (spec.reasoning !== undefined) blocks.push({ type: 'reasoning', text: spec.reasoning })
    if (spec.text !== undefined) blocks.push({ type: 'text', text: spec.text })
    const calls = (spec.tools ?? []).map(call => ({ ...call, callId: `replay-call-${String(++callSeq)}` }))
    const preparing = streamed && spec.prepareMs !== undefined && calls.length > 0
    if (streamed && (blocks.length > 0 || preparing)) {
      push(t, { op: 'stream', ...via, frame: 'start', turn: turnNo, step: stepNo })
      // The attempt shows "waiting" until the first token arrives (a `wait` mark stops playback inside it).
      for (const point of spec.marks ?? []) if (point.block === 'wait') push(t + (spec.firstTokenMs ?? 0) * point.at, { op: 'mark', name: point.name })
      t += spec.firstTokenMs ?? 0
      for (const block of blocks) {
        const channel = block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta'
        const parts = spread(block.text, spec.chunk ?? 14)
        const total = block.type === 'reasoning' ? (spec.reasoningMs ?? Math.min(7000, Math.max(900, block.text.length * 12))) : (spec.textMs ?? Math.min(6000, Math.max(500, block.text.length * 8)))
        parts.forEach((part, index) => push(t + (total * index) / parts.length, { op: 'stream', ...via, frame: 'delta', channel, block: blocks.indexOf(block), text: part }))
        // A mark inside a block stops playback part-way through it (`marks: [{ name, block: 'text', at: 0.5 }]`; the blocks are `reasoning`, `text`, `wait` for the first token, `prepare` for a call's arguments, and `tool` for a call running; `call` picks the call of the step, the first by default).
        for (const point of spec.marks ?? []) if (point.block === block.type) push(t + total * point.at, { op: 'mark', name: point.name })
        t += total
      }
      if (preparing) {
        // The model writes each call's arguments before the call is committed: the activity row names the tool.
        for (const call of calls) {
          for (const point of spec.marks ?? []) if (point.block === 'prepare' && (point.call ?? 0) === calls.indexOf(call)) push(t + spec.prepareMs * point.at, { op: 'mark', name: point.name })
          const parts = spread(JSON.stringify(call.args ?? {}), spec.chunk ?? 14)
          parts.forEach((part, index) => push(t + (spec.prepareMs * index) / parts.length, { op: 'stream', ...via, frame: 'delta', channel: 'tool-call-delta', callId: call.callId, name: index === 0 ? call.name : undefined, text: part }))
          t += spec.prepareMs
        }
      }
    } else {
      t += spec.waitMs ?? 400
    }
    const content = [...blocks, ...calls.map(call => ({ type: 'tool-call', id: call.callId, name: call.name, arguments: JSON.stringify(call.args ?? {}) }))]
    event(t, 'assistant/message', {
      turn: turnNo,
      step: stepNo,
      message: { id: id('assistant'), role: 'assistant', content, source: { kind: 'model', provider, model } },
      stream: [],
      usage: { ...DEFAULT_USAGE, ...(spec.usage ?? {}) },
    }, true, spec.reasoning === undefined ? {} : { streamTiming: { reasoning: spec.reasoning, text: spec.text, reasoningMs: spec.reasoningMs ?? Math.min(7000, Math.max(900, spec.reasoning.length * 12)) } })
    if (streamed && (blocks.length > 0 || preparing)) push(t, { op: 'stream', ...via, frame: 'end' })
    let last = t
    calls.forEach((call, index) => {
      const callAt = t + 100 + index * 60
      event(callAt, 'tool/call', { turn: turnNo, step: stepNo, callId: call.callId, name: call.name, arguments: JSON.stringify(call.args ?? {}) })
      const resultAt = callAt + (call.runMs ?? 600)
      // A `tool` mark stops playback while a call runs (the first, or the one a mark's `call` names); so does a `prepare` mark while its arguments stream.
      for (const point of spec.marks ?? []) if (point.block === 'tool' && (point.call ?? 0) === index) push(callAt + (call.runMs ?? 600) * point.at, { op: 'mark', name: point.name })
      if (call.ask !== undefined) push(callAt + 200, { op: 'ask', ...(session === null ? {} : { session }), callId: call.callId, toolName: call.name, ...call.ask })
      if (call.todos !== undefined) event(resultAt - 20, 'todo/write', { todos: call.todos.map(([status, content]) => ({ status, content })) })
      if (call.child !== undefined) {
        const childId = `replay-child-${String(++childSeq)}`
        const child = call.child
        if (child.live === true) live.add(childId)
        push(callAt + 50, { op: 'child', id: childId, parent: session, label: call.args?.description, mode: child.mode ?? 'one-shot', live: child.live === true })
        conversation([turn(child.prompt, child.items ?? [], { outcome: child.outcome })], callAt + 100 + (child.startMs ?? 300), childId)
        call.result ??= `started subagent ${childId}`
      }
      const resultData = (text, isError, meta) => ({
        turn: turnNo,
        step: stepNo,
        message: { id: id('tool'), role: 'tool', content: [{ type: 'text', text }], toolCallId: call.callId, isError, source: { kind: 'tool', callId: call.callId } },
        ...(meta === undefined ? {} : { meta }),
      })
      // A call that did not settle (`unanswered`) is closed the way the Harness stores it: an error result with the
      // failure code, then the step and turn ends. A stored step may not end with a started call unresolved.
      const cutShortData = () => {
        const cut = CUT_SHORT[call.unanswered === true ? 'aborted' : call.unanswered]
        if (cut === undefined) throw new Error(`unknown unanswered kind: ${String(call.unanswered)}`)
        return { ...resultData(cut.text, true), error: cut.error }
      }
      // `outcomes` are the results the call has for the other answers to its ask (`rejected`, `declined`, `revised`); the driver plays the one the answer picks.
      const variants = call.outcomes === undefined ? undefined : Object.fromEntries(Object.entries(call.outcomes).map(([key, outcome]) => [key, resultData(outcome.result, outcome.error === true, outcome.meta)]))
      if (call.unanswered !== undefined && call.unanswered !== false) event(resultAt, 'tool/result', cutShortData(), true)
      else event(resultAt, 'tool/result', resultData(call.result ?? '', call.error === true, call.meta), true, variants === undefined && call.ask === undefined ? {} : { ...variants === undefined ? {} : { variants }, answerOf: call.callId })
      last = Math.max(last, resultAt)
    })
    event(last + 100, 'step/end', { turn: turnNo, step: stepNo })
    // The gap counts from the step's end, so a small gap can never start the next step before it.
    return last + 100 + (spec.gapMs ?? 200)
  }

  /** A seeded session's events, at their own times: its turns compiled as a conversation of their own, then its title. */
  function seeded({ id: sessionId, at, items: turns, title, cwd, parent, provider: sessionProvider = provider, model: sessionModel = model }) {
    const events = compile(turns.map(item => item.kind === 'turn' ? { ...item, items: item.items.map(entry => entry.kind === 'step' ? { ...entry, stream: false } : entry) } : item), { provider: sessionProvider, model: sessionModel, contextWindow })
      .map((action) => {
        if (action.op !== 'append') throw new Error(`a seeded session holds turns only, not ${action.op}`)
        return { at: at + action.at, type: action.type, data: action.data, ...(action.surface === undefined ? {} : { surface: action.surface }) }
      })
    const end = events.at(-1)?.at ?? at
    if (title !== undefined) events.push({ at: end + 100, type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'user' } } })
    return { id: sessionId, createdAt: at, events, ...(cwd === undefined ? {} : { cwd }), ...(parent === undefined ? {} : { parent }) }
  }

  conversation(items, 0, null)
  return actions.map((action, index) => ({ action, index })).sort((left, right) => left.action.at - right.action.at || left.index - right.index).map(entry => entry.action)
}
