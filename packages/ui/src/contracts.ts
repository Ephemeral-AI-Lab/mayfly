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
/** The glyph animations of a loader and of a loader span; `braille` and `tide` of the first loaders are `gap`. */
export type MayflyLoaderVariant = 'bloom' | 'fill' | 'gap' | 'breath'
export interface MayflyInlineSpan {
  readonly text: string
  readonly tone?: MayflyTone
  readonly styles?: readonly MayflyTextStyle[]
  /** One motion channel, in rich text only: the letters shimmer, or the span is one animated loader cell (its `text` is `''`). */
  readonly motion?: 'shimmer' | 'loader'
  /** The animation of a `loader` span; `gap` by default. */
  readonly variant?: MayflyLoaderVariant
}
export interface MayflyField { readonly label: string, readonly value: readonly MayflyInlineSpan[] }

/**
 * How text wider than its row behaves: wrap onto more rows, stay one row ellipsized at the end, or stay one row with
 * the middle or the start elided so the distinguishing end shows (paths, titles). Rich text takes `wrap` and `truncate`.
 */
export type MayflyTextOverflow = 'wrap' | 'truncate' | 'middle' | 'start'
export interface MayflyTextNode { readonly kind: 'text', readonly content: string, readonly tone?: MayflyTone, readonly overflow?: MayflyTextOverflow, readonly styles?: readonly MayflyTextStyle[] }
export interface MayflyMarkdownNode { readonly kind: 'markdown', readonly source: string }
export interface MayflyFieldsNode { readonly kind: 'fields', readonly rows: readonly MayflyField[] }
export interface MayflyCodeNode { readonly kind: 'code', readonly code: string, readonly language?: string, readonly numbered?: boolean }
export interface MayflyDiffNode {
  readonly kind: 'diff'
  readonly before: string
  readonly after: string
  /** The number of the first line (default 1). */
  readonly start?: number
  /** Old and new line-number gutters (default true). */
  readonly numbered?: boolean
  /** Draw an `@@` header even for one hunk (default: only when there is more than one). */
  readonly hunkHeader?: boolean
  /** Context lines around each change, 0 to 3 (default 1). */
  readonly context?: number
  /** At most this many rows, then `… +N rows · Ctrl+O`. */
  readonly maxRows?: number
}
export interface MayflyRichTextNode { readonly kind: 'rich-text', readonly spans: readonly MayflyInlineSpan[], readonly overflow?: Extract<MayflyTextOverflow, 'wrap' | 'truncate'> }
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
  /** Admission order in a row: children that carry one are admitted while they fit, lower first. */
  readonly priority?: number
  /** Where an admitted child sits in its row (default `left`). */
  readonly band?: 'left' | 'center' | 'right'
  /** What a child that does not fit does: `truncate` takes the room that is left (at least 8 cells) and fills the row, `hide` drops out while later children may still fit; without one it and every later child drop. */
  readonly overflow?: 'truncate' | 'hide'
}
export interface MayflyStackNode { readonly kind: 'stack', readonly direction: 'row' | 'column', readonly gap?: 0 | 1 | 2, readonly align?: 'stretch' | 'start' | 'center' | 'end', readonly children: readonly MayflyUiChild[] }
export interface MayflySurfaceNode {
  readonly kind: 'surface'
  readonly title?: string
  readonly subtitle?: string
  readonly badges?: readonly MayflyInlineSpan[]
  readonly chrome?: 'none' | 'lane' | 'surface' | 'overlay'
  readonly padding?: 0 | 1 | 2
  readonly child: MayflyUiNode
  readonly footer?: MayflyUiNode
  /** `right` puts the title in the top-right corner (a long one is elided at its start); badges take the left. */
  readonly titleAlign?: 'left' | 'right'
  /** The border tone; the chrome's own (focus color for an overlay, quiet for a surface) otherwise. */
  readonly border?: MayflyTone
  /** What `Esc` does, as the hint row names it; `reject` dismisses as a rejection. */
  readonly escapeLabel?: 'close' | 'back' | 'cancel' | 'reject' | 'leave'
  /** `none` draws no key-hint row, `completions` draws one only while the editor's completion list is open. */
  readonly hint?: 'auto' | 'none' | 'completions'
}
export interface MayflyScrollNode {
  readonly kind: 'scroll'
  readonly id?: string
  readonly child: MayflyUiNode
  readonly follow?: 'none' | 'start' | 'end'
  readonly scrollbar?: boolean
  /** A viewport of exactly this many rows (default 6 once any of `height`, `expandedHeight`, `fit`, `pill` is set). */
  readonly height?: number
  /** The viewport's rows while the scroll is expanded with `Ctrl+E` (default 14). */
  readonly expandedHeight?: number
  /** Shrink the viewport to short content, and draw the scrollbar only when the content overflows. */
  readonly fit?: boolean
  /** `↓ N new · End` over the last row while the view is scrolled away from a followed tail. */
  readonly pill?: boolean
}
export interface MayflyTabItem { readonly id: string, readonly label: string, readonly disabled?: boolean, readonly count?: number, readonly backId?: string }
export interface MayflyTabsNode { readonly kind: 'tabs', readonly id: string, readonly activeId: string, readonly items: readonly MayflyTabItem[], readonly mode?: 'tabs' | 'wizard' }
export interface MayflyListSegmentOption { readonly id: string, readonly label: string, readonly disabled?: boolean, readonly disabledReason?: string }
/** A horizontal option strip bound to one list row; left/right steps it while the row is focused and `selection-accept` reports it as `segmentId`. */
export interface MayflyListSegment {
  readonly label?: string
  readonly options: readonly MayflyListSegmentOption[]
  readonly selectedId?: string
  /** The option the row uses while it is unpinned: drawn `(default)`, and stepping onto it (or `Delete`) unpins the row. */
  readonly inheritedId?: string
}
/** Content a list row may open under itself. It is never a control, so a body never takes focus or holds a key. */
export type MayflyListBodyNode = MayflyContentNode | MayflyImageNode | MayflyProgressNode | MayflySpacerNode | MayflyDividerNode | MayflyListBodyStackNode
export interface MayflyListBodyChild extends Omit<MayflyUiChild, 'node' | 'tab'> { readonly node: MayflyListBodyNode }
export interface MayflyListBodyStackNode extends Omit<MayflyStackNode, 'children'> { readonly children: readonly MayflyListBodyChild[] }
export interface MayflyListItem {
  readonly id: string
  /** Plain text: what a filter and the accessible name read. `labelSpans` paints it instead when present. */
  readonly label: string
  readonly labelSpans?: readonly MayflyInlineSpan[]
  /** Spans aligned to the right edge of the row; they carry their own spacing. */
  readonly right?: readonly MayflyInlineSpan[]
  /** The right spans while this row holds the cursor. */
  readonly rightFocus?: readonly MayflyInlineSpan[]
  /** Lines of text (`│ ╰` guide) or content that opens under the row; a body makes the row expandable. */
  readonly body?: string | MayflyListBodyNode
  /** The body is always open and the row is not a disclosure. */
  readonly bodyAlways?: boolean
  /** The row starts open. */
  readonly expanded?: boolean
  /** Wrap the row's text onto more rows instead of truncating it. */
  readonly wrap?: boolean
  /** With `wrap`, the most lines shown before `▸ N more lines · Enter`. */
  readonly wrapMax?: number
  readonly meter?: { readonly value: number, readonly max: number, readonly width?: number, readonly tone?: MayflyTone }
  /** Columns of indent before the row's own glyphs. */
  readonly indent?: number
  /** A non-selectable muted rule row; the text is right-aligned. */
  readonly rule?: string
  /** A non-selectable blank row. */
  readonly gap?: boolean
  readonly detail?: string
  readonly detailSpans?: readonly MayflyInlineSpan[]
  readonly badge?: string
  readonly group?: string
  readonly disabled?: boolean
  readonly disabledReason?: string
  readonly parentId?: string
  readonly searchText?: string
  readonly segment?: MayflyListSegment
  /** Actions (by id) that cannot run while this row is the selection they target, with the reason shown in place of the action. */
  readonly unavailableActions?: Readonly<Record<string, string>>
  /** Shared decision shown before accepting this single row. */
  readonly confirm?: string | MayflyConfirmation
}
export interface MayflyListNode {
  readonly kind: 'list'
  readonly id: string
  readonly role: 'browse' | 'choose'
  readonly mode?: 'single' | 'multiple'
  readonly selectedIds: readonly string[]
  readonly items: readonly MayflyListItem[]
  readonly filter?: string
  readonly filterable?: boolean
  /** `'type'` (default): printable keys start a search. `'slash'`: only `/` does, so bare letters stay free for accelerators. */
  readonly filterMode?: 'type' | 'slash'
  readonly tree?: boolean
  readonly numbered?: boolean | 'focus'
  readonly minSelected?: number
  readonly maxSelected?: number
  readonly acceptActionId?: string
  readonly empty?: MayflyUiNode
  /** `'selection'` keeps a muted arrow on the cursor row after focus leaves the list (a list whose detail follows it). */
  readonly marker?: 'cursor' | 'selection'
  /** Draw `●` `○` on a single choose list. */
  readonly marks?: boolean
  /** Show at most this many rows, windowed around the cursor, with an `↑ n more · ↓ n more` row. */
  readonly maxRows?: number
  /** The cursor row opens its body or branch while it holds the cursor. */
  readonly expandFocused?: boolean
  /** The word the hint row gives `Enter`. */
  readonly acceptVerb?: 'open' | 'choose' | 'expand' | 'edit' | 'restore'
  /** The list takes focus first when its surface opens. */
  readonly autofocus?: boolean
  /** Moves the cursor to `id` (and opens its parents) whenever `rev` changes. */
  readonly focusItem?: { readonly id: string, readonly rev: number }
  /** The word the hint row gives the list's `↑/↓`. */
  readonly hintLabel?: string
}
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
export interface MayflyFormNode {
  readonly kind: 'form'
  readonly id: string
  readonly fields: readonly MayflyFormField[]
  readonly submitActionId?: string
  /** Button text for `submitActionId`; defaults to a localized "Submit". */
  readonly submitLabel?: string
  readonly cancelActionId?: string
  /** Button text for `cancelActionId`; defaults to a localized "Cancel". */
  readonly cancelLabel?: string
  readonly enterSubmits?: string
}
/** Shared Yes/No decision shown before an action runs; No is focused first. */
export interface MayflyConfirmation {
  readonly title: string
  /** Consequences shown under the question. */
  readonly detail?: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly tone?: 'danger'
}
/**
 * A meaning shared by every panel (spec §3.5). An action that declares one runs from the `ui.<meaning>` action's
 * binding (`delete` is `x` until a user rebinds `ui.delete`), so one rebind moves the key in every panel at once.
 */
export type MayflyCommonMeaning = 'save' | 'copy' | 'delete' | 'refresh' | 'external' | 'search'
export interface MayflyActionItem {
  readonly id: string
  readonly label: string
  readonly intent?: 'primary' | 'secondary' | 'danger'
  readonly disabled?: boolean
  readonly disabledReason?: string
  readonly busy?: boolean
  readonly confirm?: string | MayflyConfirmation
  readonly submit?: readonly MayflyFormAddress[]
  readonly read?: readonly MayflyFormAddress[]
  readonly selections?: readonly MayflySelectionAddress[]
  readonly defaultFocus?: boolean
  /** Not drawn as a button and not a focus stop; still runs from its `key` accelerator or as a form's `enterSubmits` target. */
  readonly hidden?: boolean
  readonly dismiss?: boolean
  readonly navigate?: MayflyPagePath
  /** Surface accelerator key id, and with `action` that action's default. Semantic navigation keys are reserved; printable keys are rejected on surfaces with a filterable list. Exclusive with `semantic`. */
  readonly key?: string
  /** A common meaning: the item runs from that meaning's current binding. Exclusive with `key` and `action`. */
  readonly semantic?: MayflyCommonMeaning
  /** A named component action, `<owner>.<action>` (`ui.*` is reserved); `key` is its default and a user may rebind it. */
  readonly action?: string
  /** The word the hint row shows after the key; the label otherwise. */
  readonly hintLabel?: string
}
/** `scope` names controls on the same page: the group's keys act, and show their hints, only while one of them has focus. */
export interface MayflyActionsNode { readonly kind: 'actions', readonly id: string, readonly items: readonly MayflyActionItem[], readonly scope?: string | readonly string[] }
export interface MayflyLoaderNode {
  readonly kind: 'loader'
  /** What is loading; without one the loader is a bare glyph. */
  readonly message?: string
  /** The glyph animation (`gap` by default); the first loaders' `braille` and `tide` stay accepted and draw `gap`. */
  readonly variant?: MayflyLoaderVariant | 'braille' | 'tide'
  readonly elapsedMs?: number
  readonly cancelActionId?: string
  readonly cancelLabel?: string
}
export interface MayflyEmptyNode { readonly kind: 'empty', readonly title: string, readonly description?: string, readonly actions?: MayflyActionsNode }
export interface MayflyProgressNode {
  readonly kind: 'progress'
  readonly label?: string
  readonly value: number
  readonly max: number
  /** `cells` draws `▰▱`, `rule` the heavy and light rule `━─`; a bar with neither `style` nor `width` fills its row with partial blocks. */
  readonly style?: 'cells' | 'rule'
  /** The bar's cells (10 for `cells`, 24 for `rule`). */
  readonly width?: number
  /** The filled part's tone (`primary` by default). */
  readonly tone?: MayflyTone
  /** `n/N` after the bar (default true). */
  readonly showCount?: boolean
  /** The percentage after the bar. */
  readonly showPercent?: boolean
  /** A renderer-owned one-shot: when `rev` first arrives the bar drains linearly from `from` to `value` over `ms`. */
  readonly transition?: { readonly from: number, readonly ms: number, readonly rev: number }
}
export interface MayflySpacerNode { readonly kind: 'spacer', readonly size?: 1 | 2 }
export interface MayflyDividerNode { readonly kind: 'divider', readonly label?: string }
/**
 * An inline image. The wire carries a reference, never bytes: the host tree supplies a loader that resolves
 * `attachmentId`, and `alt` shows until the bytes arrive and on a terminal without an image protocol.
 */
export interface MayflyImageNode {
  readonly kind: 'image'
  readonly attachmentId: string
  /** The text fallback, e.g. `[Image #1 84 KB]`. */
  readonly alt: string
  /** The tallest the image may paint, in terminal rows. */
  readonly maxRows?: number
}

export interface MayflyChartPoint { readonly x: number, readonly y: number | null }
export interface MayflyChartSeries { readonly id: string, readonly label?: string, readonly tone?: MayflyTone, readonly points: readonly MayflyChartPoint[] }
export interface MayflyBarChartSeries { readonly id: string, readonly label?: string, readonly tone?: MayflyTone, readonly values: readonly (number | null)[], readonly empty?: boolean }
export interface MayflyChartLevel { readonly value: number | string, readonly label: string, readonly tone?: MayflyTone }
export interface MayflyLineChartNode { readonly kind: 'chart', readonly chart: 'line' | 'point', readonly series: readonly MayflyChartSeries[], readonly title?: string, readonly xLabel?: string, readonly yLabel?: string, readonly height?: number }
export interface MayflyBarChartNode { readonly kind: 'chart', readonly chart: 'bar', readonly layout?: 'grouped' | 'stacked' | 'normalized', readonly orientation?: 'vertical' | 'horizontal', readonly categories: readonly string[], readonly series: readonly MayflyBarChartSeries[], readonly title?: string, readonly yLabel?: string, readonly height?: number }
export interface MayflySparklineChartNode { readonly kind: 'chart', readonly chart: 'sparkline', readonly values: readonly (number | null)[], readonly label?: string, readonly tone?: MayflyTone }
export interface MayflyHeatmapChartNode {
  readonly kind: 'chart'
  readonly chart: 'heatmap'
  readonly columns: readonly string[]
  readonly rows: readonly string[]
  readonly values: readonly (readonly (number | string | null)[])[]
  readonly levels: readonly MayflyChartLevel[]
  readonly title?: string
  /** `1` draws one cell per value in `· ░ ▒ ▓ █` with no gap (a year of days); `2` the two-cell default. */
  readonly cell?: 1 | 2
  /** The header's labels, one per column (one-cell mode writes each where its column starts); the column names otherwise. */
  readonly columnLabels?: readonly string[]
}
export type MayflyChartNode = MayflyLineChartNode | MayflyBarChartNode | MayflySparklineChartNode | MayflyHeatmapChartNode

export type MayflyContentNode = MayflyTextNode | MayflyMarkdownNode | MayflyFieldsNode | MayflyCodeNode | MayflyDiffNode | MayflySectionsNode | MayflyRichTextNode | MayflyDiagramNode | MayflyChartNode
export type MayflyUiNode = MayflyContentNode | MayflyStackNode | MayflySurfaceNode | MayflyScrollNode | MayflyTabsNode | MayflyListNode | MayflyFormNode | MayflyActionsNode | MayflyLoaderNode | MayflyEmptyNode | MayflyProgressNode | MayflySpacerNode | MayflyDividerNode | MayflyImageNode

export interface MayflyRegistryUpsert<Entry> { readonly kind: 'upsert', readonly entry: Entry }
export interface MayflyRegistryRemove { readonly kind: 'remove', readonly id: string, readonly revision: number }
export type MayflyRegistryDelta<Entry> = MayflyRegistryUpsert<Entry> | MayflyRegistryRemove

export type MayflyPanePlacement = 'header' | 'left' | 'right' | 'bottom'
export interface MayflyInteractionDefinition { readonly scope?: MayflyUiScope, readonly source?: readonly MayflySourceStamp[] }
export interface MayflyInteractionSnapshot { readonly scope: MayflyUiScope, readonly source: readonly MayflySourceStamp[] }
/**
 * A pane contribution. `size` is measured in columns for `left`/`right`
 * panes and in rows for `bottom` panes, where the stacked dock grants each
 * pane at least `min` rows (default 1, its head row) and never more than
 * `max` before truncating its tail.
 */
export interface MayflyPaneDefinition extends MayflyInteractionDefinition { readonly id: string, readonly title?: string, readonly priority?: number, readonly placement: MayflyPanePlacement, readonly size?: { readonly min?: number, readonly preferred?: number | 'auto', readonly max?: number }, readonly narrow?: 'bottom' | 'overlay' | 'hidden', readonly onEvent?: MayflyUiEventHandlers<MayflyUiNode | null>, readonly load?: MayflySnapshotProvider<MayflyUiNode | null> }
export interface MayflyPaneEntry extends MayflyInteractionSnapshot { readonly id: string, readonly definition: MayflyPaneDefinition, readonly node: MayflyUiNode | null, readonly revision: number, readonly update: MayflySnapshotChange, readonly events: MayflyUiEventEndpoint<MayflyUiNode | null> }
export interface MayflyPaneRegistration extends MayflyNodeRegistration<MayflyUiNode> { refresh(): Promise<void>, loadMore(): Promise<boolean> }
export interface MayflyPaneRegistry { register(definition: MayflyPaneDefinition, initialNode?: MayflyUiNode | null): MayflyPaneRegistration, list(): readonly MayflyPaneEntry[], subscribe(listener: (delta: MayflyRegistryDelta<MayflyPaneEntry>) => void): () => void }

export type MayflyOverlayAnchor = 'center' | 'top' | 'bottom' | 'left' | 'right'
export interface MayflyOverlayDefinition extends MayflyInteractionDefinition { readonly id: string, readonly title?: string, readonly presentation?: 'overlay' | 'editor', readonly capturing?: boolean, readonly dismissible?: boolean, readonly dismissal?: 'confirm-dirty' | 'discard', readonly anchor?: MayflyOverlayAnchor, readonly width?: number | `${number}%`, readonly minWidth?: number, readonly maxHeight?: number | `${number}%`, readonly contentScroll?: boolean, readonly onEvent?: MayflyUiEventHandlers, readonly load?: MayflySnapshotProvider<MayflyUiNode> }
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
