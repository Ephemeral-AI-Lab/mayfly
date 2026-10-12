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
import type { TranscriptEntryModel, TranscriptModel, TranscriptTurnModel } from '../frontend/models.ts'
import type { StreamMood, StreamQueued, StreamRow, StreamTurn, TranscriptViewFacts } from '../components/transcript-view.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { buildDisplay, runningTurnOf, type DisplayItem, type EntryItem, type ProcessTitleItem, type TurnHeaderItem } from './process-groups.ts'
import { processTitle } from './process-activity.ts'
import { callsOf, standardRow, verboseRow, type Call } from './tool-calls.ts'
import type { TranscriptPresentationSnapshot } from './presentation-policy.ts'
import { ellipsize } from './present.ts'

/** Characters of a salient argument kept on a row. */
const PREVIEW_MAX_CHARS = 80

/** Characters of a one-line reasoning row kept in its facts: the row clips to the width it is given. */
const REASONING_LINE_MAX_CHARS = 400

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

function lastLine(text: string, max = PREVIEW_MAX_CHARS): string | undefined {
  const line = text.split('\n').findLast(candidate => candidate.trim() !== '')
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
    const lifecycle = new Map((model.turns ?? []).map(turn => [turn.turn, turn]))
    const buckets: { readonly turn: number, readonly rows: StreamRow[] }[] = []
    let lead: StreamRow[] = []
    runsOf(display, inputs.t).forEach((item, position) => {
      const turn = turnOf(item)
      const mapped = this.rowsOf(item, inputs, position).map(row => this.intern(row, kept))
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
    return buckets.map(({ turn, rows }) => {
      const id = `turn:${String(turn)}`
      const closing = closingOf(lifecycle.get(turn), inputs.t)
      const previous = this.turns.get(id)
      const settled = previous !== undefined && previous.closing === closing && previous.rows.length === rows.length && previous.rows.every((row, index) => row === rows[index])
      const result: StreamTurn = settled ? previous : { id, number: Math.max(0, turn), rows, ...(closing === undefined ? {} : { closing }) }
      keptTurns.set(id, result)
      return result
    })
  }

  private rowsOf(item: DisplayItem | RunUnit, inputs: StreamInputs, position: number): readonly StreamRow[] {
    if (item.kind === 'run') return [standardRow(item.calls, inputs.t)]
    if (item.kind === 'turn-header') return [headerRow(item, inputs.t)]
    if (item.kind === 'process-title') return [titleRow(item, inputs.t)]
    // A hand-built model may carry canonical nodes between its entries: their text is all the stream keeps.
    if (!isSemantic(item.entry)) return [{ kind: 'note', id: `node:${String(position)}`, text: sanitizePluginText(canonicalText(item.entry)) }]
    return entryRows(item, item.entry, inputs)
  }
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
  if (mood === 'done') return { kind: 'header', id: item.id, mood, open: !item.folded, label: [...counts, ...(hint === '' ? [] : [hint])].join(' · ') || t('Worked'), tail: '' }
  return { kind: 'header', id: item.id, mood, open: !item.folded, label, tail: `${counts.map(count => ` · ${count}`).join('')}${hint === '' ? '' : ` · ${hint}`}` }
}

function titleRow(item: ProcessTitleItem, t: MayflyTranslate): StreamRow {
  return {
    kind: 'title',
    id: item.id,
    text: sanitizePluginText(processTitle(item.summary, t)),
    ...(item.summary.failed === 0 ? {} : { failed: t('{count} failed', { count: item.summary.failed }) }),
  }
}

function canonicalText(node: MayflyUiNode): string {
  if (node.kind === 'text') return textOf(node.content)
  return node.kind === 'code' ? textOf(node.code) : `[${node.kind}]`
}

/** A run of settled calls of one kind that the standard tier draws as one block. */
interface RunUnit {
  readonly kind: 'run'
  readonly turn: number
  readonly calls: readonly Call[]
}

function isToolLike(entry: TranscriptEntryModel): boolean {
  return entry.kind === 'transcript-read-group' || entry.kind === 'transcript-search-group' || entry.kind === 'transcript-command-group'
    || entry.kind === 'transcript-tool'
}

/** An edit or a write: each is its own open block at the standard tier, never part of a run. */
function isFileChange(entry: TranscriptEntryModel): boolean {
  return entry.kind === 'transcript-tool' && (entry.activity === 'edit' || entry.activity === 'write')
}

/**
 * The display plan with the tool entries of the standard tier gathered into runs: consecutive calls of one kind, whatever
 * entries they came in, are one block. Anything else (a reasoning, an answer, a file change, a header) ends the run, and
 * a call that still runs is skipped without ending it.
 */
function runsOf(display: readonly DisplayItem[], t: MayflyTranslate): readonly (DisplayItem | RunUnit)[] {
  const units: (DisplayItem | RunUnit)[] = []
  let run: { turn: number, calls: Call[] } | undefined
  const flush = (): void => {
    if (run !== undefined) units.push({ kind: 'run', turn: run.turn, calls: run.calls })
    run = undefined
  }
  for (const item of display) {
    if (item.kind === 'entry' && item.tier === 'standard' && isSemantic(item.entry) && isToolLike(item.entry) && !isFileChange(item.entry)) {
      for (const call of callsOf(item.entry, item.turnClosed, t)) {
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
function entryRows(item: EntryItem, entry: TranscriptEntryModel, inputs: StreamInputs): readonly StreamRow[] {
  if (isToolLike(entry)) return callsOf(entry, item.turnClosed, inputs.t).map(call => verboseRow(call, item.expanded, inputs.t, item.tier === 'standard' ? 'standard' : 'verbose'))
  const row = entryRow(item, entry, inputs)
  return row === undefined ? [] : [row]
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
      // The activity row owns the live label and clock; a mode that streams reasoning grows its text under the header,
      // any other shows the latest line.
      if (entry.streaming) {
        return inputs.policy.process.streamedReasoning
          ? { kind: 'reasoning', id: entry.id, label: t('Thinking'), text: sanitizePluginText(entry.text.trim()) }
          : { kind: 'reasoning', id: entry.id, text: lastLine(entry.text, REASONING_LINE_MAX_CHARS) ?? '' }
      }
      // A mode that previews settled reasoning shows one line of it; a turn that is open (Verbose, Ctrl+O) shows the whole.
      if (inputs.policy.process.settledReasoningPreview && !item.expanded) return { kind: 'reasoning', id: entry.id, text: firstLine(entry.text, REASONING_LINE_MAX_CHARS) ?? '' }
      const took = entry.durationMs === undefined ? '' : ` · ${compactElapsedMs(Math.max(1000, entry.durationMs))}`
      return { kind: 'reasoning', id: entry.id, label: `${t('Thinking')}${took}`, text: sanitizePluginText(entry.text.trim()) }
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
    case 'transcript-compaction': {
      if (entry.state === 'running') return { kind: 'compaction', id: entry.id, state: 'running', text: `${t('compacting context…')}${entry.trigger === 'auto' ? t(' · auto') : ''}` }
      if (entry.state === 'error') return { kind: 'compaction', id: entry.id, state: 'error', text: firstLine(entry.error ?? entry.detail ?? t('compaction failed')) ?? t('compaction failed') }
      const done = entry.shadowedCount === undefined ? firstLine(entry.detail ?? t('compacted')) ?? t('compacted') : t('compacted {count} items', { count: entry.shadowedCount })
      return { kind: 'compaction', id: entry.id, state: 'ok', text: `${done}${entry.trigger === 'auto' ? t(' · auto') : ''}` }
    }
  }
}
