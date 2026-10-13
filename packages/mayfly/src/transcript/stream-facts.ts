/**
 * The facts of the conversation stream: the display plan of one transcript model (`buildDisplay`, the presentation
 * policy's window and Ctrl-O reach) mapped to the rows `TranscriptView` draws, turn by turn. A row is rebuilt on every
 * pass and kept by identity while its content is equal, so a settled turn publishes the same frozen items and only the
 * live turn's rows change. Texts leave here translated and sanitized; times leave formatted.
 *
 * @module @ephemeral-ai/mayfly/transcript/stream-facts
 */

import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { MayflyDecisionRequest } from '../core/types.ts'
import { textOf, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { sanitizePluginText } from '../core/plugin-view.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { TranscriptEntryModel, TranscriptModel, TranscriptTurnModel } from '../frontend/models.ts'
import type { StreamMood, StreamQueued, StreamRow, StreamTurn, TranscriptViewFacts } from '../components/transcript-view.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { openTurns, type Disclosure } from './disclosure.ts'
import { buildDisplay, runningTurnOf, type DisplayItem, type EntryItem, type ProcessTitleItem, type TurnHeaderItem } from './process-groups.ts'
import { diffStat, elapsedText } from './process-activity.ts'
import { callsOf, standardRow, verboseRow, type Call, type CallRequests } from './tool-calls.ts'
import { kindOf } from './tool-kinds.ts'
import type { TranscriptPresentationSnapshot } from './presentation-policy.ts'
import { ellipsize } from './present.ts'
import { contextPercent, formatTokens } from './status-context.ts'
import { COMPACTION_DRAIN_MS, type CompactionFacts } from '../components/compaction-row.ts'
import type { ApprovalMark, CompactionMark } from '../conversation/types.ts'
import type { TranscriptCompactionModel } from '../frontend/models.ts'

/** Characters of a salient argument kept on a row. */
const PREVIEW_MAX_CHARS = 80

/** Characters of a one-line reasoning row kept in its facts: the row clips to the width it is given. */
const REASONING_LINE_MAX_CHARS = 400

type Entry = TranscriptModel['entries'][number]

/** What one pass reads besides the model. */
export interface StreamInputs {
  readonly policy: TranscriptPresentationSnapshot
  /** What the reader opened beyond the level: Ctrl-O's reach, single turns and rows, the turns a search holds open. */
  readonly disclosure: Disclosure
  /** Whether a running turn keeps its header (a view without an activity row). */
  readonly liveTurnHeader: boolean
  readonly t: MayflyTranslate
  /** The time, which a call that still runs measures its own against. */
  readonly now: number
  /** The messages the user typed while the agent works. */
  readonly queued: readonly { readonly id: string, readonly text: string }[]
  /** The requests waiting on the user, in the order they were asked: the first is the one on the card, and its call is the request block. */
  readonly requests?: readonly MayflyDecisionRequest[]
  /** How each approval put to the user ended, from the session's audit events. */
  readonly approvals?: readonly ApprovalMark[]
  /** The context occupancy around each recent compaction, for its bar. */
  readonly compactions?: readonly CompactionMark[]
  /** The selected Agent's context window and occupancy, for a compaction whose marks have not landed. */
  readonly contextWindow?: number
  readonly contextTokens?: number
  /** Where each image attachment's reference is kept for the byte loader, by attachment id. */
  readonly imageRefs?: Map<string, { readonly attachmentId: string, readonly mediaType: string }>
}

function isSemantic(entry: Entry): entry is TranscriptEntryModel {
  return entry.kind.startsWith('transcript-')
}

/** One line of a user message for a queued row: its text, and a count of its images. */
export function userMessageText(message: UserMessage): string {
  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .replace(/[\r\n]+/g, ' ')
    .trim()
  const images = message.content.filter(block => block.type === 'image').length
  return [text, ...(images === 0 ? [] : [`[${images} image${images === 1 ? '' : 's'}]`])].filter(Boolean).join(' ')
}

/** The wall-clock time a turn started, as `HH:MM` in the local zone. */
export function clockTime(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function firstLine(text: string, max = PREVIEW_MAX_CHARS): string | undefined {
  const line = text.split('\n').find(candidate => candidate.trim() !== '')
  return line === undefined ? undefined : ellipsize(sanitizePluginText(line.trim()), max)
}

/** Whether two values hold the same facts: rows carry lists of plain records, so equality reaches into them. */
function sameValue(x: unknown, y: unknown): boolean {
  if (x === y) return true
  if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null) return false
  if (Array.isArray(x) !== Array.isArray(y)) return false
  const a = x as Record<string, unknown>
  const b = y as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => sameValue(a[key], b[key]))
}

/** A row that is a block of its own after the turn it followed. */
function isTrailing(row: StreamRow): boolean {
  return row.kind === 'compaction' && row.trailing === true
}

function sameRow(left: StreamRow, right: StreamRow): boolean {
  return sameValue(left, right)
}

/** Builds the facts of one conversation view and keeps the rows of its settled turns by identity. */
export class StreamFacts {
  private rows = new Map<string, StreamRow>()
  private turns = new Map<string, StreamTurn>()
  private queued = new Map<string, StreamQueued>()

  /** Forget every kept row (a locale or policy change rewrites texts under the same ids). */
  reset(): void {
    this.rows = new Map()
    this.turns = new Map()
    this.queued = new Map()
  }

  /**
   * Map one model to the stream's facts.
   * @param model - the displayed conversation, or `null` when none is attached.
   * @param inputs - the policy, disclosure state, translator, and queued messages of this pass.
   * @returns the turns in order and the messages queued behind them.
   */
  build(model: TranscriptModel | null, inputs: StreamInputs): TranscriptViewFacts {
    const rows = new Map<string, StreamRow>()
    const turns = new Map<string, StreamTurn>()
    const queued = new Map<string, StreamQueued>()
    const facts: TranscriptViewFacts = { turns: model === null ? [] : this.turnsOf(model, inputs, rows, turns), queued: this.queuedOf(inputs, queued) }
    this.rows = rows
    this.turns = turns
    this.queued = queued
    return facts
  }

  private intern(row: StreamRow, kept: Map<string, StreamRow>): StreamRow {
    const previous = this.rows.get(row.id)
    const result = previous !== undefined && sameRow(previous, row) ? previous : row
    kept.set(row.id, result)
    return result
  }

  private queuedOf(inputs: StreamInputs, kept: Map<string, StreamQueued>): readonly StreamQueued[] {
    const suffix = inputs.t('⏎ queued')
    // The inbox can hold a message twice (a step's and a turn's queue); the stream shows it once.
    return inputs.queued.filter((message, index) => inputs.queued.findIndex(other => other.id === message.id) === index).map((message) => {
      const next: StreamQueued = { id: message.id, text: sanitizePluginText(message.text), suffix }
      const previous = this.queued.get(message.id)
      const result = previous !== undefined && previous.text === next.text && previous.suffix === suffix ? previous : next
      kept.set(message.id, result)
      return result
    })
  }

  private turnsOf(model: TranscriptModel, inputs: StreamInputs, kept: Map<string, StreamRow>, keptTurns: Map<string, StreamTurn>): StreamTurn[] {
    const { policy } = inputs
    const live = model.live
    const liveEntries = live?.entries ?? []
    const bounded = live === undefined ? model.entries : model.entries.filter(entry => !((entry.kind === 'transcript-thinking' || entry.kind === 'transcript-assistant')
      && entry.turn === live.turn && entry.step === live.step))
    const turnNumbers = [...new Set([...bounded.filter(isSemantic).map(entry => entry.turn), ...(live === undefined ? [] : [live.turn])])]
    const visible = new Set([...turnNumbers.slice(-policy.windowTurns), ...inputs.disclosure.forced])
    const entries = bounded.filter(entry => !isSemantic(entry) || visible.has(entry.turn))
    const reach = new Set(turnNumbers.slice(-policy.expandTurns))
    const display = buildDisplay({
      entries: [...entries, ...liveEntries],
      policy: policy.process,
      runningTurn: runningTurnOf(model, entries),
      turns: model.turns,
      open: openTurns(inputs.disclosure, reach),
      rows: inputs.disclosure.rows,
      scope: reach,
      flat: model.streaming === undefined,
      runningHeader: inputs.liveTurnHeader,
    })
    const lifecycle = new Map((model.turns ?? []).map(turn => [turn.turn, turn]))
    const buckets: { readonly turn: number, readonly rows: StreamRow[] }[] = []
    let lead: StreamRow[] = []
    const asked = requestOf(inputs.requests, inputs.approvals)
    runsOf(display, inputs.t, inputs.now, asked).forEach((item, position) => {
      const turn = turnOf(item)
      const mapped = this.rowsOf(item, inputs, position, asked).map(row => this.intern(row, kept))
      if (mapped.length === 0) return
      if (turn === undefined) {
        // A canonical node belongs with the turn it precedes, or with the last one when none follows.
        if (buckets.length === 0 || lead.length > 0) lead.push(...mapped)
        else buckets.at(-1)!.rows.push(...mapped)
        return
      }
      let bucket = buckets.at(-1)
      if (bucket === undefined || bucket.turn !== turn) {
        bucket = { turn, rows: lead }
        lead = []
        buckets.push(bucket)
      }
      bucket.rows.push(...mapped)
    })
    if (lead.length > 0) {
      if (buckets.length === 0) buckets.push({ turn: -1, rows: lead })
      else buckets.at(-1)!.rows.push(...lead)
    }
    // A request that names no call (a hook asked) has no block to become: it is a block of its own at the end of the stream.
    const nameless = inputs.requests?.[0]
    if (nameless !== undefined && nameless.callId === undefined && buckets.length > 0) {
      buckets.at(-1)!.rows.push(this.intern(namelessRequestRow(nameless, inputs.requests!.filter(request => request.type === nameless.type).length, inputs.t), kept))
    }
    return buckets.map(({ turn, rows: all }) => {
      const id = `turn:${String(turn)}`
      const closing = closingOf(lifecycle.get(turn), inputs.t)
      const rows = all.filter(row => !isTrailing(row))
      const after = all.filter(isTrailing)
      const previous = this.turns.get(id)
      const same = (left: readonly StreamRow[], right: readonly StreamRow[]): boolean => left.length === right.length && left.every((row, index) => row === right[index])
      const settled = previous !== undefined && previous.closing === closing && same(previous.rows, rows) && same(previous.after ?? [], after)
      const result: StreamTurn = settled ? previous : { id, number: Math.max(0, turn), rows, ...(closing === undefined ? {} : { closing }), ...after.length === 0 ? {} : { after } }
      keptTurns.set(id, result)
      return result
    })
  }

  private rowsOf(item: DisplayItem | RunUnit, inputs: StreamInputs, position: number, asked: CallRequests): readonly StreamRow[] {
    if (item.kind === 'run') return [standardRow(item.calls, inputs.t, inputs.now)]
    if (item.kind === 'turn-header') return [headerRow(item, inputs.t)]
    if (item.kind === 'process-title') return [titleRow(item, inputs.t)]
    // A hand-built model may carry canonical nodes between its entries: their text is all the stream keeps.
    if (!isSemantic(item.entry)) return [{ kind: 'note', id: `node:${String(position)}`, text: sanitizePluginText(canonicalText(item.entry)) }]
    return entryRows(item, item.entry, inputs, asked)
  }
}

/** The block of a request that names no call: the tool and what the asker said, waiting on the user. */
function namelessRequestRow(request: MayflyDecisionRequest, total: number, t: MayflyTranslate): StreamRow {
  return {
    kind: 'tool',
    id: `request:${request.type}:${request.toolName}`,
    state: 'waiting',
    name: sanitizePluginText(request.toolName),
    outcome: total > 1 ? t('{index} of {total} waiting', { index: 1, total }) : t('waiting'),
    ...(request.reason === undefined || request.reason === '' ? {} : { body: [{ text: sanitizePluginText(request.reason), tone: 'muted' as const }] }),
  }
}

/**
 * The request the user is being asked about, by the call it is about. Only the first request of the queue is on the card,
 * so only its call waits; the calls behind it keep running lines until their turn. Its place reads `1 of N` among the
 * requests of its own kind.
 */
function requestOf(requests: readonly MayflyDecisionRequest[] | undefined, approvals: readonly ApprovalMark[] | undefined): CallRequests {
  const first = requests?.[0]
  const decided = new Map<string, 'allowed' | 'rejected'>()
  for (const mark of approvals ?? []) {
    if (mark.callId === undefined || mark.outcome === undefined) continue
    if (mark.outcome === 'allowed-once') decided.set(mark.callId, 'allowed')
    else if (mark.outcome === 'rejected') decided.set(mark.callId, 'rejected')
  }
  if (first?.callId === undefined) return { asked: new Map(), decided }
  const total = requests!.filter(request => request.type === first.type).length
  return { asked: new Map([[first.callId, { type: first.type, index: 1, total, ...(first.reason === undefined ? {} : { reason: first.reason }) }]]), decided }
}

function turnOf(item: DisplayItem | RunUnit): number | undefined {
  if (item.kind !== 'entry') return item.turn
  return isSemantic(item.entry) ? item.entry.turn : undefined
}

/** How long a turn that has ended worked and when it was done, or `undefined` while it runs. */
function closingOf(turn: TranscriptTurnModel | undefined, t: MayflyTranslate): string | undefined {
  if (turn?.endedAt === undefined) return undefined
  const values = { duration: compactElapsedMs(turn.endedAt - turn.startedAt), time: clockTime(turn.endedAt) }
  if (turn.outcome === 'aborted' || turn.outcome === 'interrupted' || turn.outcome === 'forked') return t('Stopped after {duration} · done {time}', values)
  if (turn.outcome === 'error') return t('Failed after {duration} · done {time}', values)
  return t('Worked for {duration} · done {time}', values)
}

function headerRow(item: TurnHeaderItem, t: MayflyTranslate): StreamRow {
  let mood: StreamMood = 'done'
  let label: string
  if (item.running) {
    mood = 'running'
    label = t('Deep diving...')
  } else if (item.outcome === 'aborted' || item.outcome === 'interrupted' || item.outcome === 'forked') {
    mood = 'stopped'
    label = t('Stopped')
  } else if (item.outcome === 'error') {
    mood = 'failed'
    label = t('Failed')
  } else {
    label = ''
  }
  const counts = item.running ? [] : [
    ...(item.toolCalls === 0 ? [] : [t(item.toolCalls === 1 ? '{count} tool call' : '{count} tool calls', { count: item.toolCalls })]),
    ...(item.subagents === 0 ? [] : [t(item.subagents === 1 ? '{count} subagent' : '{count} subagents', { count: item.subagents })]),
  ]
  const hint = item.hint ? t('Ctrl+O to expand') : ''
  // A finished turn's header is what it did: the counts. How long it took is the closing row's.
  if (mood === 'done') return { kind: 'header', id: item.id, mood, open: true, label: [...counts, ...(hint === '' ? [] : [hint])].join(' · ') || t('Worked'), tail: '' }
  return { kind: 'header', id: item.id, mood, open: true, label, tail: `${counts.map(count => ` · ${count}`).join('')}${hint === '' ? '' : ` · ${hint}`}` }
}

/** The line that collects a turn's calls at the compact level: `6 tool calls · 1 subagent · 5s · +4 −2 · Ctrl+O to expand`. */
function titleRow(item: ProcessTitleItem, t: MayflyTranslate): StreamRow {
  const parts = [
    item.toolCalls === 0 ? undefined : t(item.toolCalls === 1 ? '{count} tool call' : '{count} tool calls', { count: item.toolCalls }),
    item.subagents === 0 ? undefined : t(item.subagents === 1 ? '{count} subagent' : '{count} subagents', { count: item.subagents }),
    item.durationMs === undefined ? undefined : elapsedText(item.durationMs),
    item.added === undefined ? undefined : diffStat(item.added, item.removed ?? 0),
  ].filter((part): part is string => part !== undefined)
  return {
    kind: 'title',
    id: item.id,
    text: sanitizePluginText(parts.join(' · ')),
    ...(item.failed === 0 ? {} : { failed: t('{count} failed', { count: item.failed }), ...(item.failed < item.toolCalls + item.subagents ? { partial: true as const } : {}) }),
    ...(item.hint ? { hint: t('Ctrl+O to expand') } : {}),
  }
}

function canonicalText(node: MayflyUiNode): string {
  if (node.kind === 'text') return textOf(node.content)
  return node.kind === 'code' ? textOf(node.code) : `[${node.kind}]`
}

/** A run of calls of one kind that the standard tier draws as one block, from the first call on. */
interface RunUnit {
  readonly kind: 'run'
  readonly turn: number
  readonly calls: readonly Call[]
}

function isToolLike(entry: TranscriptEntryModel): boolean {
  return entry.kind === 'transcript-read-group' || entry.kind === 'transcript-search-group' || entry.kind === 'transcript-command-group'
    || entry.kind === 'transcript-tool'
}

/** A tool whose calls never share a run (an edit or a write): each is its own open block at the standard tier. */
function isUnmerged(entry: TranscriptEntryModel): boolean {
  return entry.kind === 'transcript-tool' && !kindOf(entry.activity).mergeable
}

/**
 * The display plan with the tool entries of the standard tier gathered into runs: consecutive calls of one kind, whatever
 * entries they came in, are one block. Anything else (a reasoning, an answer, a file change, a header) ends the run, and
 * a call that still runs is a line of its own and ends it.
 */
function runsOf(display: readonly DisplayItem[], t: MayflyTranslate, now: number, asked: CallRequests): readonly (DisplayItem | RunUnit)[] {
  const units: (DisplayItem | RunUnit)[] = []
  let run: { turn: number, calls: Call[] } | undefined
  const flush = (): void => {
    if (run !== undefined) units.push({ kind: 'run', turn: run.turn, calls: run.calls })
    run = undefined
  }
  for (const item of display) {
    if (item.kind === 'entry' && item.tier === 'standard' && isSemantic(item.entry) && isToolLike(item.entry) && !isUnmerged(item.entry)) {
      for (const call of callsOf(item.entry, item.turnClosed, t, now, asked)) {
        // A call that waits on the user is a block of its own, open, and ends the run.
        if (call.state === 'waiting') {
          flush()
          units.push({ kind: 'run', turn: item.entry.turn, calls: [call] })
          continue
        }
        if (run !== undefined && run.calls[0]!.activity !== call.activity) flush()
        if (run === undefined) run = { turn: item.entry.turn, calls: [] }
        run.calls.push(call)
      }
      continue
    }
    flush()
    units.push(item)
  }
  flush()
  return units
}

/** The rows of one entry: none for an empty one, one per call for a tool, group, or run of calls drawn as verbose blocks. */
function entryRows(item: EntryItem, entry: TranscriptEntryModel, inputs: StreamInputs, asked: CallRequests): readonly StreamRow[] {
  if (isToolLike(entry)) {
    // At the compact level a call in flight is its line alone, and one that waits on the user stays open; what has settled is the title's.
    const calls = callsOf(entry, item.turnClosed, inputs.t, inputs.now, asked)
    return (item.tier === 'compact' ? calls.filter(call => call.state === 'pending' || call.state === 'waiting') : calls).map(call => verboseRow(call, item.expanded, inputs.t, item.tier ?? 'verbose'))
  }
  const row = entryRow(item, entry, inputs)
  return row === undefined ? [] : [row]
}

/** Rows of a reasoning block that is still being written, by tier. */
const REASONING_ROWS = { standard: 3, verbose: 8, open: 40 } as const

/** The block of reasoning, in flight or settled: its line, and its rows by tier (the last ones while it is written, the first once it is done; a pending one has no time, a settled one its duration). */
function reasoningRow(item: EntryItem, entry: Extract<TranscriptEntryModel, { readonly kind: 'transcript-thinking' }>, label: string, pending: boolean, t: MayflyTranslate): StreamRow {
  const lines = entry.text.split('\n').map(line => line.trim()).filter(line => line !== '')
  const cap = item.tier === 'compact' ? 0 : item.expanded ? REASONING_ROWS.open : item.tier === 'standard' ? REASONING_ROWS.standard : REASONING_ROWS.verbose
  // While the model thinks the block shows the end of it, what it has just reached; once it is done, the start.
  const rows = (cap === 0 ? [] : pending ? lines.slice(-cap) : lines.slice(0, cap)).map(line => ellipsize(sanitizePluginText(line), REASONING_LINE_MAX_CHARS))
  const left = lines.length - rows.length
  const rest = left > 0 && cap > 0 ? `${t(pending ? '… +{count} earlier' : '… +{count} more', { count: left })}${item.expanded ? '' : t(' · Ctrl+O')}` : undefined
  return { kind: 'reasoning', id: entry.id, label, ...(pending ? { pending: true } : {}), ...(rows.length === 0 ? {} : { rows }), ...(rest === undefined ? {} : pending ? { earlier: rest } : { more: rest }) }
}

function entryRow(item: EntryItem, entry: TranscriptEntryModel, inputs: StreamInputs): StreamRow | undefined {
  const { t } = inputs
  switch (entry.kind) {
    case 'transcript-user':
      return {
        kind: 'prompt',
        id: entry.id,
        text: sanitizePluginText(entry.text),
        images: entry.images.map((image, index) => {
          inputs.imageRefs?.set(image.attachmentId, { attachmentId: image.attachmentId, mediaType: image.mediaType })
          return {
            attachmentId: image.attachmentId,
            alt: `${t('[image]')} ${String(index + 1)}${image.name === undefined ? '' : ` · ${sanitizePluginText(image.name)}`} · ${String(image.width)}×${String(image.height)} · ${String(Math.max(1, Math.round(image.bytes / 1024)))} KB`,
          }
        }),
        open: item.expanded,
      }
    case 'transcript-assistant': {
      if (entry.text.trim() === '') return undefined
      // The Markdown body paints the unit an append reached, so a long live answer costs what its tail does.
      return { kind: 'answer', id: entry.id, text: sanitizePluginText(entry.text) }
    }
    case 'transcript-thinking': {
      if (entry.text.trim() === '') return undefined
      // The block holds the last lines of what the model thinks, and the first of what it thought, as many as the tier shows. While the model thinks the
      // activity row owns the clock; once it is done the label keeps the duration.
      const took = entry.streaming || entry.durationMs === undefined ? '' : ` · ${compactElapsedMs(Math.max(1000, entry.durationMs))}`
      return reasoningRow(item, entry, `${t('Thinking')}${took}`, entry.streaming, t)
    }
    case 'transcript-tool':
    case 'transcript-read-group':
    case 'transcript-search-group':
    case 'transcript-command-group':
      return undefined
    case 'transcript-error':
      return { kind: 'error', id: entry.id, text: sanitizePluginText(entry.code === undefined ? entry.message : `${entry.message} (${entry.code})`) }
    case 'transcript-interrupted':
      return { kind: 'interrupted', id: entry.id, text: t('■ interrupted') }
    case 'transcript-compaction': return compactionRow(entry, inputs)
  }
}

/**
 * The estimated share of a compaction done after `elapsedMs` of summarizing. The Harness reports no progress, so the
 * share approaches 90% along a curve whose pace follows the size of the context being summarized (a larger context
 * takes longer): about 80% when the expected time has passed. The last tenth is the summary landing.
 * @param elapsedMs - time since the compaction began.
 * @param contextTokens - the context being summarized, when known.
 * @returns whole percent, 0 to 90.
 */
export function progressAt(elapsedMs: number, contextTokens: number | undefined): number {
  const expectedMs = Math.min(45_000, Math.max(4_000, 4_000 + (contextTokens ?? 20_000) * 0.2))
  return Math.min(90, Math.max(0, Math.round(90 * (1 - Math.exp(-Math.max(0, elapsedMs) / (expectedMs / 2.5))))))
}

/** How long after its summary lands the row still reads as applying: the fill takes 800 ms, and the painter starts it a frame later. */
const FILL_HOLD_MS = COMPACTION_DRAIN_MS + 200

/** Lines of the checkpoint summary shown when the row is opened. */
const SUMMARY_ROWS = 8

/** The estimate of the occupied tokens, as the session list and the status bar write it: `~148k`. */
const approx = (tokens: number): string => `~${formatTokens(tokens)}`

/**
 * One compaction as a row: the stage it is in while it runs, then what it did. The occupancy numbers are the facts' marks
 * for this compaction, so a settled row reads the same after later steps grow the context.
 */
function compactionRow(entry: TranscriptCompactionModel, inputs: StreamInputs): StreamRow {
  const { t, now } = inputs
  const compact = inputs.policy.process.compactionLine
  const mark = inputs.compactions?.find(item => item.id === entry.compactionId)
  const window = mark?.window ?? inputs.contextWindow
  const share = (tokens: number | undefined): number | undefined => window === undefined || tokens === undefined ? undefined : contextPercent(tokens, window)
  const before = share(mark?.before)
  const after = share(mark?.after)
  // The row settles only once the bar has filled: the end record follows the summary at once, but the fill takes a moment,
  // and the ✓ and the settled look must not come before the bar reaches 100%.
  const filling = entry.state === 'ok' && entry.summaryAt !== undefined && now - entry.summaryAt < FILL_HOLD_MS
  const running = entry.state === 'running' || filling
  const applying = filling || (entry.state === 'running' && entry.shadowedCount !== undefined)
  const summarized = entry.summaryAt === undefined ? undefined : progressAt(entry.summaryAt - entry.startedAt, mark?.before ?? inputs.contextTokens)
  const estimate = progressAt(now - entry.startedAt, mark?.before ?? inputs.contextTokens)
  // The share while summarizing is the estimate; once the summary has landed the bar fills from where it stood to 100.
  const percent = applying ? summarized ?? estimate : estimate
  const bar = { from: percent, to: applying || entry.state === 'ok' ? 100 : percent, drain: applying, rev: entry.seq }
  const trigger = entry.trigger === 'auto' ? t('auto') : undefined
  const id = entry.id
  if (running) {
    const stage = applying ? t('applying') : t('summarizing')
    const elapsed = applying ? [] : [compactElapsedMs(Math.max(0, now - entry.startedAt))]
    const facts: CompactionFacts = { state: 'running', title: t('Compacting context'), compact, bar, percent: applying ? summarized ?? estimate : estimate, progress: [stage, ...elapsed], ...trigger === undefined ? {} : { trigger } }
    return { kind: 'compaction', id, facts }
  }
  if (entry.state === 'error') {
    const reason = firstLine(entry.error ?? entry.detail ?? '')
    const title = reason === undefined ? t('Compaction failed') : t('Compaction failed: {reason}', { reason })
    return { kind: 'compaction', id, facts: { state: 'error', title, compact } }
  }
  const title = entry.shadowedCount === undefined ? firstLine(entry.detail ?? t('Compacted')) ?? t('Compacted') : t('Compacted {count} items', { count: entry.shadowedCount })
  const tokens = mark?.before !== undefined && mark.after !== undefined ? `${approx(mark.before)} → ${approx(mark.after)} ${t('tokens')}`
    : entry.shadowedTokens === undefined ? undefined : `${approx(entry.shadowedTokens)} ${t('tokens')}`
  const facts: CompactionFacts = {
    state: 'ok', title, compact, bar,
    ...before === undefined || after === undefined ? {} : { change: t('context {from}% → {to}%', { from: before, to: after }) },
    ...tokens === undefined ? {} : { tokens },
    ...trigger === undefined ? {} : { trigger },
  }
  const lines = compact || entry.summary === undefined ? [] : sanitizePluginText(entry.summary).split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
  const open = inputs.disclosure.recent || inputs.disclosure.rows.has(id) || inputs.policy.process.compactionSummary
  return {
    kind: 'compaction', id, facts,
    ...lines.length === 0 ? {} : open
      ? { summary: lines.slice(0, SUMMARY_ROWS), ...lines.length > SUMMARY_ROWS ? { more: t('… +{count} more', { count: lines.length - SUMMARY_ROWS }) } : {} }
      : { hint: t('Ctrl+O summary') },
    ...entry.trigger === 'manual' ? { trailing: true as const } : {},
  }
}
