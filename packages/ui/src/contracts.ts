/** Renderer-independent contracts shared by official and third-party Cordis plugins.
 * @module @ephemeral-ai/mayfly-ui/contracts
 */

import type {} from '@deepseek-ai/cordis'

export type MayflyJson = null | boolean | number | string | readonly MayflyJson[] | { readonly [key: string]: MayflyJson }

export interface MayflyRegistration {
  readonly disposed: boolean
  dispose(): void
}

export interface MayflyRefreshRegistration extends MayflyRegistration {
  refresh(): void
}

export type MayflyTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'danger'
export interface MayflyInlineSpan { readonly text: string, readonly tone?: MayflyTone, readonly emphasis?: 'normal' | 'strong' }
export interface MayflyField { readonly label: string, readonly value: readonly MayflyInlineSpan[] }
export interface MayflySection { readonly title?: string, readonly body: MayflyView, readonly collapsed?: boolean }

export type MayflyView =
  | { readonly kind: 'text', readonly content: string, readonly tone?: MayflyTone }
  | { readonly kind: 'fields', readonly rows: readonly MayflyField[] }
  | { readonly kind: 'code', readonly code: string, readonly language?: string }
  | { readonly kind: 'diff', readonly before: string, readonly after: string }
  | { readonly kind: 'sections', readonly sections: readonly MayflySection[] }

export interface MayflyRichTextNode { readonly kind: 'rich-text', readonly spans: readonly MayflyInlineSpan[] }
export interface MayflyViewportCondition { readonly minWidth?: number, readonly maxWidth?: number, readonly minHeight?: number, readonly maxHeight?: number }
export interface MayflyUiChild {
  readonly node: MayflyUiNode
  readonly basis?: number | 'auto'
  readonly grow?: number
  readonly shrink?: number
  readonly minSize?: number
  readonly maxSize?: number
  readonly when?: MayflyViewportCondition
}
export interface MayflyStackNode { readonly kind: 'stack', readonly direction: 'row' | 'column', readonly gap?: 0 | 1 | 2, readonly align?: 'stretch' | 'start' | 'center' | 'end', readonly children: readonly MayflyUiChild[] }
export interface MayflySurfaceNode { readonly kind: 'surface', readonly title?: string, readonly subtitle?: string, readonly badges?: readonly MayflyInlineSpan[], readonly chrome?: 'none' | 'lane' | 'surface' | 'overlay', readonly padding?: 0 | 1 | 2, readonly child: MayflyUiNode, readonly footer?: MayflyUiNode }
export interface MayflyScrollNode { readonly kind: 'scroll', readonly child: MayflyUiNode, readonly follow?: 'none' | 'start' | 'end', readonly scrollbar?: boolean }
export interface MayflyTabItem { readonly id: string, readonly label: string, readonly disabled?: boolean, readonly count?: number }
export interface MayflyTabsNode { readonly kind: 'tabs', readonly id: string, readonly activeId: string, readonly items: readonly MayflyTabItem[] }
export interface MayflyListItem { readonly id: string, readonly label: string, readonly detail?: string, readonly detailSpans?: readonly MayflyInlineSpan[], readonly badge?: string, readonly group?: string, readonly disabled?: boolean }
export interface MayflyListNode { readonly kind: 'list', readonly id: string, readonly mode?: 'single' | 'multiple', readonly selectedIds: readonly string[], readonly items: readonly MayflyListItem[], readonly filter?: string, readonly empty?: MayflyUiNode }
export type MayflyFormField =
  | { readonly kind: 'input' | 'textarea' | 'secret', readonly id: string, readonly label: string, readonly value: string, readonly placeholder?: string, readonly error?: string, readonly disabled?: boolean }
  | { readonly kind: 'select', readonly id: string, readonly label: string, readonly value: string | null, readonly options: readonly MayflyListItem[], readonly error?: string, readonly disabled?: boolean }
  | { readonly kind: 'toggle', readonly id: string, readonly label: string, readonly value: boolean, readonly error?: string, readonly disabled?: boolean }
export interface MayflyFormNode { readonly kind: 'form', readonly id: string, readonly fields: readonly MayflyFormField[], readonly submitActionId?: string, readonly cancelActionId?: string }
export interface MayflyActionItem { readonly id: string, readonly label: string, readonly intent?: 'primary' | 'secondary' | 'danger', readonly disabled?: boolean, readonly busy?: boolean, readonly confirm?: string }
export interface MayflyActionsNode { readonly kind: 'actions', readonly id: string, readonly items: readonly MayflyActionItem[] }
export interface MayflyLoaderNode { readonly kind: 'loader', readonly message: string, readonly variant?: 'braille' | 'tide', readonly elapsedMs?: number, readonly cancelActionId?: string }
export interface MayflyEmptyNode { readonly kind: 'empty', readonly title: string, readonly description?: string, readonly actions?: MayflyActionsNode }
export interface MayflyProgressNode { readonly kind: 'progress', readonly label?: string, readonly value: number, readonly max: number }
export interface MayflySpacerNode { readonly kind: 'spacer', readonly size?: 1 | 2 }
export interface MayflyDividerNode { readonly kind: 'divider', readonly label?: string }

/** Renderer-neutral rich document rendered by the active terminal adapter. */
export interface MayflyDocumentNode {
  readonly kind: 'document'
  readonly format: 'markdown' | 'mermaid'
  readonly source: string
}

/** One numeric coordinate in a line or point chart. */
export interface MayflyChartPoint { readonly x: number, readonly y: number | null }
/** One numeric series in a line or point chart. */
export interface MayflyChartSeries {
  readonly id: string
  readonly label?: string
  readonly tone?: MayflyTone
  readonly points: readonly MayflyChartPoint[]
}
/** One category-aligned series in a bar chart. */
export interface MayflyBarChartSeries {
  readonly id: string
  readonly label?: string
  readonly tone?: MayflyTone
  readonly values: readonly (number | null)[]
}
/** One exact value-to-presentation mapping in a categorical heatmap. */
export interface MayflyChartLevel {
  readonly value: number | string
  readonly label: string
  readonly tone?: MayflyTone
}
export interface MayflyLineChartNode {
  readonly kind: 'chart'
  readonly chart: 'line' | 'point'
  readonly series: readonly MayflyChartSeries[]
  readonly title?: string
  readonly xLabel?: string
  readonly yLabel?: string
  readonly height?: number
}
export interface MayflyBarChartNode {
  readonly kind: 'chart'
  readonly chart: 'bar'
  readonly layout?: 'grouped' | 'stacked' | 'normalized'
  readonly categories: readonly string[]
  readonly series: readonly MayflyBarChartSeries[]
  readonly title?: string
  readonly yLabel?: string
  readonly height?: number
}
export interface MayflySparklineChartNode {
  readonly kind: 'chart'
  readonly chart: 'sparkline'
  readonly values: readonly (number | null)[]
  readonly label?: string
  readonly tone?: MayflyTone
}
export interface MayflyHeatmapChartNode {
  readonly kind: 'chart'
  readonly chart: 'heatmap'
  readonly columns: readonly string[]
  readonly rows: readonly string[]
  readonly values: readonly (readonly (number | string | null)[])[]
  readonly levels: readonly MayflyChartLevel[]
  readonly title?: string
}
export type MayflyChartNode = MayflyLineChartNode | MayflyBarChartNode | MayflySparklineChartNode | MayflyHeatmapChartNode

export type MayflyUiNode =
  | MayflyView | MayflyRichTextNode | MayflyStackNode | MayflySurfaceNode | MayflyScrollNode
  | MayflyTabsNode | MayflyListNode | MayflyFormNode | MayflyActionsNode | MayflyLoaderNode
  | MayflyEmptyNode | MayflyProgressNode | MayflySpacerNode | MayflyDividerNode
  | MayflyDocumentNode | MayflyChartNode

export type MayflyUiEvent =
  | { readonly kind: 'activate', readonly controlId: string }
  | { readonly kind: 'selection-change' | 'value-change', readonly controlId: string, readonly value: MayflyJson }
  | { readonly kind: 'submit', readonly controlId: string, readonly values: MayflyJson }
  | { readonly kind: 'tab-change', readonly controlId: string, readonly tabId: string }
  | { readonly kind: 'dismiss' }
export interface MayflyUiEventContext { readonly surfaceId: string, readonly signal: AbortSignal, readonly revision: number }
export type MayflyUiEventHandler = (event: MayflyUiEvent, context: MayflyUiEventContext) => void | Promise<void>

export type MayflyPanePlacement = 'header' | 'left' | 'right' | 'bottom'
export interface MayflyPaneContribution {
  readonly id: string
  readonly title?: string
  readonly priority?: number
  readonly placement: MayflyPanePlacement
  readonly size?: { readonly min?: number, readonly preferred?: number | 'auto', readonly max?: number }
  readonly narrow?: 'bottom' | 'overlay' | 'hidden'
  readonly render: () => MayflyUiNode | null
  readonly onEvent?: MayflyUiEventHandler
}
export interface MayflyPaneRegistration extends MayflyRefreshRegistration { setHidden(hidden: boolean): void }
export interface MayflyPaneEntry { readonly id: string, readonly contribution: MayflyPaneContribution, readonly hidden: boolean, readonly revision: number }
export interface MayflyPaneRegistry {
  register(contribution: MayflyPaneContribution): MayflyPaneRegistration
  list(): readonly MayflyPaneEntry[]
  subscribe(listener: (entries: readonly MayflyPaneEntry[]) => void): () => void
}

export type MayflyOverlayAnchor = 'center' | 'top' | 'bottom' | 'left' | 'right'
export interface MayflyOverlayRequest {
  readonly id: string
  readonly title?: string
  readonly capturing?: boolean
  readonly dismissible?: boolean
  readonly anchor?: MayflyOverlayAnchor
  readonly width?: number | `${number}%`
  readonly minWidth?: number
  readonly maxHeight?: number | `${number}%`
  readonly render: () => MayflyUiNode
  readonly onEvent?: MayflyUiEventHandler
}
export interface MayflyOverlayHandle extends MayflyRefreshRegistration { readonly closed: boolean, close(): void }
export interface MayflyOverlayEntry { readonly id: string, readonly request: MayflyOverlayRequest, readonly revision: number, readonly order: number }
export interface MayflyOverlayRegistry {
  open(request: MayflyOverlayRequest): MayflyOverlayHandle
  close(id: string): boolean
  list(): readonly MayflyOverlayEntry[]
  subscribe(listener: (entries: readonly MayflyOverlayEntry[]) => void): () => void
}

export type MayflyStatusNode = MayflyStatusTextNode | MayflyRichTextNode | MayflyStatusFieldsNode | MayflyProgressNode | MayflyStatusStackNode
export type MayflyStatusTextNode = Extract<MayflyView, { readonly kind: 'text' }>
export type MayflyStatusFieldsNode = Extract<MayflyView, { readonly kind: 'fields' }>
export interface MayflyStatusChild extends Omit<MayflyUiChild, 'node'> { readonly node: MayflyStatusNode }
export interface MayflyStatusStackNode extends Omit<MayflyStackNode, 'children'> { readonly children: readonly MayflyStatusChild[] }
export interface MayflyStatusEntry {
  readonly id: string
  readonly node: MayflyStatusNode
  readonly priority?: number
  readonly band?: 'left' | 'center' | 'right'
  readonly row?: 1 | 2
  readonly overflow?: 'truncate' | 'hide'
  readonly visible: boolean
}
export type MayflyStatusSource = MayflyStatusEntry | (() => MayflyStatusEntry | null)
export interface MayflyStatusRegistry {
  register(source: MayflyStatusSource): MayflyRefreshRegistration
  refresh(id: string): void
  list(): readonly MayflyStatusEntry[]
  subscribe(listener: () => void): () => void
}

export interface MayflyEditorCompletionItem { readonly id: string, readonly label: string, readonly insertText: string, readonly detail?: string }
export interface MayflyEditorCompletionRequest { readonly query: string, readonly trigger: '/' | '@' | '#' | 'manual' }
export interface MayflyEditorDiagnostic { readonly id: string, readonly message: string, readonly tone?: MayflyTone }
export interface MayflyEditorAttachment { readonly id: string, readonly label: string, readonly mediaType?: string, readonly size?: number }
export interface MayflyEditorSubmitRequest { readonly text: string, readonly attachments: readonly MayflyEditorAttachment[] }
export interface MayflyEditorSubmitValue { readonly text: string }
export type MayflyEditorExtensionNode =
  | MayflyView | MayflyRichTextNode | MayflyProgressNode | MayflySpacerNode | MayflyDividerNode
  | MayflyEditorExtensionStackNode | MayflyEditorExtensionSurfaceNode
export interface MayflyEditorExtensionChild extends Omit<MayflyUiChild, 'node'> { readonly node: MayflyEditorExtensionNode }
export interface MayflyEditorExtensionStackNode extends Omit<MayflyStackNode, 'children'> { readonly children: readonly MayflyEditorExtensionChild[] }
export interface MayflyEditorExtensionSurfaceNode extends Omit<MayflySurfaceNode, 'child' | 'footer'> { readonly child: MayflyEditorExtensionNode, readonly footer?: MayflyEditorExtensionNode }
export interface MayflyEditorExtensionContribution {
  readonly id: string
  readonly priority?: number
  readonly before?: MayflyEditorExtensionNode
  readonly after?: MayflyEditorExtensionNode
  readonly hint?: string
  readonly diagnostics?: readonly MayflyEditorDiagnostic[]
  readonly actions?: readonly MayflyActionItem[]
  readonly onEvent?: MayflyUiEventHandler
  readonly complete?: (request: MayflyEditorCompletionRequest, context: MayflyUiEventContext) => readonly MayflyEditorCompletionItem[] | Promise<readonly MayflyEditorCompletionItem[]>
  readonly transformSubmit?: (request: MayflyEditorSubmitRequest, context: MayflyUiEventContext) => MayflyEditorSubmitValue | Promise<MayflyEditorSubmitValue>
}
export interface MayflyEditorExtensionRegistry {
  register(contribution: MayflyEditorExtensionContribution): MayflyRefreshRegistration
  list(): readonly MayflyEditorExtensionContribution[]
  subscribe(listener: (entries: readonly MayflyEditorExtensionContribution[], revision: number) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mayflyPanes: MayflyPaneRegistry
    mayflyOverlays: MayflyOverlayRegistry
    mayflyStatus: MayflyStatusRegistry
    mayflyEditorExtensions: MayflyEditorExtensionRegistry
  }
}
