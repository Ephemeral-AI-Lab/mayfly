/**
 * Current Mayfly present-tense activity row for Remote projection facts.
 * @module @ephemeral-ai/mayfly/remote/panels/activity-row
 */

import { ui, type MayflyInlineSpan, type MayflyTone, type MayflyUiChild, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Activity phases supported by the official Conversation projection. */
export type RemoteActivityPhase = 'diving' | 'thinking' | 'writing' | 'tool' | 'waiting' | 'stopping'

/** Fully translated facts for one activity row. */
export interface RemoteActivityRowFacts {
  readonly phase: RemoteActivityPhase
  readonly label: string
  readonly labelTone?: MayflyTone
  readonly labelStrong?: boolean
  readonly tail?: readonly string[]
  readonly info?: string
  readonly tip?: string
}

const INDENT = '  '
const DETAIL_CONNECTOR_MIN_WIDTH = 40

function head(facts: RemoteActivityRowFacts): readonly MayflyInlineSpan[] {
  switch (facts.phase) {
    case 'diving': return [{ text: INDENT }, { text: '', motion: 'loader', variant: 'fill' }, { text: ` ${facts.label}` }]
    case 'writing': return [{ text: INDENT }, { text: '', motion: 'loader', variant: 'fill' }, { text: ` ${facts.label}` }]
    case 'thinking': return [{ text: INDENT }, { text: '', motion: 'loader', variant: 'bloom' }, { text: ` ${facts.label}`, ...facts.labelTone === undefined ? {} : { tone: facts.labelTone }, ...facts.labelStrong === true ? { styles: ['strong'] as const } : {} }]
    case 'waiting': return [{ text: INDENT }, { text: '', motion: 'loader', variant: 'breath' }, { text: ` ${facts.label}` }]
    case 'tool': return [{ text: INDENT }, { text: '●', tone: 'primary' }, { text: ' ' }, { text: facts.label, motion: 'shimmer' }]
    case 'stopping': return [{ text: INDENT }, { text: '■', tone: 'danger', styles: ['strong'] }, { text: ` ${facts.label}`, tone: 'muted' }]
  }
}

function secondLine(facts: RemoteActivityRowFacts): MayflyUiChild {
  const info = facts.info !== undefined && facts.info !== ''
  const text = info ? facts.info : facts.tip
  if (text === undefined || text === '') return ui.child(ui.spacer())
  const row = (lead: string): MayflyUiNode => ui.richText([{ text: lead, tone: 'muted' }, info ? { text } : { text, tone: 'muted' }], { overflow: 'truncate' })
  return ui.child(ui.stack.column([
    ui.child(row(`${INDENT}  ⎿ `), { when: { minWidth: DETAIL_CONNECTOR_MIN_WIDTH } }),
    ui.child(row(`${INDENT}  `), { when: { maxWidth: DETAIL_CONNECTOR_MIN_WIDTH - 1 } }),
  ]))
}

/** Build the fixed three-row Mayfly activity presentation. */
export function RemoteActivityRow(facts: RemoteActivityRowFacts): MayflyUiNode {
  const tail = facts.tail ?? []
  const header = ui.stack.row([
    ui.child(ui.richText(head(facts), { overflow: 'truncate' }), { priority: 0, overflow: 'truncate' }),
    ...tail.length === 0 ? [] : [ui.child(ui.richText([{ text: `· ${tail.join(' · ')}`, tone: 'muted' }]), { priority: 1, overflow: 'hide' })],
  ], { gap: 1 })
  return ui.stack.column([ui.child(ui.spacer()), ui.child(header), secondLine(facts)])
}
