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

/** How a settled call ended: it worked, it failed, or its turn ended before it settled. */
export type ToolLineState = 'ok' | 'error' | 'cancelled'

/** The facts of one tool line. Every text is final: translated, sanitized, and without escape sequences. */
export interface ToolLineFacts {
  readonly state: ToolLineState
  /** The tool's name, in bold (`Read`, `Bash`, `WebSearch`). */
  readonly name: string
  /** What the call was given, shown in parentheses after the name: a path, a pattern, a command, an address. */
  readonly target?: string
  /** What came of it: a count, an exit status, a time. */
  readonly outcome?: string
}

/** One row of a verbose block's body: a line of code, a match, a source, an output line. */
export interface ToolBodyRow {
  /** The muted lead: a line number, a file and line, the `⎿` of an output tail. */
  readonly lead?: string
  readonly text: string
  readonly tone?: 'default' | 'muted' | 'danger'
}

/** The facts of a verbose block: the line, its body, and the row that says how much of the body is left out. */
export interface ToolBlockFacts extends ToolLineFacts {
  readonly body?: readonly ToolBodyRow[]
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
}

/** The facts of a standard block: a head and one line per call. */
export interface ToolGroupFacts {
  readonly state: ToolLineState
  /** The translated head: what the calls did, in counts. */
  readonly head: string
  /** The translated tail of the head that is a warning, such as `1 failed`. */
  readonly failed?: string
  readonly items: readonly ToolGroupItemFacts[]
}

const GLYPH = { ok: '✓ ', error: '✗ ', cancelled: '⊘ ' } as const
const GLYPH_TONE = { ok: 'success', error: 'danger', cancelled: 'muted' } as const

/**
 * The spans of one tool line.
 * @param facts - the call's state, verb, target, and outcome.
 * @returns the spans, glyph first.
 */
export function ToolLine(facts: ToolLineFacts): readonly MayflyInlineSpan[] {
  return [
    { text: GLYPH[facts.state], tone: GLYPH_TONE[facts.state] },
    { text: facts.name, tone: facts.state === 'cancelled' ? 'muted' : 'default', styles: ['strong'] },
    ...(facts.target === undefined ? [] : [{ text: '(', tone: 'muted' } as const, { text: facts.target, tone: 'accent' } as const, { text: ')', tone: 'muted' } as const]),
    ...(facts.outcome === undefined ? [] : [{ text: ` · ${facts.outcome}`, tone: 'muted' } as const]),
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
 * @returns the spans, glyph first.
 */
export function ToolGroupHead(facts: ToolGroupFacts): readonly MayflyInlineSpan[] {
  return [
    { text: GLYPH[facts.state], tone: GLYPH_TONE[facts.state] },
    { text: facts.head, tone: 'default' },
    ...(facts.failed === undefined ? [] : [{ text: ` · ${facts.failed}`, tone: 'danger' } as const]),
  ]
}

/**
 * The spans of one call line of a standard block.
 * @param item - the call.
 * @param last - whether it is the block's last call (it closes the tree).
 * @returns the spans: the tree mark, a glyph for a call that did not work, the label, and the outcome.
 */
export function ToolGroupItem(item: ToolGroupItemFacts, last: boolean): readonly MayflyInlineSpan[] {
  return [
    { text: last ? '  └ ' : '  ├ ', tone: 'muted' },
    ...(item.state === 'ok' ? [] : [{ text: GLYPH[item.state], tone: GLYPH_TONE[item.state] } as const]),
    { text: item.label, tone: 'accent' },
    ...(item.outcome === undefined ? [] : [{ text: ` · ${item.outcome}`, tone: 'muted' } as const]),
  ]
}
