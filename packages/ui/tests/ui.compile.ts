import {
  defineMayflyComponent,
  ui,
  type MayflyEditorExtensionNode,
  type MayflyUiActionHandler,
  type MayflyUiEventHandlers,
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
export const handlers: MayflyUiEventHandlers = {
  observe: event => event.kind === 'value-change' ? { kind: 'completed' } : undefined,
  action: event => event.kind === 'submit' ? { kind: 'cancelled' } : { kind: 'completed' },
}

// @ts-expect-error actions must settle with a structured reply
export const missingActionReply: MayflyUiActionHandler = () => {}
// @ts-expect-error action handlers cannot receive observation events
export const actionHandlesValueChange: MayflyUiActionHandler = event => event.kind === 'value-change' ? { kind: 'completed' } : { kind: 'cancelled' }

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

export const confirmedActions = ui.actions({ id: 'profile-actions', items: [
  { id: 'delete', label: 'Delete', key: 'ctrl+d', confirm: { title: 'Delete profile?', detail: 'This cannot be undone.', confirmLabel: 'Delete', cancelLabel: 'Keep', tone: 'danger' } },
  { id: 'archive', label: 'Archive', confirm: 'Archive profile?' },
] })
export const availabilityList = ui.list({ id: 'profiles', role: 'choose', numbered: 'focus', selectedIds: [], items: [
  { id: 'default', label: 'Default', unavailableActions: { delete: 'The default profile cannot be deleted' }, confirm: { title: 'Switch profile?' } },
] })
export const labelledForm = ui.form({ id: 'profile', fields: [], submitActionId: 'save', submitLabel: 'Save profile', cancelActionId: 'cancel', cancelLabel: 'Discard' })
export const stoppableLoader = ui.loader({ message: 'Working', cancelActionId: 'stop', cancelLabel: 'Stop now' })
// @ts-expect-error confirmation tone is limited to danger
ui.actions({ id: 'bad', items: [{ id: 'x', label: 'X', confirm: { title: 'X?', tone: 'warning' } }] })
// @ts-expect-error numbered accepts a boolean or 'focus'
ui.list({ id: 'bad', role: 'choose', numbered: 'accept', selectedIds: [], items: [] })
// @ts-expect-error a confirmation needs a title
ui.actions({ id: 'bad', items: [{ id: 'x', label: 'X', confirm: { detail: 'Why?' } }] })
