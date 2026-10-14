/**
 * The notification line: the one row between the activity block and the editor that carries the notice the user
 * should see now (a lane notification, a provider retry, a full context, a resumed session) and, when the stream is
 * scrolled away from its tail, the chip that returns to it, centered. The notice sits on the right
 * and is never wider than half the row (less, beside the chip): the row is two equal flexible halves, the left one empty, and the right one
 * puts its text in its right band and truncates it there. The row exists whether or not there is a notice (a
 * blank row then), so the editor never shifts. A pure function of facts: the text arrives translated and final, and
 * the glyph carries the severity beside the tone, never the color alone.
 *
 * @module components/notification-line
 */

import { ui, type MayflyInlineSpan, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** How serious a notice is; the same four levels as the notification lane. */
export type NotificationSeverity = 'success' | 'info' | 'warning' | 'error'

/** The facts of one notification line. */
export interface NotificationFacts {
  readonly severity: NotificationSeverity
  /** The message, one line, final. */
  readonly message: string
  /** How many more notices wait behind this one (shown as a muted `+N` after the message). */
  readonly waiting?: number
}

/** The glyph and tone of a notice; information has none, its words are the whole notice. */
const GLYPHS: Readonly<Record<Exclude<NotificationSeverity, 'info'>, readonly [string, MayflyTone]>> = {
  success: ['✓', 'success'], warning: ['⚠', 'warning'], error: ['✗', 'danger'],
}

/** The spans of a notice: the glyph, then the message (in the severity's tone for a warning or an error). */
function spans(facts: NotificationFacts): readonly MayflyInlineSpan[] {
  if (facts.severity === 'info') return [{ text: facts.message }]
  const [glyph, tone] = GLYPHS[facts.severity]
  const quiet = facts.severity === 'success'
  return [
    { text: `${glyph} `, tone },
    quiet ? { text: facts.message } : { text: facts.message, tone },
    ...facts.waiting === undefined || facts.waiting <= 0 ? [] : [{ text: ` · +${facts.waiting}`, tone: 'muted' as const }],
  ]
}

/**
 * The left filler and the right cell of the row. The flex allocator deals each pass's share to the first grower first,
 * so equal weights would give the right cell a third; 2:3 gives it just under half (47% to 48% from 40 to 200 columns,
 * before the margin).
 */
const FILLER = { basis: 0, grow: 2, shrink: 1 } as const
const CELL = { basis: 0, grow: 3, shrink: 1 } as const
/** The columns kept free at the right edge, as the stream keeps two at the left. */
const MARGIN = { basis: 3, grow: 0, shrink: 0 } as const
/** With the chip between them, the two sides share what it leaves; 5:8 comes out equal (within four columns) from 40 to 220. */
const SIDE_LEFT = { basis: 0, grow: 5, shrink: 1 } as const
const SIDE_RIGHT = { basis: 0, grow: 8, shrink: 1 } as const
/** With a notice and the mode's keys on one row, they share the room evenly. */
const SIDE_KEYS = { basis: 0, grow: 1, shrink: 1 } as const
const SIDE_NOTICE = { basis: 0, grow: 1, shrink: 1 } as const
/** The chip keeps its own width. */
const CHIP = { basis: 'auto', grow: 0, shrink: 0 } as const

/** What the row shows: a notice on the right, the way back to the bottom of the stream in the middle, or both. */
export interface NotificationRowFacts {
  readonly notice?: NotificationFacts
  /** The translated words of the chip that returns to the tail of the stream (`Back to bottom · Ctrl+↓`). */
  readonly chip?: string
  /** What the prompt awaits (`Reading the clipboard…`), shown with the unified loader while there is no notice. */
  readonly wait?: string
  /** What the row teaches while it has no notice: the keys that move focus off the prompt, muted, in the notice's place. */
  readonly hint?: string
  /** The keys of the mode that holds focus (the conversation's row cursor), muted at the stream's left margin; a notice keeps the right. */
  readonly keys?: string
}

/** The notice, right-aligned in its cell: the right band of a one-child row, which truncates a notice wider than the cell. */
function noticeCell(facts: NotificationFacts): MayflyUiNode {
  return ui.stack.row([ui.child(ui.richText(spans(facts)), { priority: 0, band: 'right', overflow: 'truncate' })])
}

/** The hint, laid out as a notice is: right-aligned in its cell, muted, truncated at the end. */
function hintCell(hint: string): MayflyUiNode {
  return ui.stack.row([ui.child(ui.richText([{ text: hint, tone: 'muted' }]), { priority: 0, band: 'right', overflow: 'truncate' })])
}

/** The wait, laid out as a notice is: the loader cell (one clock, frozen under reduced motion), then the words. */
function waitCell(message: string): MayflyUiNode {
  return ui.stack.row([ui.child(ui.richText([{ text: '', motion: 'loader', variant: 'gap' }, { text: ` ${message}` }]), { priority: 0, band: 'right', overflow: 'truncate' })])
}

/** The right side of the row: the notice, else what the prompt awaits, else the hint, else nothing. */
function rightOf(facts: NotificationRowFacts | undefined): MayflyUiNode | undefined {
  if (facts?.notice !== undefined) return noticeCell(facts.notice)
  if (facts?.wait !== undefined) return waitCell(facts.wait)
  return facts?.hint === undefined ? undefined : hintCell(facts.hint)
}

/**
 * The notification line.
 * @param facts - the notice, the chip, and the hint shown while there is no notice, or `undefined` for the blank row.
 * @returns a one-row node. A notice alone sits at the right edge within the right half. With the chip, the chip is
 *   centered and the notice takes the right side of what it leaves, so the two never overlap.
 */
export function NotificationLine(facts: NotificationRowFacts | undefined): MayflyUiNode {
  if (facts?.chip !== undefined) {
    return ui.stack.row([
      ui.child(ui.spacer(), MARGIN),
      ui.child(ui.spacer(), SIDE_LEFT),
      ui.child(ui.richText([{ text: ` ${facts.chip} `, styles: ['inverse'] }]), CHIP),
      ui.child(rightOf(facts) ?? ui.spacer(), SIDE_RIGHT),
      ui.child(ui.spacer(), MARGIN),
    ])
  }
  if (facts?.keys !== undefined) {
    // The mode's keys take the left of the row; a notice keeps the right, each side at most about half the row.
    const keys = ui.richText([{ text: `  ${facts.keys}`, tone: 'muted' }], { overflow: 'truncate' })
    if (facts.notice === undefined) return ui.stack.row([ui.child(keys, { priority: 0, overflow: 'truncate' })])
    return ui.stack.row([ui.child(keys, SIDE_KEYS), ui.child(noticeCell(facts.notice), SIDE_NOTICE), ui.child(ui.spacer(), MARGIN)])
  }
  const right = rightOf(facts)
  if (right === undefined) return ui.spacer()
  return ui.stack.row([ui.child(ui.spacer(), FILLER), ui.child(right, CELL), ui.child(ui.spacer(), MARGIN)])
}
