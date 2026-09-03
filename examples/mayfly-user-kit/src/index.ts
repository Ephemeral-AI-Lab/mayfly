/**
 * Pure component factories shared by multiple Mayfly ecosystem examples.
 *
 * @module @mayfly-example/user-kit
 */
import { defineMayflyComponent, ui } from '@ephemeral-ai/mayfly-ui'

/** Compact label/value row suitable for a pane header or inspector. */
export const summaryMetric = defineMayflyComponent<{
  readonly label: string
  readonly value: string
  readonly detail: string
}>({
  id: '@mayfly-example/summary-metric',
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
