/**
 * Multi-select semantics layered over the shared canonical list controller.
 * @module @ephemeral-ai/mayfly/interaction/select
 */

import type { MayflyFocusable, MayflyKeymap, MayflyTheme, MayflyComponents } from '../core/index.ts'
import { ACTION_SUBMIT, ACTION_TOGGLE, interactionKeyHint } from './keys.ts'
import { CanonicalSelectController, type SelectRow } from './select-list.ts'

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

/** Shared-list multi-select retaining only its checked-value state. */
export class CanonicalMultiSelectController implements MayflyFocusable {
  private readonly selected = new Set<string>()
  private readonly list: CanonicalSelectController

  constructor(private readonly options: MayflySelectOptions) {
    const confirm = this.confirm.bind(this)
    const rows: SelectRow[] = options.items.map(item => ({
      value: item.value,
      label: item.label,
      ...(item.description === undefined ? {} : { description: item.description }),
    }))
    this.list = new CanonicalSelectController({
      keymap: options.keymap,
      theme: options.theme,
      components: options.components,
      rows,
      title: options.title ?? 'Select',
      mode: 'multiple',
      selectedValues: () => [...this.selected],
      onToggle: row => {
        if (this.selected.has(row.value)) this.selected.delete(row.value)
        else this.selected.add(row.value)
      },
      onSelect: confirm,
      onConfirm: confirm,
      onCancel: options.onCancel,
      contextHints: [
        {
          id: 'activate',
          keys: `${interactionKeyHint(options.keymap, ACTION_TOGGLE, 'Space')} / ${interactionKeyHint(options.keymap, ACTION_SUBMIT, 'Enter')}`,
          label: 'toggle / confirm',
          compact: 'Space/Enter',
          priority: 100,
        },
      ],
    })
  }

  get focused(): boolean { return this.list.focused }
  set focused(value: boolean) { this.list.focused = value }

  handleInput(data: string): void {
    this.list.handleInput(data)
  }

  invalidate(): void { this.list.invalidate() }
  render(width: number): string[] { return this.list.render(width) }
  currentNode() { return this.list.currentNode() }

  private confirm(): void {
    const chosen = this.options.items.filter(item => this.selected.has(item.value))
    if (chosen.length > 0) {
      this.options.onConfirm(chosen)
      return
    }
    const focused = this.list.currentRow()
    const fallback = focused === undefined ? undefined : this.options.items.find(item => item.value === focused.value)
    this.options.onConfirm(fallback === undefined ? [] : [fallback])
  }
}
