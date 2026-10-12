/**
 * The conversation stream: one browse list whose rows are the turns of a session. A turn after the first starts with a
 * blank row, and a turn that has ended closes with one muted row (`✻ Worked for 21s · done 10:13`); the prompt row keeps
 * its own bold line, wraps, and folds behind `▸ N more lines · Enter` past {@link PROMPT_MAX_LINES}. Every other kind of row is a minimal one-row stand-in that its
 * own component replaces (answers, reasoning, tools, groups, compaction).
 *
 * The component is a pure function of facts: texts arrive translated and times arrive formatted. The facts of a row are
 * kept by identity, so an unchanged row keeps its frozen items and the list's row cache hits.
 *
 * @module components/transcript-view
 */

import { freezeWire, ui, type MayflyInlineSpan, type MayflyListItem, type MayflyListNode } from '@ephemeral-ai/mayfly-ui'

/** A prompt shows at most this many lines; opening it (or a search hit inside it) shows the rest. */
export const PROMPT_MAX_LINES = 4

/** How a header or a step reads: the tone of its label and its glyph. */
export type StreamMood = 'running' | 'done' | 'stopped' | 'failed'

/** One row of a turn. Every text is final: translated, sanitized, and without escape sequences. */
export type StreamRow =
  | {
    readonly kind: 'prompt'
    readonly id: string
    readonly text: string
    /** One short label per attached image. */
    readonly images: readonly string[]
    /** Whether the prompt shows all its lines. */
    readonly open: boolean
  }
  | { readonly kind: 'answer', readonly id: string, readonly text: string }
  | { readonly kind: 'reasoning', readonly id: string, readonly label: string, readonly preview?: string }
  /** A tool call or a group of calls: a glyph by state, a title, and the salient argument. */
  | { readonly kind: 'step', readonly id: string, readonly state: 'running' | 'ok' | 'error', readonly title: string, readonly detail?: string }
  /** The past-tense title of a folded process group. */
  | { readonly kind: 'title', readonly id: string, readonly text: string, readonly failed?: string }
  /** The turn header: its lifecycle label and counts. */
  | { readonly kind: 'header', readonly id: string, readonly mood: StreamMood, readonly open: boolean, readonly label: string, readonly tail: string }
  | { readonly kind: 'compaction', readonly id: string, readonly state: 'running' | 'ok' | 'error', readonly text: string }
  | { readonly kind: 'error', readonly id: string, readonly text: string }
  /** The cut-turn marker, whole: its `■` is part of the translated text. */
  | { readonly kind: 'interrupted', readonly id: string, readonly text: string }
  /** Any other text the stream shows. */
  | { readonly kind: 'note', readonly id: string, readonly text: string }

/** One turn: the rows it holds, and the closing line of a turn that has ended. */
export interface StreamTurn {
  readonly id: string
  readonly rows: readonly StreamRow[]
  /** The translated closing text, without its glyph: how long the turn worked and when it was done. */
  readonly closing?: string
}

/** A message the user typed while the agent works: the next turn's prompt, not yet part of the session. */
export interface StreamQueued {
  readonly id: string
  readonly text: string
  /** The translated mark after the text, such as `⏎ queued`. */
  readonly suffix: string
}

/** The facts of the stream. */
export interface TranscriptViewFacts {
  readonly turns: readonly StreamTurn[]
  readonly queued: readonly StreamQueued[]
}

const span = (text: string, tone?: MayflyInlineSpan['tone'], styles?: MayflyInlineSpan['styles']): MayflyInlineSpan =>
  ({ text, ...(tone === undefined ? {} : { tone }), ...(styles === undefined ? {} : { styles }) })

const MOOD_TONE = { running: 'primary', done: 'muted', stopped: 'warning', failed: 'danger' } as const
const STATE_GLYPH = { running: '● ', ok: '✓ ', error: '✗ ' } as const
const STATE_TONE = { running: 'primary', ok: 'success', error: 'danger' } as const

/** A one-row item: `spans` are what it paints, and the plain label is what a filter or a screen reader reads. */
function line(id: string, spans: readonly MayflyInlineSpan[], more: Partial<MayflyListItem> = {}): MayflyListItem {
  return { id, label: spans.map(part => part.text).join(''), labelSpans: spans, ...more }
}

/** A non-selectable blank row. */
function blank(id: string): MayflyListItem {
  return { id, label: '', disabled: true, gap: true }
}

/** The prompt row, wrapped under its own gutter and capped unless it is open. */
function promptItem(id: string, text: string, open: boolean, suffix?: string): MayflyListItem {
  return line(id, [span('» ', 'user'), span(text, 'default', ['strong']), ...(suffix === undefined ? [] : [span(`  ${suffix}`, 'muted')])], {
    wrap: true,
    hang: 2,
    ...(open ? {} : { wrapMax: PROMPT_MAX_LINES }),
  })
}

function rowItems(row: StreamRow): readonly MayflyListItem[] {
  switch (row.kind) {
    case 'prompt':
      return [
        promptItem(row.id, row.text, row.open),
        ...row.images.map((label, index) => line(`${row.id}.image.${String(index)}`, [span('  ▪ ', 'muted'), span(label, 'muted')])),
      ]
    // One item per source line keeps the blank lines and the layout of the text; a long line wraps under the gutter.
    case 'answer': return row.text.split('\n').map((text, index) => text.trim() === '' && index > 0
      ? blank(`${row.id}.${String(index)}`)
      : line(`${row.id}.${String(index)}`, [span(index === 0 ? '● ' : '  '), span(text)], { wrap: true, hang: 2 }))
    case 'reasoning': return [line(row.id, [span('✻ ', 'muted'), span(row.label, 'muted', ['italic']), ...(row.preview === undefined ? [] : [span(`  ${row.preview}`, 'muted', ['italic'])])])]
    case 'step': return [line(row.id, [span(STATE_GLYPH[row.state], STATE_TONE[row.state]), span(row.title), ...(row.detail === undefined ? [] : [span(` · ${row.detail}`, 'muted')])])]
    case 'title': return [line(row.id, [span('▸ ', 'muted'), span(row.text, 'muted'), ...(row.failed === undefined ? [] : [span(` · ${row.failed}`, 'danger')])])]
    case 'header': return [line(row.id, [span(row.open ? '▾ ' : '▸ ', 'muted'), span(row.label, MOOD_TONE[row.mood]), ...(row.tail === '' ? [] : [span(row.tail, 'muted')])])]
    case 'compaction': return [line(row.id, [span(STATE_GLYPH[row.state], STATE_TONE[row.state]), span(row.text)])]
    case 'error': return [line(row.id, [span('✗ ', 'danger'), span(row.text, 'danger')], { wrap: true, hang: 2 })]
    case 'interrupted': return [line(row.id, [span(row.text, 'warning')])]
    case 'note': return [line(row.id, [span(row.text, 'muted')])]
  }
}

/** A row's frozen items, kept while the row's facts keep their identity. */
const rowCache = new WeakMap<StreamRow, readonly MayflyListItem[]>()

function itemsOf(row: StreamRow): readonly MayflyListItem[] {
  let items = rowCache.get(row)
  if (items === undefined) {
    items = freezeWire(rowItems(row))
    rowCache.set(row, items)
  }
  return items
}

/** The blank row that opens a turn after the first. */
const gapCache = new WeakMap<StreamTurn, MayflyListItem>()

function blankBetween(turn: StreamTurn): MayflyListItem {
  let item = gapCache.get(turn)
  if (item === undefined) {
    item = freezeWire(blank(`${turn.id}.gap`))
    gapCache.set(turn, item)
  }
  return item
}

/** The closing row of a turn that has ended, behind a blank row, by turn facts. */
const closingCache = new WeakMap<StreamTurn, readonly MayflyListItem[]>()

function closingOf(turn: StreamTurn): readonly MayflyListItem[] {
  if (turn.closing === undefined) return []
  let items = closingCache.get(turn)
  if (items === undefined) {
    items = freezeWire([blank(`${turn.id}.end.gap`), line(`${turn.id}.end`, [span('✻ ', 'muted'), span(turn.closing, 'muted')])])
    closingCache.set(turn, items)
  }
  return items
}

const queuedCache = new WeakMap<StreamQueued, readonly MayflyListItem[]>()

function queuedItems(message: StreamQueued): readonly MayflyListItem[] {
  let items = queuedCache.get(message)
  if (items === undefined) {
    items = freezeWire([blank(`queued.${message.id}.gap`), promptItem(`queued.${message.id}`, message.text, false, message.suffix)])
    queuedCache.set(message, items)
  }
  return items
}

/**
 * The stream as a browse list.
 * @param facts - the turns, in order, and the messages queued behind them.
 * @returns the list node; its items keep their identity while their facts do.
 */
export function TranscriptView(facts: TranscriptViewFacts): MayflyListNode {
  const items: MayflyListItem[] = []
  facts.turns.forEach((turn, index) => {
    if (index > 0) items.push(blankBetween(turn))
    for (const row of turn.rows) items.push(...itemsOf(row))
    items.push(...closingOf(turn))
  })
  for (const message of facts.queued) items.push(...queuedItems(message))
  return ui.list({ id: 'stream', role: 'browse', acceptVerb: 'expand', hintLabel: 'stream', items })
}
