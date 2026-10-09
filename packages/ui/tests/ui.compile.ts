import {
  defineMayflyComponent,
  patterns,
  ui,
  type MayflyDecisionPanelProps,
  type MayflyEditorExtensionNode,
  type MayflyOverlayDefinition,
  type MayflyRailPanelProps,
  type MayflySplitViewProps,
  type MayflyStatusPageProps,
  type MayflySurfaceNode,
  type MayflyUiActionHandler,
  type MayflyUiEventHandlers,
  type MayflyStatusNode,
  type MayflyUiChild,
  type MayflyUiNode,
  type MayflyUiObservationHandler,
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
export const horizontalBar = ui.chart({ chart: 'bar', layout: 'normalized', orientation: 'horizontal', categories: ['ctx'], series: [{ id: 'load', values: [1] }, { id: 'free', values: [9], empty: true }] })
export const photo = ui.image({ attachmentId: 'att-1', alt: '[Image #1 84 KB]', maxRows: 12 })
export const photoNode: MayflyUiNode = photo
export const composer = ui.prompt({
  id: 'composer',
  symbol: '! ',
  symbolTone: 'accent',
  value: 'draft',
  tokens: [{ id: 't1', label: 'Image #1', size: '84 KB' }, { id: 't2', label: 'notes.md' }],
  recall: [{ kind: 'queued', text: 'also update the footer' }, { kind: 'history', text: 'run the width scan again' }],
  recallLabel: 'history',
  placeholder: ['Ask anything · / commands', 'Ask anything'],
  completions: { items: [{ id: 'c1', label: '/model', detail: 'switch model', right: 'Ctrl+M' }, { id: 'c2', label: '/trace' }] },
  reset: { rev: 1, value: '' },
  submitLabel: 'send',
  autofocus: true,
})
export const composerNode: MayflyUiNode = composer
export const bareComposer = ui.prompt({ id: 'bare', placeholder: 'Ask anything' })
export const handlers: MayflyUiEventHandlers = {
  observe: event => event.kind === 'value-change' || event.kind === 'recall-change' ? { kind: 'completed' } : undefined,
  action: event => event.kind === 'submit' ? { kind: 'cancelled' } : { kind: 'completed' },
}
export const promptHandlers: MayflyUiEventHandlers = {
  observe: event => event.kind === 'recall-change' && event.source === 'draft' ? { kind: 'completed' } : undefined,
  action: event => event.kind === 'token-remove' ? { kind: 'completed', feedback: { message: event.tokenId, severity: 'info' } }
    : event.kind === 'completion-accept' ? { kind: 'completed', feedback: { message: event.itemId, severity: 'info' } }
      : event.kind === 'completion-dismiss' ? { kind: 'completed' } : { kind: 'cancelled' },
}

// @ts-expect-error actions must settle with a structured reply
export const missingActionReply: MayflyUiActionHandler = () => {}
// @ts-expect-error action handlers cannot receive observation events
export const actionHandlesValueChange: MayflyUiActionHandler = event => event.kind === 'value-change' ? { kind: 'completed' } : { kind: 'cancelled' }

export const rail = ui.tabs({
  id: 'rail', orientation: 'vertical', hintLabel: 'labels', activeId: 'a',
  items: [{ id: 'a', label: 'A', count: '2/6', group: 'Session', clip: 'start' }, { id: 'b', label: 'B', count: 3, attention: true, group: 'Session' }],
})
// @ts-expect-error a rail is horizontal or vertical
ui.tabs({ id: 'diagonal', activeId: 'a', orientation: 'diagonal', items: [{ id: 'a', label: 'A' }] })
// @ts-expect-error a tab label clips at its end or its start
ui.tabs({ id: 'clip', activeId: 'a', items: [{ id: 'a', label: 'A', clip: 'middle' }] })
export const focusObserver: MayflyUiObservationHandler = event => event.kind === 'focus-change' ? { kind: 'completed' } : undefined
// @ts-expect-error action handlers cannot receive focus reports
export const actionHandlesFocusChange: MayflyUiActionHandler = event => event.kind === 'focus-change' ? { kind: 'completed' } : { kind: 'cancelled' }

// @ts-expect-error rich documents are not status nodes
export const statusDocument: MayflyStatusNode = document
// @ts-expect-error charts are not editor-extension nodes
export const editorChart: MayflyEditorExtensionNode = chart
// @ts-expect-error images are not status nodes
export const statusImage: MayflyStatusNode = photo
// @ts-expect-error images are not editor-extension nodes
export const editorImage: MayflyEditorExtensionNode = photo
// @ts-expect-error prompts are not status nodes
export const statusPrompt: MayflyStatusNode = composer
// @ts-expect-error prompts are not editor-extension nodes
export const editorPrompt: MayflyEditorExtensionNode = composer
// @ts-expect-error a prompt names its control
ui.prompt({ placeholder: 'missing id' })
// @ts-expect-error a recalled message is queued or history
ui.prompt({ id: 'p', recall: [{ kind: 'pinned', text: 'x' }] })
// @ts-expect-error a token carries a label
ui.prompt({ id: 'p', tokens: [{ id: 't' }] })
// @ts-expect-error the wire carries no callbacks
ui.prompt({ id: 'p', onSubmit: () => {} })
// @ts-expect-error observations cannot publish, so the draft returning is not an action
export const recallIsAction: MayflyUiActionHandler = event => event.kind === 'recall-change' ? { kind: 'completed' } : { kind: 'cancelled' }
// @ts-expect-error an image names its attachment and carries its fallback text
ui.image({ alt: 'missing id' })
// @ts-expect-error an image carries its fallback text
ui.image({ attachmentId: 'att-1' })
// @ts-expect-error the wire carries a reference, never bytes
ui.image({ attachmentId: 'att-1', alt: 'x', data: new Uint8Array() })
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
export const namedActions = ui.actions({ id: 'row-keys', scope: ['sessions', 'workspaces'], items: [
  { id: 'remove', label: 'Remove', semantic: 'delete', hidden: true, confirm: 'Remove the session?' },
  { id: 'install', label: 'Install', action: 'demo-plugin.install', key: 'i', hintLabel: 'install' },
] })
export const scopedToOne = ui.actions({ id: 'stream-keys', scope: 'stream', items: [{ id: 'copy', label: 'Copy', semantic: 'copy', hidden: true }] })
// @ts-expect-error common meanings are a closed set
ui.actions({ id: 'bad', items: [{ id: 'x', label: 'X', semantic: 'undo' }] })

// Content, layout, and motion (slice 1.3): every field is optional and additive.
export const motionRow = ui.richText([
  { text: '', motion: 'loader', variant: 'breath' },
  { text: 'Waiting for authorization', tone: 'muted' },
])
export const shimmerRow = ui.richText([{ text: 'Running commands', motion: 'shimmer' }])
// @ts-expect-error a loader span names one of the four variants
ui.richText([{ text: '', motion: 'loader', variant: 'braille' }])
// @ts-expect-error motion is shimmer or loader
ui.richText([{ text: 'x', motion: 'pulse' }])
// @ts-expect-error rich text never elides the middle
ui.richText([{ text: 'x' }], { overflow: 'middle' })
export const elided = ui.text('~/work/mayfly/packages/mayfly', { overflow: 'middle', styles: ['strong'] })
export const pathTail = ui.text('~/work/mayfly/packages/mayfly', { overflow: 'start', tone: 'muted' })
export const numberedCode = ui.code('const a = 1', { language: 'ts', numbered: true })
export const options = ui.diff('a', 'b', { start: 41, numbered: true, hunkHeader: true, context: 3, maxRows: 12 })
export const plainDiff = ui.diff('a', 'b')
export const yearHeatmap = ui.chart({ chart: 'heatmap', cell: 1, columns: ['w1'], columnLabels: ['Jan'], rows: ['Mon'], values: [[1]], levels: [{ value: 1, label: 'some' }] })
export const bareLoader = ui.loader({ variant: 'bloom' })
export const oldLoader = ui.loader({ message: 'Working', variant: 'braille' })
// @ts-expect-error a loader variant is one of the four, or an old braille or tide
ui.loader({ variant: 'spin' })
export const meter = ui.progress({ label: 'Building', value: 6, max: 10, style: 'cells', width: 10, tone: 'success', showCount: true, showPercent: true, transition: { from: 91, ms: 800, rev: 1 } })
export const headRule = ui.progress({ style: 'rule', value: 2, max: 8, width: 40 })
// @ts-expect-error a progress style is cells or rule
ui.progress({ style: 'ring', value: 1, max: 2 })
export const admittingRow = ui.stack.row([
  ui.child(ui.richText([{ text: 'deepseek-chat' }]), { priority: 0 }),
  ui.child(ui.richText([{ text: 'cache 34%' }]), { priority: 4, band: 'right', overflow: 'hide' }),
  ui.child(ui.richText([{ text: '~/work' }]), { priority: 5, band: 'center', overflow: 'truncate' }),
], { gap: 2 })
// @ts-expect-error admission fields belong to ui.child, not to the node
ui.stack.row([{ kind: 'text', content: 'bad', priority: 1 }])
export const chrome = ui.surface({ title: '~/work/mayfly', titleAlign: 'right', border: 'warning', escapeLabel: 'reject', hint: 'completions', child: ui.text('x') })
// @ts-expect-error the title aligns left or right
ui.surface({ titleAlign: 'center', child: ui.text('x') })
export const region = ui.scroll(ui.text('log'), { id: 'log', height: 6, expandedHeight: 14, fit: true, pill: true, follow: 'end' })

export const richRows = ui.list({ id: 'stream', role: 'browse', filterable: true, filterMode: 'slash', marker: 'selection', marks: false, maxRows: 12, expandFocused: true, acceptVerb: 'expand', autofocus: true, focusItem: { id: 'a', rev: 1 }, hintLabel: 'stream', selectedIds: [], items: [
  { id: 'a', label: 'A', labelSpans: [{ text: 'A', styles: ['strong'] }], right: [{ text: '1.0', tone: 'muted' }], rightFocus: [{ text: 'Enter' }], body: ui.listBody([ui.text('one'), ui.image({ attachmentId: 'att', alt: '[Image]' })]), expanded: true, wrap: true, wrapMax: 3, meter: { value: 1, max: 2, width: 8, tone: 'success' }, indent: 2,
    segment: { options: [{ id: 'x', label: 'x' }], inheritedId: 'x' } },
  { id: 'b', label: 'B', body: 'text', bodyAlways: true },
  { id: 'c', label: '', rule: 'Earlier' },
  { id: 'd', label: '', gap: true },
] })
// @ts-expect-error a body is content: a list inside a row would take focus
ui.listBody([ui.list({ id: 'inner', role: 'browse', selectedIds: [], items: [] })])
// @ts-expect-error filterMode is type or slash
ui.list({ id: 'bad', role: 'browse', filterMode: 'fuzzy', selectedIds: [], items: [] })
// @ts-expect-error acceptVerb is a closed set
ui.list({ id: 'bad', role: 'browse', acceptVerb: 'delete', selectedIds: [], items: [] })

export const armedRequest: MayflyOverlayDefinition = { id: 'request', presentation: 'editor', capturing: true, armMs: 300 }
// @ts-expect-error the arm delay is a number of milliseconds
export const badArm: MayflyOverlayDefinition = { id: 'request', armMs: '300' }

// Forms (slice 1.6): help and group on every field, and the text-entry rules on the three text kinds.
export const groupedForm = ui.form({ id: 'provider', enterSubmits: 'save', fields: [
  { kind: 'input', id: 'url', label: 'Endpoint', value: '', group: 'Connection', help: 'Base URL', pattern: '^https?://\\S+$', patternMessage: 'Must be an http(s) URL', suggestions: ['https://api.example.com'] },
  { kind: 'textarea', id: 'notes', label: 'Notes', value: '', pattern: '^[^\\n]*$', suggestions: [] },
  { kind: 'secret', id: 'key', label: 'Key', value: '', pattern: '^sk-' },
  { kind: 'number', id: 'timeout', label: 'Timeout', value: 30, help: 'Seconds', group: 'Behaviour' },
  { kind: 'select', id: 'mode', label: 'Mode', value: null, options: [], help: 'Pick one' },
  { kind: 'multiselect', id: 'tags', label: 'Tags', value: [], options: [], group: 'Behaviour' },
  { kind: 'toggle', id: 'on', label: 'On', value: true, help: 'Streaming' },
] })
// @ts-expect-error a pattern belongs to the text fields
ui.form({ id: 'bad', fields: [{ kind: 'number', id: 'n', label: 'N', value: 1, pattern: '^1$' }] })
// @ts-expect-error suggestions belong to the text fields
ui.form({ id: 'bad', fields: [{ kind: 'toggle', id: 't', label: 'T', value: true, suggestions: ['on'] }] })
// @ts-expect-error help is a line of text
ui.form({ id: 'bad', fields: [{ kind: 'input', id: 'i', label: 'I', value: '', help: 3 }] })

// Patterns (slice 1.8b): pure calls that return ordinary nodes; the props are the real builders' shapes.
export const decision: MayflySurfaceNode = patterns.decisionPanel({
  title: 'Delete branch?', badges: [{ text: '1 of 2 waiting', tone: 'muted' }], preview: [ui.text('feature/old-hero')],
  options: [{ id: 'keep', label: 'Keep' }, { id: 'delete', label: 'Delete', detail: 'cannot be undone' }],
  input: { id: 'why', label: 'Note', placeholder: 'optional' }, instant: false,
  accelerators: [{ id: 'copy', label: 'Copy name', key: 'c', hintLabel: 'copy name' }], escapeLabel: 'reject', chrome: 'overlay',
})
export const decisionOverlay: MayflyOverlayDefinition = { id: 'decision', presentation: 'editor', capturing: true, armMs: patterns.decisionArmMs }
export const railed: MayflyUiNode = patterns.railPanel({
  title: 'Workspaces', rail: { id: 'rail', activeId: 'a', items: [{ id: 'a', label: 'A', count: 2 }] },
  content: { a: ui.text('a') }, railWidth: 24,
})
export const railedLive: MayflyUiNode = patterns.railPanel({ title: 'Sessions', rail: { id: 'rail', activeId: 'a', items: [{ id: 'a', label: 'A' }], hintLabel: 'labels' }, content: ui.text('live') })
export const split: MayflyUiNode = patterns.splitView({ list: ui.text('list'), detail: ui.text('detail'), listWidth: 50, breakpoint: 100 })
export const status: MayflyUiNode = patterns.statusPage({
  title: 'Status', tabs: { id: 'st', activeId: 'overview', items: [{ id: 'overview', label: 'Overview' }] },
  rows: [{ label: 'Provider', value: [{ text: 'DeepSeek' }] }], footer: ui.text('r refresh'),
})
export const statusPaged: MayflyUiNode = patterns.statusPage({ title: 'Status', tabs: { id: 'st', activeId: 'a', items: [{ id: 'a', label: 'A' }] }, pages: { a: ui.text('a') } })
export const decisionProps: MayflyDecisionPanelProps = { title: 'Ask', options: [] }
export const railProps: MayflyRailPanelProps = { title: 'Rail', rail: { id: 'r', activeId: 'a', items: [] }, content: {} }
export const splitProps: MayflySplitViewProps = { list: ui.text('l'), detail: ui.text('d') }
export const statusProps: MayflyStatusPageProps = { title: 'S', tabs: { id: 's', activeId: 'a', items: [] }, body: ui.text('b') }
// @ts-expect-error a decision panel needs its options
patterns.decisionPanel({ title: 'Ask' })
// @ts-expect-error accelerators are always hidden, so the pattern sets that itself
patterns.decisionPanel({ title: 'Ask', options: [], accelerators: [{ id: 'x', label: 'X', hidden: false }] })
// @ts-expect-error a decision panel's Esc word is one of the surface's
patterns.decisionPanel({ title: 'Ask', options: [], escapeLabel: 'dismiss' })
// @ts-expect-error a rail panel takes a rail and its content
patterns.railPanel({ title: 'Rail' })
// @ts-expect-error a split view takes a list and a detail node
patterns.splitView({ list: ui.text('l') })
// @ts-expect-error a status page takes tabs
patterns.statusPage({ title: 'S', rows: [] })
// @ts-expect-error the patterns are a frozen namespace
patterns.decisionArmMs = 0
