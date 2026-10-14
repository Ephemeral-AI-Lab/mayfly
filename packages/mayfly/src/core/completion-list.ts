/**
 * The editor's completion list as state only. pi-tui's `Editor` instantiates it through a private factory and keeps
 * filtering, selection, and the keys; this subclass paints no rows, so the editor's rows never grow with the list, and
 * hands the state to the drawer (`completion-drawer.ts`) that draws it over the stream.
 *
 * The single cast is pinned against pi-tui 0.84.2 by the companion spec.
 *
 * @module @ephemeral-ai/mayfly/core/completion-list
 */

import { SelectList, type SelectItem, type SelectListTheme } from '@earendil-works/pi-tui'
import type { MayflyCompletionView } from './types.ts'

/** The private pi-tui row state the view reads (see module doc). */
interface SelectListInternals {
  readonly filteredItems: SelectItem[]
  readonly selectedIndex: number
}

/** A select list that keeps pi-tui's state and keys and paints nothing. */
export class CompletionList extends SelectList {
  /** The prefix the provider matched; it names the list's kind. */
  readonly prefix: string

  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme, prefix: string) {
    super(items, maxVisible, theme)
    this.prefix = prefix
  }

  override render(): string[] {
    return []
  }

  /**
   * The list as facts.
   * @returns the kind, the kept items, and the focused index.
   */
  view(): MayflyCompletionView {
    const { filteredItems, selectedIndex } = this as unknown as SelectListInternals
    return {
      kind: this.prefix.startsWith('/') ? 'commands' : this.prefix.startsWith('@') ? 'files' : 'completions',
      items: filteredItems.map(item => ({
        label: item.label || item.value,
        ...(item.description === undefined ? {} : { detail: item.description }),
      })),
      index: selectedIndex,
      prefix: this.prefix,
    }
  }
}
