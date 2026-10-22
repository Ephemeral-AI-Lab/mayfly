/**
 * Interaction-private adapter from canonical Mayfly UI nodes to the editor
 * replacement slot. Product panels own only readonly nodes and UI events;
 * core remains the sole validator, compiler, focus, and renderer boundary.
 *
 * @module @ephemeral-ai/mayfly/interaction/canonical-panel
 */

import type { MayflyUiEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import {
  compileMayflyUiNode,
  type MayflyComponents,
  type MayflyEditor,
  type MayflyFocusable,
  type MayflyFocusIdentity,
  type MayflyTheme,
  type MayflyUiCompileResult,
} from '../core/index.ts'
import type { MayflyTranslate } from '../frontend/index.ts'

/** One interaction-private contextual operation merged by core. */
export interface CanonicalContextHint {
  readonly id: string
  readonly keys: string
  readonly label?: string
  readonly compact?: string
  readonly priority?: number
}

/** A controller that can expose its current canonical node. */
export interface CanonicalNodeSource {
  focused: boolean
  currentNode(): MayflyUiNode
  currentFocusIdentity?(): MayflyFocusIdentity | undefined
  handleInput(data: string): void
  invalidate(): void
}

/** Dependencies for one canonical editor-slot adapter. */
export interface CanonicalPanelAdapterOptions {
  readonly components: MayflyComponents
  readonly theme: MayflyTheme
  readonly node: () => MayflyUiNode
  readonly onEvent: (event: MayflyUiEvent) => void
  readonly onUnhandledEscape?: () => void
  readonly maxLeafRows?: number | (() => number)
  readonly leafRowWindowPath?: string
  readonly leafRowOffset?: () => number
  readonly onLeafRowOffset?: (offset: number, totalRows: number, limit: number) => void
  readonly onTextSubmit?: (controlId: string, value: string) => void
  readonly onFocusChange?: (identity: MayflyFocusIdentity) => void
  /** Dynamic translator for core-owned contextual operation labels. */
  readonly t?: MayflyTranslate
  /** Controller-only operations that canonical control roles cannot infer. */
  readonly contextHints?: () => readonly CanonicalContextHint[]
  /** Complex controllers may replace the automatic control-role hints. */
  readonly suppressAutomaticContextHints?: boolean
  /** Controller-only overlays remain focusable even without canonical controls. */
  readonly focusWithoutControls?: boolean
  /** Semantic fallback used when the previously focused control disappeared. */
  readonly fallbackFocusIdentity?: () => MayflyFocusIdentity | undefined
  /** Whether the restored text control is already in an explicit edit mode. */
  readonly startEditing?: () => boolean
}

/** Compile canonical nodes lazily while preserving the outer focus identity. */
export class CanonicalPanelAdapter implements MayflyFocusable {
  private ownFocused = false
  private revision = 0
  private compiledRevision = -1
  private result: MayflyUiCompileResult | undefined
  private columns = 80
  private readonly editors = new Map<string, MayflyEditor>()
  private focusIdentity: MayflyFocusIdentity | undefined
  private leafRows = 0
  private leafLimit = 0

  constructor(private readonly options: CanonicalPanelAdapterOptions) {}

  get focused(): boolean { return this.ownFocused }

  set focused(value: boolean) {
    this.ownFocused = value
    const target = this.focusTarget()
    if (target !== null) target.focused = value
  }

  /** Mark the current node stale; the next operation recompiles it. */
  invalidate(): void {
    if (this.result?.ok === true) this.focusIdentity = this.result.value.focusTarget?.captureFocusIdentity?.() ?? this.focusIdentity
    const component = this.result === undefined
      ? undefined
      : this.result.ok ? this.result.value.component : this.result.errorComponent
    component?.invalidate()
    for (const editor of this.editors.values()) {
      editor.focused = false
      editor.onChange = undefined
      editor.onSubmit = undefined
    }
    this.revision += 1
    this.result = undefined
  }

  /** Rebuild with one explicit semantic control as the next focus target. */
  focus(identity: MayflyFocusIdentity): void {
    this.invalidate()
    this.focusIdentity = identity
  }

  /** Read the compiler-owned semantic identity without changing focus. */
  currentFocusIdentity(): MayflyFocusIdentity | undefined {
    if (this.result?.ok === true) {
      return this.result.value.focusTarget?.captureFocusIdentity?.() ?? this.focusIdentity
    }
    return this.focusIdentity
  }

  /** Forward input only through the compiler-owned focus target. */
  handleInput(data: string): void {
    const target = this.focusTarget()
    if (target !== null) target.handleInput?.(data)
    else if (data === '\x1b') this.options.onUnhandledEscape?.()
  }

  /** Render only through the compiler-owned component or safe error surface. */
  render(width: number): string[] {
    this.columns = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
    const revision = this.revision
    const rows = this.component().render(this.columns)
    return this.revision === revision ? rows : this.component().render(this.columns)
  }

  private compile(): MayflyUiCompileResult {
    if (this.result !== undefined && this.compiledRevision === this.revision) return this.result
    let node: MayflyUiNode
    try {
      node = this.options.node()
    } catch (error) {
      node = {
        kind: 'text',
        content: `dialog unavailable: ${error instanceof Error ? error.message : 'unknown node builder failure'}`,
        tone: 'danger',
      }
    }
    const result = compileMayflyUiNode(node, {
      components: this.options.components,
      colors: this.options.theme.colors,
      getViewport: () => ({ columns: this.columns, rows: Number.MAX_SAFE_INTEGER }),
      screenMode: 'main',
      maxLeafRows: typeof this.options.maxLeafRows === 'function' ? this.options.maxLeafRows() : this.options.maxLeafRows ?? 256,
      ...(this.options.leafRowWindowPath === undefined ? {} : { leafRowWindowPath: this.options.leafRowWindowPath }),
      ...(this.options.leafRowOffset === undefined ? {} : { leafRowOffset: this.options.leafRowOffset }),
      ...(this.options.onLeafRowOffset === undefined ? {} : {
        onLeafRowOffset: (offset: number, totalRows: number, limit: number) => {
          this.leafRows = totalRows
          this.leafLimit = limit
          this.options.onLeafRowOffset?.(offset, totalRows, limit)
        },
        onLeafRowScroll: (offset: number) => this.options.onLeafRowOffset?.(offset, this.leafRows, this.leafLimit),
      }),
      resolveTextEditor: (controlId, path) => {
        const key = `${path}:${controlId}`
        let editor = this.editors.get(key)
        if (editor === undefined) {
          editor = this.options.components.createEditor()
          this.editors.set(key, editor)
        }
        return editor
      },
      ...(this.options.onTextSubmit === undefined ? {} : { onTextSubmit: this.options.onTextSubmit }),
      ...(this.options.onFocusChange === undefined ? {} : { onFocusChange: this.options.onFocusChange }),
      contextHints: {
        enabled: true,
        ...(this.options.suppressAutomaticContextHints === true ? { suppressAuto: true } : {}),
        ...(this.options.focusWithoutControls === true ? { focusWithoutControls: true } : {}),
        ...(this.options.t === undefined ? {} : { translate: this.options.t }),
        ...(this.options.contextHints === undefined ? {} : { extra: this.options.contextHints }),
      },
      emit: this.options.onEvent,
      ...(this.options.onUnhandledEscape === undefined ? {} : { onUnhandledEscape: this.options.onUnhandledEscape }),
    })
    this.result = result
    this.compiledRevision = this.revision
    const target = result.ok ? result.value.focusTarget : null
    if (target !== null) {
      target.focused = this.ownFocused
      let restored = this.focusIdentity !== undefined && target.restoreFocusIdentity?.(this.focusIdentity) === true
      const fallback = this.options.fallbackFocusIdentity?.()
      if (!restored && fallback !== undefined) restored = target.restoreFocusIdentity?.(fallback) === true
      if (this.options.startEditing?.() === true) target.handleInput?.('\r')
    }
    return result
  }

  private component() {
    const result = this.compile()
    return result.ok ? result.value.component : result.errorComponent
  }

  private focusTarget(): MayflyFocusable | null {
    const result = this.compile()
    return result.ok ? result.value.focusTarget : null
  }
}
