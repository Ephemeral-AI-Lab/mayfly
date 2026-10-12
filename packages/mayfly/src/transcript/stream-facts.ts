/**
 * The facts of the conversation stream: the display plan of one transcript model (`buildDisplay`, the presentation
 * policy's window and Ctrl-O reach) mapped to the rows `TranscriptView` draws, turn by turn. A row is rebuilt on every
 * pass and kept by identity while its content is equal, so a settled turn publishes the same frozen items and only the
 * live turn's rows change. Texts leave here translated and sanitized; times leave formatted.
 *
 * @module @ephemeral-ai/mayfly/transcript/stream-facts
 */

import type { UserMessage } from '@deepseek-ai/dsh-session'
import { textOf, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { sanitizePluginText } from '../core/plugin-view.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { TranscriptEntryModel, TranscriptModel } from '../frontend/models.ts'
import type { StreamMood, StreamQueued, StreamRow, StreamTurn, TranscriptViewFacts } from '../components/transcript-view.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { buildDisplay, memberFacts, runningTurnOf, type DisplayItem, type EntryItem, type ProcessTitleItem, type TurnHeaderItem } from './process-groups.ts'
import { processTitle, summarizeProcess } from './process-activity.ts'
import type { TranscriptPresentationSnapshot } from './presentation-policy.ts'
import { ellipsize, toolDisplayName } from './present.ts'

/** Maximum source characters one streamed answer paints: the rest of a longer one is summarized by its count. */
export const STREAMING_RENDER_MAX_CHARS = 32_000

/** Characters of a reasoning preview and of a salient argument kept on a row. */
const PREVIEW_MAX_CHARS = 80

type Entry = TranscriptModel['entries'][number]

/** What one pass reads besides the model. */
export interface StreamInputs {
  readonly policy: TranscriptPresentationSnapshot
  /** The global Ctrl-O toggle. */
  readonly expanded: boolean
  /** Whether a running turn keeps its header (a view without an activity row). */
  readonly liveTurnHeader: boolean
  readonly t: MayflyTranslate
  /** The messages the user typed while the agent works. */
  readonly queued: readonly { readonly id: string, readonly text: string }[]
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

/** Keep a long live text bounded while the model keeps the whole of it. */
function streamingWindow(text: string): string {
  const start = text.length - STREAMING_RENDER_MAX_CHARS
  const boundary = text.indexOf('\n', start)
  const visible = sanitizePluginText(text.slice(boundary < 0 ? start : boundary + 1))
  return `... (${String(text.length - visible.length)} earlier characters)\n${visible}`
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').find(candidate => candidate.trim() !== '')
  return line === undefined ? undefined : ellipsize(sanitizePluginText(line.trim()), PREVIEW_MAX_CHARS)
}

function lastLine(text: string): string | undefined {
  const line = text.split('\n').findLast(candidate => candidate.trim() !== '')
  return line === undefined ? undefined : ellipsize(sanitizePluginText(line.trim()), PREVIEW_MAX_CHARS)
}

function sameRow(left: StreamRow, right: StreamRow): boolean {
  const a = left as unknown as Record<string, unknown>
  const b = right as unknown as Record<string, unknown>
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const x = a[key]
    const y = b[key]
    return Array.isArray(x) ? Array.isArray(y) && x.length === y.length && x.every((value, index) => value === y[index]) : x === y
  })
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
    return inputs.queued.map((message) => {
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
    const visible = new Set(turnNumbers.slice(-policy.windowTurns))
    const entries = bounded.filter(entry => !isSemantic(entry) || visible.has(entry.turn))
    const display = buildDisplay({
      entries: [...entries, ...liveEntries],
      policy: policy.process,
      runningTurn: runningTurnOf(model, entries),
      turns: model.turns,
      expanded: inputs.expanded,
      scope: new Set(turnNumbers.slice(-policy.expandTurns)),
      flat: model.streaming === undefined,
      runningHeader: inputs.liveTurnHeader,
    })
    const times = new Map((model.turns ?? []).map(turn => [turn.turn, clockTime(turn.startedAt)]))
    const buckets: { readonly turn: number, readonly rows: StreamRow[] }[] = []
    let lead: StreamRow[] = []
    display.forEach((item, position) => {
      const turn = turnOf(item)
      const mapped = this.rowOf(item, inputs, position)
      if (mapped === undefined) return
      const row = this.intern(mapped, kept)
      if (turn === undefined) {
        // A canonical node belongs with the turn it precedes, or with the last one when none follows.
        if (buckets.length === 0 || lead.length > 0) lead.push(row)
        else buckets.at(-1)!.rows.push(row)
        return
      }
      let bucket = buckets.at(-1)
      if (bucket === undefined || bucket.turn !== turn) {
        bucket = { turn, rows: lead }
        lead = []
        buckets.push(bucket)
      }
      bucket.rows.push(row)
    })
    if (lead.length > 0) {
      if (buckets.length === 0) buckets.push({ turn: -1, rows: lead })
      else buckets.at(-1)!.rows.push(...lead)
    }
    return buckets.map(({ turn, rows }) => {
      const id = `turn:${String(turn)}`
      const time = times.get(turn)
      const previous = this.turns.get(id)
      const settled = previous !== undefined && previous.time === time && previous.rows.length === rows.length && previous.rows.every((row, index) => row === rows[index])
      const result: StreamTurn = settled ? previous : { id, ...(time === undefined ? {} : { time }), rows }
      keptTurns.set(id, result)
      return result
    })
  }

  private rowOf(item: DisplayItem, inputs: StreamInputs, position: number): StreamRow | undefined {
    if (item.kind === 'turn-header') return headerRow(item, inputs.t)
    if (item.kind === 'process-title') return titleRow(item, inputs.t)
    // A hand-built model may carry canonical nodes between its entries: their text is all the stream keeps.
    if (!isSemantic(item.entry)) return { kind: 'note', id: `node:${String(position)}`, text: sanitizePluginText(canonicalText(item.entry)) }
    return entryRow(item, item.entry, inputs)
  }
}

function turnOf(item: DisplayItem): number | undefined {
  if (item.kind !== 'entry') return item.turn
  return isSemantic(item.entry) ? item.entry.turn : undefined
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
    label = item.startedAt === undefined || item.endedAt === undefined ? t('Worked') : t('Took {duration}', { duration: compactElapsedMs(item.endedAt - item.startedAt) })
  }
  const counts = item.running ? [] : [
    ...(item.toolCalls === 0 ? [] : [t(item.toolCalls === 1 ? '{count} tool call' : '{count} tool calls', { count: item.toolCalls })]),
    ...(item.subagents === 0 ? [] : [t(item.subagents === 1 ? '{count} subagent' : '{count} subagents', { count: item.subagents })]),
  ]
  const tail = `${counts.map(count => ` · ${count}`).join('')}${item.hint ? ` · ${t('Ctrl+O to expand')}` : ''}`
  return { kind: 'header', id: item.id, mood, open: !item.folded, label, tail }
}

function titleRow(item: ProcessTitleItem, t: MayflyTranslate): StreamRow {
  return {
    kind: 'title',
    id: item.id,
    text: sanitizePluginText(processTitle(item.summary, t)),
    ...(item.summary.failed === 0 ? {} : { failed: t('{count} failed', { count: item.summary.failed }) }),
  }
}

/** The state a group of calls reads as: any pending call runs, any failed call fails. */
function groupState(states: readonly ('pending' | 'ok' | 'error')[], closed: boolean): 'running' | 'ok' | 'error' {
  if (states.includes('error')) return 'error'
  return states.includes('pending') && !closed ? 'running' : 'ok'
}

function canonicalText(node: MayflyUiNode): string {
  if (node.kind === 'text') return textOf(node.content)
  return node.kind === 'code' ? textOf(node.code) : `[${node.kind}]`
}

function entryRow(item: EntryItem, entry: TranscriptEntryModel, inputs: StreamInputs): StreamRow | undefined {
  const { t } = inputs
  switch (entry.kind) {
    case 'transcript-user':
      return {
        kind: 'prompt',
        id: entry.id,
        text: sanitizePluginText(entry.text),
        images: entry.images.map((image, index) => `${t('[image]')} ${String(index + 1)}${image.name === undefined ? '' : ` · ${sanitizePluginText(image.name)}`} · ${String(image.width)}×${String(image.height)} · ${String(Math.max(1, Math.round(image.bytes / 1024)))} KB`),
        open: item.expanded,
      }
    case 'transcript-assistant': {
      if (entry.text.trim() === '') return undefined
      return { kind: 'answer', id: entry.id, text: entry.text.length > STREAMING_RENDER_MAX_CHARS && entry.streaming ? streamingWindow(entry.text) : sanitizePluginText(entry.text) }
    }
    case 'transcript-thinking': {
      if (entry.text.trim() === '') return undefined
      // The activity row owns the live label; the stream shows the tail of what is being thought.
      if (entry.streaming) return { kind: 'reasoning', id: entry.id, label: lastLine(entry.text) ?? '' }
      const label = entry.durationMs === undefined ? t('Thought for a while') : t('Thought for {duration}', { duration: compactElapsedMs(Math.max(1000, entry.durationMs)) })
      const preview = inputs.policy.process.settledReasoningPreview ? firstLine(entry.text) : undefined
      return { kind: 'reasoning', id: entry.id, label, ...(preview === undefined ? {} : { preview }) }
    }
    case 'transcript-tool': {
      const state = entry.result === undefined ? item.turnClosed ? 'error' : 'running' : entry.result.isError ? 'error' : 'ok'
      const title = sanitizePluginText(entry.title ?? toolDisplayName(entry.name))
      const salient = ellipsize(sanitizePluginText(entry.detail), PREVIEW_MAX_CHARS)
      // The presenter's title often names the argument already.
      const detail = salient === '' || title.includes(salient) ? undefined : salient
      return { kind: 'step', id: entry.id, state, title, ...(detail === undefined ? {} : { detail }) }
    }
    case 'transcript-read-group': {
      const paths = [...new Set(entry.reads.map(read => read.path ?? read.label).filter((path): path is string => path !== undefined))]
      return groupRow(entry, entry.id, entry.reads.map(read => read.state), paths, item.turnClosed, t)
    }
    case 'transcript-search-group':
      return groupRow(entry, entry.id, entry.searches.map(call => call.state), entry.searches.map(call => call.pattern ?? call.detail), item.turnClosed, t)
    case 'transcript-command-group':
      return groupRow(entry, entry.id, entry.commands.map(call => call.state), entry.commands.map(call => call.command), item.turnClosed, t)
    case 'transcript-error':
      return { kind: 'error', id: entry.id, text: sanitizePluginText(entry.code === undefined ? entry.message : `${entry.message} (${entry.code})`) }
    case 'transcript-interrupted':
      return { kind: 'interrupted', id: entry.id, text: t('■ interrupted') }
    case 'transcript-compaction': {
      if (entry.state === 'running') return { kind: 'compaction', id: entry.id, state: 'running', text: `${t('compacting context…')}${entry.trigger === 'auto' ? t(' · auto') : ''}` }
      if (entry.state === 'error') return { kind: 'compaction', id: entry.id, state: 'error', text: firstLine(entry.error ?? entry.detail ?? t('compaction failed')) ?? t('compaction failed') }
      const done = entry.shadowedCount === undefined ? firstLine(entry.detail ?? t('compacted')) ?? t('compacted') : t('compacted {count} items', { count: entry.shadowedCount })
      return { kind: 'compaction', id: entry.id, state: 'ok', text: `${done}${entry.trigger === 'auto' ? t(' · auto') : ''}` }
    }
  }
}

/** One row for a group of read, search, or command calls: the past-tense title and the first things it touched. */
function groupRow(entry: TranscriptEntryModel, id: string, states: readonly ('pending' | 'ok' | 'error')[], things: readonly string[], closed: boolean, t: MayflyTranslate): StreamRow {
  const title = processTitle(summarizeProcess(memberFacts(entry, true).map(fact => ({ ...fact, running: false }))), t)
  const shown = things.slice(0, 2).map(thing => sanitizePluginText(thing)).join(', ')
  const more = things.length > 2 ? ` +${String(things.length - 2)}` : ''
  const detail = shown === '' ? undefined : ellipsize(`${shown}${more}`, PREVIEW_MAX_CHARS)
  return { kind: 'step', id, state: groupState(states, closed), title: sanitizePluginText(title), ...(detail === undefined ? {} : { detail }) }
}
