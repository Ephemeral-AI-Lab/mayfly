/**
 * Pure component factories shared by multiple Mayfly ecosystem examples.
 *
 * @module @mayfly-example/user-kit
 */
import { defineMayflyComponent, patterns, ui } from '@ephemeral-ai/mayfly-ui'

/** Compact label/value row suitable for a pane header or inspector. */
export const summaryMetric = defineMayflyComponent<{
  readonly label: string
  readonly value: string
  readonly detail: string
}>({
  id: '@mayfly-example/summary-metric',
  // A pane re-renders on every data tick; equal props keep the node, so core reuses what it already admitted and compiled.
  memo: true,
  render: props => ui.surface({
    chrome: 'lane',
    padding: 1,
    child: ui.stack.row([
      ui.richText([
        { text: props.label, tone: 'muted' },
        { text: ` ${props.value}`, tone: 'accent', styles: ['strong'] },
      ]),
      ui.child(ui.text(props.detail, { tone: 'muted' }), { grow: 1, when: { minWidth: 32 } }),
    ], { gap: 1, align: 'center' }),
  }),
})

/** The `armMs` an overlay sets when it shows {@link approvalCard} unprompted, so a stray key grants nothing. */
export const APPROVAL_ARM_MS = patterns.decisionArmMs

/** A grant-first approval: the common grant is row 1 and focused, digits choose, `Esc` rejects. */
export const approvalCard = defineMayflyComponent<{
  readonly title: string
  readonly command: string
  readonly detail: string
}>({
  id: '@mayfly-example/approval-card',
  render: props => patterns.decisionPanel({
    id: 'approval',
    title: props.title,
    preview: [ui.text(props.command, { overflow: 'middle' }), ui.text(props.detail, { tone: 'muted' })],
    options: [
      { id: 'once', label: 'Allow once' },
      { id: 'session', label: 'Allow for this session' },
      { id: 'reject', label: 'Reject' },
    ],
  }),
})
