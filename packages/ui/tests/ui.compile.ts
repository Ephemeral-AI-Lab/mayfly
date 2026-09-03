import {
  defineMayflyComponent,
  ui,
  type MayflyEditorExtensionNode,
  type MayflyStatusNode,
  type MayflyUiChild,
  type MayflyUiNode,
} from '@ephemeral-ai/mayfly-ui'

interface MetricProps { readonly label: string, readonly value: number }

export const metric = defineMayflyComponent<MetricProps>({
  id: '@acme/metric',
  render: props => ui.stack.column([
    ui.progress({ label: 'Direct node', value: props.value, max: 100 }),
    ui.child(ui.progress({ label: props.label, value: props.value, max: 100 }), {
      grow: 1,
      basis: 'auto',
      when: { minWidth: 40 },
    }),
  ], { gap: 1 }),
})

export const node: MayflyUiNode = metric.render({ label: 'Context', value: 42 })
export const child: MayflyUiChild = ui.child(node, { shrink: 1 })
export const document = ui.diagram('graph TD\nA --> B')
export const chart = ui.chart({ chart: 'line', series: [{ id: 'load', points: [{ x: 0, y: 1 }] }] })

// @ts-expect-error rich documents are not status nodes
export const statusDocument: MayflyStatusNode = document
// @ts-expect-error charts are not editor-extension nodes
export const editorChart: MayflyEditorExtensionNode = chart
// @ts-expect-error bar charts require category-aligned values
ui.chart({ chart: 'bar', series: [{ id: 'load', values: [1] }] })

// @ts-expect-error flex properties belong to ui.child, not scroll options
ui.scroll(node, { grow: 1 })
// @ts-expect-error flex properties cannot be attached directly to a node
ui.stack.row([{ kind: 'text', content: 'bad', grow: 1 }])
// @ts-expect-error component props are preserved by the factory
metric.render({ label: 'Context' })
// @ts-expect-error user kits cannot introduce a new node kind through the type contract
defineMayflyComponent({ id: '@acme/invalid', render: () => ({ kind: 'custom' }) })
