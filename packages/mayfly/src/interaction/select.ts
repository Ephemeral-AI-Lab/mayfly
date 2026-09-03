/**
 * Canonical multi-select and panel adapters for editor-slot overlays.
 * Interaction state stays local while core compiles every public UI node.
 *
 * @module @ephemeral-ai/mayfly/interaction/select
 */

import type { MayflyUiEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyComponents, MayflyFocusable, MayflyKeymap, MayflyTheme } from '../core/index.ts'
import { CanonicalPanelAdapter } from './canonical-panel.ts'
import { ACTION_SUBMIT } from './keys.ts'
import { MAX_LIST_VISIBLE, counterRow, oneLine } from './select-list.ts'

/** One selectable entry. */
export interface MayflySelectItem { readonly value: string, readonly label: string, readonly description?: string }

/** Construction options for {@link CanonicalMultiSelectController}. */
export interface MayflySelectOptions {
  readonly keymap: MayflyKeymap
  readonly theme: MayflyTheme
  readonly components: MayflyComponents
  readonly items: readonly MayflySelectItem[]
  readonly title?: string
  readonly onConfirm: (items: MayflySelectItem[]) => void
  readonly onCancel: () => void
}

/** Canonical multi-select controller with bounded navigation and fallback confirm. */
export class CanonicalMultiSelectController implements MayflyFocusable {
  private readonly adapter: CanonicalPanelAdapter
  private cursor = 0
  private readonly toggled = new Set<string>()

  constructor(private readonly options: MayflySelectOptions) {
    this.adapter = new CanonicalPanelAdapter({
      components: options.components,
      theme: options.theme,
      node: () => this.currentNode(),
      onEvent: event => this.onEvent(event),
      onFocusChange: identity => {
        /* v8 ignore next -- core reports only rows from this list. */
        if (identity.controlId !== 'mayfly-select' || identity.itemId === undefined) return
        const index = this.options.items.findIndex(item => item.value === identity.itemId)
        /* v8 ignore next -- core reports a changed, enabled item identity. */
        if (index < 0 || index === this.cursor) return
        this.cursor = index
        this.adapter.focus(identity)
      },
      onUnhandledEscape: options.onCancel,
      maxLeafRows: MAX_LIST_VISIBLE,
      suppressAutomaticContextHints: true,
      contextHints: () => [
        { id: 'toggle', keys: 'Space', label: 'toggle', priority: 100 },
        { id: 'confirm', keys: 'Enter', label: 'confirm', priority: 95 },
        { id: 'dismiss', keys: 'Esc', label: 'close', priority: 90 },
      ],
    })
  }

  get focused(): boolean { return this.adapter.focused }
  set focused(value: boolean) { this.adapter.focused = value }

  handleInput(data: string): void {
    if (this.options.keymap.matches(data, ACTION_SUBMIT)) { this.options.onConfirm(this.confirmed()); return }
    this.adapter.handleInput(data)
  }

  invalidate(): void { this.adapter.invalidate() }
  render(width: number): string[] { return this.adapter.render(width) }

  /** Current canonical overlay node. */
  currentNode(): MayflyUiNode {
    const counter = counterRow(this.cursor, this.options.items.length, MAX_LIST_VISIBLE)
    return {
      kind: 'surface', chrome: 'overlay', title: this.options.title ?? 'Select',
      child: {
        kind: 'list', id: 'mayfly-select', mode: 'multiple', selectedIds: [...this.toggled],
        items: this.options.items.map(item => ({
          id: item.value, label: item.label,
          ...(item.description === undefined ? {} : { detail: oneLine(item.description) }),
        })),
      },
      ...(counter === undefined ? {} : { footer: { kind: 'text', content: counter, tone: 'muted' } as const }),
    }
  }

  private onEvent(event: MayflyUiEvent): void {
    if (event.kind !== 'selection-change' || event.controlId !== 'mayfly-select' || !Array.isArray(event.value)) return
    this.toggled.clear()
    for (const value of event.value) if (typeof value === 'string') this.toggled.add(value)
    this.adapter.invalidate()
  }

  private confirmed(): MayflySelectItem[] {
    const chosen = this.options.items.filter(item => this.toggled.has(item.value))
    if (chosen.length > 0) return [...chosen]
    const focused = this.options.items[this.cursor]
    return focused === undefined ? [] : [focused]
  }
}
