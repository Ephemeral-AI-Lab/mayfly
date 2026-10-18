/**
 * The long-session fixture behind the Phase 7 work-budget rows W28 to W31: a deterministic 2,000-turn
 * `mayflyConversation` projection, the tool presenters that render its read, edit, bash, and subagent cards, a fake feed and
 * tick, and a harness that runs the real transcript controller against a real screen service.
 *
 * @module @ephemeral-ai/mayfly/tests/perf/long-session
 */

import type { ConversationEntry, ConversationImage, ConversationJson, ConversationProjection, ConversationToolEntry, ConversationTurn } from '../../src/conversation/types.ts'
import type { MayflyComponent } from '../../src/core/types.ts'
import type { LiveAssistantDraft } from '../../src/conversation/live-stream.ts'
import type { MayflyScreenService } from '../../src/core/screen.ts'
import type { MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { TranscriptModel } from '../../src/frontend/models.ts'
import type { ConversationFeed, ConversationFeedState, ConversationProjectionSource } from '../../src/transcript/conversation-feed.ts'
import { OfficialConversationModelSource } from '../../src/transcript/official-model.ts'
import type { ToolPresentationSource } from '../../src/transcript/present.ts'
import type { TickSource } from '../../src/transcript/tick.ts'
import { TranscriptController, type TranscriptControllerOptions, type TranscriptScreen } from '../../src/transcript/transcript-model.ts'

/** A deterministic epoch: turn times and draft times never read the wall clock. */
const EPOCH = 1_700_000_000_000

/** Milliseconds between two turn starts. */
const TURN_SPAN = 1_000

/** A read of one source file: the path and line window every read entry carries. */
const READ_PATH = 'src/session.ts'

const READ_TEXT = 'read src/session.ts'

const EDIT_TEXT = 'edited src/session.ts'

const SUBAGENT_TEXT = 'subagent review complete'

const USER_TEXT = 'Continue the long session.'

const THINKING_TEXT = 'Checking the latest tool output and the pending work before continuing.'

const ASSISTANT_TEXT = 'I read the session state, applied the edit, and ran the checks.'

const SUBAGENT_DESCRIPTION = 'Review the long session'

const READ_LINES = Array.from({ length: 8 }, (_, index) => ({ number: index + 1, text: `const line ${String(index + 1)} = compute(${String(index + 1)})` }))

const READ_META = { path: READ_PATH, offset: 1, lines: READ_LINES, totalLines: 128 }

const READ_META_JSON = READ_META as unknown as ConversationJson

/** The two hunks an edit result carries; both presenters share the same frozen facts. */
const EDIT_HUNKS = [
  { oldText: 'export function run(input: string): string {\n  return input.trim()\n}', newText: 'export function run(input: string): string {\n  return input.trimEnd()\n}' },
  { oldText: 'const retry = 2\nconst delay = 10\nexport { retry, delay }', newText: 'const retry = 3\nconst delay = 20\nexport { retry, delay }' },
]

const EDIT_ARGUMENTS = JSON.stringify({ path: READ_PATH, edits: EDIT_HUNKS })

const READ_ARGUMENTS = JSON.stringify({ file_path: READ_PATH, offset: 1, limit: READ_LINES.length })

/** A forty-line command, the size the command card keeps as input rows. */
const BASH_COMMAND = Array.from({ length: 40 }, (_, index) => `printf 'check ${String(index + 1)}\\n'`).join('\n')

/** Forty output lines, the size the command card keeps as preview rows. */
const BASH_OUTPUT = Array.from({ length: 40 }, (_, index) => `check ${String(index + 1)} ok`).join('\n')

const BASH_ARGUMENTS = JSON.stringify({ command: BASH_COMMAND })

const SUBAGENT_ARGUMENTS = JSON.stringify({ description: SUBAGENT_DESCRIPTION, prompt: 'Review the session projection fixtures and report the work they do.' })

const BASH_META = { output: BASH_OUTPUT, exitCode: 0 }

const EDIT_META = { path: READ_PATH, operation: 'update' }

const SUBAGENT_META = { description: SUBAGENT_DESCRIPTION }

const TEXT_CONTENT: readonly ConversationJson[] = Object.freeze([{ type: 'text', text: 'ok' }])

const NO_IMAGES: readonly ConversationImage[] = Object.freeze([])

const NO_PROJECTIONS: ConversationProjectionSource = Object.freeze({
  snapshot: () => ({ asOfSeq: 0, values: {} }),
  onChanged: () => () => {},
})

const READY: ConversationFeedState = Object.freeze({ kind: 'ready' })

const NO_QUEUED: readonly { readonly id: string, readonly text: string, readonly lane: 'turn' | 'step' }[] = Object.freeze([])

function translate(key: string): string { return key }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function pathOf(args: unknown): string {
  const value = record(args)['path'] ?? record(args)['file_path']
  return typeof value === 'string' && value !== '' ? value : READ_PATH
}

function commandOf(args: unknown): string {
  const value = record(args)['command']
  if (typeof value !== 'string' || value === '') return 'bash checks'
  return value.split('\n')[0] ?? 'bash checks'
}

function editDiffs(path: string): readonly { readonly path: string, readonly oldText: string, readonly newText: string }[] {
  return EDIT_HUNKS.map(hunk => ({ path, oldText: hunk.oldText, newText: hunk.newText }))
}

/**
 * The tool presenters the long-session cards use: reads as a read card, edits as two diff hunks, bash as a terminal card,
 * and the subagent as a generic card. The upstream view types are structural, so the returns use the spec's `as never`
 * casts.
 * @returns a presenter source that resolves the four long-session tools.
 */
export function longSessionTools(): ToolPresentationSource {
  return {
    get(name: string) {
      if (name === 'read') {
        return {
          presentCall: (args: unknown) => ({ card: 'generic', title: `Read ${pathOf(args)}`, kind: 'read', locations: [{ path: pathOf(args) }] }) as never,
          presentResult: (_args: unknown, result: { readonly isError: boolean, readonly meta?: unknown }) => {
            if (result.isError) return undefined
            const meta = result.meta as typeof READ_META | undefined
            return meta === undefined ? undefined : { card: 'read', path: meta.path, offset: meta.offset, lines: meta.lines, totalLines: meta.totalLines } as never
          },
        }
      }
      if (name === 'edit') {
        return {
          presentCall: (args: unknown) => ({ card: 'diff', title: `Edit ${pathOf(args)}`, diffs: editDiffs(pathOf(args)) }) as never,
          presentResult: (args: unknown, result: { readonly isError: boolean }) => result.isError
            ? undefined
            : { card: 'diff', title: `Edit ${pathOf(args)}`, diffs: editDiffs(pathOf(args)) } as never,
        }
      }
      if (name === 'bash') {
        return {
          presentCall: (args: unknown) => ({ card: 'terminal', title: commandOf(args), description: 'Run the long-session checks' }) as never,
          presentResult: (args: unknown, result: { readonly isError: boolean, readonly meta?: unknown }) => {
            if (result.isError) return undefined
            const meta = result.meta as typeof BASH_META | undefined
            return meta === undefined ? undefined : { card: 'terminal', title: commandOf(args), output: meta.output, exitCode: meta.exitCode } as never
          },
        }
      }
      if (name === 'subagent') {
        return {
          presentCall: (args: unknown) => ({ card: 'generic', title: 'Run subagent review', rawInput: args }) as never,
          presentResult: (_args: unknown, result: { readonly isError: boolean }) => ({
            card: 'generic',
            title: result.isError ? 'Subagent review failed' : 'Subagent review complete',
            content: [{ type: 'text', text: result.isError ? 'failed' : 'completed' }],
          }) as never,
        }
      }
      return undefined
    },
  } as unknown as ToolPresentationSource
}

function toolResultFor(name: string, endedAt: number): NonNullable<ConversationToolEntry['result']> {
  if (name === 'read') return { content: TEXT_CONTENT, text: READ_TEXT, isError: false, endedAt, meta: READ_META_JSON }
  if (name === 'edit') return { content: TEXT_CONTENT, text: EDIT_TEXT, isError: false, endedAt, meta: EDIT_META as unknown as ConversationJson }
  if (name === 'bash') return { content: TEXT_CONTENT, text: BASH_OUTPUT, isError: false, endedAt, meta: BASH_META as unknown as ConversationJson }
  return { content: TEXT_CONTENT, text: SUBAGENT_TEXT, isError: false, endedAt, meta: SUBAGENT_META as unknown as ConversationJson }
}

/**
 * Build the deterministic long-session projection.
 *
 * Every turn holds a user message, a thinking block, an assistant answer, a read, an edit with two hunks, and a forty-line
 * bash command. Every twentieth turn adds a settled `agents` subagent call. Sequence numbers are monotonic; the turns carry
 * completed lifecycle times and both of their steps are settled.
 * @param turns - the number of turns to build.
 * @returns the projection, with entries in chronological order.
 */
export function longSessionProjection(turns: number): ConversationProjection {
  const count = Number.isFinite(turns) ? Math.max(0, Math.floor(turns)) : 0
  const entries: ConversationEntry[] = []
  const settledSteps: string[] = []
  const lifecycle: ConversationTurn[] = []
  let seq = 0
  for (let turn = 1; turn <= count; turn += 1) {
    const startedAt = EPOCH + (turn - 1) * TURN_SPAN
    const endedAt = startedAt + TURN_SPAN - 1
    lifecycle.push({ turn, startedAt, endedAt, outcome: 'completed' })
    settledSteps.push(`${String(turn)}:0`, `${String(turn)}:1`)
    const userSeq = ++seq
    entries.push({ kind: 'user', id: `user-${String(turn)}`, seq: userSeq, updatedSeq: userSeq, turn, text: USER_TEXT, images: NO_IMAGES })
    const thinkingSeq = ++seq
    entries.push({ kind: 'thinking', id: `thinking-${String(turn)}`, seq: thinkingSeq, updatedSeq: thinkingSeq, turn, step: 0, text: THINKING_TEXT, streaming: false })
    const assistantSeq = ++seq
    entries.push({ kind: 'assistant', id: `assistant-${String(turn)}`, seq: assistantSeq, updatedSeq: assistantSeq, turn, step: 0, text: ASSISTANT_TEXT, streaming: false })
    const readSeq = ++seq
    entries.push({
      kind: 'tool', id: `read-${String(turn)}`, seq: readSeq, updatedSeq: readSeq, turn, step: 1,
      callId: `call-${String(turn)}-read`, name: 'read', arguments: READ_ARGUMENTS, startedAt: startedAt + 3,
      channel: 'transcript', result: toolResultFor('read', startedAt + TURN_SPAN - 3),
    })
    const editSeq = ++seq
    entries.push({
      kind: 'tool', id: `edit-${String(turn)}`, seq: editSeq, updatedSeq: editSeq, turn, step: 1,
      callId: `call-${String(turn)}-edit`, name: 'edit', arguments: EDIT_ARGUMENTS, startedAt: startedAt + 4,
      channel: 'transcript', result: toolResultFor('edit', startedAt + TURN_SPAN - 3),
    })
    const bashSeq = ++seq
    entries.push({
      kind: 'tool', id: `bash-${String(turn)}`, seq: bashSeq, updatedSeq: bashSeq, turn, step: 1,
      callId: `call-${String(turn)}-bash`, name: 'bash', arguments: BASH_ARGUMENTS, startedAt: startedAt + 5,
      channel: 'transcript', result: toolResultFor('bash', startedAt + TURN_SPAN - 2),
    })
    if (turn % 20 === 0) {
      const agentSeq = ++seq
      entries.push({
        kind: 'tool', id: `subagent-${String(turn)}`, seq: agentSeq, updatedSeq: agentSeq, turn, step: 1,
        callId: `call-${String(turn)}-subagent`, name: 'subagent', arguments: SUBAGENT_ARGUMENTS, startedAt: startedAt + 6,
        channel: 'agents', result: toolResultFor('subagent', startedAt + TURN_SPAN - 1),
      })
    }
  }
  return { entries, streaming: false, settledSteps, turns: lifecycle }
}

/** The last tool entry in `projection` as pending: its result is gone and its update sequence moved on. */
export function pendingLastTool(projection: ConversationProjection): ConversationProjection {
  const entries = projection.entries.slice()
  const index = entries.findLastIndex(entry => entry.kind === 'tool')
  if (index === -1) return projection
  const entry = entries[index] as ConversationToolEntry
  entries[index] = {
    kind: 'tool', id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq + 1, turn: entry.turn, step: entry.step,
    callId: entry.callId, name: entry.name, arguments: entry.arguments, startedAt: entry.startedAt, channel: entry.channel,
  }
  return { ...projection, entries }
}

/** The last tool entry in `projection` settled: its result arrives and its update sequence moved on once more. */
export function settleLastTool(projection: ConversationProjection): ConversationProjection {
  const entries = projection.entries.slice()
  const index = entries.findLastIndex(entry => entry.kind === 'tool')
  if (index === -1) return projection
  const entry = entries[index] as ConversationToolEntry
  entries[index] = {
    ...entry, updatedSeq: entry.updatedSeq + 1, result: toolResultFor(entry.name, entry.startedAt + 20),
  }
  return { ...projection, entries }
}

/**
 * Build the live assistant draft the transcript overlays on a settled projection.
 * @param projection - the durable projection the draft follows.
 * @param text - the answer text the draft carries.
 * @param revision - the producer revision, which moves on with each text change.
 * @returns a valid live draft for the next turn.
 */
export function longSessionDraft(projection: ConversationProjection, text: string, revision = 1): LiveAssistantDraft {
  const turn = (projection.turns.at(-1)?.turn ?? 0) + 1
  const updatedAt = EPOCH + text.length
  return {
    sessionId: 'long-session',
    attemptId: 'long-session-answer',
    revision,
    turn,
    step: 0,
    phase: 'composing',
    reasoning: '',
    text,
    outputProgress: { chars: text.length, initialChars: 0, startedAt: EPOCH, updatedAt },
    chars: text.length,
    updatedAt,
  }
}

/** What one retained view owns: the feed the harness pushes into and the real model source over it. */
export interface LongSessionView {
  readonly feed: FakeConversationFeed
  readonly source: OfficialConversationModelSource
}

/** The screen face the harness mounts on; `SlotScreen` satisfies it. */
export interface LongSessionScreen {
  readonly service: MayflyScreenService
  contentHost(): MayflyComponent
  dispose(): void
}

/** A fake conversation feed: the harness pushes whole values and drafts, the real source takes them. */
export class FakeConversationFeed implements ConversationFeed {
  private pending: { readonly value: unknown, readonly seq: number } | undefined
  private watermark = -1
  private draftValue: LiveAssistantDraft | undefined
  private disposed = false

  /** Queue a whole value newer than every value already taken or settled. */
  push(value: unknown, seq: number): void {
    if (this.disposed || seq <= Math.max(this.watermark, this.pending?.seq ?? -1)) return
    this.pending = { value, seq }
  }

  /** Replace the live draft the source overlays. */
  setDraft(draft: LiveAssistantDraft | undefined): void {
    this.draftValue = draft
  }

  take(): { readonly value: unknown, readonly seq: number } | undefined {
    const pending = this.pending
    this.pending = undefined
    return pending
  }

  settle(seq: number): void { this.watermark = seq }

  draft(): LiveAssistantDraft | undefined { return this.draftValue }

  state(): ConversationFeedState { return READY }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
    this.draftValue = undefined
  }
}

/** A tick source the workload fires by hand, so a measured step never waits for a timer. */
export class FakeTickSource implements TickSource {
  private readonly listeners = new Set<(now: number) => void>()

  subscribe(listener: (now: number) => void): () => void {
    this.listeners.add(listener)
    let live = true
    return () => {
      if (!live) return
      live = false
      this.listeners.delete(listener)
    }
  }

  /** Fire every current listener with `now`. */
  emit(now: number): void {
    for (const listener of [...this.listeners]) listener(now)
  }

  /** The one listener the controller registered while a call is pending. */
  capture(): ((now: number) => void) | undefined {
    const [listener] = this.listeners
    return listener
  }

  get listenerCount(): number { return this.listeners.size }
}

/** A fixed publish clock: the controller's publish window never opens from wall-clock passage inside a measured step. */
class FixedPublishClock {
  private next = 0
  private readonly timers = new Map<number, () => void>()

  now(): number { return 0 }

  setTimeout(callback: () => void, _ms: number): unknown {
    this.next += 1
    this.timers.set(this.next, callback)
    return this.next
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle)
  }

  /** Run the trailing publish the controller scheduled, so a measured step includes it. */
  flush(): void {
    const pending = [...this.timers.values()]
    this.timers.clear()
    for (const callback of pending) callback()
  }
}

/**
 * Run the real transcript controller and one or more real model sources over a real `MayflyScreenService`.
 *
 * The content slot stays unfocused, so the stream flows; `render()` paints the mounted host. Publishing is explicit
 * (`publish`, `republish`, or a fake tick), which keeps a measured step deterministic without timers.
 */
export class LongSessionHarness {
  readonly controller: TranscriptController
  readonly tick = new FakeTickSource()
  private readonly tools: ToolPresentationSource = longSessionTools()
  private readonly clock = new FixedPublishClock()
  private readonly views = new Map<string, LongSessionView>()

  constructor(
    private readonly screen: LongSessionScreen,
    private readonly counters: MayflyWorkCounters,
    private readonly width = 100,
  ) {
    const options: TranscriptControllerOptions = {
      t: translate,
      queued: () => NO_QUEUED,
      tick: this.tick,
      clock: this.clock,
      counters,
    }
    this.controller = new TranscriptController(options)
    this.controller.attach(this.screen.service as unknown as TranscriptScreen)
  }

  /** Push one whole projection into a new retained view, warm its durable model, and set the view. */
  addView(key: string, projection: ConversationProjection, options: { readonly seq?: number, readonly draft?: LiveAssistantDraft } = {}): LongSessionView {
    const feed = new FakeConversationFeed()
    feed.push(projection, options.seq ?? 1)
    if (options.draft !== undefined) feed.setDraft(options.draft)
    const source = new OfficialConversationModelSource(
      NO_PROJECTIONS,
      this.tools,
      () => { this.controller.refresh() },
      undefined,
      translate,
      this.counters,
    )
    source.attachFeed(feed)
    source.snapshot()
    this.controller.setView(key, () => source.snapshot())
    const view: LongSessionView = { feed, source }
    this.views.set(key, view)
    return view
  }

  view(key = 'main'): LongSessionView {
    const view = this.views.get(key)
    if (view === undefined) throw new Error(`long-session harness has no view "${key}"`)
    return view
  }

  show(key: string): void { this.controller.show(key) }

  /** Convert the newest pending value (or draft) in one view, then publish the controller. */
  publish(key = 'main'): TranscriptModel {
    const model = this.view(key).source.snapshot()
    this.controller.republish()
    this.clock.flush()
    return model
  }

  /** Republish the controller without converting another feed value. */
  republish(): void {
    this.controller.republish()
    this.clock.flush()
  }

  /** Paint the conversation host at the workload width. */
  render(): string[] { return this.screen.contentHost().render(this.width) }

  dispose(): void {
    this.controller.dispose()
    for (const view of this.views.values()) view.source.dispose()
    this.views.clear()
    this.screen.dispose()
  }
}

/** How many entries with the same id kept their object identity between two models. */
export interface EntryReuse {
  readonly compared: number
  readonly reused: number
  readonly missed: readonly string[]
}

/**
 * Compare the entries of two snapshots by id and count the ones that were reused by identity. The live overlay of the
 * same durable projection must keep every durable entry, which is the assumption the Phase 7 entry cache builds on.
 * @param before - the earlier snapshot.
 * @param after - the later snapshot.
 * @returns the compared and reused counts and the ids that were rebuilt.
 */
export function entryReuse(before: TranscriptModel, after: TranscriptModel): EntryReuse {
  const earlier = new Map<string, TranscriptModel['entries'][number]>()
  for (const entry of before.entries) {
    const id = entryId(entry)
    if (id !== undefined) earlier.set(id, entry)
  }
  const missed: string[] = []
  let compared = 0
  let reused = 0
  for (const entry of after.entries) {
    const id = entryId(entry)
    const previous = id === undefined ? undefined : earlier.get(id)
    if (previous === undefined || id === undefined) continue
    compared += 1
    if (previous === entry) reused += 1
    else missed.push(id)
  }
  return { compared, reused, missed }
}

function entryId(entry: TranscriptModel['entries'][number]): string | undefined {
  const id = (entry as { readonly id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/**
 * Assert that every entry a later snapshot shares with an earlier one is the same object.
 * @param before - the earlier snapshot.
 * @param after - the later snapshot.
 */
export function assertUnchangedEntriesReused(before: TranscriptModel, after: TranscriptModel): void {
  const reuse = entryReuse(before, after)
  if (reuse.compared === 0) throw new Error('the two snapshots share no entry ids')
  if (reuse.missed.length > 0) {
    throw new Error(`${String(reuse.missed.length)} of ${String(reuse.compared)} entries were rebuilt; first ${reuse.missed[0]!}`)
  }
}
