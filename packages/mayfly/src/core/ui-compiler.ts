/**
 * The sole compiler from canonical public Mayfly UI nodes into pi-tui-backed
 * components. One outer focus target owns roving state, event dispatch,
 * responsive reconciliation, cursor-marker insertion, and render containment.
 *
 * @module @ephemeral-ai/mayfly/core/ui-compiler
 */

import type {
  MayflyActionItem,
  MayflyChartNode,
  MayflyDiagramNode,
  MayflyImageNode,
  MayflyFormField,
  MayflyInlineSpan,
  MayflyListNode,
  MayflySectionContentNode,
  MayflyStatusNode,
  MayflyTone,
  MayflyUiEvent,
  MayflyUiNode,
  MayflyUiChild,
  MayflyViewportCondition,
  MayflyFieldAddress,
  MayflyFieldValue,
  MayflyPagePath,
} from '@ephemeral-ai/mayfly-ui'
import { CURSOR_MARKER, HStack, ScrollView, VStack, type Component } from '@earendil-works/pi-tui'
import { renderLayoutFrame, type LayoutBox, type LayoutRect } from '@earendil-works/pi-tui/dist/layout.js'
import { getLayoutNode, LAYOUT_NODE, type LayoutNode, type LayoutViewport } from '@earendil-works/pi-tui/dist/layout-node.js'
import { glyphRows } from './glyphs.ts'
import { renderChartRows } from './chart-renderer.ts'
import { ownDataErrorMessage } from './error-message.ts'
import { paintPluginTone, renderCanonicalView, sanitizePluginText, truncatedRow } from './plugin-view.ts'
import type { MayflyComponent, MayflyComponents, MayflyEditor, MayflyFocusable, MayflyFocusIdentity, MayflyKeymap, MayflySemanticColors } from './types.ts'
import {
  renderActions,
  renderDivider,
  renderEmpty,
  renderFormField,
  renderList,
  renderListSegment,
  renderLoader,
  renderProgress,
  renderHintRow,
  renderSurfaceHead,
  renderSurfaceTail,
  surfaceBorderPaint,
  type HintPart,
  renderTabs,
  type PatternFocus,
} from './ui-patterns.ts'
import { sliceByColumn, visibleWidth } from './width.ts'
import { fieldActions, fieldReset, type UiFieldAction } from './ui-interaction-field-actions.ts'
import {
  deferredUiNodeMayHaveControls,
  isDeferredUiNode,
  materializeDeferredUiNode,
  materializedDeferredUiNode,
  type MayflyAdmissionCache,
  validateMayflyEditorShellNode,
  validateMayflyStatusNode,
  validateMayflyUiNode,
} from './ui-validator.ts'
import type { MayflyEditorShellNode, MayflyUiErrorCode } from './ui-contracts.ts'
import {
  UiControlStore,
  type UiControlBinding,
  type UiListMovement,
  type UiScrollControl,
  type UiVirtualListEntry,
} from './ui-surface-state.ts'
import type { UiSurfaceModel } from './ui-interaction-surface.ts'
import { feedbackSpans } from './ui-interaction-notifications.ts'
import { admittedListItem } from './ui-validator.ts'
import { MayflyCompileCache, type PaintOptions } from './ui-compile-cache.ts'
import { actionHintLabel, actionScopeActive, effectiveItemKeys } from './ui-actions.ts'
import { UiRowCache } from './ui-row-cache.ts'
import { UiImagePainter } from './ui-image.ts'
import type { MayflyUiImageSource } from './ui-images.ts'
import { countWork, type MayflyWorkCounters } from './ui-work-counters.ts'
import { choiceError, choiceSegment, choiceVisibleCount, choiceVisibleIndex, choiceVisiblePosition, decorateChoiceItem } from './ui-interaction-choice.ts'
import { SearchInput } from './search-input.ts'
import { UiLoaderAnimation, type UiAnimationClock } from './ui-loader-animation.ts'
import { AdmissionRow } from './ui-admission.ts'
import { ScrollRegion, SCROLL_DEFAULT_EXPANDED_HEIGHT, SCROLL_DEFAULT_HEIGHT, type ScrollMemory } from './ui-scroll-region.ts'
import { hasMotion, paintMotionSpans } from './ui-motion-text.ts'
import { UiProgressTransitions } from './ui-progress-transition.ts'
import { untranslated, type UiTranslateValues } from './ui-interaction-locale.ts'
import { grammarHints, hintNotation, keyGrammar, type EscapeStep, type GrammarControl, type GrammarIntent, type GrammarMatch, type GrammarState } from './ui-key-grammar.ts'
import { documentAnchorAtRow, documentAnchorRow } from './ui-interaction-document.ts'
import type { UiControlAddress } from './ui-interaction-tree.ts'
import {
  keyActionKeys,
  matchesKeyAction,
  matchesKeyId,
} from './key-actions.ts'

const FOCUS_SENTINEL = '\uf8ff'
const ERROR_MAX_ROWS = 3
const LAYOUT_VALUE_MAX = 1_000_000
const INACTIVE_FIELD_CACHE_LIMIT = 64
const PASSIVE_EVENT_SINK = Function.prototype as (event: MayflyUiEvent) => void

/** Apply one semantic scroll movement to a scroll view. */
function scrollBy(scroll: ScrollControl, movement: ListMovement): void {
  switch (movement) {
    case 'up': scroll.scrollBy(-1); return
    case 'down': scroll.scrollBy(1); return
    case 'page-up': scroll.scrollBy(-Math.max(1, scroll.viewportHeight)); return
    case 'page-down': scroll.scrollBy(Math.max(1, scroll.viewportHeight)); return
    case 'home': scroll.scrollToStart(); return
    case 'end': scroll.scrollToEnd(); return
  }
}

/** Pane-relative dimensions used by responsive child conditions. */
export interface MayflyUiViewport {
  readonly columns: number
  readonly rows: number
}

/** Narrow runtime dependencies accepted by the canonical compiler. */
export interface MayflyUiCompilerOptions {
  readonly interaction?: UiSurfaceModel
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly getViewport: () => MayflyUiViewport
  readonly screenMode: 'main' | 'alternate'
  /** Live semantic key bindings; omitted only by isolated compiler fixtures. */
  readonly keymap?: MayflyKeymap
  /** Interaction-private observation of renderer focus; public UI events stay confirmation-only. */
  readonly onFocusChange?: (identity: MayflyFocusIdentity) => void
  /** Renderer-private contextual key hints used by official panel adapters. */
  readonly contextHints?: {
    readonly enabled?: boolean
    readonly suppressAuto?: boolean
    readonly focusWithoutControls?: boolean
    readonly translate?: (key: string, values?: UiTranslateValues) => string
    readonly extra?: () => readonly {
      readonly id: string
      readonly keys: string
      readonly label?: string
      readonly compact?: string
      readonly priority?: number
    }[]
  }
  readonly emit: (event: MayflyUiEvent) => void
  /** Called only when Escape did not first cancel compiler-local state. */
  readonly onUnhandledEscape?: () => void
  /** Whether the editor's completion list is open; a surface with `hint: 'completions'` draws its key-hint row only then. */
  readonly completionsOpen?: () => boolean
  /** Measurement sink for validation, compilation, and painting; production passes none. */
  readonly counters?: MayflyWorkCounters
  /** The caller's admission memo; a publish that shares subtrees with the previous one validates only what changed. */
  readonly admission?: MayflyAdmissionCache
  /** The caller's compile memo; static leaves of an unchanged subtree keep their components. A surface runtime brings its own. */
  readonly reuse?: MayflyCompileCache
}

/** Canonical shell dependencies, including the one host-owned editing engine. */
export interface MayflyEditorShellCompilerOptions extends MayflyUiCompilerOptions {
  readonly editor: MayflyEditor
}

/** Core-private compiler options for one bridge-owned plugin surface. */
interface MayflyUiSurfaceCompilerOptions extends MayflyUiCompilerOptions {
  readonly surfaceRuntime: MayflyUiSurfaceRuntime
  readonly title?: string
  readonly escapeHint?: 'close' | 'leave'
}

/** Passive dependencies and bounded height for one compact status tree. */
export interface MayflyStatusCompilerOptions {
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly getViewport: () => MayflyUiViewport
  readonly screenMode: 'main' | 'alternate'
  /** Status output is always bounded to one through three rows; defaults to one. */
  readonly maxRows?: 1 | 2 | 3
  /** Measurement sink for validation, compilation, and painting; production passes none. */
  readonly counters?: MayflyWorkCounters
  /** The caller's admission memo; a publish that shares subtrees with the previous one validates only what changed. */
  readonly admission?: MayflyAdmissionCache
  /** The caller's compile memo; static leaves of an unchanged subtree keep their components. */
  readonly reuse?: MayflyCompileCache
}

/** Successful canonical compilation result. */
export interface MayflyCompiledUi {
  readonly node: MayflyUiNode
  readonly component: MayflyComponent
  readonly focusTarget: MayflyFocusable | null
}

/** Successful editor-shell compilation around the injected editing engine. */
export interface MayflyCompiledEditorShell {
  readonly node: MayflyEditorShellNode
  readonly component: MayflyEditorShellComponent
  readonly focusTarget: MayflyEditorShellComponent
}

/** One editor-shell render plus a contained renderer failure, when present. */
export interface MayflyEditorShellRenderResult {
  readonly rows: string[]
  readonly runtimeFailure?: string
}

/** Checked-render options used before an editor provider is committed. */
export interface MayflyEditorShellRenderOptions {
  /** Restore composite/editor focus and roving state after the render. */
  readonly dryRun?: boolean
}

/** Focusable editor shell with a provider-owned checked-render boundary. */
export interface MayflyEditorShellComponent extends MayflyFocusable {
  /**
   * Render with structured failure reporting. A dry run restores all focus
   * state after measuring the candidate.
   * @param width - assigned editor-shell width.
   * @param options - optional dry-run behavior.
   * @returns rendered rows and the first contained runtime failure.
   */
  renderChecked(width: number, options?: MayflyEditorShellRenderOptions): MayflyEditorShellRenderResult
  /** Select the host editor inside this shell without taking screen focus. */
  focusEditor(): void
}

/** One bounded status render and whether the assigned viewport hid content. */
export interface MayflyStatusRenderResult {
  readonly rows: string[]
  readonly overflowed: boolean
  /** Renderer failure contained behind the status boundary, when present. */
  readonly runtimeFailure?: string
}

/** Passive status component with explicit overflow metadata for footer policy. */
export interface MayflyStatusComponent extends MayflyComponent {
  /**
   * Render within the compiler's one-to-three-row budget.
   * @param width - assigned status width in terminal columns.
   * @returns bounded rows plus whether row or column content overflowed.
   */
  renderStatus(width: number): MayflyStatusRenderResult
}

/** Successful canonical status compilation result. */
export interface MayflyCompiledStatus {
  readonly node: MayflyStatusNode
  readonly component: MayflyStatusComponent
}

/** Compile failure with a safe renderer-owned error surface. */
export interface MayflyUiCompileFailure {
  readonly ok: false
  readonly code: MayflyUiErrorCode
  readonly message: string
  readonly errorComponent: MayflyComponent
}

/** Result returned by the no-bypass UI compiler. */
export type MayflyUiCompileResult = { readonly ok: true, readonly value: MayflyCompiledUi } | MayflyUiCompileFailure

/** Result returned by the no-bypass editor-shell compiler. */
export type MayflyEditorShellCompileResult = { readonly ok: true, readonly value: MayflyCompiledEditorShell } | MayflyUiCompileFailure

/** Status compile failure with a passive, height-bounded error component. */
export interface MayflyStatusCompileFailure {
  readonly ok: false
  readonly code: MayflyUiErrorCode
  readonly message: string
  readonly errorComponent: MayflyStatusComponent
}

/** Result returned by the no-bypass status compiler. */
export type MayflyStatusCompileResult = { readonly ok: true, readonly value: MayflyCompiledStatus } | MayflyStatusCompileFailure

type CompilerMode = 'ui' | 'status' | 'editor'

type CompilableNode = MayflyUiNode | MayflyEditorShellNode

interface RuntimeCompilerOptions extends MayflyUiCompilerOptions {
  readonly editor?: MayflyEditor
  readonly listRuntime: MayflyUiSurfaceRuntime
  readonly reportRuntimeFailure: (message: string) => void
  /** Always present while compiling: the caller's memo, else the surface runtime's own. */
  readonly reuse: MayflyCompileCache
}

interface ControlBase {
  readonly key: string
  readonly renderKey: string
  readonly identity: MayflyFocusIdentity
  readonly preferred: boolean
  readonly group: string
  readonly navigation: 'horizontal' | 'vertical' | 'none'
  /** An id an action scope may name that neither the identity nor the group carries (a scroll's own id). */
  readonly scopeId?: string
}

/** An action item that answers keys: its effective keys are resolved through the keymap on every key and paint. */
interface KeyedAction {
  readonly item: MayflyActionItem
  readonly label: string
  /** The controls whose focus puts the item's keys in scope; the whole surface when absent. */
  readonly scope?: readonly string[]
}

/** A hidden action's accelerator: fires its activate event without a button or focus stop. */
interface HiddenAccelerator extends KeyedAction {
  readonly event: MayflyUiEvent
}

type TextField = Extract<MayflyFormField, { readonly kind: 'input' | 'textarea' | 'secret' | 'number' }>
type SelectField = Extract<MayflyFormField, { readonly kind: 'select' | 'multiselect' }>
type ToggleField = Extract<MayflyFormField, { readonly kind: 'toggle' }>
type FormNode = Extract<MayflyUiNode, { readonly kind: 'form' }>

type ControlDescriptor =
  | (ControlBase & {
      readonly kind: 'event'
      readonly role: 'tab' | 'list-single' | 'list-multiple' | 'action' | 'cancel'
      readonly activation: 'enter' | 'space' | 'both'
      readonly event: MayflyUiEvent
      readonly commitEvent?: MayflyUiEvent
      readonly listEntry?: { readonly node: MayflyListNode, readonly index: number }
      /** Declared surface-local accelerator; fires the same activate event while the surface holds focus. */
      readonly keyed?: KeyedAction
      /** A loader's cancel: Escape fires it before it leaves the surface. */
      readonly work?: true
    })
  | (ControlBase & { readonly kind: 'text', readonly field: TextField, readonly form: FormNode })
  | (ControlBase & { readonly kind: 'select', readonly field: SelectField })
  | (ControlBase & { readonly kind: 'toggle', readonly field: ToggleField })
  | (ControlBase & { readonly kind: 'submit', readonly form: FormNode })
  | (ControlBase & { readonly kind: 'field-action', readonly address: MayflyFieldAddress, readonly action: UiFieldAction })
  | (ControlBase & { readonly kind: 'editor' })
  | (ControlBase & { readonly kind: 'scroll' })
  | (ControlBase & { readonly kind: 'list', readonly node: MayflyListNode })

interface ControlGroup {
  readonly id: string
  readonly kind: 'tabs' | 'content'
  readonly entries: readonly { readonly control: ControlDescriptor, readonly index: number }[]
}

type ControlBinding = UiControlBinding
type ScrollControl = UiScrollControl
type VirtualListEntry = UiVirtualListEntry
type ListMovement = UiListMovement

interface FocusState {
  activeKey: string | undefined
  activeGroup: string | undefined
  desiredKey: string | undefined
  desiredGroup: string | undefined
  editingKey: string | undefined
  expandedKey: string | undefined
  readonly groupActiveKeys: Map<string, string>
  readonly controlBindings: Map<string, ControlBinding>
  readonly scrollViews: Map<string, ScrollControl>
  lastTabGroupIndex: number
  lastIndex: number
  focused: boolean
  layoutPass: boolean
  /** The viewport this layout pass last reconciled focus for. */
  layoutReconciled: MayflyUiViewport | undefined
  controls(): readonly ControlDescriptor[]
  allControls(): readonly ControlDescriptor[]
  accelerators(): readonly HiddenAccelerator[]
  emit(event: MayflyUiEvent): void
  field(field: MayflyFormField, key: string): MayflyFormField
  fieldValue(field: MayflyFormField, key: string): MayflyFieldValue
  setValue(key: string, value: MayflyFieldValue): void
  textEditor(field: TextField, key: string): MayflyEditor
  beginSelectEditing(field: SelectField, key: string): void
  finishSelectEditing(field: SelectField, key: string, cancel: boolean): MayflyFieldValue
  setEditing(key: string | undefined): void
  blurInactiveEditors(controls: readonly ControlDescriptor[]): void
  setLayoutViewport(viewport: MayflyUiViewport): void
  bindControls(keys: readonly string[], binding: ControlBinding): void
  bindScroll(key: string, scroll: ScrollControl): void
}

/** Enter a layout pass; its first visible check reconciles focus again. */
function beginLayoutPass(state: FocusState): void {
  state.layoutPass = true
  state.layoutReconciled = undefined
}

function sameViewport(left: MayflyUiViewport | undefined, right: MayflyUiViewport): boolean {
  return left?.columns === right.columns && left.rows === right.rows
}

function safeViewport(getViewport: () => MayflyUiViewport): MayflyUiViewport {
  try {
    const viewport = getViewport()
    const columns = Number.isFinite(viewport.columns) ? Math.max(1, Math.floor(viewport.columns)) : 1
    const rows = Number.isFinite(viewport.rows) ? Math.max(1, Math.floor(viewport.rows)) : 1
    return { columns, rows }
  } catch {
    return { columns: 1, rows: 1 }
  }
}

function tabVisible(child: Pick<MayflyUiChild, 'tab'>, pagePath: MayflyPagePath, options: RuntimeCompilerOptions): boolean {
  return child.tab === undefined
    || options.listRuntime.activeTab({ pagePath, controlId: child.tab.controlId }) === child.tab.itemId
}

function conditionMatches(condition: MayflyViewportCondition | undefined, viewport: MayflyUiViewport): boolean {
  if (condition === undefined) return true
  return (condition.minWidth === undefined || viewport.columns >= condition.minWidth)
    && (condition.maxWidth === undefined || viewport.columns <= condition.maxWidth)
    && (condition.minHeight === undefined || viewport.rows >= condition.minHeight)
    && (condition.maxHeight === undefined || viewport.rows <= condition.maxHeight)
}

function errorRows(message: string, width: number, colors: MayflySemanticColors): string[] {
  const safeWidth = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
  const source = `Mayfly UI rejected: ${message}`.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')
  const chunks: string[] = []
  let remaining = source
  while (remaining.length > 0 && chunks.length < ERROR_MAX_ROWS) {
    let consumed = 0
    let columns = 0
    for (const codePoint of remaining) {
      const codePointWidth = visibleWidth(codePoint)
      consumed += codePoint.length
      if (columns + codePointWidth > safeWidth) break
      columns += codePointWidth
      if (columns >= safeWidth) break
    }
    const row = sliceByColumn(remaining.slice(0, consumed), 0, safeWidth, true)
    chunks.push(row)
    remaining = remaining.slice(consumed)
  }
  return chunks.map(row => {
    try {
      const painted = colors.error(row)
      return visibleWidth(painted) <= safeWidth ? painted : sliceByColumn(painted, 0, safeWidth, true)
    } catch {
      return row
    }
  })
}

class ErrorComponent implements MayflyComponent {
  constructor(private readonly message: string, private readonly colors: MayflySemanticColors) {}
  render(width: number): string[] { return errorRows(this.message, width, this.colors) }
  invalidate(): void {}
}

function renderFailure(error: unknown, fallback = 'unknown render failure'): string {
  return ownDataErrorMessage(error) ?? fallback
}

/**
 * A component painted by a pattern painter. Its rows are shown in the presentation's glyph mode: every replacement is
 * one cell, so the conversion runs after the painter laid the row out. Editors are not static components, so the text
 * being typed is never converted.
 */
function staticComponent(render: (width: number) => string[], options: Pick<PaintOptions, 'colors' | 'counters' | 'reportRuntimeFailure'> & { readonly components?: Pick<MayflyComponents, 'presentation'> }, counted = true): MayflyComponent {
  return {
    render: width => {
      try {
        const rows = glyphRows(render(width), options.components?.presentation?.glyphs)
        if (counted) countWork(options.counters, 'rowsPainted', rows.length)
        return rows
      } catch (error) {
        const message = renderFailure(error)
        options.reportRuntimeFailure(message)
        return errorRows(message, width, options.colors)
      }
    },
    invalidate: () => {},
  }
}

/**
 * A static render that depends only on its immutable node and the width.
 * Layout frames re-render every row on each paint (spinner ticks, scroll
 * steps); these rows answer from a per-width memo until invalidated.
 */
function pureStaticComponent(render: (width: number) => string[], options: Pick<PaintOptions, 'colors' | 'components' | 'counters' | 'reportRuntimeFailure'>): MayflyComponent {
  // A row layout measures a leaf at several widths before it paints, so one remembered width would thrash.
  const memo = new Map<number, string[]>()
  const component = staticComponent(width => {
    const known = memo.get(width)
    if (known !== undefined) return known
    const rows = render(width)
    countWork(options.counters, 'rowsPainted', rows.length)
    if (memo.size >= PURE_STATIC_WIDTHS) memo.delete(memo.keys().next().value!)
    memo.set(width, rows)
    return rows
  }, options, false)
  // The rows are a pure function of the node, the width, and the palette this leaf was compiled with, and a new palette
  // recompiles the leaf, so an invalidation (a loader tick, a scroll step) leaves them in place.
  return { render: component.render, invalidate: () => {} }
}

/** How many widths a pure static leaf remembers rows for. */
const PURE_STATIC_WIDTHS = 4

class SemanticScrollView extends ScrollView {
  private width = 1

  constructor(
    component: Component,
    options: ConstructorParameters<typeof ScrollView>[1],
    private readonly model: UiSurfaceModel,
    private readonly address: UiControlAddress,
  ) { super(component, options) }

  override render(width: number): string[] {
    this.width = this.getContentWidth(width)
    return super.render(width)
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender)
    const state = this.model.document(this.address)
    if (state?.anchor?.follow === 'end') super.scrollToEnd()
    else if (state !== undefined) super.scrollTo(documentAnchorRow(state, this.width), { disableFollow: true })
  }

  private sync(): void {
    const state = this.model.document(this.address)
    if (state === undefined) return
    const anchor = documentAnchorAtRow(state, this.scrollTop, this.width, this.isFollowingEnd ? 'end' : 'none')
    if (anchor !== undefined) this.model.moveDocument(this.address, anchor)
  }

  override scrollTo(scrollTop: number, options?: Parameters<ScrollView['scrollTo']>[1]): void {
    super.scrollTo(scrollTop, options)
    this.sync()
  }
  override scrollBy(lines: number): number { const remaining = super.scrollBy(lines); this.sync(); return remaining }
  override scrollToStart(): void { super.scrollToStart(); this.sync() }
  override scrollToEnd(): void { super.scrollToEnd(); this.sync() }
}

function markdownLeafComponent(node: Extract<MayflyUiNode, { readonly kind: 'markdown' }>, options: RuntimeCompilerOptions): MayflyComponent {
  const markdown = options.components.createMarkdown({ text: node.source })
  return {
    render: width => {
      try { return glyphRows(markdown.render(Math.max(1, width)), options.components.presentation?.glyphs) }
      catch (error) {
        const message = renderFailure(error)
        options.reportRuntimeFailure(message)
        return errorRows(message, width, options.colors)
      }
    },
    invalidate: () => markdown.invalidate(),
  }
}

function diagramSource(node: MayflyDiagramNode): string {
  const longest = Math.max(0, ...Array.from(node.source.matchAll(/`+/gu), match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}mermaid\n${node.source}\n${fence}`
}

function diagramComponent(node: MayflyDiagramNode, options: RuntimeCompilerOptions): MayflyComponent {
  const markdown = options.components.createMarkdown({ text: diagramSource(node) })
  return {
    render: width => glyphRows(markdown.render(Math.max(1, width)), options.components.presentation?.glyphs),
    invalidate: () => markdown.invalidate(),
  }
}

function imageComponent(node: MayflyImageNode, options: RuntimeCompilerOptions): MayflyComponent {
  const painter = new UiImagePainter(node, options.components, options.colors, options.listRuntime.images, options.listRuntime.repaint)
  const component = staticComponent(width => painter.render(width), options)
  return { render: component.render, invalidate: () => { painter.invalidate() } }
}

function chartComponent(node: MayflyChartNode, options: RuntimeCompilerOptions): MayflyComponent {
  return staticComponent(width => renderChartRows(node, Math.max(1, width), options.components, options.colors), options)
}

function editorFieldComponent(field: TextField, key: string, state: FocusState, options: RuntimeCompilerOptions): MayflyComponent {
  let editor: MayflyEditor | undefined
  const currentEditor = (): MayflyEditor => editor ??= state.textEditor(field, key)
  return {
    render: width => {
      try {
        const editor = currentEditor()
        const presented = state.field(field, key)
        const available = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
        const focused = state.focused && state.activeKey === key && presented.disabled !== true
        editor.focused = focused && state.editingKey === key
        const prefix = focused ? `${FOCUS_SENTINEL}→ ` : '   '
        const labelText = `${prefix}${presented.label}: `
        const label = presented.disabled === true ? options.colors.muted(labelText) : focused ? options.colors.primary(labelText) : options.colors.textStrong(labelText)
        const labelWidth = visibleWidth(label)
        const stacked = available - labelWidth < Math.min(12, available)
        const contentWidth = stacked ? available : available - labelWidth
        const placeholder = 'placeholder' in field ? field.placeholder : undefined
        const emptyPlaceholder = editor.getExpandedText().length === 0 && placeholder !== undefined
        const content = emptyPlaceholder && !editor.focused
          ? [options.colors.textMuted(placeholder!)]
          : editor.renderContent(contentWidth, field.kind === 'secret')
        const unit = field.kind === 'number' && field.unit !== undefined ? options.colors.textMuted(` ${field.unit}`) : ''
        const body = content.map((row, index) => index === 0 ? `${row}${unit}` : row)
        const indent = ' '.repeat(Math.min(available, labelWidth))
        let rows = stacked
          ? [sliceByColumn(label, 0, available, true), ...body.map(row => sliceByColumn(row, 0, available, true))]
          : body.map((row, index) => sliceByColumn(`${index === 0 ? label : indent}${row}`, 0, available, true))
        if (presented.error !== undefined) rows.push(sliceByColumn(options.colors.error(`   ! ${presented.error}`), 0, available, true))
        if (state.layoutPass && focused) {
          let inserted = rows.some(row => row.includes(CURSOR_MARKER))
          rows = rows.map(row => {
            if (inserted || !row.includes(FOCUS_SENTINEL)) return row.replaceAll(FOCUS_SENTINEL, ' ')
            inserted = true
            return row.replace(FOCUS_SENTINEL, `${CURSOR_MARKER} `).replaceAll(FOCUS_SENTINEL, ' ')
          })
        }
        return rows
      } catch (error) {
        const message = renderFailure(error, 'unknown editor failure')
        options.reportRuntimeFailure(message)
        return errorRows(message, width, options.colors)
      }
    },
    invalidate: () => editor?.invalidate(),
  }
}

function safePaint(colors: MayflySemanticColors, tone: MayflyTone | undefined, value: string): string {
  return paintPluginTone(colors, tone)(value)
}

function patternFocus(state: FocusState, prefix: string): PatternFocus {
  const controls = state.controls()
  const active = controls.find(control => control.group === prefix && control.key === state.activeKey)
  return {
    key: active?.renderKey ?? '',
    focused: state.focused,
    marker: state.layoutPass ? `${CURSOR_MARKER} ` : FOCUS_SENTINEL,
  }
}

/** The clock frame a moving cell paints at: reduced motion stays on the first frame and never joins the clock. */
function motionFrame(options: RuntimeCompilerOptions): number {
  return options.components.presentation?.reducedMotion === true ? 0 : options.listRuntime.loaderFrame()
}

function joinSpans(node: { readonly spans: readonly MayflyInlineSpan[] }, colors: MayflySemanticColors): string {
  return node.spans.map(span => {
    const painted = safePaint(colors, span.tone, span.text)
    return (span.styles ?? []).reduce((value, style) => {
      if (style === 'strong') return `\x1b[1m${value}\x1b[22m`
      if (style === 'italic') return `\x1b[3m${value}\x1b[23m`
      return `\x1b[9m${value}\x1b[29m`
    }, painted)
  }).join('')
}

function pad(component: Component, amount: number, options: RuntimeCompilerOptions): Component {
  if (amount === 0) return component
  const padded = new HStack()
  const spacer = (): MayflyComponent => staticComponent(() => [''], options)
  padded.addChild(spacer(), { basis: amount, grow: 0, shrink: 1 })
  padded.addChild(component, { basis: 0, grow: 1, shrink: 1, minSize: 1 })
  padded.addChild(spacer(), { basis: amount, grow: 0, shrink: 1 })
  return padded
}

/**
 * A framed surface (`overlay` or `surface` chrome): the inset title rule, side bars, and bottom rule in the chrome's
 * border paint, with at least one column of gutter inside each bar (`padding` 2 adds a second).
 */
function framedSurfaceComponent(node: Extract<CompilableNode, { readonly kind: 'surface' }>, chrome: 'surface' | 'overlay', child: Component, footer: Component | undefined, contextHint: Component | undefined, options: RuntimeCompilerOptions): MayflyComponent & { [LAYOUT_NODE](): LayoutNode } {
  const body = new VStack()
  body.addChild(staticComponent(width => renderSurfaceHead(node, width, options.colors).slice(1), options))
  body.addChild(child, options.listRuntime.interaction === undefined ? {} : { grow: 1, minSize: 1 })
  if (footer !== undefined) body.addChild(footer)
  if (contextHint !== undefined) body.addChild(contextHint)

  const paint = surfaceBorderPaint(chrome, options.colors, node.border)
  const glyphs = options.components.presentation?.glyphs
  const bar = glyphRows(['│'], glyphs)[0]!
  const gutter = Math.max(1, node.padding ?? 0)
  let layoutRows = 1
  const captureLayoutRows = (viewport: LayoutViewport): boolean => {
    layoutRows = Math.min(LAYOUT_VALUE_MAX, Math.max(1, Math.floor(viewport.height)))
    return viewport.width >= 3
  }
  const frameVisible = (viewport: LayoutViewport): boolean => viewport.width >= 3
  const paddingVisible = (index: number) => (viewport: LayoutViewport): boolean => viewport.width >= 5 + index * 2
  const borderRows = (): string[] => Array.from({ length: layoutRows }, () => paint(bar))
  const middle = new HStack()
  middle.addChild(staticComponent(borderRows, options), { basis: 1, grow: 0, shrink: 1, visible: captureLayoutRows })
  for (let index = 0; index < gutter; index += 1) {
    middle.addChild(staticComponent(() => [''], options), { basis: 1, grow: 0, shrink: 100, visible: paddingVisible(index) })
  }
  middle.addChild(body, { basis: 1, grow: 1, shrink: 1, minSize: 0 })
  for (let index = 0; index < gutter; index += 1) {
    middle.addChild(staticComponent(() => [''], options), { basis: 1, grow: 0, shrink: 100, visible: paddingVisible(index) })
  }
  middle.addChild(staticComponent(borderRows, options), { basis: 1, grow: 0, shrink: 1, visible: captureLayoutRows })

  const layout = new VStack()
  layout.addChild(staticComponent(width => renderSurfaceHead(node, width, options.colors).slice(0, 1), options), { basis: 1, grow: 0, shrink: 0, visible: frameVisible })
  layout.addChild(middle, { basis: 0, grow: 1, shrink: 1, minSize: 0 })
  layout.addChild(staticComponent(width => renderSurfaceTail(node, width, options.colors), options), { basis: 1, grow: 0, shrink: 0, visible: frameVisible })

  return {
    [LAYOUT_NODE](): LayoutNode { return layout[LAYOUT_NODE]() },
    render(width: number): string[] {
      const available = Math.max(1, Math.floor(width))
      if (available < 3) return body.render(available).map(row => { countWork(options.counters, 'stringsMeasured'); return options.components.truncateToWidth(row, available, '') })
      const horizontalPadding = Math.min(gutter, Math.max(0, Math.floor((available - 3) / 2)))
      const contentWidth = Math.max(1, available - 2 - horizontalPadding * 2)
      // The frame's own rows convert to the glyph mode here; the body's painters converted theirs.
      const head = glyphRows(renderSurfaceHead(node, available, options.colors).slice(0, 1), glyphs)
      const bodyRows = body.render(contentWidth)
      const tail = glyphRows(renderSurfaceTail(node, available, options.colors), glyphs)
      const border = paint(bar)
      const framed = bodyRows.map(row => {
        countWork(options.counters, 'stringsMeasured', 2)
        const clipped = options.components.truncateToWidth(row, contentWidth, '')
        const fill = ' '.repeat(Math.max(0, contentWidth - options.components.visibleWidth(clipped)))
        const inset = ' '.repeat(horizontalPadding)
        return `${border}${inset}${clipped}${fill}${inset}${border}`
      })
      return [...head, ...framed, ...tail]
    },
    invalidate(): void { layout.invalidate() },
  }
}

function surfaceComponent(node: Extract<CompilableNode, { readonly kind: 'surface' }>, child: Component, footer: Component | undefined, contextHint: Component | undefined, options: RuntimeCompilerOptions): MayflyComponent {
  if (node.chrome === 'overlay' || node.chrome === 'surface') return framedSurfaceComponent(node, node.chrome, child, footer, contextHint, options)
  const component = new VStack()
  component.addChild(staticComponent(width => renderSurfaceHead(node, width, options.colors), options))
  component.addChild(child, options.listRuntime.interaction === undefined ? {} : { grow: 1, minSize: 1 })
  if (footer !== undefined) component.addChild(footer)
  if (contextHint !== undefined) component.addChild(contextHint)
  return pad(component, node.padding ?? 0, options)
}

function controlKey(kind: string, controlId: string, itemId?: string, pagePath: MayflyPagePath = []): string {
  return JSON.stringify([pagePath, kind, controlId, itemId])
}

function focusIdentity(controlId: string, itemId?: string, pagePath: MayflyPagePath = []): MayflyFocusIdentity {
  return { controlId, pagePath, ...(itemId === undefined ? {} : { itemId }) }
}

function controlGroup(kind: string, controlId: string, pagePath: MayflyPagePath = []): string {
  return JSON.stringify([pagePath, kind, controlId])
}

function actionGroup(node: Extract<MayflyUiNode, { readonly kind: 'actions' }>, pagePath: MayflyPagePath = []): string {
  return JSON.stringify([pagePath, 'actions', node.id, [...node.items].map(item => item.id).sort()])
}

function fieldStateKey(key: string, kind: MayflyFormField['kind']): string {
  return JSON.stringify(['field-state', key, kind])
}

function controlGroups(controls: readonly ControlDescriptor[]): ControlGroup[] {
  const groups: { id: string, kind: 'tabs' | 'content', entries: { control: ControlDescriptor, index: number }[] }[] = []
  const byId = new Map<string, (typeof groups)[number]>()
  for (const [index, control] of controls.entries()) {
    let group = byId.get(control.group)
    if (group === undefined) {
      group = {
        id: control.group,
        kind: control.kind === 'event' && control.role === 'tab' ? 'tabs' : 'content',
        entries: [],
      }
      groups.push(group)
      byId.set(control.group, group)
    }
    group.entries.push({ control, index })
  }
  return groups
}

function sameFocusIdentity(left: MayflyFocusIdentity, right: MayflyFocusIdentity): boolean {
  return left.controlId === right.controlId && left.itemId === right.itemId && JSON.stringify(left.pagePath) === JSON.stringify(right.pagePath ?? [])
}

function groupTarget(controls: readonly ControlDescriptor[], group: string, remembered: string | undefined): number {
  const rememberedIndex = remembered === undefined
    ? -1
    : controls.findIndex(control => control.group === group && control.key === remembered)
  if (rememberedIndex >= 0) return rememberedIndex
  const preferred = controls.findIndex(control => control.group === group && control.preferred)
  if (preferred >= 0) return preferred
  return controls.findIndex(control => control.group === group)
}

interface ContextKeyHint {
  readonly id: string
  readonly keys: string
  readonly label: string | undefined
  readonly compact: string
  readonly priority: number
}

type EscapeLabel = 'close' | 'leave' | 'reject' | 'surface-back' | 'surface-cancel'

/** The escape step a surface's `escapeLabel` names; every one hands Escape to the host's `onUnhandledEscape`. */
const SURFACE_ESCAPE: Readonly<Record<NonNullable<Extract<MayflyUiNode, { readonly kind: 'surface' }>['escapeLabel']>, EscapeLabel>> = {
  close: 'close', leave: 'leave', reject: 'reject', back: 'surface-back', cancel: 'surface-cancel',
}

/** The label of the outermost Escape: a surface's own `escapeLabel` replaces the host's, once the host handles Escape at all. */
function surfaceEscape(node: CompilableNode, host: EscapeLabel | undefined): EscapeLabel | undefined {
  return host === undefined || node.kind !== 'surface' || node.escapeLabel === undefined ? host : SURFACE_ESCAPE[node.escapeLabel]
}

/** Translate a core-owned string through the host catalog, falling back to English interpolation. */
function coreText(options: Pick<MayflyUiCompilerOptions, 'contextHints'> | undefined, key: string, values?: UiTranslateValues): string {
  try { return options?.contextHints?.translate?.(key, values) ?? untranslated(key, values) } catch { return untranslated(key, values) }
}

/** An action a targeted selection row declares unavailable renders disabled with that row's reason. */
function effectiveActionItem(item: MayflyActionItem, options: RuntimeCompilerOptions): MayflyActionItem {
  const reason = options.listRuntime.interaction?.unavailableReason(item)
  return reason === undefined ? item : { ...item, disabled: true, disabledReason: reason }
}

/** A named component action's button shows the key that answers it now; an action rebound to no key shows none. */
function withEffectiveKey(item: MayflyActionItem, options: RuntimeCompilerOptions): MayflyActionItem {
  if (item.action === undefined) return item
  const [key] = effectiveItemKeys(item, options.keymap)
  if (key === item.key) return item
  const { key: _declared, ...rest } = item
  return key === undefined ? rest : { ...rest, key }
}

/** Summarize the focused control and its surroundings for the shared key grammar. */
function grammarStateFor(state: FocusState, options: RuntimeCompilerOptions, controls: readonly ControlDescriptor[], active: ControlDescriptor | undefined, mode: CompilerMode, escapeLabel: EscapeLabel | undefined): GrammarState {
  const runtime = options.listRuntime
  const interaction = runtime.interaction
  const groups = controlGroups(controls)
  const node = active?.kind === 'list' ? active.node : active?.kind === 'event' ? active.listEntry?.node : undefined
  const pagePath = node === undefined ? [] : runtime.pagePath(node)
  const choice = node === undefined ? undefined : interaction?.choice({ pagePath, controlId: node.id })
  const editing = active !== undefined && state.editingKey === active.key
  const expanded = state.expandedKey !== undefined && state.scrollViews.has(state.expandedKey)
  const control = ((): GrammarControl => {
    if (active === undefined) return { kind: 'none' }
    switch (active.kind) {
      case 'editor': return { kind: 'editor' }
      case 'scroll': return { kind: 'scroll' }
      case 'list': return { kind: 'empty-list' }
      case 'toggle': return { kind: 'toggle' }
      case 'submit': return { kind: 'submit' }
      case 'field-action': return { kind: 'field-action' }
      case 'text': return { kind: 'text', field: active.field.kind, editing, enterSubmits: active.form.enterSubmits !== undefined }
      case 'select': {
        const field = state.field(active.field, active.key) as SelectField
        const enabled = field.options.filter(option => option.disabled !== true).length
        return { kind: 'select', multiple: field.kind === 'multiselect', picker: editing, adjustable: enabled > 1 || (enabled === 1 && field.value === null) }
      }
      case 'event': {
        if (active.role === 'tab') return { kind: 'tab' }
        if (active.role === 'action') return { kind: 'action', decision: active.event.kind === 'activate' && active.event.actionId.startsWith('mayfly.decision.') }
        if (active.role === 'cancel') return { kind: 'cancel' }
        const list = active.listEntry!.node
        const segment = admittedListItem(list.items, active.listEntry!.index)?.segment
        const adjustable = segment !== undefined && segment.options.filter(option => option.disabled !== true).length > 1
        return { kind: 'row', role: list.role, multiple: active.role === 'list-multiple', tree: list.tree === true, ...(adjustable ? { segment: (segment.label ?? 'segment').toLowerCase() } : {}) }
      }
    }
  })()
  const searching = choice?.searching === true
  const escape: EscapeStep | undefined = expanded ? 'collapse'
    : control.kind === 'select' && control.picker ? 'cancel'
      : control.kind === 'text' && control.editing ? 'done'
        : searching ? 'end-search'
          : interaction?.backTarget() !== undefined ? 'back'
            : controls.some(candidate => candidate.kind === 'event' && candidate.work === true) ? 'cancel-work'
              : escapeLabel
  const numbered = node?.numbered
  const fieldAddress = active?.kind === 'text' || active?.kind === 'select' || active?.kind === 'toggle' ? runtime.fieldAddress(active.key) : undefined
  const reset = fieldAddress === undefined ? undefined : fieldReset(interaction?.form(fieldAddress), fieldAddress.fieldId)
  return {
    mode: mode === 'editor' ? 'editor' : 'ui',
    expanded,
    control,
    ...(node === undefined ? {} : { list: {
      /* Search state lives in the frontend choice; without it the list stays a plain roving list. */
      filterable: node.filterable === true && choice !== undefined,
      searching,
      query: (choice?.query ?? '').length > 0,
      pasting: node.filterable === true && choice !== undefined && runtime.search(node).pending,
      ...(numbered === undefined || numbered === false ? {} : { numbered: { accept: numbered === true, count: Math.min(9, choice === undefined ? node.items.length : choiceVisibleCount(choice)) } }),
    } }),
    keyed: [
      ...controls.flatMap((candidate, index) => candidate.kind === 'event' && candidate.keyed !== undefined ? keyedBindings(index, candidate.keyed, active, options) : []),
      // Hidden accelerators follow the focusable controls in the index space.
      ...state.accelerators().flatMap((accelerator, index) => keyedBindings(controls.length + index, accelerator, active, options)),
    ],
    tabs: groups.some(group => group.kind === 'tabs'),
    groups: groups.length,
    siblings: active === undefined ? 0 : controls.filter(candidate => candidate.group === active.group).length,
    escape,
    closable: escapeLabel !== undefined && escapeLabel !== 'leave',
    ...(reset === undefined ? {} : { reset }),
  }
}

/** The ids an action scope can name for the focused control: itself, the list, form, tabs, or actions group holding it, and a scroll's own id. */
function focusScopeIds(active: ControlDescriptor | undefined): readonly string[] {
  if (active === undefined) return []
  const group = JSON.parse(active.group) as readonly unknown[]
  return [active.identity.controlId, String(group[2]), ...(active.scopeId === undefined ? [] : [active.scopeId])]
}

/** One grammar entry per effective key of an in-scope keyed action; an action rebound to no key answers nothing. */
function keyedBindings(control: number, keyed: KeyedAction, active: ControlDescriptor | undefined, options: RuntimeCompilerOptions): GrammarState['keyed'] {
  if (keyed.scope !== undefined && !actionScopeActive(keyed.scope, focusScopeIds(active))) return []
  return effectiveItemKeys(keyed.item, options.keymap).map(key => ({ control, key, label: keyed.label }))
}

function matchesBinding(match: GrammarMatch, data: string, keymap: MayflyKeymap | undefined): boolean {
  switch (match.kind) {
    case 'action': return matchesKeyAction(keymap, data, match.action)
    case 'key': return matchesKeyId(data, match.key)
    case 'digit': return data.length === 1 && data >= '1' && data <= '9'
    case 'text': return (match.space || data !== ' ') && startsText(data)
    case 'backspace': return data === '\x7f' || data === '\b'
    case 'any': return true
  }
}

function contextualKeyHints(state: FocusState, options: RuntimeCompilerOptions, controls: readonly ControlDescriptor[], active: ControlDescriptor | undefined, mode: CompilerMode, escapeLabel: EscapeLabel | undefined, limit: number): ContextKeyHint[] {
  const merged = new Map<string, ContextKeyHint>()
  const withoutControls = active === undefined && options.contextHints?.focusWithoutControls !== true
  if (options.contextHints?.suppressAuto !== true && !withoutControls) {
    for (const hint of grammarHints(keyGrammar(grammarStateFor(state, options, controls, active, mode, escapeLabel)))) {
      // Literal key words (the "Type" of type-to-filter) are prose; key names are not translated.
      const keys = hint.keys === 'Type' ? coreText(options, 'Type') : hint.keys ?? hintNotation(hint.actions!.flatMap(actionId => keyActionKeys(options.keymap, actionId).slice(0, 1)))
      merged.set(hint.id, { id: hint.id, keys, label: hint.label, compact: hint.compact ?? keys, priority: hint.priority })
    }
  }
  let extra: readonly { readonly id: string, readonly keys: string, readonly label?: string, readonly compact?: string, readonly priority?: number }[] = []
  try { extra = options.contextHints?.extra?.() ?? [] } catch { /* official hint providers cannot break their panel */ }
  for (const hint of extra) {
    if (hint.id.length === 0 || hint.keys.length === 0) continue
    merged.set(hint.id, {
      id: hint.id,
      keys: hint.keys,
      label: hint.label,
      compact: hint.compact ?? hint.keys,
      priority: hint.priority ?? 75,
    })
  }
  const indexed = [...merged.values()].map((hint, index) => ({ hint, index }))
  const admitted = new Set(indexed
    .toSorted((left, right) => right.hint.priority - left.hint.priority || left.index - right.index)
    .slice(0, limit)
    .map(entry => entry.hint.id))
  // The kit's order (spec §3.2): navigation, adjustment, the digit range, the primary operation, accelerators, the
  // filter and clear, tabs, group moves, and Esc last, so the row reads "what I can do … how I leave".
  const displayOrder = (id: string): number => HINT_ORDER[id] ?? (id.startsWith('keyed:') ? HINT_ORDER.keyed! : HINT_ORDER.other!)
  return indexed
    .filter(entry => admitted.has(entry.hint.id))
    .toSorted((left, right) => displayOrder(left.hint.id) - displayOrder(right.hint.id) || left.index - right.index)
    .map(entry => entry.hint)
}

/** Where each hint fragment sits in the row, by hint id (the kit's `order`). */
const HINT_ORDER: Readonly<Record<string, number>> = {
  navigate: 10, adjust: 20, branch: 20, toggle: 20, numbered: 30, activate: 40, confirm: 45, keyed: 50, reset: 50,
  expand: 50, other: 55, search: 60, clear: 60, newline: 60, tabs: 70, group: 80, escape: 90, dismiss: 90,
}

/** Hint fragments admitted at a width: three on narrow terminals, four from 80 columns. */
function hintLimit(width: number): number {
  return width >= 80 ? 4 : 3
}

function contextKeyHintRows(state: FocusState, options: RuntimeCompilerOptions, width: number, mode: CompilerMode, escapeLabel: EscapeLabel | undefined): string[] {
  if (!state.focused) return []
  const controls = reconcile(state)
  const parts = contextualKeyHints(state, options, controls, controls[state.lastIndex], mode, escapeLabel, hintLimit(width))
  if (parts.length === 0) return []
  const translate = (key: string): string => {
    try { return options.contextHints?.translate?.(key) ?? key } catch { return key }
  }
  const candidates: HintPart[][] = []
  for (let count = parts.length; count > 0; count -= 1) {
    const retained = new Set(parts
      .map((part, index) => ({ part, index }))
      .toSorted((left, right) => right.part.priority - left.part.priority || left.index - right.index)
      .slice(0, count)
      .map(entry => entry.part.id))
    const candidate = parts.filter(part => retained.has(part.id))
    candidates.push(
      candidate.map(part => part.label === undefined ? { keys: part.keys } : { keys: part.keys, label: translate(part.label) }),
      candidate.map(part => ({ keys: part.compact })),
    )
  }
  const safeWidth = Math.max(1, Math.floor(width))
  // The painted row is a pure function of the translated candidates, the width, and the palette, so an unchanged hint
  // answers from the surface's memo while the parts themselves are still read fresh on every paint.
  const key = `${String(safeWidth)}\0${candidates.map(candidate => candidate.map(part => `${part.keys}\x03${part.label ?? ''}`).join('\x01')).join('\x02')}`
  const memo = options.listRuntime.hintMemo
  if (memo !== undefined && memo.colors === options.colors && memo.key === key) return memo.rows
  let rows: string[] = []
  for (const candidate of candidates) {
    const row = renderHintRow(candidate, options.colors)
    countWork(options.counters, 'stringsMeasured')
    if (visibleWidth(row) <= safeWidth) { rows = [row]; break }
  }
  countWork(options.counters, 'rowsPainted', rows.length)
  options.listRuntime.hintMemo = { colors: options.colors, key, rows }
  return rows
}

function contextKeyHintComponent(state: FocusState, options: RuntimeCompilerOptions, mode: CompilerMode, escapeLabel: EscapeLabel | undefined, open?: () => boolean): Component {
  return staticComponent(width => open?.() === false ? [] : contextKeyHintRows(state, options, width, mode, escapeLabel), options, false)
}

/** Printable text or the opening of a bracketed paste. */
function startsText(data: string): boolean {
  return data.includes('\x1b[200~') || /^[^\x00-\x1f\x7f-\x9f]+$/u.test(data)
}

interface TextEditorLease {
  readonly editor: MayflyEditor
  onChange: MayflyEditor['onChange']
  onSubmit: MayflyEditor['onSubmit']
}

function detachTextEditorCallbacks(lease: TextEditorLease): void {
  if (lease.onChange !== undefined && lease.editor.onChange === lease.onChange) lease.editor.onChange = undefined
  if (lease.onSubmit !== undefined && lease.editor.onSubmit === lease.onSubmit) lease.editor.onSubmit = undefined
  lease.onChange = undefined
  lease.onSubmit = undefined
}

function releaseTextEditor(lease: TextEditorLease): void {
  lease.editor.focused = false
  detachTextEditorCallbacks(lease)
  lease.editor.setText('')
}

function listRowLimit(options: RuntimeCompilerOptions): number {
  return options.listRuntime.listRowLimit(safeViewport(options.getViewport).rows)
}

/**
 * One control-tree walk: the visible descriptors, the same walk with the
 * conditionally hidden stack branches appended, and the hidden-action
 * accelerators of the visible branches. The `all` set feeds order-free
 * membership checks only (reconcile's key pruning and hidden-desired
 * checks), so appending — not interleaving — the hidden entries keeps every
 * visible index identical to the visible-only walk.
 */
interface ControlWalk {
  readonly visible: ControlDescriptor[]
  readonly all: ControlDescriptor[]
  readonly accelerators: HiddenAccelerator[]
}

const EMPTY_CONTROL_WALK: ControlWalk = { visible: [], all: [], accelerators: [] }

function walkControls(node: CompilableNode, options: RuntimeCompilerOptions, path = '$'): ControlWalk {
  const visible: ControlDescriptor[] = []
  const hidden: ControlDescriptor[] = []
  const accelerators: HiddenAccelerator[] = []
  const visit = (current: CompilableNode, currentPath: string, isHidden: boolean): void => {
    const pagePath = options.listRuntime.pagePath(current)
    const scopedControlKey = (kind: string, id: string, itemId?: string) => controlKey(kind, id, itemId, pagePath)
    const scopedControlGroup = (kind: string, id: string) => controlGroup(kind, id, pagePath)
    const scopedFocusIdentity = (id: string, itemId?: string) => focusIdentity(id, itemId, pagePath)
    const controls = isHidden ? hidden : visible
    if (current.kind !== 'editor-control' && isDeferredUiNode(current as MayflyUiNode)) {
      const admitted = materializeDeferredUiNode(current as MayflyUiNode)
      if (admitted?.ok === true) { options.listRuntime.admitDeferred(admitted.value, pagePath); visit(admitted.value, currentPath, isHidden) }
      return
    }
    switch (current.kind) {
      case 'editor-control':
        controls.push({ kind: 'editor', key: scopedControlKey('editor', 'editor-control'), renderKey: 'editor-control', identity: scopedFocusIdentity('editor-control'), preferred: true, group: scopedControlGroup('editor', 'editor-control'), navigation: 'none' })
        break
      case 'stack':
        for (const [index, child] of current.children.entries()) {
          const shown = conditionMatches(child.when, safeViewport(options.getViewport)) && tabVisible(child, pagePath, options)
          if (shown) {
            visit(child.node, `${currentPath}.${String(index)}`, isHidden)
            continue
          }
          // Hidden branches feed only the `all` set. A materialized
          // responsive subtree is read as-is; activating it here would
          // eagerly admit hidden-tab state.
          const admitted = materializedDeferredUiNode(child.node as MayflyUiNode)
          if (admitted?.ok === true) visit(admitted.value, `${currentPath}.${String(index)}`, true)
          else if (!isDeferredUiNode(child.node as MayflyUiNode)) visit(child.node, `${currentPath}.${String(index)}`, true)
        }
        break
      case 'surface':
        visit(current.child, `${currentPath}.child`, isHidden)
        if (current.footer !== undefined) visit(current.footer, `${currentPath}.footer`, isHidden)
        break
      case 'scroll': {
        const before = controls.length
        visit(current.child, `${currentPath}.scroll`, isHidden)
        if (controls.length === before && (options.screenMode === 'alternate' || options.listRuntime.interaction !== undefined)) {
          const key = scopedControlKey('scroll', currentPath)
          controls.push({ kind: 'scroll', key, renderKey: currentPath, identity: scopedFocusIdentity(key), preferred: true, group: scopedControlGroup('scroll', currentPath), navigation: 'none', ...(current.id === undefined ? {} : { scopeId: current.id }) })
        }
        break
      }
      case 'tabs':
        for (const item of current.items) if (item.disabled !== true) controls.push({ kind: 'event', role: 'tab', activation: 'enter', key: scopedControlKey('tabs', current.id, item.id), renderKey: item.id, identity: scopedFocusIdentity(current.id, item.id), preferred: item.id === (options.listRuntime.activeTab({ pagePath, controlId: current.id }) ?? current.activeId), group: scopedControlGroup('tabs', current.id), navigation: 'horizontal', event: { kind: 'tab-change', pagePath, controlId: current.id, tabId: item.id } })
        break
      case 'list': {
        const window = options.listRuntime.listWindow(current, listRowLimit(options))
        if (window.length === 0) controls.push({ kind: 'list', node: current, key: scopedControlKey('empty-list', current.id), renderKey: current.id, identity: scopedFocusIdentity(current.id), preferred: true, group: scopedControlGroup('list', current.id), navigation: 'none' })
        for (const { item, index } of window) if (item.disabled !== true) {
          const selected = options.listRuntime.interaction?.choice({ pagePath, controlId: current.id })?.selectedIds ?? current.selectedIds
          const selectedIds = current.mode === 'multiple'
            ? selected.includes(item.id) ? selected.filter(id => id !== item.id) : [...selected, item.id]
            : [item.id]
          controls.push({
            kind: 'event',
            role: current.mode === 'multiple' ? 'list-multiple' : 'list-single',
            activation: current.mode === 'multiple' ? 'space' : 'enter',
            key: scopedControlKey('list', current.id, item.id),
            renderKey: item.id,
            identity: scopedFocusIdentity(current.id, item.id),
            preferred: options.listRuntime.interaction?.choice({ pagePath, controlId: current.id })?.focusedId === item.id,
            group: scopedControlGroup('list', current.id),
            navigation: 'vertical',
            event: { kind: current.mode === 'multiple' ? 'selection-toggle' : 'selection-accept', pagePath, controlId: current.id, selectedIds },
            listEntry: { node: current, index },
            ...(current.mode === 'multiple' ? { commitEvent: { kind: 'selection-accept', pagePath, controlId: current.id, selectedIds: selected } as MayflyUiEvent } : {}),
          })
        }
        if (current.items.length === 0 && current.empty !== undefined) visit(current.empty, `${currentPath}.empty`, isHidden)
        break
      }
      case 'form':
        for (const field of current.fields) if (field.disabled !== true) {
          const base: ControlBase = { key: scopedControlKey('form-field', current.id, field.id), renderKey: field.id, identity: scopedFocusIdentity(field.id), preferred: false, group: scopedControlGroup('form', current.id), navigation: 'vertical' }
          if (field.kind === 'toggle') controls.push({ ...base, kind: 'toggle', field })
          else if (field.kind === 'select' || field.kind === 'multiselect') controls.push({ ...base, kind: 'select', field })
          else controls.push({ ...base, kind: 'text', field, form: current })
          const address = { pagePath, formId: current.id, fieldId: field.id }
          for (const action of fieldActions(options.listRuntime.interaction?.form(address), field.id)) controls.push({
            ...base, kind: 'field-action', key: scopedControlKey('field-action', current.id, `${field.id}/${action.id}`),
            renderKey: `${field.id}/${action.id}`, identity: scopedFocusIdentity(field.id, action.id), address, action,
          })
        }
        if (current.submitActionId !== undefined) controls.push({ kind: 'submit', key: scopedControlKey('form-submit', current.id), renderKey: 'submit', identity: scopedFocusIdentity(current.submitActionId), preferred: false, group: scopedControlGroup('form', current.id), navigation: 'vertical', form: current })
        if (current.cancelActionId !== undefined) controls.push({ kind: 'event', role: 'cancel', activation: 'both', key: scopedControlKey('form-cancel', current.id), renderKey: 'cancel', identity: scopedFocusIdentity(current.cancelActionId), preferred: false, group: scopedControlGroup('form', current.id), navigation: 'vertical', event: { kind: 'activate', pagePath, controlId: current.cancelActionId, actionId: current.cancelActionId } })
        break
      case 'actions': {
        const scope = current.scope === undefined ? {} : { scope: [current.scope].flat() }
        for (const item of current.items.map(entry => effectiveActionItem(entry, options))) {
          const keyed = item.key === undefined && item.semantic === undefined && item.action === undefined ? undefined : { item, label: actionHintLabel(item), ...scope }
          if (item.hidden === true) {
            // Hidden branches contribute no accelerators, matching the old
            // visible-only accelerators walk.
            if (isHidden !== true && item.disabled !== true && item.busy !== true && keyed !== undefined) accelerators.push({ ...keyed, event: { kind: 'activate', pagePath, controlId: item.id, actionId: item.id } })
            continue
          }
          if (item.disabled !== true && item.busy !== true) controls.push({ kind: 'event', role: 'action', activation: 'both', key: scopedControlKey('action', current.id, item.id), renderKey: item.id, identity: scopedFocusIdentity(item.id), preferred: item.defaultFocus === true, group: actionGroup(current, pagePath), navigation: 'horizontal', event: { kind: 'activate', pagePath, controlId: item.id, actionId: item.id }, ...(keyed === undefined ? {} : { keyed }) })
        }
        break
      }
      case 'loader':
        if (current.cancelActionId !== undefined) controls.push({ kind: 'event', role: 'cancel', activation: 'both', key: scopedControlKey('loader-cancel', current.cancelActionId), renderKey: 'cancel', identity: scopedFocusIdentity(current.cancelActionId), preferred: false, group: scopedControlGroup('loader', current.cancelActionId!), navigation: 'none', work: true, event: { kind: 'activate', pagePath, controlId: current.cancelActionId, actionId: current.cancelActionId } })
        break
      case 'empty': if (current.actions !== undefined) visit(current.actions, `${currentPath}.actions`, isHidden); break
      default: break
    }
  }
  visit(node, path, false)
  return { visible, all: visible.concat(hidden), accelerators }
}

function containsDeferredNode(node: CompilableNode): boolean {
  if (node.kind !== 'editor-control' && isDeferredUiNode(node as MayflyUiNode)) {
    const admitted = materializedDeferredUiNode(node as MayflyUiNode)
    if (admitted === undefined) return deferredUiNodeMayHaveControls(node as MayflyUiNode)
    return admitted.ok && containsDeferredNode(admitted.value)
  }
  if (node.kind === 'stack') return node.children.some(child => containsDeferredNode(child.node))
  if (node.kind === 'surface') return containsDeferredNode(node.child) || (node.footer !== undefined && containsDeferredNode(node.footer))
  if (node.kind === 'scroll') return containsDeferredNode(node.child)
  if (node.kind === 'list') return node.empty !== undefined && containsDeferredNode(node.empty)
  return false
}

function deferredComponent(node: MayflyUiNode, state: FocusState, options: RuntimeCompilerOptions, path: string, mode: CompilerMode): MayflyComponent {
  let component: Component | undefined
  const current = (): Component => {
    if (component !== undefined) return component
    const admitted = materializeDeferredUiNode(node)!
    if (admitted?.ok === true) {
      options.listRuntime.admitDeferred(admitted.value, options.listRuntime.pagePath(node))
      component = compileNode(admitted.value, state, options, path, mode)
    } else component = new ErrorComponent(admitted.message, options.colors)
    return component
  }
  return {
    render: width => current().render(width),
    invalidate: () => component?.invalidate?.(),
  }
}

/** Node kinds that paint only from their admitted node, the width, the colors, and the components. */
const REUSABLE_KINDS: ReadonlySet<string> = new Set(['text', 'fields', 'code', 'diff', 'sections', 'rich-text', 'divider'])

/** Compiles a reusable leaf and remembers it for the next publish. */
function leaf(node: CompilableNode, options: RuntimeCompilerOptions, build: (paint: PaintOptions) => MayflyComponent): MayflyComponent {
  return options.reuse.keep(node, options, build)
}

function compileNode(node: CompilableNode, state: FocusState, options: RuntimeCompilerOptions, path = '$', mode: CompilerMode = 'ui', contextHint?: Component): Component {
  const pagePath = options.listRuntime.pagePath(node)
  const scopedControlKey = (kind: string, id: string, itemId?: string) => controlKey(kind, id, itemId, pagePath)
  const scopedControlGroup = (kind: string, id: string) => controlGroup(kind, id, pagePath)
  if (node.kind !== 'editor-control' && isDeferredUiNode(node as MayflyUiNode)) return deferredComponent(node as MayflyUiNode, state, options, path, mode)
  if (REUSABLE_KINDS.has(node.kind)) {
    const reused = options.reuse.take(node, options)
    if (reused !== undefined) return reused
  }
  countWork(options.counters, 'unitsCompiled')
  switch (node.kind) {
    case 'editor-control': {
      const editor = options.editor
      if (editor === undefined) throw new Error('editor-control requires a host editor')
      const component: MayflyComponent = {
        render: width => {
          try {
            editor.focused = state.focused && state.activeKey === scopedControlKey('editor', 'editor-control')
            return editor.render(Math.max(1, width))
          } catch (error) {
            const message = renderFailure(error, 'unknown editor failure')
            options.reportRuntimeFailure(message)
            return errorRows(message, width, options.colors)
          }
        },
        invalidate: () => editor.invalidate(),
      }
      state.bindControls([scopedControlKey('editor', 'editor-control')], { component, axis: 'none' })
      return component
    }
    case 'text': return leaf(node, options, paint => pureStaticComponent(width => renderCanonicalView(
        node,
        width,
        paint.components,
        paint.colors,
      ), paint))
    case 'markdown': return markdownLeafComponent(node, options)
    case 'fields':
    case 'code':
    case 'diff':
    case 'sections': return leaf(node, options, paint => pureStaticComponent(width => renderCanonicalView(
      node as MayflySectionContentNode,
      width,
      paint.components,
      paint.colors,
    ), paint))
    case 'rich-text': return hasMotion(node.spans) ? staticComponent(width => {
      // An animated row is the one row a clock tick repaints: it is not memoized, and it joins the clock while painted.
      countWork(options.counters, 'stringsMeasured')
      const presentation = options.components.presentation
      const line = paintMotionSpans(node.spans, options.colors, motionFrame(options), { glyphs: presentation?.glyphs, reducedMotion: presentation?.reducedMotion })
      return node.overflow === 'truncate' ? [truncatedRow(line, width, options.components)] : options.components.wrapText(line, Math.max(1, width))
    }, options) : leaf(node, options, paint => pureStaticComponent(width => {
      countWork(paint.counters, 'stringsMeasured')
      return node.overflow === 'truncate'
        ? [truncatedRow(joinSpans(node, paint.colors), width, paint.components)]
        : paint.components.wrapText(joinSpans(node, paint.colors), Math.max(1, width))
    }, paint))
    case 'stack': {
      // A row whose children carry a priority admits them while they fit, one row of the children's first rows.
      if (node.direction === 'row' && node.children.some(child => child.priority !== undefined)) {
        const compiled = node.children.map((child, index) => compileNode(child.node, state, options, `${path}.${String(index)}`, mode))
        return new AdmissionRow({
          components: options.components,
          ...(node.gap === undefined ? {} : { gap: node.gap }),
          children: () => node.children.flatMap((child, index) => conditionMatches(child.when, safeViewport(options.getViewport)) && tabVisible(child, pagePath, options)
            ? [{ component: compiled[index]!, band: child.band ?? 'left', ...(child.priority === undefined ? {} : { priority: child.priority }), ...(child.overflow === undefined ? {} : { overflow: child.overflow }) }]
            : []),
        })
      }
      const stackOptions = {
        ...(node.gap === undefined ? {} : { gap: node.gap }),
        ...(node.align === undefined ? {} : { align: node.align }),
      }
      const spatial = mode === 'status' || options.screenMode === 'alternate' || options.listRuntime.interaction !== undefined
      const stack = !spatial || node.direction === 'column'
        ? new VStack([], stackOptions)
        : new HStack([], stackOptions)
      for (const [index, child] of node.children.entries()) {
        const compiled = compileNode(child.node, state, options, `${path}.${String(index)}`, mode)
        const layout = !spatial
          ? { visible: () => conditionMatches(child.when, safeViewport(options.getViewport)) && tabVisible(child, pagePath, options) }
          : {
              ...(child.basis === undefined || child.basis === 'auto' ? (child.basis === 'auto' ? { basis: 'auto' as const } : {}) : { basis: Math.min(child.basis, LAYOUT_VALUE_MAX) }),
              ...(child.grow === undefined ? {} : { grow: Math.min(child.grow, LAYOUT_VALUE_MAX) }),
              ...(child.shrink === undefined ? {} : { shrink: Math.min(child.shrink, LAYOUT_VALUE_MAX) }),
              ...(child.minSize === undefined ? {} : { minSize: Math.min(child.minSize, LAYOUT_VALUE_MAX) }),
              ...(child.maxSize === undefined ? {} : { maxSize: Math.min(child.maxSize, LAYOUT_VALUE_MAX) }),
              visible: (viewport: LayoutViewport) => {
                const current = state.layoutPass
                  ? { columns: viewport.width, rows: viewport.height }
                  : safeViewport(options.getViewport)
                // Siblings laid out at the same viewport share one focus
                // reconciliation per pass instead of one per child.
                if (state.layoutPass && !sameViewport(state.layoutReconciled, current)) {
                  state.setLayoutViewport(current)
                  reconcile(state)
                  state.layoutReconciled = current
                }
                return conditionMatches(child.when, current) && tabVisible(child, pagePath, options)
              },
            }
        stack.addChild(compiled, layout)
      }
      return stack
    }
    case 'surface': return surfaceComponent(node, compileNode(node.child, state, options, `${path}.child`, mode), node.footer === undefined ? undefined : compileNode(node.footer, state, options, `${path}.footer`, mode), contextHint, options)
    case 'scroll': {
      const childPath = `${path}.scroll`
      if (options.screenMode === 'main' && options.listRuntime.interaction === undefined) {
        return compileNode(node.child, state, options, childPath, mode)
      }
      const child = compileNode(node.child, state, options, childPath, mode)
      if (node.height !== undefined || node.expandedHeight !== undefined || node.fit === true || node.pill === true) {
        // A declared viewport: the region paints its own rows, with its scrollbar, `fit`, and pill.
        const key = scopedControlKey('scroll', path)
        const model = options.listRuntime.interaction
        const address = node.id === undefined || model === undefined ? undefined : { pagePath, controlId: node.id }
        const region = new ScrollRegion({
          child: child as Component,
          memory: options.listRuntime.scrollMemory(key),
          height: node.height ?? SCROLL_DEFAULT_HEIGHT,
          expandedHeight: node.expandedHeight ?? SCROLL_DEFAULT_EXPANDED_HEIGHT,
          fit: node.fit === true,
          pill: node.pill === true,
          follow: node.follow === 'end',
          scrollbar: node.scrollbar !== false,
          expanded: () => state.expandedKey === key,
          colors: options.colors,
          components: options.components,
          pillText: count => coreText(options, '↓ {count} new · End', { count }),
          anchors: address === undefined || model!.document(address) === undefined ? undefined : {
            state: () => model!.document(address),
            rowOf: documentAnchorRow,
            anchorAt: documentAnchorAtRow,
            move: anchor => { model!.moveDocument(address, anchor) },
          },
        })
        state.bindControls([key], { component: region, axis: 'none' })
        state.bindScroll(key, region)
        return region
      }
      const scrollOptions = { follow: node.follow === 'end' ? 'end' as const : 'none' as const, primary: false, overscroll: 'contain' as const, scrollbar: node.scrollbar === true ? 'auto' as const : 'hidden' as const }
      const address = node.id === undefined ? undefined : { pagePath, controlId: node.id }
      const model = options.listRuntime.interaction
      const scroll = address === undefined || model === undefined || model.document(address) === undefined
        ? new ScrollView(child, scrollOptions)
        : new SemanticScrollView(child as Component, scrollOptions, model, address)
      const key = scopedControlKey('scroll', path)
      state.bindControls([key], { component: scroll, axis: 'none' })
      state.bindScroll(key, scroll)
      return scroll
    }
    case 'tabs': {
      const component = staticComponent(width => {
        const completed = options.listRuntime.interaction?.completedSteps({ pagePath, controlId: node.id }) ?? []
        return renderTabs({ ...node, activeId: options.listRuntime.activeTab({ pagePath, controlId: node.id }) ?? node.activeId }, width, patternFocus(state, scopedControlGroup('tabs', node.id)), options.colors, completed)
      }, options)
      state.bindControls(node.items.filter(item => item.disabled !== true).map(item => scopedControlKey('tabs', node.id, item.id)), { component, axis: 'horizontal' })
      return component
    }
    case 'list': {
      const empty = node.empty === undefined ? undefined : compileNode(node.empty, state, options, `${path}.empty`, mode)
      const { filter: _filter, ...unfiltered } = node
      let component!: MayflyComponent
      component = staticComponent(width => {
        const entries = options.listRuntime.listWindow(node, listRowLimit(options))
        const items = entries.map(entry => entry.item)
        const choice = options.listRuntime.interaction?.choice({ pagePath, controlId: node.id })
        state.bindControls(items.filter(item => item.disabled !== true).map(item => scopedControlKey('list', node.id, item.id)), { component, axis: 'vertical' })
        const query = choice?.query ?? node.filter ?? ''
        const queryRows = choice?.searching === true ? options.listRuntime.search(node).render(Math.max(1, width - 2), state.focused && state.activeGroup === scopedControlGroup('list', node.id)).map(row => sliceByColumn(`/ ${row}`, 0, width, true)) : []
        const visibleCount = choice === undefined ? node.items.length : choiceVisibleCount(choice)
        const position = choice === undefined ? 0 : choiceVisiblePosition(choice)
        const counter = visibleCount > entries.length ? `  (${String(position + 1)}/${String(visibleCount)})` : undefined
        const focus = patternFocus(state, scopedControlGroup('list', node.id))
        const body = entries.length === 0 ? query.length > 0 ? [sliceByColumn(options.colors.textMuted(coreText(options, 'No matches')), 0, width, true)] : empty?.render(width) ?? [] : renderList(
          { ...unfiltered, items, selectedIds: options.listRuntime.interaction?.choice({ pagePath, controlId: node.id })?.selectedIds ?? node.selectedIds },
          width,
          Math.max(1, listRowLimit(options) - (counter === undefined ? 0 : 1)),
          focus,
          options.colors,
          entries[0]!.position,
          { cache: options.listRuntime.rows, counters: options.counters },
        )
        const focusedItem = focus.focused && focus.key !== '' ? entries.find(entry => entry.item.id === focus.key)?.item : undefined
        const segment = focusedItem?.segment
        const segmentRows = segment === undefined ? [] : [renderListSegment(segment, choice === undefined ? segment.selectedId : choiceSegment(choice, focusedItem!.id), width, options.colors)]
        return [...(queryRows.length > 0 ? queryRows : query.length > 0 ? [sliceByColumn(`/ ${query}`, 0, width, true)] : []), ...(counter === undefined ? [] : [sliceByColumn(options.colors.textMuted(counter), 0, width, true)]), ...body, ...segmentRows]
      }, options, false)
      const initial = options.listRuntime.listWindow(node, listRowLimit(options))
      if (initial.length === 0) state.bindControls([scopedControlKey('empty-list', node.id)], { component, axis: 'none' })
      state.bindControls(initial.filter(entry => entry.item.disabled !== true).map(entry => scopedControlKey('list', node.id, entry.item.id)), { component, axis: 'vertical' })
      return component
    }
    case 'form': {
      const stack = new VStack()
      for (const field of node.fields) {
        const key = scopedControlKey('form-field', node.id, field.id)
        const component = field.kind === 'input' || field.kind === 'textarea' || field.kind === 'secret' || field.kind === 'number'
          ? editorFieldComponent(field, key, state, options)
          : staticComponent(width => {
            const address = options.listRuntime.fieldAddress(key)!
            const picker = options.listRuntime.interaction?.form(address)?.fields[field.id]?.picker
            const editing = picker === undefined ? {} : { editing: true as const, ...(picker.focusedId === undefined ? {} : { optionId: picker.focusedId }) }
            return renderFormField(state.field(field, key), width, { ...patternFocus(state, scopedControlGroup('form', node.id)), ...editing }, options.colors, key => coreText(options, key))
          }, options)
        stack.addChild(component)
        if (field.disabled !== true) state.bindControls([key], { component, axis: 'none' })
        const address = { pagePath, formId: node.id, fieldId: field.id }
        const actions = fieldActions(options.listRuntime.interaction?.form(address), field.id)
        if (actions.length > 0) {
          const tools = staticComponent(width => {
            const current = fieldActions(options.listRuntime.interaction?.form(address), field.id)
            state.bindControls(current.map(action => scopedControlKey('field-action', node.id, `${field.id}/${action.id}`)), { component: tools, axis: 'horizontal' })
            return renderActions({ kind: 'actions', id: field.id, items: current.map(action => ({ id: `${field.id}/${action.id}`, label: options.contextHints?.translate?.(action.label) ?? action.label })) }, width, patternFocus(state, scopedControlGroup('form', node.id)), options.colors, false)
          }, options)
          stack.addChild(tools)
          state.bindControls(actions.map(action => scopedControlKey('field-action', node.id, `${field.id}/${action.id}`)), { component: tools, axis: 'horizontal' })
        }
      }
      if (node.submitActionId !== undefined) {
        const component = staticComponent(width => renderActions({ kind: 'actions', id: node.id, items: [{ id: 'submit', label: node.submitLabel ?? coreText(options, 'Submit'), intent: 'primary' }] }, width, patternFocus(state, scopedControlGroup('form', node.id)), options.colors, true), options)
        stack.addChild(component)
        state.bindControls([scopedControlKey('form-submit', node.id)], { component, axis: 'none' })
      }
      if (node.cancelActionId !== undefined) {
        const component = staticComponent(width => renderActions({ kind: 'actions', id: node.id, items: [{ id: 'cancel', label: node.cancelLabel ?? coreText(options, 'Cancel') }] }, width, patternFocus(state, scopedControlGroup('form', node.id)), options.colors, true), options)
        stack.addChild(component)
        state.bindControls([scopedControlKey('form-cancel', node.id)], { component, axis: 'none' })
      }
      return stack
    }
    case 'actions': {
      const vertical = options.screenMode === 'main'
      /* An action with a handled invoke in flight renders as busy until the
         reply lands, matching the disabled-side effect at control level. */
      /* Busy and row-unavailable states follow the live model, so they are read per frame. */
      // The runtime has now seen these component actions, so the keymap can offer them for rebinding.
      options.keymap?.see?.(node.items.flatMap(item => item.action === undefined ? [] : [{ id: item.action, label: item.label, keys: item.key === undefined ? [] : [item.key] }]))
      const items = () => node.items.map(entry => {
        const item = withEffectiveKey(effectiveActionItem(entry, options), options)
        return item.busy === true || options.listRuntime.interaction?.actionPending({ pagePath, controlId: item.id }) === true ? { ...item, busy: true as const } : item
      }).filter(item => item.hidden !== true)
      const bind = (current: readonly MayflyActionItem[]): void => {
        state.bindControls(current.filter(item => item.disabled !== true && item.busy !== true).map(item => scopedControlKey('action', node.id, item.id)), { component, axis: vertical ? 'vertical' : 'horizontal' })
      }
      const component: MayflyComponent = staticComponent(width => {
        const current = items()
        bind(current)
        return renderActions({ ...node, items: current }, width, patternFocus(state, actionGroup(node, pagePath)), options.colors, vertical)
      }, options)
      bind(items())
      return component
    }
    case 'loader': {
      const stack = new VStack()
      // Reduced motion freezes the channel on its first frame and never joins the clock.
      const presentation = options.components.presentation
      stack.addChild(staticComponent(width => renderLoader(node, width, options.colors, motionFrame(options), presentation?.glyphs, presentation?.reducedMotion === true), options))
      const cancelActionId = node.cancelActionId
      if (cancelActionId !== undefined) {
        // The cancel is a hint, not a button: Escape fires it (`cancel-work`), and the row only says so.
        const component = staticComponent(width => [sliceByColumn(`  ${options.colors.muted(`Esc ${(node.cancelLabel ?? coreText(options, 'Cancel')).toLowerCase()}`)}`, 0, width, true)], options)
        stack.addChild(component)
        state.bindControls([scopedControlKey('loader-cancel', cancelActionId)], { component, axis: 'none' })
      }
      return stack
    }
    case 'empty': {
      const stack = new VStack()
      stack.addChild(staticComponent(width => renderEmpty(node, width, options.colors), options))
      if (node.actions !== undefined) stack.addChild(compileNode(node.actions, state, options, `${path}.actions`, mode))
      return stack
    }
    case 'progress': return node.transition === undefined
      ? staticComponent(width => renderProgress(node, width, options.colors), options)
      : staticComponent(width => renderProgress(node, width, options.colors, options.listRuntime.progressValue(`${JSON.stringify(pagePath)}${path}`, node as typeof node & { readonly transition: NonNullable<typeof node.transition> }, options.components.presentation?.reducedMotion === true)), options)
    case 'spacer': return staticComponent(() => Array.from({ length: node.size ?? 1 }, () => ''), options)
    case 'divider': return leaf(node, options, paint => pureStaticComponent(width => renderDivider(node.label, width, paint.colors), paint))
    case 'diagram': return diagramComponent(node, options)
    case 'chart': return chartComponent(node, options)
    case 'image': return imageComponent(node, options)
  }
}

function reconcile(state: FocusState): readonly ControlDescriptor[] {
  const controls = state.controls()
  const groups = controlGroups(controls)
  const tabGroups = groups.filter(group => group.kind === 'tabs')
  state.blurInactiveEditors(controls)
  const allControls = state.allControls()
  const allKeys = new Set(allControls.map(control => control.key))
  for (const [group, key] of state.groupActiveKeys) {
    if (!allControls.some(control => control.group === group && control.key === key)) state.groupActiveKeys.delete(group)
  }
  if (state.editingKey !== undefined && !allKeys.has(state.editingKey)) state.setEditing(undefined)
  if (state.desiredKey !== undefined && !allControls.some(control => control.key === state.desiredKey)) {
    state.desiredKey = undefined
    state.desiredGroup = undefined
  }
  if (controls.length === 0) {
    if (state.desiredKey === undefined) {
      state.activeKey = undefined
      state.activeGroup = undefined
    }
    state.lastIndex = 0
    state.lastTabGroupIndex = 0
    for (const scroll of state.scrollViews.values()) scroll.setScrollbarActive(false)
    return controls
  }
  state.lastTabGroupIndex = Math.min(state.lastTabGroupIndex, Math.max(0, tabGroups.length - 1))
  const syncScrollFocus = (): void => {
    for (const [key, scroll] of state.scrollViews) scroll.setScrollbarActive(state.focused && key === state.activeKey)
  }
  const rememberTabGroup = (control: ControlDescriptor): void => {
    const index = tabGroups.findIndex(group => group.id === control.group)
    if (index >= 0) state.lastTabGroupIndex = index
  }
  const desired = controls.findIndex(control => control.key === state.desiredKey)
  if (desired >= 0) {
    state.lastIndex = desired
    state.activeKey = controls[desired]!.key
    state.activeGroup = controls[desired]!.group
    state.groupActiveKeys.set(controls[desired]!.group, controls[desired]!.key)
    rememberTabGroup(controls[desired]!)
    syncScrollFocus()
    return controls
  }
  const desiredHidden = state.desiredKey !== undefined && allControls.some(control => control.key === state.desiredKey)
  const current = controls.findIndex(control => control.key === state.activeKey)
  if (current >= 0) {
    state.lastIndex = current
    state.activeGroup = controls[current]!.group
    if (state.desiredKey === undefined) {
      state.desiredKey = controls[current]!.key
      state.desiredGroup = controls[current]!.group
    }
    if (!desiredHidden) state.groupActiveKeys.set(controls[current]!.group, controls[current]!.key)
    rememberTabGroup(controls[current]!)
    syncScrollFocus()
    return controls
  }
  const groupIds = groups.map(group => group.id)
  const requestedGroup = desiredHidden ? state.desiredGroup : state.activeGroup
  const declaredDefault = controls.find(control => control.kind === 'event' && control.role === 'action' && control.preferred)
  const fallbackGroup = requestedGroup !== undefined && groupIds.includes(requestedGroup)
    ? requestedGroup
    : declaredDefault?.group ?? groupIds[0]!
  state.lastIndex = groupTarget(controls, fallbackGroup, state.groupActiveKeys.get(fallbackGroup))
  state.activeKey = controls[state.lastIndex]!.key
  state.activeGroup = controls[state.lastIndex]!.group
  if (!desiredHidden) {
    state.desiredKey = state.activeKey
    state.desiredGroup = state.activeGroup
    state.groupActiveKeys.set(state.activeGroup, state.activeKey)
  }
  rememberTabGroup(controls[state.lastIndex]!)
  syncScrollFocus()
  return controls
}

type NavigationDirection = 'up' | 'down' | 'left' | 'right'

function intersectRect(rect: LayoutRect, clip: LayoutRect): LayoutRect | undefined {
  const x = Math.max(rect.x, clip.x)
  const y = Math.max(rect.y, clip.y)
  const right = Math.min(rect.x + rect.width, clip.x + clip.width)
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height)
  return right <= x || bottom <= y ? undefined : { x, y, width: right - x, height: bottom - y }
}

function layoutBoxes(root: LayoutBox): Map<Component, LayoutRect> {
  const boxes = new Map<Component, LayoutRect>()
  const visit = (box: LayoutBox): void => {
    const visible = intersectRect(box.rect, box.clip)
    if (visible !== undefined) boxes.set(box.component, visible)
    for (const child of box.children) visit(child)
  }
  visit(root)
  return boxes
}

function divideRect(rect: LayoutRect, axis: ControlBinding['axis'], index: number, count: number): LayoutRect {
  if (axis === 'horizontal' && count > 1) {
    const start = Math.floor(rect.width * index / count)
    const end = Math.floor(rect.width * (index + 1) / count)
    return { x: rect.x + start, y: rect.y, width: Math.max(1, end - start), height: rect.height }
  }
  if (axis === 'vertical' && count > 1) {
    const start = Math.floor(rect.height * index / count)
    const end = Math.floor(rect.height * (index + 1) / count)
    return { x: rect.x, y: rect.y + start, width: rect.width, height: Math.max(1, end - start) }
  }
  return rect
}

function nearestDirectionalControl(
  controls: readonly ControlDescriptor[],
  rectangles: ReadonlyMap<string, LayoutRect>,
  activeIndex: number,
  direction: NavigationDirection,
): number | undefined {
  const active = rectangles.get(controls[activeIndex]!.key)
  if (active === undefined) return undefined
  const activeCenterX = active.x + active.width / 2
  const activeCenterY = active.y + active.height / 2
  const candidates = controls.flatMap((control, index) => {
    if (index === activeIndex || (control.kind === 'event' && control.role === 'tab')) return []
    const rect = rectangles.get(control.key)
    if (rect === undefined) return []
    const centerX = rect.x + rect.width / 2
    const centerY = rect.y + rect.height / 2
    const eligible = direction === 'left' ? centerX < activeCenterX
      : direction === 'right' ? centerX > activeCenterX
        : direction === 'up' ? centerY < activeCenterY
          : centerY > activeCenterY
    if (!eligible) return []
    const horizontal = direction === 'left' || direction === 'right'
    const overlap = horizontal
      ? Math.min(active.y + active.height, rect.y + rect.height) > Math.max(active.y, rect.y)
      : Math.min(active.x + active.width, rect.x + rect.width) > Math.max(active.x, rect.x)
    const primary = horizontal ? Math.abs(centerX - activeCenterX) : Math.abs(centerY - activeCenterY)
    const secondary = horizontal ? Math.abs(centerY - activeCenterY) : Math.abs(centerX - activeCenterX)
    return [{ index, overlap, primary, secondary }]
  })
  return candidates
    .toSorted((left, right) => left.index - right.index)
    .toSorted((left, right) => left.secondary - right.secondary)
    .toSorted((left, right) => left.primary - right.primary)
    .toSorted((left, right) => Number(right.overlap) - Number(left.overlap))[0]?.index
}

/**
 * Renderer bindings shared by compiled projections of one surface. The
 * frontend model owns drafts and actions; this object owns only editor,
 * focus, geometry, and admission caches for the current renderer lifetime.
 */
export class MayflyUiSurfaceRuntime {
  /** The static leaves this surface compiled before; each publish of an unchanged subtree reuses them. */
  readonly reuse = new MayflyCompileCache()
  /** The item rows this surface's lists have painted, kept by item and state. */
  readonly rows = new UiRowCache()
  /** Where this surface's scroll regions are scrolled, by control key. */
  private readonly scrolled = new Map<string, ScrollMemory>()
  /** The one-shot drains of this surface's progress bars. */
  private readonly transitions = new UiProgressTransitions()
  /** The last key-hint row this surface painted, with what it was painted from. */
  hintMemo: { readonly colors: object, readonly key: string, readonly rows: string[] } | undefined
  private node: CompilableNode | undefined
  private options: RuntimeCompilerOptions | undefined
  private layoutViewport: ((viewport: MayflyUiViewport) => void) | undefined
  private generation = 0
  private live = true
  private readonly controls = new UiControlStore()
  private readonly fieldAddresses = new Map<string, MayflyFieldAddress>()
  private readonly nodePages = new WeakMap<object, MayflyPagePath>()
  private readonly tabDefinitions = new Map<string, Extract<MayflyUiNode, { readonly kind: 'tabs' }>>()
  private readonly searches = new Map<string, SearchInput>()
  private readonly textEditors = new Map<string, TextEditorLease>()
  private readonly fieldKinds = new Map<string, MayflyFormField['kind']>()
  private readonly fieldOwners = new Map<string, string>()
  private readonly fieldRecency = new Map<string, true>()
  private listRowBudget: number | undefined
  /**
   * One control walk per reconcile round (UX-34), keyed by everything the
   * walk reads: node and options identity, the surface generation, the
   * viewport, and the interaction revision covering choice, tab, focus, and
   * admission state. `handleInput` → `moveTo` → render re-reads all hit the
   * same walk instead of rewalking the tree.
   */
  private controlsWalkMemo: {
    readonly node: CompilableNode
    readonly options: RuntimeCompilerOptions
    readonly generation: number
    readonly columns: number
    readonly rows: number
    readonly revision: number
    readonly walk: ControlWalk
  } | undefined
  readonly state: FocusState
  private readonly loaderAnimation: UiLoaderAnimation | undefined

  constructor(readonly interaction?: UiSurfaceModel, private readonly requestRender?: () => void, clock?: UiAnimationClock, readonly images?: MayflyUiImageSource) {
    this.loaderAnimation = requestRender === undefined ? undefined : new UiLoaderAnimation(requestRender, clock)
    const fieldValue = (field: MayflyFormField, key: string): MayflyFieldValue => {
      const address = this.fieldAddresses.get(key)
      const draft = address === undefined ? undefined : this.interaction?.form(address)?.fields[address.fieldId]
      return draft === undefined ? field.value : draft.value
    }
    this.state = {
      activeKey: undefined,
      activeGroup: undefined,
      desiredKey: undefined,
      desiredGroup: undefined,
      editingKey: undefined,
      expandedKey: undefined,
      groupActiveKeys: new Map(),
      controlBindings: this.controls.bindings,
      scrollViews: this.controls.scrolls,
      lastTabGroupIndex: 0,
      lastIndex: 0,
      focused: false,
      layoutPass: false,
      layoutReconciled: undefined,
      controls: () => this.walkControlsCached().visible,
      allControls: () => this.walkControlsCached().all,
      accelerators: () => this.walkControlsCached().accelerators,
      emit: event => {
        if (!this.live) return
        try {
          if (this.interaction !== undefined) this.interaction.emit(event)
          else this.options?.emit(event)
        } catch { /* event failures are host-owned */ }
      },
      field: (field, key) => {
        const address = this.fieldAddresses.get(key)
        const form = address === undefined ? undefined : this.interaction?.form(address)
        const draft = address === undefined ? undefined : form?.fields[address.fieldId]
        const picker = draft?.picker
        const value = picker === undefined ? fieldValue(field, key) : field.kind === 'multiselect' ? picker.selectedIds : picker.selectedIds[0] ?? null
        const origin = draft?.change === 'reset' || (draft?.change ?? 'unchanged') === 'unchanged' && field.origin === 'inherited' ? 'Inherited' : 'Override'
        const text = (key: string, values?: UiTranslateValues) => coreText(this.options, key, values)
        const pickerError = picker === undefined ? undefined : choiceError(picker, text)
        return { ...field, value: field.kind === 'number' ? field.value : value,
          ...field.origin === undefined ? {} : { label: `${field.label} (${text(origin)})` },
          ...(draft?.error === undefined ? {} : { error: draft.error }),
          ...(draft?.conflict ? { error: text('Resolve the changed value before saving') } : {}),
          ...(pickerError === undefined ? {} : { error: pickerError }),
          ...(form?.pending === undefined ? {} : { disabled: true }),
        } as MayflyFormField
      },
      fieldValue,
      setValue: (key, value) => {
        const address = this.fieldAddresses.get(key)
        if (address !== undefined) this.interaction?.edit(address, value)
      },
      textEditor: (field, key) => this.textEditor(field, key),
      beginSelectEditing: (_field, key) => {
        this.state.setEditing(key)
        const address = this.fieldAddresses.get(key)
        if (address !== undefined) this.interaction?.updateForm(address, { kind: 'begin-picker', fieldId: address.fieldId })
      },
      finishSelectEditing: (field, key, cancel) => {
        const address = this.fieldAddresses.get(key)
        if (address !== undefined) this.interaction?.updateForm(address, { kind: 'finish-picker', fieldId: address.fieldId, cancel })
        this.state.setEditing(undefined)
        return fieldValue(field, key)
      },
      setEditing: key => {
        if (this.state.editingKey === key) return
        this.state.editingKey = key
        for (const lease of this.textEditors.values()) lease.editor.focused = false
      },
      blurInactiveEditors: controls => {
        const visible = new Set(controls.flatMap(control => control.kind === 'text'
          ? [fieldStateKey(control.key, control.field.kind)]
          : []))
        for (const [stateKey, lease] of this.textEditors) if (!visible.has(stateKey)) lease.editor.focused = false
      },
      setLayoutViewport: viewport => { this.layoutViewport?.(viewport) },
      bindControls: (keys, binding) => { this.controls.bind(keys, binding) },
      bindScroll: (key, scroll) => { this.controls.bindScroll(key, scroll) },
    }
  }

  bind(node: CompilableNode, options: RuntimeCompilerOptions, setLayoutViewport: (viewport: MayflyUiViewport) => void): number {
    if (!this.live) throw new Error('surface runtime is disposed')
    this.node = node
    this.options = options
    this.layoutViewport = setLayoutViewport
    this.listRowBudget = undefined
    this.controls.resetGeneration()
    this.generation += 1
    return this.generation
  }

  /** Renderer clocks do not change shared model revisions or form state. */
  get animationFrame(): number { return this.loaderAnimation?.frame ?? 0 }
  loaderFrame(): number { return this.loaderAnimation?.render() ?? 0 }
  /** Asks the renderer to paint this surface again: an image's bytes arrived. */
  readonly repaint = (): void => { if (this.live) this.requestRender?.() }
  /** The scroll position a region keeps across publishes. */
  scrollMemory(key: string): ScrollMemory {
    let memory = this.scrolled.get(key)
    if (memory === undefined) { memory = { offset: 0, following: undefined, away: 0 }; this.scrolled.set(key, memory) }
    return memory
  }
  /**
   * The value a bar with a `transition` draws now. Without a clock, or under reduced motion, the bar is already settled;
   * otherwise it drains with the clock and holds it only while it moves.
   */
  progressValue(key: string, node: Parameters<UiProgressTransitions['step']>[1], reducedMotion: boolean): number {
    if (this.loaderAnimation === undefined || reducedMotion) return node.value
    const step = this.transitions.step(key, node, this.loaderAnimation.frame)
    if (step.animating) this.loaderAnimation.render()
    return step.value
  }
  beginAnimationFrame(): void { this.loaderAnimation?.beginFrame() }
  pauseAnimation(): void { this.loaderAnimation?.stop() }

  current(generation: number): boolean { return this.live && this.interaction?.disposed !== true && generation === this.generation }

  pagePath(node: object): MayflyPagePath { return this.nodePages.get(node) ?? [] }

  activeTab(address: { readonly pagePath: MayflyPagePath, readonly controlId: string }): string | undefined {
    return this.interaction === undefined ? this.tabDefinitions.get(controlGroup('tabs', address.controlId, address.pagePath))?.activeId : this.interaction.activeTab(address)
  }

  fieldAddress(key: string): MayflyFieldAddress | undefined { return this.fieldAddresses.get(key) }

  listRowLimit(viewportRows: number): number { return Math.min(viewportRows, this.listRowBudget ?? viewportRows) }

  setListRowBudget(rows: number | undefined): void { this.listRowBudget = rows }

  search(node: MayflyListNode): SearchInput {
    const key = controlGroup('list', node.id, this.pagePath(node))
    let search = this.searches.get(key)
    if (search === undefined) { search = new SearchInput(this.options!.components); this.searches.set(key, search) }
    search.setText(this.interaction?.choice({ pagePath: this.pagePath(node), controlId: node.id })?.query ?? '')
    return search
  }

  listWindow(node: MayflyListNode, rowLimit: number): readonly VirtualListEntry[] {
    const state = this.interaction?.choice({ pagePath: this.pagePath(node), controlId: node.id })
    const count = state === undefined ? node.items.length : choiceVisibleCount(state)
    const size = Math.min(count, Math.max(1, Math.floor(rowLimit)) + 4)
    const cursor = state === undefined ? 0 : choiceVisiblePosition(state)
    const start = Math.max(0, Math.min(count - size, cursor - Math.floor(size / 2)))
    return Array.from({ length: size }, (_, offset) => {
      const index = state === undefined ? start + offset : choiceVisibleIndex(state, start + offset)!
      return { index, position: start + offset, item: state === undefined ? admittedListItem(node.items, index)! : decorateChoiceItem(state, index) }
    })
  }

  moveList(node: MayflyListNode, movement: ListMovement, pageSize: number): VirtualListEntry | undefined {
    const address = { pagePath: this.pagePath(node), controlId: node.id }
    if (movement === 'home' || movement === 'end') this.interaction?.updateChoice(address, { kind: 'edge', edge: movement === 'home' ? 'first' : 'last' })
    else this.interaction?.updateChoice(address, { kind: 'move', direction: movement === 'up' || movement === 'page-up' ? -1 : 1, count: movement === 'page-up' || movement === 'page-down' ? pageSize : 1 })
    const state = this.interaction?.choice(address)
    const index = state?.focusedIndex ?? -1
    const item = index < 0 ? undefined : admittedListItem(node.items, index)
    return item === undefined ? undefined : { index, position: state!.focusedPosition, item }
  }

  setFocused(value: boolean): void {
    this.state.focused = value
    if (!value) for (const lease of this.textEditors.values()) lease.editor.focused = false
  }

  checkpoint(): () => void {
    const node = this.node
    const options = this.options
    const layoutViewport = this.layoutViewport
    const listRowBudget = this.listRowBudget
    const generation = this.generation
    const focus = {
      activeKey: this.state.activeKey,
      activeGroup: this.state.activeGroup,
      desiredKey: this.state.desiredKey,
      desiredGroup: this.state.desiredGroup,
      editingKey: this.state.editingKey,
      lastIndex: this.state.lastIndex,
      focused: this.state.focused,
      layoutPass: this.state.layoutPass,
      lastTabGroupIndex: this.state.lastTabGroupIndex,
      expandedKey: this.state.expandedKey,
    }
    const groupActiveKeys = new Map(this.state.groupActiveKeys)
    const restoreControls = this.controls.checkpoint()
    return () => {
      this.node = node
      this.options = options
      this.layoutViewport = layoutViewport
      this.listRowBudget = listRowBudget
      this.generation = generation
      Object.assign(this.state, focus)
      this.state.groupActiveKeys.clear(); for (const [key, value] of groupActiveKeys) this.state.groupActiveKeys.set(key, value)
      restoreControls()
    }
  }

  /** Retain recent inactive fields while bounding registration-owned renderer state. */
  admit(node: CompilableNode): void {
    const active = new Set<string>()
    this.admitFields(node, active)
    for (const [stateKey, lease] of this.textEditors) if (!active.has(stateKey)) lease.editor.focused = false
    let inactive = this.fieldRecency.size - active.size
    // Every active key was just touched and therefore sits after all inactive keys.
    for (const stateKey of this.fieldRecency.keys()) {
      if (inactive <= INACTIVE_FIELD_CACHE_LIMIT) break
      this.evictField(stateKey)
      inactive -= 1
    }
  }

  /** Add fields from a newly visible deferred branch without aging sibling state. */
  admitDeferred(node: MayflyUiNode, pagePath: MayflyPagePath): void {
    this.interaction?.admitVisibleControls()
    this.admitFields(node, new Set(), pagePath)
  }

  /**
   * The memoized control walk behind `FocusState.controls()` and
   * `allControls()`: one tree walk per input/render round instead of one per
   * read, with the same membership semantics.
   */
  private walkControlsCached(): ControlWalk {
    const node = this.node
    const options = this.options
    if (node === undefined || options === undefined) return EMPTY_CONTROL_WALK
    const viewport = safeViewport(options.getViewport)
    const revision = this.interaction?.revision ?? 0
    const cached = this.controlsWalkMemo
    if (cached !== undefined && cached.generation === this.generation && cached.node === node && cached.options === options
      && cached.columns === viewport.columns && cached.rows === viewport.rows && cached.revision === revision) {
      return cached.walk
    }
    const walk = walkControls(node, options)
    this.controlsWalkMemo = { generation: this.generation, node, options, columns: viewport.columns, rows: viewport.rows, revision, walk }
    return walk
  }

  deactivate(): void {
    if (!this.live) return
    this.pauseAnimation()
    this.generation += 1
    this.node = undefined
    this.options = undefined
    this.layoutViewport = undefined
    this.listRowBudget = undefined
    this.setFocused(false)
    for (const lease of this.textEditors.values()) releaseTextEditor(lease)
  }

  dispose(): void {
    if (!this.live) return
    this.deactivate()
    this.live = false
    for (const lease of this.textEditors.values()) releaseTextEditor(lease)
    this.textEditors.clear()
    this.fieldAddresses.clear()
    this.tabDefinitions.clear()
    for (const search of this.searches.values()) search.clear()
    this.searches.clear()
    this.fieldKinds.clear()
    this.fieldOwners.clear()
    this.fieldRecency.clear()
    this.controls.resetGeneration()
    this.state.activeKey = undefined
    this.state.activeGroup = undefined
    this.state.desiredKey = undefined
    this.state.desiredGroup = undefined
    this.state.setEditing(undefined)
    this.state.groupActiveKeys.clear()
    this.state.lastIndex = 0
    this.state.lastTabGroupIndex = 0
  }

  private admitFields(current: CompilableNode, active: Set<string>, pagePath: MayflyPagePath = []): void {
    this.nodePages.set(current, pagePath)
    if (current.kind !== 'editor-control' && isDeferredUiNode(current as MayflyUiNode)) {
      const admitted = materializedDeferredUiNode(current as MayflyUiNode)
      if (admitted?.ok === true) this.admitFields(admitted.value, active, pagePath)
      return
    }
    switch (current.kind) {
      case 'stack': for (const child of current.children) this.admitFields(child.node, active, child.tab === undefined ? pagePath : [...pagePath, child.tab]); break
      case 'surface':
        this.admitFields(current.child, active, pagePath)
        if (current.footer !== undefined) this.admitFields(current.footer, active, pagePath)
        break
      case 'scroll': this.admitFields(current.child, active, pagePath); break
      case 'list': if (current.empty !== undefined) this.admitFields(current.empty, active, pagePath); break
      case 'form': for (const field of current.fields) {
        const key = controlKey('form-field', current.id, field.id, pagePath)
        const address = { pagePath, formId: current.id, fieldId: field.id }
        this.fieldAddresses.set(key, address)
        this.fieldAddresses.set(fieldStateKey(key, field.kind), address)
        this.touchField(key, field, active)
      }; break
      case 'tabs': this.tabDefinitions.set(controlGroup('tabs', current.id, pagePath), current); break
      case 'empty': if (current.actions !== undefined) this.admitFields(current.actions, active, pagePath); break
      default: break
    }
  }

  private touchField(key: string, field: MayflyFormField, active: Set<string>): void {
    const previousKind = this.fieldKinds.get(key)
    if (previousKind !== undefined && previousKind !== field.kind) this.evictField(fieldStateKey(key, previousKind))
    const stateKey = fieldStateKey(key, field.kind)
    this.fieldKinds.set(key, field.kind)
    this.fieldOwners.set(stateKey, key)
    this.fieldRecency.delete(stateKey)
    this.fieldRecency.set(stateKey, true)
    active.add(stateKey)
  }

  private evictField(stateKey: string): void {
    this.fieldAddresses.delete(stateKey)
    const lease = this.textEditors.get(stateKey)
    if (lease !== undefined) {
      releaseTextEditor(lease)
      this.textEditors.delete(stateKey)
    }
    const owner = this.fieldOwners.get(stateKey)!
    this.fieldAddresses.delete(owner)
    if (this.state.editingKey === owner) this.state.setEditing(undefined)
    this.fieldKinds.delete(owner)
    this.fieldOwners.delete(stateKey)
    this.fieldRecency.delete(stateKey)
  }

  private textEditor(field: TextField, key: string): MayflyEditor {
    const options = this.options
    if (options === undefined) throw new Error('surface runtime is inactive')
    const stateKey = fieldStateKey(key, field.kind)
    const previous = this.textEditors.get(stateKey)
    let editor = previous?.editor
    if (editor === undefined) {
      editor = options.components.createEditor()
    }
    let lease = previous
    if (lease === undefined) {
      lease = { editor, onChange: undefined, onSubmit: undefined }
      this.textEditors.set(stateKey, lease)
    } else {
      detachTextEditorCallbacks(lease)
    }
    const controlled = String(this.state.fieldValue(field, key))
    if (editor.getExpandedText() !== controlled) {
      editor.onChange = undefined
      editor.setText(controlled)
    }
    editor.disableSubmit = false
    const onChange = (): void => {
      if (!this.live || this.options !== options || editor.onChange !== onChange) return
      const value = editor!.getExpandedText()
      this.state.setValue(stateKey, value)
    }
    const onSubmit = (value: string): void => {
      if (!this.live || this.options !== options || editor.onSubmit !== onSubmit) return
      this.state.setValue(stateKey, value)
      if (this.state.editingKey === key) this.state.setEditing(undefined)
    }
    lease.onChange = onChange
    lease.onSubmit = onSubmit
    editor.onChange = onChange
    editor.onSubmit = onSubmit
    return editor
  }
}

class CompiledSurface implements MayflyEditorShellComponent {
  private readonly state: FocusState
  private readonly root: Component
  private viewport: MayflyUiViewport
  private runtimeFailure: string | undefined
  private readonly surfaceRuntime: MayflyUiSurfaceRuntime
  private readonly generation: number
  private readonly hintRowsFor: ((width: number) => string[]) | undefined
  private viewportOffset = 0
  private readonly runtimeOptions: RuntimeCompilerOptions

  constructor(
    private readonly node: CompilableNode,
    private readonly options: MayflyUiCompilerOptions,
    private readonly mode: CompilerMode,
    private readonly editor?: MayflyEditor,
    surfaceRuntime?: MayflyUiSurfaceRuntime,
    contextKeyHints = false,
    private readonly escapeLabel?: EscapeLabel,
  ) {
    this.viewport = safeViewport(options.getViewport)
    this.surfaceRuntime = surfaceRuntime ?? new MayflyUiSurfaceRuntime(options.interaction)
    const runtimeOptions: RuntimeCompilerOptions = {
      ...options,
      reuse: options.reuse ?? this.surfaceRuntime.reuse,
      ...(editor === undefined ? {} : { editor }),
      getViewport: () => this.viewport,
      listRuntime: this.surfaceRuntime,
      reportRuntimeFailure: message => { this.runtimeFailure ??= message },
    }
    this.runtimeOptions = runtimeOptions
    this.generation = this.surfaceRuntime.bind(node, runtimeOptions, viewport => { this.viewport = viewport })
    this.state = this.surfaceRuntime.state
    this.surfaceRuntime.admit(node)
    runtimeOptions.reuse.beginPass()
    // A surface with `hint: 'completions'` draws its hint row only while the editor's completion list is open.
    const hintOpen = node.kind === 'surface' && node.hint === 'completions' ? () => runtimeOptions.completionsOpen?.() === true : undefined
    const contextHint = contextKeyHints ? contextKeyHintComponent(this.state, runtimeOptions, mode, escapeLabel, hintOpen) : undefined
    this.hintRowsFor = contextKeyHints ? width => hintOpen?.() === false ? [] : contextKeyHintRows(this.state, runtimeOptions, width, mode, escapeLabel) : undefined
    const compiledRoot = compileNode(node, this.state, runtimeOptions, '$', mode, node.kind === 'surface' ? contextHint : undefined)
    if (contextHint === undefined || node.kind === 'surface') this.root = compiledRoot
    else {
      const root = new VStack()
      root.addChild(compiledRoot, this.surfaceRuntime.interaction === undefined ? {} : { grow: 1, minSize: 1 })
      root.addChild(contextHint)
      this.root = root
    }
    reconcile(this.state)
    const remembered = this.surfaceRuntime.interaction?.focus
    const active = this.state.controls()[this.state.lastIndex]
    // The model remembers the control, while editing and cursor state belong to this runtime.
    if (remembered !== undefined && (active === undefined || !sameFocusIdentity(active.identity, remembered))) this.restoreFocusIdentity(remembered)
  }

  get focused(): boolean { return this.state.focused }
  set focused(value: boolean) {
    this.frameResult = undefined
    if (!this.surfaceRuntime.current(this.generation)) return
    this.surfaceRuntime.setFocused(value)
    if (!value && this.editor !== undefined) this.editor.focused = false
    reconcile(this.state)
  }

  hasControls(): boolean {
    const controls = this.state.allControls()
    const deferred = containsDeferredNode(this.node)
    return controls.length > 0 || deferred
  }

  captureFocusIdentity(): MayflyFocusIdentity | undefined {
    if (!this.surfaceRuntime.current(this.generation)) return undefined
    this.viewport = safeViewport(this.options.getViewport)
    const controls = reconcile(this.state)
    const active = controls[this.state.lastIndex]
    /* v8 ignore next -- a live focus facade is created only for a tree with controls. */
    if (active === undefined) return undefined
    const tabControlId = controlGroups(controls)
      .filter(group => group.kind === 'tabs')[this.state.lastTabGroupIndex]
      ?.entries[0]?.control.identity.controlId
    const identity: MayflyFocusIdentity = (active.kind === 'text' || active.kind === 'select')
      && this.state.editingKey === active.key
      ? { ...active.identity, editing: true }
      : active.identity
    return tabControlId === undefined ? identity : { ...identity, tabControlId }
  }

  restoreFocusIdentity(identity: MayflyFocusIdentity): boolean {
    this.frameResult = undefined
    if (!this.surfaceRuntime.current(this.generation)) return false
    this.viewport = safeViewport(this.options.getViewport)
    const controls = this.state.controls()
    const index = controls.findIndex(control => sameFocusIdentity(control.identity, identity))
    if (index < 0) return false
    const control = controls[index]!
    this.state.activeKey = control.key
    this.state.activeGroup = control.group
    this.state.desiredKey = control.key
    this.state.desiredGroup = control.group
    this.state.groupActiveKeys.set(control.group, control.key)
    this.state.lastIndex = index
    const tabGroups = controlGroups(controls).filter(group => group.kind === 'tabs')
    const tabIndex = tabGroups.findIndex(group => group.entries[0]?.control.identity.controlId === identity.tabControlId)
    if (tabIndex >= 0) this.state.lastTabGroupIndex = tabIndex
    const address = this.surfaceRuntime.fieldAddress(control.key)
    const picker = address === undefined ? undefined : this.surfaceRuntime.interaction?.form(address)?.fields[address.fieldId]?.picker
    if (control.kind === 'select' && (identity.editing === true || picker !== undefined)) this.state.beginSelectEditing(control.field, control.key)
    else this.state.setEditing(control.kind === 'text' && identity.editing === true ? control.key : undefined)
    reconcile(this.state)
    return true
  }

  [LAYOUT_NODE](): LayoutNode {
    if (!this.surfaceRuntime.current(this.generation)) return { type: 'vstack', entries: [], gap: 0, align: 'stretch' }
    this.viewport = safeViewport(this.options.getViewport)
    this.surfaceRuntime.beginAnimationFrame()
    reconcile(this.state)
    beginLayoutPass(this.state)
    return getLayoutNode(this.root) ?? {
      type: 'vstack',
      entries: [{ component: this.root, basis: 'auto', grow: 1, shrink: 1 }],
      gap: 0,
      align: 'stretch',
    }
  }

  private renderFrame(width: number, maxRows: number | undefined): MayflyStatusRenderResult {
    const safeWidth = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
    if (!this.surfaceRuntime.current(this.generation)) return { rows: [], overflowed: false }
    this.runtimeFailure = undefined
    this.surfaceRuntime.beginAnimationFrame()
    try {
      this.state.layoutPass = false
      this.viewport = maxRows === undefined
        ? safeViewport(this.options.getViewport)
        : { columns: safeWidth, rows: maxRows }
      this.surfaceRuntime.setListRowBudget(undefined)
      reconcile(this.state)
      /* A scroll view expanded with Ctrl+E owns the whole frame: the shared
         layout pass slices the same scroll state the embedded view uses. */
      const expandedScroll = this.state.expandedKey === undefined ? undefined : this.state.scrollViews.get(this.state.expandedKey)
      if (this.state.expandedKey !== undefined && expandedScroll === undefined) this.state.expandedKey = undefined
      if (expandedScroll !== undefined && expandedScroll.inline !== true) {
        const viewport = this.viewport
        beginLayoutPass(this.state)
        try {
          const hint = glyphRows(this.hintRowsFor?.(safeWidth) ?? [], this.options.components.presentation?.glyphs)
          const expandedComponent = expandedScroll as unknown as Component
          /* Semantic scrolls learn the content width from render(); refresh it
             so anchors written while expanded match the expanded width. */
          expandedComponent.render(safeWidth)
          const frame = renderLayoutFrame(expandedComponent, safeWidth, Math.max(1, viewport.rows - hint.length), () => {})
          const lines = [...frame.lines, ...hint]
          return { rows: lines.map(row => visibleWidth(row) <= safeWidth ? row : /* v8 ignore next -- layout frames and hint rows are already produced at the safe width */ sliceByColumn(row, 0, safeWidth, true)), overflowed: false }
        } finally { this.state.layoutPass = false; this.viewport = viewport }
      }
      let rows: string[]
      const constrainedLayout = (): string[] => {
        const viewport = this.viewport
        beginLayoutPass(this.state)
        try { return renderLayoutFrame(this.root, safeWidth, viewport.rows, () => {}).lines }
        finally { this.state.layoutPass = false; this.viewport = viewport }
      }
      rows = this.root.render(safeWidth)
      if (this.surfaceRuntime.interaction !== undefined && [...this.state.scrollViews.values()].some(view => view.inline !== true)) rows = constrainedLayout()
      else {
        const hasList = this.state.controls().some(control => control.kind === 'list' || control.kind === 'event' && control.listEntry !== undefined)
        if (this.surfaceRuntime.interaction !== undefined && hasList) {
          let budget = this.viewport.rows
          while (rows.length > this.viewport.rows && budget > 1) {
            const next = Math.max(1, budget - (rows.length - this.viewport.rows))
            budget = next
            this.surfaceRuntime.setListRowBudget(budget)
            reconcile(this.state)
            rows = this.root.render(safeWidth)
          }
        }
      }
      const rowLimit = maxRows ?? (this.options.screenMode === 'alternate' || this.surfaceRuntime.interaction !== undefined ? this.viewport.rows : undefined)
      const severity = { info: 0, success: 1, warning: 2, error: 3 }
      const notice = this.surfaceRuntime.interaction?.feedbackSnapshot().toSorted((left, right) => severity[left.severity] - severity[right.severity]).at(-1)
      const feedbackRows = notice === undefined || rowLimit === 1 ? [] : glyphRows([sliceByColumn(
        joinSpans({ spans: feedbackSpans(notice.severity, sanitizePluginText(notice.message).replace(/[\r\n]+/gu, ' ')) }, this.options.colors),
        0, safeWidth, true,
      )], this.options.components.presentation?.glyphs)
      const contentLimit = rowLimit === undefined ? rows.length : Math.max(1, rowLimit - feedbackRows.length)
      const caretRow = rows.findIndex(row => row.includes(CURSOR_MARKER))
      const focusRow = caretRow < 0 ? rows.findIndex(row => row.includes(FOCUS_SENTINEL)) : caretRow
      const pinFrame = rowLimit !== undefined && rows.length > contentLimit && this.node.kind === 'surface'
        && (this.node.chrome === 'overlay' || this.node.chrome === 'surface')
      let limited: string[]
      if (pinFrame && contentLimit > 1) {
        const innerLength = Math.max(0, rows.length - 2)
        const innerLimit = Math.max(0, contentLimit - 2)
        const innerFocus = focusRow > 0 && focusRow < rows.length - 1 ? focusRow - 1 : -1
        if (innerFocus >= 0 && innerFocus < this.viewportOffset) this.viewportOffset = innerFocus
        else if (innerFocus >= this.viewportOffset + innerLimit) this.viewportOffset = innerFocus - innerLimit + 1
        this.viewportOffset = Math.max(0, Math.min(this.viewportOffset, innerLength - innerLimit))
        limited = [rows[0]!, ...rows.slice(1 + this.viewportOffset, 1 + this.viewportOffset + innerLimit), rows.at(-1)!, ...feedbackRows]
      } else {
        if (focusRow >= 0 && focusRow < this.viewportOffset) this.viewportOffset = focusRow
        else if (focusRow >= this.viewportOffset + contentLimit) this.viewportOffset = focusRow - contentLimit + 1
        this.viewportOffset = Math.max(0, Math.min(this.viewportOffset, rows.length - contentLimit))
        limited = [...rows.slice(this.viewportOffset, this.viewportOffset + contentLimit), ...feedbackRows]
      }
      let overflowed = rowLimit !== undefined && rows.length > rowLimit
      countWork(this.runtimeOptions.counters, 'stringsMeasured', limited.length)
      const rendered = limited.map(row => {
        if (visibleWidth(row) <= safeWidth) return row
        overflowed = true
        return sliceByColumn(row, 0, safeWidth, true)
      })
      let inserted = rendered.some(row => row.includes(CURSOR_MARKER))
      const result = { rows: rendered.map(row => {
        if (!this.focused || inserted || !row.includes(FOCUS_SENTINEL)) return row.replaceAll(FOCUS_SENTINEL, ' ')
        inserted = true
        return row.replace(FOCUS_SENTINEL, `${CURSOR_MARKER} `).replaceAll(FOCUS_SENTINEL, ' ')
      }), overflowed }
      return this.runtimeFailure === undefined ? result : { ...result, runtimeFailure: this.runtimeFailure }
    } catch (error) {
      const message = renderFailure(error)
      const rows = errorRows(message, safeWidth, this.options.colors)
      return { rows: maxRows === undefined ? rows : rows.slice(0, maxRows), overflowed: maxRows !== undefined && rows.length > maxRows, runtimeFailure: message }
    }
  }

  /* pi-tui measures a surface before painting it inside one synchronous
     pass, so identical renderFrame calls reuse the previous result. The
     key covers every input the frame reads from outside itself: runtime
     liveness (a rebind retires this surface), the caller-owned viewport
     object, the interaction revision, the keymap revision (a key rebind
     moves buttons and hints), and the renderer animation frame.
     Internal state changes — focus, input, scroll — all flow
     through the entry points below, which clear the memo eagerly. */
  private frameResult: {
    readonly current: boolean
    readonly width: number
    readonly maxRows: number | undefined
    readonly columns: number
    readonly rows: number
    readonly revision: number | undefined
    readonly keymapRevision: number | undefined
    readonly animationFrame: number
    readonly result: MayflyStatusRenderResult
  } | undefined

  private renderFrameOnce(width: number, maxRows: number | undefined): MayflyStatusRenderResult {
    const current = this.surfaceRuntime.current(this.generation)
    const viewport = safeViewport(this.options.getViewport)
    const revision = this.surfaceRuntime.interaction?.revision
    const keymapRevision = this.options.keymap?.revision
    const animationFrame = this.surfaceRuntime.animationFrame
    const cached = this.frameResult
    if (cached !== undefined
      && cached.current === current && cached.width === width && cached.maxRows === maxRows
      && cached.columns === viewport.columns && cached.rows === viewport.rows && cached.revision === revision
      && cached.keymapRevision === keymapRevision && cached.animationFrame === animationFrame) {
      return cached.result
    }
    const result = this.renderFrame(width, maxRows)
    this.frameResult = { current, width, maxRows, columns: viewport.columns, rows: viewport.rows, revision, keymapRevision, animationFrame, result }
    return result
  }

  render(width: number): string[] { return this.renderChecked(width).rows }

  renderChecked(width: number, options: MayflyEditorShellRenderOptions = {}): MayflyEditorShellRenderResult {
    if (options.dryRun !== true) {
      const rendered = this.renderFrameOnce(width, undefined)
      return rendered.runtimeFailure === undefined
        ? { rows: rendered.rows }
        : { rows: rendered.rows, runtimeFailure: rendered.runtimeFailure }
    }
    // `dryRun` is exposed only by the validated editor-shell result, whose
    // compiler contract guarantees the injected editor and its one control.
    const editor = this.editor!
    const focus = {
      activeKey: this.state.activeKey,
      activeGroup: this.state.activeGroup,
      desiredKey: this.state.desiredKey,
      desiredGroup: this.state.desiredGroup,
      editingKey: this.state.editingKey,
      groupActiveKeys: new Map(this.state.groupActiveKeys),
      lastIndex: this.state.lastIndex,
      focused: this.state.focused,
      layoutPass: this.state.layoutPass,
      lastTabGroupIndex: this.state.lastTabGroupIndex,
      expandedKey: this.state.expandedKey,
      viewport: this.viewport,
      runtimeFailure: this.runtimeFailure,
      editorFocused: editor.focused,
    }
    try {
      const rendered = this.renderFrame(width, undefined)
      return rendered.runtimeFailure === undefined
        ? { rows: rendered.rows }
        : { rows: rendered.rows, runtimeFailure: rendered.runtimeFailure }
    } finally {
      this.state.activeKey = focus.activeKey
      this.state.activeGroup = focus.activeGroup
      this.state.desiredKey = focus.desiredKey
      this.state.desiredGroup = focus.desiredGroup
      this.state.editingKey = focus.editingKey
      this.state.groupActiveKeys.clear(); for (const [key, value] of focus.groupActiveKeys) this.state.groupActiveKeys.set(key, value)
      this.state.lastIndex = focus.lastIndex
      this.state.focused = focus.focused
      this.state.layoutPass = focus.layoutPass
      this.state.lastTabGroupIndex = focus.lastTabGroupIndex
      this.state.expandedKey = focus.expandedKey
      this.viewport = focus.viewport
      this.runtimeFailure = focus.runtimeFailure
      editor.focused = focus.editorFocused
    }
  }

  focusEditor(): void {
    this.frameResult = undefined
    if (!this.surfaceRuntime.current(this.generation)) return
    this.viewport = safeViewport(this.options.getViewport)
    const controls = this.state.controls()
    const index = controls.findIndex(control => control.kind === 'editor')
    this.state.activeKey = controls[index]!.key
    this.state.activeGroup = controls[index]!.group
    this.state.desiredKey = controls[index]!.key
    this.state.desiredGroup = controls[index]!.group
    this.state.groupActiveKeys.set(controls[index]!.group, controls[index]!.key)
    this.state.lastIndex = index
  }

  /** Render a passive status surface with a fixed row budget and overflow signal. */
  renderStatus(width: number, maxRows: number): MayflyStatusRenderResult { return this.renderFrameOnce(width, maxRows) }

  private controlRectangles(controls: readonly ControlDescriptor[]): Map<string, LayoutRect> {
    const rectangles = new Map<string, LayoutRect>()
    /* v8 ignore next -- input returns before geometry lookup when no control exists. */
    if (controls.length === 0) return rectangles
    const width = Math.max(1, this.viewport.columns)
    // Alternate and interaction surfaces size geometry from the viewport;
    // only the passive inline case needs a measurement render (UX-34).
    const height = this.options.screenMode === 'alternate' || this.surfaceRuntime.interaction !== undefined
      ? Math.max(1, this.viewport.rows)
      : Math.max(1, this.root.render(width).length)
    const previousLayoutPass = this.state.layoutPass
    beginLayoutPass(this.state)
    try {
      /* v8 ignore next -- pi-tui does not request repaint during synchronous measurement. */
      const frame = renderLayoutFrame(this.root, width, height, () => {})
      const boxes = layoutBoxes(frame.root)
      const byComponent = new Map<Component, ControlDescriptor[]>()
      for (const control of controls) {
        const binding = this.state.controlBindings.get(control.key)
        if (binding === undefined || !boxes.has(binding.component)) continue
        const siblings = byComponent.get(binding.component) ?? []
        siblings.push(control)
        byComponent.set(binding.component, siblings)
      }
      for (const [component, siblings] of byComponent) {
        const rect = boxes.get(component)!
        for (const [index, control] of siblings.entries()) {
          const binding = this.state.controlBindings.get(control.key)!
          rectangles.set(control.key, divideRect(rect, binding.axis, index, siblings.length))
        }
      }
    } catch { /* a missing layout box falls back to semantic group navigation */ }
    finally { this.state.layoutPass = previousLayoutPass }
    return rectangles
  }

  handleInput(data: string): void {
    this.frameResult = undefined
    if (!this.surfaceRuntime.current(this.generation)) return
    this.viewport = safeViewport(this.options.getViewport)
    if (this.state.expandedKey !== undefined && !this.state.scrollViews.has(this.state.expandedKey)) this.state.expandedKey = undefined
    const controls = reconcile(this.state)
    const active = controls[this.state.lastIndex]
    const runtimeOptions = this.runtimeOptions
    const grammar = keyGrammar(grammarStateFor(this.state, runtimeOptions, controls, active, this.mode, this.escapeLabel))
    const binding = grammar.find(candidate => matchesBinding(candidate.match, data, this.options.keymap))
    /* v8 ignore next -- every grammar ends with a catch-all binding. */
    if (binding === undefined) return
    this.apply(binding.intent, data, controls, active)
  }

  private moveTo(index: number, within: readonly ControlDescriptor[]): void {
    const control = within[index]
    /* v8 ignore next -- every caller resolves an entry from the current control set. */
    if (control === undefined) return
    const tabGroups = controlGroups(within).filter(group => group.kind === 'tabs')
    this.state.setEditing(undefined)
    this.state.lastIndex = index
    this.state.activeKey = control.key
    this.state.activeGroup = control.group
    this.state.desiredKey = control.key
    this.state.desiredGroup = control.group
    this.state.groupActiveKeys.set(control.group, control.key)
    const tabIndex = tabGroups.findIndex(group => group.id === control.group)
    if (tabIndex >= 0) this.state.lastTabGroupIndex = tabIndex
    reconcile(this.state)
    this.surfaceRuntime.interaction?.focusControl(control.identity as UiControlAddress)
    try { this.options.onFocusChange?.(control.identity) } catch { /* focus observers cannot escape input */ }
  }

  private moveGroup(delta: -1 | 1, controls: readonly ControlDescriptor[], active: ControlDescriptor): void {
    const groups = controlGroups(controls)
    const current = groups.findIndex(group => group.id === active.group)
    /* v8 ignore next -- a non-tab active control belongs to one content group above. */
    if (current < 0) return
    const sibling = controls[this.state.lastIndex + delta]
    if (sibling?.group === active.group && !(active.kind === 'event' && (active.role === 'tab' || active.role === 'list-single' || active.role === 'list-multiple'))) {
      this.moveTo(this.state.lastIndex + delta, controls)
      return
    }
    const target = groups[current + delta]
    if (target === undefined) return
    this.moveTo(groupTarget(controls, target.id, this.state.groupActiveKeys.get(target.id)), controls)
  }

  /** Select one list row in both the frontend choice and the renderer roving focus. */
  private focusRow(node: MayflyListNode, itemId: string, pagePath: MayflyPagePath): void {
    const key = controlKey('list', node.id, itemId, pagePath)
    const group = controlGroup('list', node.id, pagePath)
    this.state.setEditing(undefined)
    this.state.activeKey = key
    this.state.activeGroup = group
    this.state.desiredKey = key
    this.state.desiredGroup = group
    this.state.groupActiveKeys.set(group, key)
    const updated = reconcile(this.state)
    this.state.lastIndex = updated.findIndex(control => control.key === key)
    this.surfaceRuntime.interaction?.focusControl({ pagePath, controlId: node.id, itemId })
    try { this.options.onFocusChange?.(focusIdentity(node.id, itemId, pagePath)) } catch { /* focus observers cannot escape input */ }
  }

  /** Commit an in-progress text edit or picker before focus leaves the field. */
  private commitEditing(active: ControlDescriptor): void {
    if (active.kind === 'text' && this.state.editingKey === active.key) {
      this.state.setValue(active.key, this.state.textEditor(active.field, active.key).getExpandedText())
      this.state.setEditing(undefined)
    } else if (active.kind === 'select' && this.state.editingKey === active.key) this.applyPicker(active)
  }

  private applyPicker(active: Extract<ControlDescriptor, { readonly kind: 'select' }>): void {
    const address = this.surfaceRuntime.fieldAddress(active.key)!
    const model = this.surfaceRuntime.interaction
    const picker = model?.form(address)?.fields[address.fieldId]?.picker
    if (active.field.kind === 'select' && picker?.focusedId !== undefined) {
      model!.updateForm(address, { kind: 'picker', fieldId: address.fieldId, intent: { kind: 'select', ids: [picker.focusedId] } })
    }
    this.state.finishSelectEditing(active.field, active.key, false)
  }

  private switchTab(delta: -1 | 1, controls: readonly ControlDescriptor[], active: ControlDescriptor | undefined): void {
    const tabGroups = controlGroups(controls).filter(group => group.kind === 'tabs')
    const onStrip = active?.kind === 'event' && active.role === 'tab'
    const activePath = active?.identity.pagePath
    /* Content nested in a tab page addresses its innermost enclosing tab
       group; page-level controls fall back to the last focused tab group. */
    const enclosing = onStrip || activePath === undefined || activePath.length === 0
      ? undefined
      : controlGroup('tabs', activePath.at(-1)!.controlId, activePath.slice(0, -1))
    const groupIndex = onStrip
      ? tabGroups.findIndex(candidate => candidate.id === active.group)
      : enclosing === undefined
        ? Math.min(this.state.lastTabGroupIndex, tabGroups.length - 1)
        : tabGroups.findIndex(candidate => candidate.id === enclosing)
    const group = tabGroups[Math.max(0, groupIndex)]!
    /* v8 ignore next -- tab groups register only tab-change event controls. */
    const tabEvent = (control: ControlDescriptor): Extract<MayflyUiEvent, { readonly kind: 'tab-change' }> | undefined =>
      control.kind === 'event' && control.event.kind === 'tab-change' ? control.event : undefined
    const entries = group.entries.filter(entry => tabEvent(entry.control) !== undefined)
    const anchor = tabEvent(entries[0]!.control)!
    const currentId = this.surfaceRuntime.activeTab({ pagePath: anchor.pagePath, controlId: anchor.controlId })
    const currentIndex = entries.findIndex(entry => tabEvent(entry.control)?.tabId === currentId)
    const target = entries[currentIndex + delta]
    const targetEvent = target === undefined ? undefined : tabEvent(target.control)
    if (targetEvent === undefined) return
    this.state.emit(targetEvent)
    const refreshed = reconcile(this.state)
    const stripIndex = refreshed.findIndex(control => control.kind === 'event' && control.role === 'tab' && tabEvent(control)?.tabId === targetEvent.tabId)
    const refreshedGroups = controlGroups(refreshed)
    const content = onStrip ? undefined : refreshedGroups.slice(refreshedGroups.findIndex(candidate => candidate.id === group.id) + 1).find(candidate => candidate.kind === 'content')
    this.moveTo(content === undefined ? stripIndex : groupTarget(refreshed, content.id, this.state.groupActiveKeys.get(content.id)), refreshed)
  }

  private escape(step: EscapeStep, active: ControlDescriptor | undefined): void {
    switch (step) {
      case 'cancel': {
        const select = active as Extract<ControlDescriptor, { readonly kind: 'select' }>
        this.state.finishSelectEditing(select.field, select.key, true)
        return
      }
      case 'done': this.commitEditing(active!); return
      case 'end-search': {
        const node = (active as Extract<ControlDescriptor, { readonly kind: 'event' }>).listEntry?.node ?? (active as Extract<ControlDescriptor, { readonly kind: 'list' }>).node
        this.surfaceRuntime.interaction!.updateChoice({ pagePath: this.surfaceRuntime.pagePath(node), controlId: node.id }, { kind: 'stop-search' })
        return
      }
      case 'back': this.surfaceRuntime.interaction!.back(); return
      /* v8 ignore next -- an expanded view resolves Escape through its own collapse binding. */
      case 'collapse': this.state.expandedKey = undefined; return
      case 'cancel-work': {
        const work = this.state.controls().find(candidate => candidate.kind === 'event' && candidate.work === true) as Extract<ControlDescriptor, { readonly kind: 'event' }> | undefined
        if (work !== undefined) this.state.emit(work.event)
        return
      }
      case 'close':
      case 'leave':
      case 'reject':
      case 'surface-back':
      case 'surface-cancel': this.options.onUnhandledEscape?.(); return
    }
  }

  private selectCycle(active: Extract<ControlDescriptor, { readonly kind: 'select' }>, delta: -1 | 1): void {
    const options = (this.state.field(active.field, active.key) as SelectField).options.filter(option => option.disabled !== true)
    const value = this.state.fieldValue(active.field, active.key)
    const index = options.findIndex(option => option.id === value)
    /* An unset or unavailable value starts from the edge the arrow points into. */
    const target = index < 0 ? (delta > 0 ? options[0] : options.at(-1)) : options[index + delta]
    if (target !== undefined) this.state.setValue(active.key, target.id)
  }

  private numbered(data: string, active: ControlDescriptor): void {
    const node = (active as Extract<ControlDescriptor, { readonly kind: 'event' }>).listEntry!.node
    const pagePath = this.surfaceRuntime.pagePath(node)
    const address = { pagePath, controlId: node.id }
    const choice = this.surfaceRuntime.interaction?.choice(address)
    const index = choice === undefined ? Number(data) - 1 : choiceVisibleIndex(choice, Number(data) - 1)
    const item = index === undefined ? undefined : admittedListItem(node.items, index)
    if (item === undefined || item.disabled === true) return
    this.surfaceRuntime.interaction?.updateChoice(address, { kind: 'focus', id: item.id })
    this.focusRow(node, item.id, pagePath)
    if (node.numbered !== true) return
    const selected = choice?.selectedIds ?? node.selectedIds
    this.state.emit(node.mode === 'multiple'
      ? { kind: 'selection-toggle', pagePath, controlId: node.id, selectedIds: selected.includes(item.id) ? selected.filter(id => id !== item.id) : [...selected, item.id] }
      : { kind: 'selection-accept', pagePath, controlId: node.id, selectedIds: [item.id] })
  }

  private navigate(direction: 'up' | 'down' | 'left' | 'right', controls: readonly ControlDescriptor[], active: ControlDescriptor): void {
    const group = controlGroups(controls).find(candidate => candidate.id === active.group)
    const matchingAxis = active.navigation === 'horizontal'
      ? direction === 'left' || direction === 'right'
      : active.navigation === 'vertical' && (direction === 'up' || direction === 'down')
    let target: number | undefined
    if (matchingAxis && group !== undefined) {
      const current = group.entries.findIndex(entry => entry.index === this.state.lastIndex)
      target = group.entries[current + (direction === 'left' || direction === 'up' ? -1 : 1)]?.index
    }
    if (target === undefined) target = nearestDirectionalControl(controls, this.controlRectangles(controls), this.state.lastIndex, direction)
    if (target !== undefined) this.moveTo(target, controls)
  }

  private apply(intent: GrammarIntent, data: string, controls: readonly ControlDescriptor[], active: ControlDescriptor | undefined): void {
    const model = this.surfaceRuntime.interaction
    const listNode = active?.kind === 'list' ? active.node : active?.kind === 'event' ? active.listEntry?.node : undefined
    const listAddress = listNode === undefined ? undefined : { pagePath: this.surfaceRuntime.pagePath(listNode), controlId: listNode.id }
    switch (intent.kind) {
      case 'editor': this.editor?.handleInput?.(data); return
      case 'swallow': return
      case 'collapse': this.state.expandedKey = undefined; return
      case 'expand': this.state.expandedKey = active!.key; return
      case 'scroll': {
        const scroll = this.state.scrollViews.get(this.state.expandedKey ?? active!.key)
        /* v8 ignore next -- compiler registration creates both descriptors atomically. */
        if (scroll !== undefined) scrollBy(scroll, intent.movement)
        return
      }
      case 'escape': this.escape(intent.step, active); return
      case 'close': this.options.onUnhandledEscape?.(); return
      case 'keyed': this.state.emit(intent.control < controls.length ? (controls[intent.control] as Extract<ControlDescriptor, { readonly kind: 'event' }>).event : this.state.accelerators()[intent.control - controls.length]!.event); return
      case 'numbered': this.numbered(data, active!); return
      case 'tab-switch': this.switchTab(intent.delta, controls, active); return
      case 'search-clear': {
        this.surfaceRuntime.search(listNode!).clear()
        model!.updateChoice(listAddress!, { kind: 'clear-search' })
        return
      }
      case 'search-start': model!.updateChoice(listAddress!, { kind: 'query', query: model!.choice(listAddress!)!.query }); return
      case 'search-type': {
        // The grammar routes only text, Backspace, and paste chunks here, all of which the search input accepts.
        const search = this.surfaceRuntime.search(listNode!)
        search.handleInput(data, data === '\x7f' || data === '\b')
        model!.updateChoice(listAddress!, { kind: 'query', query: search.text })
        return
      }
    }
    /* v8 ignore next -- every remaining intent is bound only while a control holds focus. */
    if (active === undefined) return
    switch (intent.kind) {
      case 'group': this.commitEditing(active); this.moveGroup(intent.delta, reconcile(this.state), active); return
      case 'text-newline': this.state.textEditor((active as Extract<ControlDescriptor, { readonly kind: 'text' }>).field, active.key).insertText('\n'); return
      case 'text-enter': {
        const text = active as Extract<ControlDescriptor, { readonly kind: 'text' }>
        const editor = this.state.textEditor(text.field, text.key)
        if (text.field.kind === 'textarea' && text.form.enterSubmits === undefined) { editor.insertText('\n'); return }
        this.state.setValue(text.key, editor.getExpandedText())
        if (text.form.enterSubmits === undefined) this.moveGroup(1, controls, active)
        else { this.state.setEditing(undefined); model?.invoke(text.form.enterSubmits, text.identity.pagePath!) }
        return
      }
      case 'text-type': {
        const text = active as Extract<ControlDescriptor, { readonly kind: 'text' }>
        if (this.state.field(text.field, text.key).disabled === true) return
        const editor = this.state.textEditor(text.field, text.key)
        editor.focused = this.state.focused
        editor.handleInput?.(data)
        return
      }
      case 'text-begin': {
        const text = active as Extract<ControlDescriptor, { readonly kind: 'text' }>
        this.state.setEditing(text.key)
        if (startsText(data)) {
          const editor = this.state.textEditor(text.field, text.key)
          editor.focused = this.state.focused
          editor.handleInput?.(data)
        }
        return
      }
      case 'enter-submits': {
        const text = active as Extract<ControlDescriptor, { readonly kind: 'text' }>
        model?.invoke(text.form.enterSubmits!, text.identity.pagePath!)
        return
      }
      case 'select-cycle': this.selectCycle(active as Extract<ControlDescriptor, { readonly kind: 'select' }>, intent.delta); return
      case 'field-reset': {
        const address = this.surfaceRuntime.fieldAddress(active!.key)!
        model!.updateForm(address, { kind: 'reset', fieldId: address.fieldId })
        return
      }
      case 'picker-open': {
        const select = active as Extract<ControlDescriptor, { readonly kind: 'select' }>
        this.state.beginSelectEditing(select.field, select.key)
        return
      }
      case 'picker-move':
      case 'picker-toggle': {
        const address = this.surfaceRuntime.fieldAddress(active.key)!
        const picker = model?.form(address)?.fields[address.fieldId]?.picker
        /* v8 ignore next -- an open picker always has a frontend model. */
        if (picker === undefined) return
        if (intent.kind === 'picker-move') model!.updateForm(address, { kind: 'picker', fieldId: address.fieldId, intent: { kind: 'move', direction: intent.delta, count: 1 } })
        else if (picker.focusedId !== undefined) model!.updateForm(address, { kind: 'picker', fieldId: address.fieldId, intent: { kind: 'toggle', id: picker.focusedId } })
        return
      }
      case 'picker-apply': this.applyPicker(active as Extract<ControlDescriptor, { readonly kind: 'select' }>); return
      case 'tab-move': {
        const group = controlGroups(controls).find(candidate => candidate.id === active.group)!
        const current = group.entries.findIndex(entry => entry.index === this.state.lastIndex)
        const target = group.entries[current + intent.delta]
        if (target === undefined) return
        this.moveTo(target.index, controls)
        this.state.emit((target.control as Extract<ControlDescriptor, { readonly kind: 'event' }>).event)
        return
      }
      case 'tab-descend': {
        const groups = controlGroups(controls)
        const target = groups[groups.findIndex(group => group.id === active.group) + 1]
        if (target !== undefined) this.moveTo(groupTarget(controls, target.id, this.state.groupActiveKeys.get(target.id)), controls)
        return
      }
      case 'list-move': {
        const target = this.surfaceRuntime.moveList(listNode!, intent.movement, Math.max(1, Math.min(10, this.viewport.rows - 1)))
        if (target === undefined || target.index === (active as Extract<ControlDescriptor, { readonly kind: 'event' }>).listEntry!.index) return
        this.focusRow(listNode!, target.item.id, listAddress!.pagePath)
        return
      }
      case 'segment': {
        const row = active as Extract<ControlDescriptor, { readonly kind: 'event' }>
        model?.updateChoice(listAddress!, { kind: 'segment', id: admittedListItem(listNode!.items, row.listEntry!.index)!.id, direction: intent.delta })
        return
      }
      case 'branch': {
        const row = active as Extract<ControlDescriptor, { readonly kind: 'event' }>
        const item = admittedListItem(listNode!.items, row.listEntry!.index)!
        const choice = model?.choice(listAddress!)
        const expanded = choice?.expandedIds.includes(item.id) === true
        // Space toggles; Right opens a closed parent; Left closes an open one.
        const toggle = intent.expand === undefined ? true : intent.expand ? !expanded && choice?.treeIndex?.parents.has(item.id) === true : expanded
        if (toggle) model?.updateChoice(listAddress!, { kind: 'expand', id: item.id })
        return
      }
      case 'accept':
        if (active.kind === 'list') this.state.emit({ kind: 'selection-accept', pagePath: active.identity.pagePath!, controlId: active.node.id, selectedIds: model?.choice(listAddress!)?.selectedIds ?? [] })
        else this.state.emit((active as Extract<ControlDescriptor, { readonly kind: 'event' }>).event)
        return
      case 'commit': this.state.emit((active as Extract<ControlDescriptor, { readonly kind: 'event' }>).commitEvent!); return
      case 'toggle-row': this.state.emit((active as Extract<ControlDescriptor, { readonly kind: 'event' }>).event); return
      case 'navigate': this.navigate(intent.direction, controls, active); return
      case 'activate':
        if (active.kind === 'field-action') {
          model?.updateForm(active.address, active.action.intent)
          model?.focusControl({ pagePath: active.address.pagePath, controlId: active.address.fieldId })
          this.restoreFocusIdentity({ pagePath: active.address.pagePath, controlId: active.address.fieldId })
        } else if (active.kind === 'toggle') this.state.setValue(active.key, !this.state.fieldValue(active.field, active.key))
        else if (active.kind === 'submit') model?.invoke(active.form.submitActionId!, active.identity.pagePath!)
        else this.state.emit((active as Extract<ControlDescriptor, { readonly kind: 'event' }>).event)
        return
    }
  }

  invalidate(): void {
    this.frameResult = undefined
    if (this.surfaceRuntime.current(this.generation)) this.root.invalidate?.()
  }
}

/** Passive facade that deliberately does not expose focus or input methods. */
class CompiledStatusComponent implements MayflyStatusComponent {
  constructor(private readonly surface: CompiledSurface, private readonly maxRows: number) {}
  render(width: number): string[] { return this.renderStatus(width).rows }
  renderStatus(width: number): MayflyStatusRenderResult { return this.surface.renderStatus(width, this.maxRows) }
  invalidate(): void { this.surface.invalidate() }
}

/** Passive bounded facade for status validation and setup failures. */
class StatusErrorComponent implements MayflyStatusComponent {
  private readonly error: ErrorComponent
  constructor(message: string, colors: MayflySemanticColors, private readonly maxRows: number) {
    this.error = new ErrorComponent(message, colors)
  }
  render(width: number): string[] { return this.renderStatus(width).rows }
  renderStatus(width: number): MayflyStatusRenderResult {
    const rows = this.error.render(width)
    return { rows: rows.slice(0, this.maxRows), overflowed: rows.length > this.maxRows }
  }
  invalidate(): void { this.error.invalidate() }
}

function admittedSurface(node: CompilableNode, options: MayflyUiCompilerOptions, mode: CompilerMode, editor?: MayflyEditor, surfaceRuntime?: MayflyUiSurfaceRuntime, contextKeyHints = false, contextEscapeHint?: EscapeLabel): CompiledSurface {
  const rollback = surfaceRuntime?.checkpoint()
  try { return new CompiledSurface(node, options, mode, editor, surfaceRuntime, contextKeyHints && !(node.kind === 'surface' && node.hint === 'none'), surfaceEscape(node, contextEscapeHint)) }
  catch (error) { rollback?.(); throw error }
}

function statusRowLimit(value: MayflyStatusCompilerOptions['maxRows']): number {
  return value === 2 || value === 3 ? value : 1
}

/** Validate first, then compile one canonical UI tree without a bypass path. */
export function compileMayflyUiNode(value: unknown, options: MayflyUiCompilerOptions): MayflyUiCompileResult {
  const admitted = validateMayflyUiNode(value, options.counters, options.admission)
  if (!admitted.ok) {
    return { ok: false, code: admitted.code, message: admitted.message, errorComponent: new ErrorComponent(admitted.message, options.colors) }
  }
  try {
    const contextKeyHints = options.contextHints?.enabled === true
    const contextEscapeHint = options.onUnhandledEscape === undefined ? undefined : 'close'
    const surface = admittedSurface(admitted.value, options, 'ui', undefined, undefined, contextKeyHints, contextEscapeHint)
    const hasControls = surface.hasControls()
    const focusTarget = hasControls || (contextKeyHints && options.contextHints?.focusWithoutControls === true) ? surface : null
    return { ok: true, value: { node: admitted.value, component: surface, focusTarget } }
  } catch {
    const message = 'Mayfly UI compilation failed safely'
    return { ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION', message, errorComponent: new ErrorComponent(message, options.colors) }
  }
}

/** Compile one validated projection into a bridge-owned persistent runtime. */
export function compileMayflyUiSurfaceNode(value: unknown, options: MayflyUiSurfaceCompilerOptions): MayflyUiCompileResult {
  const admitted = value !== null && value === options.surfaceRuntime.interaction?.node
    ? { ok: true as const, value: value as MayflyUiNode } : validateMayflyUiNode(value, options.counters, options.admission)
  if (!admitted.ok) {
    return { ok: false, code: admitted.code, message: admitted.message, errorComponent: new ErrorComponent(admitted.message, options.colors) }
  }
  try {
    const contextEscapeHint = options.onUnhandledEscape === undefined ? undefined : options.escapeHint ?? 'close'
    let node = admitted.value
    if (options.title !== undefined) {
      const frame = validateMayflyUiNode({ kind: 'surface', chrome: 'overlay', title: options.title, padding: 1, child: { kind: 'spacer' } }, options.counters)
      if (!frame.ok || frame.value.kind !== 'surface') throw new Error('invalid surface title')
      node = admitted.value.kind === 'surface' && admitted.value.chrome === 'overlay'
        ? { ...admitted.value, title: options.title }
        : { ...frame.value, child: node }
    }
    const surface = admittedSurface(node, options, 'ui', undefined, options.surfaceRuntime, true, contextEscapeHint)
    const hasControls = surface.hasControls()
    const focusTarget = hasControls || options.contextHints?.focusWithoutControls === true ? surface : null
    return { ok: true, value: { node: admitted.value, component: surface, focusTarget } }
  } catch {
    const message = 'Mayfly UI compilation failed safely'
    return { ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION', message, errorComponent: new ErrorComponent(message, options.colors) }
  }
}

/** Validate an editor shell, then compile it around the exact injected engine. */
export function compileMayflyEditorShellNode(value: unknown, options: MayflyEditorShellCompilerOptions): MayflyEditorShellCompileResult {
  const admitted = validateMayflyEditorShellNode(value, options.counters, options.admission)
  if (!admitted.ok) {
    return { ok: false, code: admitted.code, message: admitted.message, errorComponent: new ErrorComponent(admitted.message, options.colors) }
  }
  try {
    const surface = admittedSurface(admitted.value, options, 'editor', options.editor)
    return { ok: true, value: { node: admitted.value, component: surface, focusTarget: surface } }
  } catch {
    const message = 'Mayfly editor shell compilation failed safely'
    return { ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION', message, errorComponent: new ErrorComponent(message, options.colors) }
  }
}

/** Validate the non-interactive status subset, then compile it through the canonical painter. */
export function compileMayflyStatusNode(value: unknown, options: MayflyStatusCompilerOptions): MayflyStatusCompileResult {
  const maxRows = statusRowLimit(options.maxRows)
  const admitted = validateMayflyStatusNode(value, options.counters, options.admission)
  if (!admitted.ok) {
    return { ok: false, code: admitted.code, message: admitted.message, errorComponent: new StatusErrorComponent(admitted.message, options.colors, maxRows) }
  }
  try {
    const runtimeOptions: MayflyUiCompilerOptions = {
      components: options.components,
      colors: options.colors,
      getViewport: options.getViewport,
      screenMode: options.screenMode,
      emit: PASSIVE_EVENT_SINK,
      ...(options.counters === undefined ? {} : { counters: options.counters }),
      ...(options.reuse === undefined ? {} : { reuse: options.reuse }),
    }
    const surface = admittedSurface(admitted.value, runtimeOptions, 'status')
    return { ok: true, value: { node: admitted.value, component: new CompiledStatusComponent(surface, maxRows) } }
  } catch {
    const message = 'Mayfly status compilation failed safely'
    return { ok: false, code: 'MAYFLY_INVALID_CONTRIBUTION', message, errorComponent: new StatusErrorComponent(message, options.colors, maxRows) }
  }
}
