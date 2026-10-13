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
import { CompactionRow, type CompactionFacts } from './compaction-row.ts'
import { ToolBody, ToolGroupHead, ToolGroupItem, ToolLine, ToolMore, type ToolBlockFacts, type ToolGroupFacts } from './tool-line.ts'

/** A prompt shows at most this many lines; opening it (or a search hit inside it) shows the rest. */
export const PROMPT_MAX_LINES = 4

/** Unchanged lines a diff body keeps around each change. */
const DIFF_CONTEXT = 1

/** The tallest a prompt's picture paints, in terminal rows. */
export const PROMPT_IMAGE_MAX_ROWS = 12

/** One image attached to a prompt: the reference the host resolves to bytes, and the text shown until it does. */
export interface StreamImage {
  readonly attachmentId: string
  /** The text fallback: while the bytes load, when they are missing, and on a terminal without an image protocol. */
  readonly alt: string
}

/** How a header or a step reads: the tone of its label and its glyph. */
export type StreamMood = 'running' | 'done' | 'stopped' | 'failed'

/** One row of a turn. Every text is final: translated, sanitized, and without escape sequences. */
export type StreamRow =
  | {
    readonly kind: 'prompt'
    readonly id: string
    readonly text: string
    /** The images attached to the prompt, in block order. */
    readonly images: readonly StreamImage[]
    /** Whether the prompt shows all its lines. */
    readonly open: boolean
  }
  /** The model's answer, as Markdown source. */
  | { readonly kind: 'answer', readonly id: string, readonly text: string }
  /**
   * The model's reasoning: a header (`Thinking`, with how long it took once settled; a breathing dot while `pending`) and its
   * `rows` by tier: the last ones under an `earlier` row while it is written, the first ones above a `more` row once it is done.
   */
  | { readonly kind: 'reasoning', readonly id: string, readonly label: string, readonly pending?: boolean, readonly rows?: readonly string[], readonly earlier?: string, readonly more?: string }
  /** A tool call, the verbose tier: a glyph by state (a dot that breathes while it runs), the name, the target, what came of it, and a short body. */
  | ({ readonly kind: 'tool', readonly id: string } & ToolBlockFacts)
  /** A run of settled calls of one kind, the standard tier: a head and one line per call. */
  | ({ readonly kind: 'tools', readonly id: string } & ToolGroupFacts)
  /** The past-tense title of a folded process group. */
  | { readonly kind: 'title', readonly id: string, readonly text: string, readonly failed?: string, readonly hint?: string }
  /** The turn header: its lifecycle label and counts. */
  | { readonly kind: 'header', readonly id: string, readonly mood: StreamMood, readonly open: boolean, readonly label: string, readonly tail: string }
  /**
   * One context compaction: its facts, and under a settled one the hint that opens its summary or, once opened, the
   * summary's first lines. A `trailing` row (a manual `/compact`) is its own block after the turn it followed.
   */
  | { readonly kind: 'compaction', readonly id: string, readonly facts: CompactionFacts, readonly hint?: string, readonly summary?: readonly string[], readonly more?: string, readonly trailing?: true }
  | { readonly kind: 'error', readonly id: string, readonly text: string }
  /** The cut-turn marker, whole: its `■` is part of the translated text. */
  | { readonly kind: 'interrupted', readonly id: string, readonly text: string }
  /** Any other text the stream shows. */
  | { readonly kind: 'note', readonly id: string, readonly text: string }

/** One turn: the rows it holds, and the closing line of a turn that has ended. */
export interface StreamTurn {
  readonly id: string
  /** The turn's number in its session: it only grows, so a count of turns survives the window dropping old ones. */
  readonly number: number
  readonly rows: readonly StreamRow[]
  /** The translated closing text, without its glyph: how long the turn worked and when it was done. */
  readonly closing?: string
  /** Blocks of their own after the closing line: a manual `/compact` that followed the turn. */
  readonly after?: readonly StreamRow[]
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
        ...row.images.map((image, index): MayflyListItem => ({
          id: `${row.id}.image.${String(index)}`,
          label: image.alt,
          body: ui.image({ attachmentId: image.attachmentId, alt: image.alt, maxRows: PROMPT_IMAGE_MAX_ROWS }),
          bodyAlways: true,
          bodyLead: [span('  ▪ ', 'muted')],
        })),
      ]
    // One item holds the whole answer: its Markdown body lays out the blocks and wraps under the `●` that leads it.
    case 'answer': return [{ id: row.id, label: '', body: ui.markdown(row.text), bodyAlways: true, bodyLead: [span('● ')] }]
    // The reasoning is a header row and its rows under it (as many as the tier shows), aligned under the label.
    case 'reasoning': return [
      // Still thinking: a breathing dot; done: the `✻` with the duration. Then its rows.
      row.pending === true
        ? { id: row.id, label: row.label, body: ui.richText([{ text: '', motion: 'loader', variant: 'breath' }, { text: ` ${row.label}`, tone: 'muted' }], { overflow: 'truncate' }), bodyAlways: true, bodyLead: [span('')] } satisfies MayflyListItem
        : line(row.id, [span('✻ ', 'muted'), span(row.label, 'muted')]),
      ...(row.earlier === undefined ? [] : [line(`${row.id}.earlier`, ToolMore(row.earlier))]),
      ...(row.rows ?? []).map((text, index) => line(`${row.id}.row.${String(index)}`, ToolBody({ text, tone: 'muted' }))),
      ...(row.more === undefined ? [] : [line(`${row.id}.more`, ToolMore(row.more))]),
    ]
    case 'tool': return [
      // A call that still runs leads with a breathing dot, a motion span that only a row body may paint.
      row.state === 'pending'
        ? { id: row.id, label: row.name, body: ui.richText(ToolLine(row), { overflow: 'truncate' }), bodyAlways: true, bodyLead: [span('')] } satisfies MayflyListItem
        : line(row.id, ToolLine(row)),
      ...(row.moreBefore === undefined ? [] : [line(`${row.id}.before`, ToolMore(row.moreBefore))]),
      ...(row.body ?? []).map((part, index) => line(`${row.id}.body.${String(index)}`, ToolBody(part))),
      // An edit's hunks, each a diff of its own (the band behind the changed code, no line numbers); a write's code.
      ...(row.diff ?? []).flatMap((hunk, index): MayflyListItem[] => [
        // The hunks of one edit are apart in the file: a `⋯` stands between them.
        ...(index === 0 ? [] : [line(`${row.id}.diff.${String(index)}.gap`, [span('  ⋯', 'muted')])]),
        {
          id: `${row.id}.diff.${String(index)}`,
          label: '',
          body: ui.diff(hunk.before, hunk.after, {
            hunkHeader: false,
            context: DIFF_CONTEXT,
            ...(hunk.maxRows === undefined ? {} : { maxRows: hunk.maxRows }),
            ...(hunk.tail === undefined ? {} : { tail: hunk.tail }),
            ...(hunk.language === undefined ? {} : { language: hunk.language }),
            ...(hunk.start === undefined ? {} : { start: hunk.start }),
          }),
          bodyAlways: true,
          // A lead puts the body on the line itself (no blank head row); the diff's own indent sets its column.
          bodyLead: [span('')],
        },
      ]),
      ...(row.code === undefined ? [] : [{
        id: `${row.id}.code`,
        label: '',
        body: ui.code(row.code.text, { numbered: true, label: false, ...(row.code.language === undefined ? {} : { language: row.code.language }), ...(row.code.start === undefined ? {} : { start: row.code.start }) }),
        bodyAlways: true,
        bodyLead: [span('  ')],
      } satisfies MayflyListItem]),
      ...(row.more === undefined ? [] : [line(`${row.id}.more`, ToolMore(row.more))]),
    ]
    case 'tools': return [
      row.state === 'pending'
        ? { id: row.id, label: row.name, body: ui.richText(ToolGroupHead(row), { overflow: 'truncate' }), bodyAlways: true, bodyLead: [span('')] } satisfies MayflyListItem
        : line(row.id, ToolGroupHead(row)),
      ...row.items.map((item, index) => line(`${row.id}.item.${String(index)}`, ToolGroupItem(item, index === row.items.length - 1))),
    ]
    case 'title': return [line(row.id, [span('▸ ', 'muted'), span(row.text, 'muted'), ...(row.failed === undefined ? [] : [span(` · ${row.failed}`, 'danger')]), ...(row.hint === undefined ? [] : [span(` · ${row.hint}`, 'muted')])])]
    case 'header': return [line(row.id, [span(row.open ? '▾ ' : '▸ ', 'muted'), span(row.label, MOOD_TONE[row.mood]), ...(row.tail === '' ? [] : [span(row.tail, 'muted')])])]
    case 'compaction': return [
      { id: row.id, label: row.facts.title, body: CompactionRow(row.facts), bodyAlways: true, bodyLead: [span('')] } satisfies MayflyListItem,
      ...row.hint === undefined ? [] : [line(`${row.id}.hint`, [span('  ⎿ ', 'muted'), span(row.hint, 'muted')])],
      ...(row.summary ?? []).map((text, index) => line(`${row.id}.summary.${String(index)}`, [span(index === 0 ? '  ⎿ ' : '    ', 'muted'), span(text, 'muted')], { wrap: true, hang: 4 })),
      ...row.more === undefined ? [] : [line(`${row.id}.more`, [span('    '), span(row.more, 'muted')])],
    ]
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

/** The blank row before a row, kept by the row's facts. */
const rowGapCache = new WeakMap<StreamRow, MayflyListItem>()

function rowGap(row: StreamRow): MayflyListItem {
  let item = rowGapCache.get(row)
  if (item === undefined) {
    item = freezeWire(blank(`${row.id}.gap`))
    rowGapCache.set(row, item)
  }
  return item
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
 * The number of the newest turn the stream holds, for the `N new turns` tally of a view scrolled away from its tail: the
 * screen compares it over time, so the tally counts the turns of the agent loop that began below the view, never the
 * rows, tool calls, or message blocks inside one.
 * @param facts - the facts the stream was built from.
 * @returns the newest turn's number, or 0 with no turn.
 */
export function latestTurnOf(facts: TranscriptViewFacts): number {
  return facts.turns.reduce((latest, turn) => Math.max(latest, turn.number), 0)
}

/**
 * The stream as a browse list.
 * @param facts - the turns, in order, and the messages queued behind them.
 * @returns the list node; its items keep their identity while their facts do.
 */
/**
 * The items with every id unique: the list node is refused whole when two items share an id, which would blank the
 * whole stream for one repeated id. A repeat takes a numbered id, so the stream draws and the rest keep their identity.
 */
function withUniqueIds(items: MayflyListItem[]): MayflyListItem[] {
  const seen = new Set<string>()
  let repeated = false
  for (const item of items) {
    if (seen.has(item.id)) { repeated = true; break }
    seen.add(item.id)
  }
  if (!repeated) return items
  const used = new Set<string>()
  return items.map((item) => {
    let id = item.id
    for (let copy = 2; used.has(id); copy += 1) id = `${item.id}~${String(copy)}`
    used.add(id)
    return id === item.id ? item : freezeWire({ ...item, id })
  })
}

export function TranscriptView(facts: TranscriptViewFacts): MayflyListNode {
  const items: MayflyListItem[] = []
  facts.turns.forEach((turn, index) => {
    if (index > 0) items.push(blankBetween(turn))
    turn.rows.forEach((row, position) => {
      // Every row is a block of its own, and a blank row separates two blocks.
      if (position > 0) items.push(rowGap(row))
      items.push(...itemsOf(row))
    })
    items.push(...closingOf(turn))
    turn.after?.forEach((row) => {
      items.push(rowGap(row), ...itemsOf(row))
    })
  })
  for (const message of facts.queued) items.push(...queuedItems(message))
  return ui.list({ id: 'stream', role: 'browse', acceptVerb: 'expand', hintLabel: 'stream', items: withUniqueIds(items) })
}
