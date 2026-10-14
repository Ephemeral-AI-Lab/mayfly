/**
 * A tool call drawn at one of three tiers. Verbose is a block per call: a line (a glyph by outcome, the tool's name in bold,
 * the arguments it was given in parentheses, and what came of it) with a short body under it. Standard is a block for a run of calls of one
 * kind: a head line and a tree with one line per call. Compact is the stream's merged `title` row. A pure function of
 * facts: the texts arrive translated and the rows take the width they are given (the list clips their end), so a long
 * target is the first thing to give.
 *
 * @module components/tool-line
 */

import type { MayflyInlineSpan } from '@ephemeral-ai/mayfly-ui'

/** How a call stands: it still runs, it waits on the user's decision, it worked, it failed, the user sent it back with a revision, or it was cancelled (stopped by the user, or never started) and left no effect. */
export type ToolLineState = 'pending' | 'waiting' | 'ok' | 'error' | 'returned' | 'cancelled'

/** How a block of calls stands: as a call does, or `partial` when some of its calls failed and others worked. */
export type ToolGroupState = ToolLineState | 'partial'

/** The facts of one tool line. Every text is final: translated, sanitized, and without escape sequences. */
export interface ToolLineFacts {
  readonly state: ToolLineState
  /** The tool's name, in bold (`Read`, `Bash`, `WebSearch`). */
  readonly name: string
  /** What the call was given, shown in parentheses after the name: a path, a pattern, a command, an address. */
  readonly target?: string
  /** What came of it: a count, an exit status, a time. */
  readonly outcome?: string
  /** The lines a file change added and removed: a diffstat with its bar, in place of an outcome. */
  readonly stat?: ToolStat
}

/** Lines added and removed, which a line draws as `+4 −2` and a bar. */
export interface ToolStat {
  readonly added: number
  readonly removed: number
}

/** Cells of the bar that shows the share of added lines. */
const STAT_BAR_CELLS = 8

/** One row of a verbose block's body: a line of code, a match, a source, an output line. */
export interface ToolBodyRow {
  /** The muted lead: a line number, a file and line, the `⎿` of an output tail. */
  readonly lead?: string
  readonly text: string
  readonly tone?: 'default' | 'muted' | 'danger' | 'warning'
}

/** One hunk of a diff body: the text of each side. */
export interface ToolDiffHunk {
  readonly before: string
  readonly after: string
  /** Rows of this hunk shown before its `tail` row; absent shows it whole. */
  readonly maxRows?: number
  /** The translated row that ends a hunk cut at `maxRows`: how many rows the change leaves out. */
  readonly tail?: string
  /** The language of the file, which colors the code. */
  readonly language?: string
  /** The number the first row has after the change, for the end of a change (default 1: a hunk counts from its own first row). */
  readonly start?: number
  /** The number the first row has before the change (default `start`). */
  readonly beforeStart?: number
  /** The least width of the number column, which gives the hunks of one edit the gutter of the widest. */
  readonly numberWidth?: number
}

/** The code of a write, numbered and highlighted by its language. */
export interface ToolCodeFacts {
  readonly text: string
  readonly language?: string
  /** The number the first line has, for the end of a longer text. */
  readonly start?: number
}

/** The facts of a verbose block: the line, its body, and the row that says how much of the body is left out. */
export interface ToolBlockFacts extends ToolLineFacts {
  readonly body?: readonly ToolBodyRow[]
  /** A file change's body: the hunks of an edit (each numbered from its own first row, the Harness gives no file line), or a write's code. */
  readonly diff?: readonly ToolDiffHunk[]
  readonly code?: ToolCodeFacts
  /** A plan under review, as Markdown source of any length: the request's body, wrapped under the line. */
  readonly markdown?: string
  /** The translated `… +N more` row after a capped body. */
  readonly more?: string
  /** The translated `… +N earlier` row before a body that shows the end of the output. */
  readonly moreBefore?: string
}

/** One call in a standard block. */
export interface ToolGroupItemFacts {
  readonly state: ToolLineState
  readonly label: string
  readonly outcome?: string
  /** An opened call: the rows under its line, and the translated `… +N more` that follows when the call carries more. */
  readonly body?: readonly ToolBodyRow[]
  readonly more?: string
}

/** The facts of a standard block: a head and one line per call. */
export interface ToolGroupFacts {
  /** Pending while any call runs, then failed (every call), partial (some failed, some worked), cut off, or done. */
  readonly state: ToolGroupState
  /** The tool's name, in bold. */
  readonly name: string
  /** The translated rest of the head: what the calls count, and the time. */
  readonly head: string
  /** The translated tail of the head that is a warning, such as `1 failed`. */
  readonly failed?: string
  /** The translated tail of the head that counts the calls cancelled (stopped by the user or never started), such as `2 interrupted`: not failures, so it is muted. */
  readonly interrupted?: string
  readonly items: readonly ToolGroupItemFacts[]
}

const GLYPH = { pending: '● ', waiting: '? ', ok: '✓ ', error: '✗ ', returned: '↩ ', cancelled: '⊘ ', partial: '⚠ ' } as const
const GLYPH_TONE = { pending: 'primary', waiting: 'warning', ok: 'success', error: 'danger', returned: 'warning', cancelled: 'muted', partial: 'warning' } as const

/** The mark of a call in flight under a block's head: a small dot that breathes with the head's, as a row body paints it. */
const ITEM_PENDING_GLYPH: readonly MayflyInlineSpan[] = [{ text: '', motion: 'loader', variant: 'pulse' }, { text: ' ' }]

/** The glyph of a call that still runs: a dot that breathes (one motion channel, so the rest of the line is still). */
const PENDING_GLYPH: readonly MayflyInlineSpan[] = [{ text: '', motion: 'loader', variant: 'breath' }, { text: ' ' }]

/**
 * The spans of one tool line.
 * @param facts - the call's state, verb, target, and outcome.
 * @returns the spans, glyph first; a call that still runs leads with the breathing dot, which only a row body may paint.
 */
export function ToolLine(facts: ToolLineFacts): readonly MayflyInlineSpan[] {
  return [
    ...facts.state === 'pending' ? PENDING_GLYPH : [{ text: GLYPH[facts.state], tone: GLYPH_TONE[facts.state], ...(facts.state === 'waiting' ? { styles: ['strong'] as const } : {}) } as const],
    { text: facts.name, tone: facts.state === 'cancelled' ? 'muted' : 'default', styles: ['strong'] },
    ...(facts.target === undefined ? [] : [{ text: '(', tone: 'muted' } as const, { text: facts.target, tone: 'accent' } as const, { text: ')', tone: 'muted' } as const]),
    ...(facts.outcome === undefined ? [] : [{ text: ` · ${facts.outcome}`, tone: 'muted' } as const]),
    ...(facts.stat === undefined ? [] : [{ text: ' · ', tone: 'muted' } as const, ...ToolStatSpans(facts.stat)]),
  ]
}

/**
 * A diffstat: the added count in `success`, the removed in `danger`, and a bar of {@link STAT_BAR_CELLS} cells split by
 * their share.
 * @param stat - lines added and removed.
 * @returns the spans.
 */
function ToolStatSpans(stat: ToolStat): readonly MayflyInlineSpan[] {
  const total = stat.added + stat.removed
  // Each side keeps at least one cell while it has any line.
  const filled = total === 0 ? 0 : Math.min(STAT_BAR_CELLS - (stat.removed > 0 ? 1 : 0), Math.max(stat.added > 0 ? 1 : 0, Math.round(stat.added / total * STAT_BAR_CELLS)))
  return [
    { text: `+${String(stat.added)}`, tone: 'success' },
    { text: ' ', tone: 'muted' },
    { text: `−${String(stat.removed)}`, tone: 'danger' },
    ...(total === 0 ? [] : [
      { text: ' ', tone: 'muted' } as const,
      ...(filled === 0 ? [] : [{ text: '▮'.repeat(filled), tone: 'success' } as const]),
      ...(STAT_BAR_CELLS - filled === 0 ? [] : [{ text: '▮'.repeat(STAT_BAR_CELLS - filled), tone: 'danger' } as const]),
    ]),
  ]
}

/**
 * The spans of one body row of a verbose block, indented under the verb.
 * @param row - the row's lead and text.
 * @returns the spans.
 */
export function ToolBody(row: ToolBodyRow): readonly MayflyInlineSpan[] {
  return [
    { text: '  ' },
    ...(row.lead === undefined ? [] : [{ text: `${row.lead} `, tone: 'muted' } as const]),
    { text: row.text, tone: row.tone ?? 'default' },
  ]
}

/**
 * The spans of the row that follows a capped body.
 * @param more - the translated `… +N more` text.
 * @returns the spans.
 */
export function ToolMore(more: string): readonly MayflyInlineSpan[] {
  return [{ text: '  ' }, { text: more, tone: 'muted' }]
}

/**
 * The spans of a standard block's head.
 * @param facts - the block's state, head, and warning.
 * @returns the spans, glyph first; a block with a call in flight leads with the breathing dot, which only a row body may paint.
 */
export function ToolGroupHead(facts: ToolGroupFacts): readonly MayflyInlineSpan[] {
  return [
    ...facts.state === 'pending' ? PENDING_GLYPH : [{ text: GLYPH[facts.state], tone: GLYPH_TONE[facts.state] } as const],
    { text: facts.name, tone: facts.state === 'cancelled' ? 'muted' : 'default', styles: ['strong'] },
    ...(facts.head === '' ? [] : [{ text: ` · ${facts.head}`, tone: 'muted' } as const]),
    ...(facts.failed === undefined ? [] : [{ text: ` · ${facts.failed}`, tone: facts.state === 'partial' ? 'warning' : 'danger' } as const]),
    ...(facts.interrupted === undefined ? [] : [{ text: ` · ${facts.interrupted}`, tone: 'muted' } as const]),
  ]
}

/**
 * The spans of one call line of a standard block.
 * @param item - the call.
 * @param last - whether it is the block's last call (it closes the tree).
 * @returns the spans: the tree mark, a glyph for a call that did not work (a breathing small dot for one in flight, which only a row body may paint), the label, and the outcome.
 */
export function ToolGroupItem(item: ToolGroupItemFacts, last: boolean): readonly MayflyInlineSpan[] {
  return [
    { text: last ? '  └ ' : '  ├ ', tone: 'muted' },
    ...item.state === 'ok' ? [] : item.state === 'pending' ? ITEM_PENDING_GLYPH : [{ text: GLYPH[item.state], tone: GLYPH_TONE[item.state] } as const],
    { text: item.label, tone: 'accent' },
    ...(item.outcome === undefined ? [] : [{ text: ` · ${item.outcome}`, tone: 'muted' } as const]),
  ]
}
