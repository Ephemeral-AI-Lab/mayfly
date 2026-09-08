/** Renderer-independent contracts shared by official and third-party Cordis plugins.
 * @module @ephemeral-ai/mayfly-ui/contracts
 */

import type {} from '@deepseek-ai/cordis'
import type { MayflyFieldValue, MayflyFormAddress, MayflyPagePath, MayflyPageSegment, MayflySelectionAddress, MayflySnapshotChange, MayflySnapshotUpdate, MayflySourceStamp, MayflyUiEventContext, MayflyUiEventEndpoint, MayflyUiEventHandlers, MayflyUiScope } from './interaction.ts'
export type * from './interaction.ts'

export type MayflyJson = null | boolean | number | string | readonly MayflyJson[] | { readonly [key: string]: MayflyJson }

export interface MayflyRegistration {
  readonly disposed: boolean
  dispose(): void
}

export interface MayflyNodeRegistration<Node> extends MayflyRegistration {
  readonly revision: number
  set(node: Node | null, update?: MayflySnapshotUpdate): void
}

/** Service-owned asynchronous snapshot source; the node remains pure data. */
export interface MayflySnapshotRequest { readonly cursor?: string, readonly signal: AbortSignal }
export interface MayflySnapshotPage<Node> { readonly node: Node, readonly nextCursor?: string, readonly total?: number }
export type MayflySnapshotProvider<Node> = (request: MayflySnapshotRequest) => MayflySnapshotPage<Node> | Promise<MayflySnapshotPage<Node>>

export type MayflyTone = 'default' | 'muted' | 'primary' | 'accent' | 'user' | 'success' | 'warning' | 'danger'
export type MayflyTextStyle = 'strong' | 'italic' | 'strike'
export interface MayflyInlineSpan { readonly text: string, readonly tone?: MayflyTone, readonly styles?: readonly MayflyTextStyle[] }
export interface MayflyField { readonly label: string, readonly value: readonly MayflyInlineSpan[] }

export interface MayflyTextNode { readonly kind: 'text', readonly content: string, readonly tone?: MayflyTone }
export interface MayflyMarkdownNode { readonly kind: 'markdown', readonly source: string }
export interface MayflyFieldsNode { readonly kind: 'fields', readonly rows: readonly MayflyField[] }
export interface MayflyCodeNode { readonly kind: 'code', readonly code: string, readonly language?: string }
export interface MayflyDiffNode { readonly kind: 'diff', readonly before: string, readonly after: string }
export interface MayflyRichTextNode { readonly kind: 'rich-text', readonly spans: readonly MayflyInlineSpan[] }
export interface MayflyDiagramNode { readonly kind: 'diagram', readonly diagram: 'mermaid', readonly source: string }
export type MayflySectionContentNode = MayflyTextNode | MayflyFieldsNode | MayflyCodeNode | MayflyDiffNode | MayflySectionsNode
export interface MayflySection { readonly title?: string, readonly body: MayflySectionContentNode, readonly collapsed?: boolean }
export interface MayflySectionsNode { readonly kind: 'sections', readonly sections: readonly MayflySection[] }

export interface MayflyViewportCondition { readonly minWidth?: number, readonly maxWidth?: number, readonly minHeight?: number, readonly maxHeight?: number }
export interface MayflyUiChild {
  readonly node: MayflyUiNode
  readonly id?: string
  readonly tab?: MayflyPageSegment
  readonly basis?: number | 'auto'
  readonly grow?: number
  readonly shrink?: number
  readonly minSize?: number
  readonly maxSize?: number
  readonly when?: MayflyViewportCondition
}
export interface MayflyStackNode { readonly kind: 'stack', readonly direction: 'row' | 'column', readonly gap?: 0 | 1 | 2, readonly align?: 'stretch' | 'start' | 'center' | 'end', readonly children: readonly MayflyUiChild[] }
export interface MayflySurfaceNode { readonly kind: 'surface', readonly title?: string, readonly subtitle?: string, readonly badges?: readonly MayflyInlineSpan[], readonly chrome?: 'none' | 'lane' | 'surface' | 'overlay', readonly padding?: 0 | 1 | 2, readonly child: MayflyUiNode, readonly footer?: MayflyUiNode }
export interface MayflyScrollNode { readonly kind: 'scroll', readonly id?: string, readonly child: MayflyUiNode, readonly follow?: 'none' | 'start' | 'end', readonly scrollbar?: boolean }
export interface MayflyTabItem { readonly id: string, readonly label: string, readonly disabled?: boolean, readonly count?: number, readonly backId?: string }
export interface MayflyTabsNode { readonly kind: 'tabs', readonly id: string, readonly activeId: string, readonly items: readonly MayflyTabItem[], readonly mode?: 'tabs' | 'wizard' }
export interface MayflyListItem { readonly id: string, readonly label: string, readonly detail?: string, readonly detailSpans?: readonly MayflyInlineSpan[], readonly badge?: string, readonly group?: string, readonly disabled?: boolean, readonly disabledReason?: string, readonly parentId?: string, readonly searchText?: string }
export interface MayflyListNode { readonly kind: 'list', readonly id: string, readonly role: 'browse' | 'choose', readonly mode?: 'single' | 'multiple', readonly selectedIds: readonly string[], readonly items: readonly MayflyListItem[], readonly filter?: string, readonly filterable?: boolean, readonly tree?: boolean, readonly minSelected?: number, readonly maxSelected?: number, readonly acceptActionId?: string, readonly empty?: MayflyUiNode }
export interface MayflyFormFieldBase {
  readonly id: string
  readonly label: string
  readonly error?: string
  readonly disabled?: boolean
  readonly disabledReason?: string
  readonly required?: boolean
  readonly origin?: 'inherited' | 'explicit'
  readonly resetValue?: MayflyFieldValue
}
export type MayflyFormField = MayflyFormFieldBase & (
  | { readonly kind: 'input' | 'textarea' | 'secret', readonly value: string, readonly placeholder?: string, readonly minLength?: number, readonly maxLength?: number }
  | { readonly kind: 'number', readonly value: number | null, readonly min?: number, readonly max?: number, readonly step?: number, readonly unit?: string }
  | { readonly kind: 'select', readonly value: string | null, readonly options: readonly MayflyListItem[] }
  | { readonly kind: 'multiselect', readonly value: readonly string[], readonly options: readonly MayflyListItem[], readonly minSelected?: number, readonly maxSelected?: number }
  | { readonly kind: 'toggle', readonly value: boolean }
)
export interface MayflyFormNode { readonly kind: 'form', readonly id: string, readonly fields: readonly MayflyFormField[], readonly submitActionId?: string, readonly cancelActionId?: string }
export interface MayflyActionItem { readonly id: string, readonly label: string, readonly intent?: 'primary' | 'secondary' | 'danger', readonly disabled?: boolean, readonly disabledReason?: string, readonly busy?: boolean, readonly confirm?: string, readonly submit?: readonly MayflyFormAddress[], readonly read?: readonly MayflyFormAddress[], readonly selections?: readonly MayflySelectionAddress[], readonly defaultFocus?: boolean, readonly dismiss?: boolean, readonly navigate?: MayflyPagePath }
export interface MayflyActionsNode { readonly kind: 'actions', readonly id: string, readonly items: readonly MayflyActionItem[] }
export interface MayflyLoaderNode { readonly kind: 'loader', readonly message: string, readonly variant?: 'braille' | 'tide', readonly elapsedMs?: number, readonly cancelActionId?: string }
export interface MayflyEmptyNode { readonly kind: 'empty', readonly title: string, readonly description?: string, readonly actions?: MayflyActionsNode }
export interface MayflyProgressNode { readonly kind: 'progress', readonly label?: string, readonly value: number, readonly max: number }
export interface MayflySpacerNode { readonly kind: 'spacer', readonly size?: 1 | 2 }
export interface MayflyDividerNode { readonly kind: 'divider', readonly label?: string }

export interface MayflyChartPoint { readonly x: number, readonly y: number | null }
export interface MayflyChartSeries { readonly id: string, readonly label?: string, readonly tone?: MayflyTone, readonly points: readonly MayflyChartPoint[] }
export interface MayflyBarChartSeries { readonly id: string, readonly label?: string, readonly tone?: MayflyTone, readonly values: readonly (number | null)[] }
export interface MayflyChartLevel { readonly value: number | string, readonly label: string, readonly tone?: MayflyTone }
export interface MayflyLineChartNode { readonly kind: 'chart', readonly chart: 'line' | 'point', readonly series: readonly MayflyChartSeries[], readonly title?: string, readonly xLabel?: string, readonly yLabel?: string, readonly height?: number }
export interface MayflyBarChartNode { readonly kind: 'chart', readonly chart: 'bar', readonly layout?: 'grouped' | 'stacked' | 'normalized', readonly categories: readonly string[], readonly series: readonly MayflyBarChartSeries[], readonly title?: string, readonly yLabel?: string, readonly height?: number }
export interface MayflySparklineChartNode { readonly kind: 'chart', readonly chart: 'sparkline', readonly values: readonly (number | null)[], readonly label?: string, readonly tone?: MayflyTone }
export interface MayflyHeatmapChartNode { readonly kind: 'chart', readonly chart: 'heatmap', readonly columns: readonly string[], readonly rows: readonly string[], readonly values: readonly (readonly (number | string | null)[])[], readonly levels: readonly MayflyChartLevel[], readonly title?: string }
export type MayflyChartNode = MayflyLineChartNode | MayflyBarChartNode | MayflySparklineChartNode | MayflyHeatmapChartNode

export type MayflyContentNode = MayflyTextNode | MayflyMarkdownNode | MayflyFieldsNode | MayflyCodeNode | MayflyDiffNode | MayflySectionsNode | MayflyRichTextNode | MayflyDiagramNode | MayflyChartNode
export type MayflyUiNode = MayflyContentNode | MayflyStackNode | MayflySurfaceNode | MayflyScrollNode | MayflyTabsNode | MayflyListNode | MayflyFormNode | MayflyActionsNode | MayflyLoaderNode | MayflyEmptyNode | MayflyProgressNode | MayflySpacerNode | MayflyDividerNode

export interface MayflyRegistryUpsert<Entry> { readonly kind: 'upsert', readonly entry: Entry }
export interface MayflyRegistryRemove { readonly kind: 'remove', readonly id: string, readonly revision: number }
export type MayflyRegistryDelta<Entry> = MayflyRegistryUpsert<Entry> | MayflyRegistryRemove

export type MayflyPanePlacement = 'header' | 'left' | 'right' | 'bottom'
export interface MayflyInteractionDefinition { readonly scope?: MayflyUiScope, readonly source?: readonly MayflySourceStamp[] }
export interface MayflyInteractionSnapshot { readonly scope: MayflyUiScope, readonly source: readonly MayflySourceStamp[] }
export interface MayflyPaneDefinition extends MayflyInteractionDefinition { readonly id: string, readonly title?: string, readonly priority?: number, readonly placement: MayflyPanePlacement, readonly size?: { readonly min?: number, readonly preferred?: number | 'auto', readonly max?: number }, readonly narrow?: 'bottom' | 'overlay' | 'hidden', readonly onEvent?: MayflyUiEventHandlers<MayflyUiNode | null>, readonly load?: MayflySnapshotProvider<MayflyUiNode | null> }
export interface MayflyPaneEntry extends MayflyInteractionSnapshot { readonly id: string, readonly definition: MayflyPaneDefinition, readonly node: MayflyUiNode | null, readonly revision: number, readonly update: MayflySnapshotChange, readonly events: MayflyUiEventEndpoint<MayflyUiNode | null> }
export interface MayflyPaneRegistration extends MayflyNodeRegistration<MayflyUiNode> { refresh(): Promise<void>, loadMore(): Promise<boolean> }
export interface MayflyPaneRegistry { register(definition: MayflyPaneDefinition, initialNode?: MayflyUiNode | null): MayflyPaneRegistration, list(): readonly MayflyPaneEntry[], subscribe(listener: (delta: MayflyRegistryDelta<MayflyPaneEntry>) => void): () => void }

export type MayflyOverlayAnchor = 'center' | 'top' | 'bottom' | 'left' | 'right'
export interface MayflyOverlayDefinition extends MayflyInteractionDefinition { readonly id: string, readonly title?: string, readonly presentation?: 'overlay' | 'editor', readonly capturing?: boolean, readonly dismissible?: boolean, readonly dismissal?: 'confirm-dirty' | 'discard', readonly anchor?: MayflyOverlayAnchor, readonly width?: number | `${number}%`, readonly minWidth?: number, readonly maxHeight?: number | `${number}%`, readonly onEvent?: MayflyUiEventHandlers, readonly load?: MayflySnapshotProvider<MayflyUiNode> }
export interface MayflyOverlayEntry extends MayflyInteractionSnapshot { readonly id: string, readonly definition: MayflyOverlayDefinition, readonly node: MayflyUiNode, readonly revision: number, readonly order: number, readonly hidden: boolean, readonly focusRevision: number, readonly update: MayflySnapshotChange, readonly events: MayflyUiEventEndpoint }
export interface MayflyOverlayHandle extends MayflyRegistration { readonly revision: number, readonly closed: boolean, set(node: MayflyUiNode, update?: MayflySnapshotUpdate): void, focus(): void, hide(): void, show(): void, close(): void }
export interface MayflyOverlayRegistry { open(definition: MayflyOverlayDefinition, initialNode: MayflyUiNode): MayflyOverlayHandle, close(id: string): boolean, focus(id: string): boolean, list(): readonly MayflyOverlayEntry[], subscribe(listener: (delta: MayflyRegistryDelta<MayflyOverlayEntry>) => void): () => void }

export type MayflyStatusNode = MayflyTextNode | MayflyRichTextNode | MayflyFieldsNode | MayflyProgressNode | MayflyStatusStackNode
export interface MayflyStatusChild extends Omit<MayflyUiChild, 'node' | 'tab'> { readonly node: MayflyStatusNode }
export interface MayflyStatusStackNode extends Omit<MayflyStackNode, 'children'> { readonly children: readonly MayflyStatusChild[] }
export interface MayflyStatusDefinition { readonly id: string, readonly priority?: number, readonly band?: 'left' | 'center' | 'right', readonly row?: 1 | 2, readonly overflow?: 'truncate' | 'hide' }
export interface MayflyStatusEntry { readonly id: string, readonly definition: MayflyStatusDefinition, readonly node: MayflyStatusNode | null, readonly revision: number }
export interface MayflyStatusRegistration extends MayflyRegistration { readonly revision: number, set(node: MayflyStatusNode | null): void }
export interface MayflyStatusRegistry { register(definition: MayflyStatusDefinition, initialNode?: MayflyStatusNode | null): MayflyStatusRegistration, list(): readonly MayflyStatusEntry[], subscribe(listener: (delta: MayflyRegistryDelta<MayflyStatusEntry>) => void): () => void }

export interface MayflyEditorCompletionItem { readonly id: string, readonly label: string, readonly insertText: string, readonly detail?: string }
export interface MayflyEditorCompletionRequest { readonly query: string, readonly trigger: '/' | '@' | '#' | 'manual' }
export interface MayflyEditorDiagnostic { readonly id: string, readonly message: string, readonly tone?: MayflyTone }
export interface MayflyEditorAttachment { readonly id: string, readonly label: string, readonly mediaType?: string, readonly size?: number }
export interface MayflyEditorSubmitRequest { readonly text: string, readonly attachments: readonly MayflyEditorAttachment[] }
export interface MayflyEditorSubmitValue { readonly text: string }
export type MayflyEditorContentNode = Exclude<MayflyContentNode, MayflyDiagramNode | MayflyChartNode>
export type MayflyEditorExtensionNode = MayflyEditorContentNode | MayflyProgressNode | MayflySpacerNode | MayflyDividerNode | MayflyEditorExtensionStackNode | MayflyEditorExtensionSurfaceNode
export interface MayflyEditorExtensionChild extends Omit<MayflyUiChild, 'node' | 'tab'> { readonly node: MayflyEditorExtensionNode }
export interface MayflyEditorExtensionStackNode extends Omit<MayflyStackNode, 'children'> { readonly children: readonly MayflyEditorExtensionChild[] }
export interface MayflyEditorExtensionSurfaceNode extends Omit<MayflySurfaceNode, 'child' | 'footer'> { readonly child: MayflyEditorExtensionNode, readonly footer?: MayflyEditorExtensionNode }
export interface MayflyEditorDecoration { readonly before?: MayflyEditorExtensionNode, readonly after?: MayflyEditorExtensionNode, readonly hint?: string, readonly diagnostics?: readonly MayflyEditorDiagnostic[], readonly actions?: readonly MayflyActionItem[] }
export interface MayflyEditorExtensionDefinition extends MayflyInteractionDefinition { readonly id: string, readonly priority?: number, readonly onEvent?: MayflyUiEventHandlers<MayflyEditorDecoration>, readonly complete?: (request: MayflyEditorCompletionRequest, context: MayflyUiEventContext) => readonly MayflyEditorCompletionItem[] | Promise<readonly MayflyEditorCompletionItem[]>, readonly transformSubmit?: (request: MayflyEditorSubmitRequest, context: MayflyUiEventContext) => MayflyEditorSubmitValue | Promise<MayflyEditorSubmitValue> }
export interface MayflyEditorExtensionEntry extends MayflyInteractionSnapshot { readonly id: string, readonly definition: MayflyEditorExtensionDefinition, readonly decoration: MayflyEditorDecoration, readonly revision: number, readonly update: MayflySnapshotChange, readonly events: MayflyUiEventEndpoint<MayflyEditorDecoration> }
export interface MayflyEditorExtensionRegistration extends MayflyRegistration { readonly revision: number, set(decoration: MayflyEditorDecoration, update?: MayflySnapshotUpdate): void }
export interface MayflyEditorExtensionRegistry { register(definition: MayflyEditorExtensionDefinition, initialDecoration?: MayflyEditorDecoration): MayflyEditorExtensionRegistration, list(): readonly MayflyEditorExtensionEntry[], subscribe(listener: (delta: MayflyRegistryDelta<MayflyEditorExtensionEntry>) => void): () => void }

declare module '@deepseek-ai/cordis' {
  interface Context {
    mayflyPanes: MayflyPaneRegistry
    mayflyOverlays: MayflyOverlayRegistry
    mayflyStatus: MayflyStatusRegistry
    mayflyEditorExtensions: MayflyEditorExtensionRegistry
  }
}
