/**
 * The notification line: the one row between the activity block and the editor that carries the notice the user
 * should see now (a lane notification, a provider retry, a full context, a resumed session) and, when the stream is
 * scrolled away from its tail, the chip that returns to it, centered. The notice sits at the right and may use the whole
 * row between the stream's margins (less, beside the chip or the mode's keys); a notice that is too long is cut at its
 * front with `…` and keeps its tail, the count or countdown it ends with. The mode's keys take the left and are shed by
 * priority, the notice taking the rest. Without a notice the right shows what the prompt awaits (with the loader) or a muted
 * hint, after the keys that go between conversations. The row exists whether or not there is a notice (a
 * blank row then), so the editor never shifts. A pure function of facts: the text arrives translated and final, and
 * the glyph carries the severity beside the tone, never the color alone.
 *
 * @module components/notification-line
 */

import { ui, type MayflyTone, type MayflyUiChild, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** How serious a notice is; the same four levels as the notification lane. */
export type NotificationSeverity = 'success' | 'info' | 'warning' | 'error'

/** The facts of one notification line. */
export interface NotificationFacts {
  readonly severity: NotificationSeverity
  /** The message, one line, final. */
  readonly message: string
  /** The end of `message` that stays whole on a row too narrow for it, a count or a countdown (`retrying in 9s · 1/5`). */
  readonly tail?: string
  /** How many more notices wait behind this one (shown as a muted `+N` after the message). */
  readonly waiting?: number
}

/** The glyph and tone of a notice; information has none, its words are the whole notice. */
const GLYPHS: Readonly<Record<Exclude<NotificationSeverity, 'info'>, readonly [string, MayflyTone]>> = {
  success: ['✓', 'success'], warning: ['⚠', 'warning'], error: ['✗', 'danger'],
}

/** One key of the mode that holds focus: its words, and how long it survives a narrow row (the lower, the longer). */
export interface NotificationKeyPart {
  /** The key and its label, final (`Enter expand`). */
  readonly text: string
  /** Admission order: parts are admitted lowest first, so the highest numbers are shed first. */
  readonly priority: number
}

/** The columns kept free at the right edge, as the stream keeps two at the left. */
const MARGIN = { basis: 3, grow: 0, shrink: 0 } as const
const INDENT = { basis: 2, grow: 0, shrink: 0 } as const
/** The row of a lone notice or of mode keys: everything between the indent and the margin. */
const BODY = { basis: 0, grow: 1, shrink: 1 } as const
/** With the chip between them, the two sides share what it leaves; 5:8 comes out equal (within four columns) from 40 to 220. */
const SIDE_LEFT = { basis: 0, grow: 5, shrink: 1 } as const
const SIDE_RIGHT = { basis: 0, grow: 8, shrink: 1 } as const
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
  /** The keys of the mode that holds focus (the conversation's row cursor), muted at the stream's left margin, in the order they read; the row sheds them by `priority`. A notice takes what they leave. */
  readonly keys?: readonly NotificationKeyPart[]
  /** The keys that go back and forth between conversations (`F7 btw · F8 close`): they take the right of the row, before the notice, the wait, or the hint. */
  readonly toggle?: string
}

/** The admission gap of the row: one column between parts. */
const GAP = 1

/**
 * The children of a notice, in reading order: the glyph (information has none), the front of the message (cut with `…` when
 * the room is short, so it is admitted last, at `back`), the tail the message ends with (a count or a countdown, kept whole), and the
 * muted `+N` of the notices waiting; all but the front are admitted from `front` on.
 */
function noticeChildren(facts: NotificationFacts, front: number, back: number): readonly MayflyUiChild[] {
  const mark = facts.severity === 'info' ? undefined : GLYPHS[facts.severity]
  const tail = facts.tail !== undefined && facts.message.length > facts.tail.length && facts.message.endsWith(facts.tail) ? facts.tail : undefined
  const head = tail === undefined ? facts.message : facts.message.slice(0, facts.message.length - tail.length).replace(/\s*·\s*$/u, '')
  const waiting = facts.waiting === undefined || facts.waiting <= 0 ? undefined : facts.waiting
  const style = mark === undefined || facts.severity === 'success' ? {} : { tone: mark[1] }
  const right = { band: 'right' } as const
  return [
    ...mark === undefined ? [] : [ui.child(ui.richText([{ text: mark[0], tone: mark[1] }]), { ...right, priority: front })],
    ui.child(ui.richText([{ text: head, ...style }], { overflow: 'truncate' }), { ...right, priority: back, overflow: 'truncate' }),
    ...tail === undefined ? [] : [ui.child(ui.richText([{ text: `· ${tail}`, ...style }]), { ...right, priority: front + 1 })],
    ...waiting === undefined ? [] : [ui.child(ui.richText([{ text: `· +${String(waiting)}`, tone: 'muted' }]), { ...right, priority: front + 2 })],
  ]
}

/** The way between conversations, muted, with the gap that parts it from what follows (when something does). */
function toggleChild(toggle: string, followed: boolean): MayflyUiChild {
  return ui.child(ui.richText([{ text: followed ? `${toggle}  ` : toggle, tone: 'muted' }]), { band: 'right', priority: 0 })
}

/** What the prompt awaits, laid out as a notice is: the loader cell (one clock, frozen under reduced motion), then the words. */
function waitChild(message: string): MayflyUiChild {
  return ui.child(ui.richText([{ text: '', motion: 'loader', variant: 'gap' }, { text: ` ${message}` }], { overflow: 'truncate' }), { band: 'right', priority: 1, overflow: 'truncate' })
}

/** The hint, muted; it is cut at its end on a narrow row. */
function hintChild(hint: string): MayflyUiChild {
  return ui.child(ui.richText([{ text: hint, tone: 'muted' }], { overflow: 'truncate' }), { band: 'right', priority: 1, overflow: 'truncate' })
}

/**
 * The right side of the row as one admission row: the way between conversations first, then the notice, which gives up its
 * front before anything else; without a notice, what the prompt awaits, else the hint, follows the toggle; with none of
 * them the row is empty.
 */
function rightOf(facts: NotificationRowFacts | undefined): MayflyUiNode | undefined {
  const toggle = facts?.toggle
  if (facts?.notice !== undefined) return ui.stack.row([...toggle === undefined ? [] : [toggleChild(toggle, true)], ...noticeChildren(facts.notice, 1, 4)], { gap: GAP })
  const after = facts?.wait !== undefined ? waitChild(facts.wait) : facts?.hint !== undefined ? hintChild(facts.hint) : undefined
  if (toggle === undefined && after === undefined) return undefined
  return ui.stack.row([...toggle === undefined ? [] : [toggleChild(toggle, after !== undefined)], ...after === undefined ? [] : [after]], { gap: GAP })
}

/**
 * The mode's keys at the left of the row and the notice at the right, as one admission row: the keys in the order they read, each
 * admitted by its priority (the lowest numbers survive a narrow row), after the notice's glyph and tail, so a notice that is
 * wider than what the keys leave shows its front cut with `…` or gives it up, never the keys' `Esc`.
 */
function keysRow(keys: readonly NotificationKeyPart[], notice: NotificationFacts | undefined): MayflyUiNode {
  const order = keys.map((part, index) => ({ part, index })).toSorted((left, right) => left.part.priority - right.part.priority || left.index - right.index).map(entry => entry.index)
  return ui.stack.row([
    ...keys.map((part, index) => ui.child(
      ui.richText([{ text: index === 0 ? part.text : `· ${part.text}`, tone: 'muted' }]),
      { band: 'left', priority: order.indexOf(index) * 10, overflow: 'hide' },
    )),
    // The notice's glyph, tail, and count come after the three keys that matter most; its front gives way to every key.
    ...notice === undefined ? [] : noticeChildren(notice, 25, 1000),
  ], { gap: GAP })
}

/**
 * The notification line.
 * @param facts - the notice, the chip, the mode's keys, and the hint shown while there is no notice, or `undefined` for the blank row.
 * @returns a one-row node. A notice alone sits at the right edge and may use the whole row between the stream's margins; one that
 *   does not fit is cut with `…` and keeps its tail. With the chip, the chip is centered and the notice takes the right side of what
 *   it leaves, so the two never overlap. The mode's keys take the left of the row, shed by priority, and the notice the rest.
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
  const body = facts?.keys === undefined ? rightOf(facts) : keysRow(facts.keys, facts.notice)
  if (body === undefined) return ui.spacer()
  return ui.stack.row([ui.child(ui.spacer(), INDENT), ui.child(body, BODY), ui.child(ui.spacer(), MARGIN)])
}
