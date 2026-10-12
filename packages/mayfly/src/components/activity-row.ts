/**
 * The activity row: the one present-tense block above the editor, always three rows high so the editor never shifts
 * between phases: a header (the phase's glyph and label and a muted tail of counts), one line under it, and a blank row
 * before the editor. The line under the header, after a `⎿`, is the single action running now; with no action it is the
 * teaching tip, and with neither it is blank. The glyph or the label moves, never both: a model phase animates its
 * glyph over a still label, a running tool keeps a still `●` while its label shimmers, a wait breathes its `●`, and a
 * stop is static. A pure function of facts: the texts arrive translated and final, the clock and the motion belong to
 * core, and the row sheds by priority as it narrows (the tail first), then the `⎿` connector.
 *
 * @module components/activity-row
 */

import { ui, type MayflyInlineSpan, type MayflyTone, type MayflyUiChild, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** What the model or the user is doing now. */
export type ActivityPhase = 'diving' | 'thinking' | 'writing' | 'tool' | 'waiting' | 'stopping'

/** The facts of one activity row. Every text is final: translated, sanitized, and without escape sequences. */
export interface ActivityFacts {
  readonly phase: ActivityPhase
  /** The present-tense label (`Deep diving`, `Thinking`, `Running commands`, `Waiting for your approval`). */
  readonly label: string
  /** The label's tone and weight, for a label that deepens with time (thinking). */
  readonly labelTone?: MayflyTone
  readonly labelStrong?: boolean
  /** The action running now, one line. */
  readonly detail?: string
  /** The muted counts after the label (`8s`, `↑30.2k ↓1.1k`, `38 tok/s`), joined by ` · `. */
  readonly tail?: readonly string[]
  /** The line under the header when no action runs: a teaching tip. */
  readonly tip?: string
}

/** The row width from which the detail line leads with the `⎿` connector. */
export const DETAIL_CONNECTOR_MIN_WIDTH = 40

/** The stream's left margin: the block lines up with the message blocks above it. */
const INDENT = '  '

/** The glyph and label of a phase; the label's motion is a shimmer for a running tool only. */
function head(facts: ActivityFacts): readonly MayflyInlineSpan[] {
  const { phase, label } = facts
  switch (phase) {
    case 'diving': return [{ text: INDENT }, { text: '', motion: 'loader', variant: 'fill' }, { text: ` ${label}` }]
    case 'writing': return [{ text: INDENT }, { text: '', motion: 'loader', variant: 'fill' }, { text: ` ${label}` }]
    case 'thinking': return [{ text: INDENT }, { text: '', motion: 'loader', variant: 'bloom' }, { text: ` ${label}`, ...facts.labelTone === undefined ? {} : { tone: facts.labelTone }, ...facts.labelStrong === true ? { styles: ['strong'] as const } : {} }]
    case 'waiting': return [{ text: INDENT }, { text: '', motion: 'loader', variant: 'breath' }, { text: ` ${label}` }]
    case 'tool': return [{ text: INDENT }, { text: '●', tone: 'primary' }, { text: ' ' }, { text: label, motion: 'shimmer' }]
    case 'stopping': return [{ text: INDENT }, { text: '■', tone: 'danger', styles: ['strong'] }, { text: ` ${label}`, tone: 'muted' }]
  }
}

/** The line under the header, after its `⎿`: the action, else the tip (muted), else blank. */
function secondLine(facts: ActivityFacts): MayflyUiChild {
  const detail = facts.detail !== undefined && facts.detail !== ''
  const text = detail ? facts.detail! : facts.tip
  if (text === undefined || text === '') return ui.child(ui.spacer())
  const row = (lead: string): MayflyUiNode => ui.richText([{ text: lead, tone: 'muted' }, detail ? { text } : { text, tone: 'muted' }], { overflow: 'truncate' })
  return ui.child(ui.stack.column([
    ui.child(row(`${INDENT}  ⎿ `), { when: { minWidth: DETAIL_CONNECTOR_MIN_WIDTH } }),
    ui.child(row(`${INDENT}  `), { when: { maxWidth: DETAIL_CONNECTOR_MIN_WIDTH - 1 } }),
  ]))
}

/**
 * The activity row of one phase.
 * @param facts - the phase, its texts, and the action running now.
 * @returns the header, the line under it, and the blank row before the editor.
 */
export function ActivityRow(facts: ActivityFacts): MayflyUiNode {
  const tail = facts.tail ?? []
  const header = ui.stack.row([
    ui.child(ui.richText(head(facts), { overflow: 'truncate' }), { priority: 0, overflow: 'truncate' }),
    ...tail.length === 0 ? [] : [ui.child(ui.richText([{ text: `· ${tail.join(' · ')}`, tone: 'muted' }]), { priority: 1, overflow: 'hide' })],
  ], { gap: 1 })
  return ui.stack.column([ui.child(header), secondLine(facts), ui.child(ui.spacer())])
}
