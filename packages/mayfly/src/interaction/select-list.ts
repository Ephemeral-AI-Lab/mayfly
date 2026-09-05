/**
 * Canonical single-select controller and shared list geometry helpers.
 * Filtering, hydration, and command callbacks remain interaction state;
 * presentation is a public Mayfly list/surface compiled only by core.
 *
 * @module @ephemeral-ai/mayfly/interaction/select-list
 */

import type { MayflyUiEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyComponents, MayflyFocusable, MayflyFocusIdentity, MayflyKeymap, MayflyTheme } from '../core/index.ts'
import type { MayflyTranslate } from '../frontend/index.ts'
import { SearchInput } from '../core/search-input.ts'
import { CanonicalPanelAdapter, type CanonicalContextHint, type CanonicalNodeSource } from './canonical-panel.ts'
import {
  ACTION_BACKSPACE,
  ACTION_CANCEL,
  ACTION_DELETE,
  ACTION_END,
  ACTION_HOME,
  ACTION_MOVE_DOWN,
  ACTION_MOVE_UP,
  ACTION_PAGE_DOWN,
  ACTION_PAGE_UP,
  ACTION_SUBMIT,
  ACTION_TOGGLE,
  interactionKeyHint,
} from './keys.ts'

/** One selectable row of a {@link CanonicalSelectController}. */
export interface SelectRow {
  readonly value: string
  readonly label: string
  readonly filterText?: string
  readonly description?: string
  readonly badge?: string
  readonly disabled?: boolean
}

/** Construction options for {@link CanonicalSelectController}. */
export interface SelectListPanelOptions {
  readonly keymap: MayflyKeymap
  readonly theme: MayflyTheme
  readonly components: MayflyComponents
  readonly rows: readonly SelectRow[] | ((query: string) => readonly SelectRow[])
  readonly title?: string
  readonly footer?: string
  readonly contextHints?: readonly CanonicalContextHint[]
  readonly suppressAutomaticContextHints?: boolean
  readonly initialValue?: string
  readonly filter?: boolean
  readonly mode?: 'single' | 'multiple'
  readonly selectedValues?: () => readonly string[]
  /** Dynamic translator for package-owned chrome and row copy. */
  readonly t?: MayflyTranslate
  readonly onCursorChanged?: (cursor: number, rows: readonly SelectRow[]) => void
  readonly onSelect: (row: SelectRow) => void
  readonly onBlockedSelect?: (row: SelectRow) => void
  readonly onHighlight?: (row: SelectRow) => void
  readonly onToggle?: (row: SelectRow) => void
  readonly onConfirm?: () => void
  readonly onDelete?: (row: SelectRow) => void
  readonly onCancel: () => void
}

export const MAX_LIST_VISIBLE = 8

export function counterRow(cursor: number, count: number, maxVisible: number): string | undefined {
  return count > maxVisible ? `  (${cursor + 1}/${count})` : undefined
}

export function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim()
}

/** Canonical single-select panel preserving filtering and callback behavior. */
export class CanonicalSelectController implements MayflyFocusable, CanonicalNodeSource {
  private readonly adapter: CanonicalPanelAdapter
  private cursor: number
  private readonly search: SearchInput
  private get query(): string { return this.search.text }
  private filterEditing = false
  private readonly filter: boolean
  private rows: readonly SelectRow[]

  constructor(private readonly options: SelectListPanelOptions) {
    this.search = new SearchInput(options.components)
    this.rows = typeof options.rows === 'function' ? options.rows('') : options.rows
    const seeded = options.initialValue === undefined ? -1 : this.sourceRows().findIndex(row => row.value === options.initialValue)
    this.cursor = seeded >= 0 ? seeded : 0
    this.filter = options.filter === true
    this.adapter = new CanonicalPanelAdapter({
      components: options.components,
      theme: options.theme,
      keymap: options.keymap,
      node: () => this.currentNode(),
      onEvent: event => this.onEvent(event),
      onUnhandledEscape: options.onCancel,
      maxLeafRows: MAX_LIST_VISIBLE,
      ...(options.t === undefined ? {} : { t: options.t }),
      contextHints: () => [
        ...(this.filter && this.query === '' ? [{ id: 'filter', keys: 'Type', label: 'to search', priority: 85 }] : []),
        ...(this.query.length === 0 && this.options.onToggle !== undefined && this.options.mode !== 'multiple'
          ? [{ id: 'toggle', keys: interactionKeyHint(this.options.keymap, ACTION_TOGGLE, 'Space'), label: 'toggle', priority: 95 }]
          : []),
        ...(this.options.contextHints ?? []),
        ...(this.options.onDelete === undefined
          ? []
          : [{ id: 'delete', keys: interactionKeyHint(this.options.keymap, ACTION_DELETE, 'Delete'), label: 'delete', priority: 90 }]),
      ],
      ...(options.suppressAutomaticContextHints === true ? { suppressAutomaticContextHints: true } : {}),
    })
  }

  get focused(): boolean { return this.adapter.focused }
  set focused(value: boolean) { this.adapter.focused = value }

  setRows(rows: readonly SelectRow[]): void {
    const current = this.filtered()[this.cursor]?.value
    this.rows = rows
    const view = this.filtered()
    const next = current === undefined ? -1 : view.findIndex(row => row.value === current)
    this.cursor = next >= 0 ? next : Math.min(this.cursor, Math.max(0, view.length - 1))
    this.focusCursor()
  }

  handleInput(data: string): void {
    if (this.search.pending) { this.updateSearch(data); return }
    const view = this.filtered()
    if (this.options.mode === 'multiple' && this.options.onConfirm !== undefined
      && this.options.keymap.matches(data, ACTION_SUBMIT)) {
      this.options.onConfirm()
      return
    }
    if (this.options.onDelete !== undefined && this.options.keymap.matches(data, ACTION_DELETE)) {
      const row = view[this.cursor]
      if (row !== undefined) this.options.onDelete(row)
      return
    }
    if (this.query.length === 0 && this.options.onToggle !== undefined && this.options.keymap.matches(data, ACTION_TOGGLE)) {
      const row = view[this.cursor]
      if (row === undefined) return
      this.options.onToggle(row)
      const next = this.filtered()
      const anchored = next.findIndex(candidate => candidate.value === row.value)
      this.cursor = anchored >= 0 ? anchored : 0
      this.focusCursor()
      return
    }
    if (this.options.keymap.matches(data, ACTION_CANCEL)) {
      if (this.filterEditing) {
        this.filterEditing = false
        this.adapter.invalidate()
      } else this.adapter.handleInput(data)
      return
    }
    const movement = this.options.keymap.matches(data, ACTION_MOVE_UP) ? -1
      : this.options.keymap.matches(data, ACTION_MOVE_DOWN) ? 1
        : this.options.keymap.matches(data, ACTION_PAGE_UP) ? -MAX_LIST_VISIBLE
          : this.options.keymap.matches(data, ACTION_PAGE_DOWN) ? MAX_LIST_VISIBLE
            : this.options.keymap.matches(data, ACTION_HOME) ? -Infinity
              : this.options.keymap.matches(data, ACTION_END) ? Infinity
                : undefined
    if (movement !== undefined) {
      this.moveCursor(view, movement)
      return
    }
    if (!this.filter) { this.adapter.handleInput(data); return }
    if (this.updateSearch(data)) return
    this.adapter.handleInput(data)
  }

  private updateSearch(data: string): boolean {
    const backspace = this.options.keymap.matches(data, ACTION_BACKSPACE)
    if (!this.search.handleInput(data, backspace)) return false
    if (!backspace) this.filterEditing = true
    this.reseedCursor()
    this.options.onCursorChanged?.(this.cursor, this.filtered())
    this.focusCursor()
    return true
  }

  invalidate(): void { this.adapter.invalidate() }
  render(width: number): string[] { return this.adapter.render(width) }
  currentFocusIdentity(): MayflyFocusIdentity | undefined { return this.adapter.currentFocusIdentity() }
  currentRow(): SelectRow | undefined { return this.filtered()[this.cursor] }

  currentNode(): MayflyUiNode {
    const t = this.options.t ?? ((value: string) => value)
    const view = this.filtered()
    const selected = view[this.cursor]
    const footer = [
      this.options.footer === undefined ? undefined : t(this.options.footer),
      counterRow(this.cursor, view.length, MAX_LIST_VISIBLE),
    ].filter((value): value is string => value !== undefined && value !== '')
    const list = {
      kind: 'list' as const,
      id: 'select-list',
      ...(this.options.mode === undefined ? {} : { mode: this.options.mode }),
      selectedIds: this.options.mode === 'multiple'
        ? [...(this.options.selectedValues?.() ?? [])]
        : selected === undefined ? [] : [selected.value],
      ...(this.query === '' ? {} : { filter: this.query }),
      items: view.map(row => ({
        id: row.value,
        label: t(row.label),
        ...(row.description === undefined ? {} : { detail: oneLine(t(row.description)) }),
        ...(row.badge === undefined ? {} : { badge: row.badge }),
        ...(row.disabled === true ? { disabled: true } : {}),
      })),
      ...(view.length === 0 ? { empty: { kind: 'empty', title: t('no matches') } as const } : {}),
    }
    const footerNode: MayflyUiNode | undefined = this.query === ''
      ? footer.length === 0 ? undefined : { kind: 'text', content: footer.join(' · '), tone: 'muted' }
      : {
          kind: 'stack', direction: 'column', gap: 1,
          children: [
            ...footer.length === 0 ? [] : [{ node: { kind: 'text' as const, content: footer.join(' · '), tone: 'muted' as const } }],
            { node: { kind: 'actions', id: 'select-list-filter-actions', items: [{ id: 'select-list-clear-filter', label: t('Clear filter') }] } },
          ],
        }
    return {
      kind: 'surface',
      chrome: 'overlay',
      title: this.options.title === undefined ? t('Select') : t(this.options.title),
      child: list,
      ...(footerNode === undefined ? {} : { footer: footerNode }),
    }
  }

  private sourceRows(): readonly SelectRow[] {
    return typeof this.options.rows === 'function' ? this.options.rows(this.query) : this.rows
  }

  private filtered(): readonly SelectRow[] {
    const rows = this.sourceRows()
    if (!this.filter || this.query === '') return rows
    const t = this.options.t ?? ((value: string) => value)
    return rows.filter(row => this.options.components.fuzzyMatch(this.query, row.filterText ?? t(row.label)).matches)
  }

  private reseedCursor(): void {
    const view = this.filtered()
    const seeded = this.options.initialValue === undefined ? -1 : view.findIndex(row => row.value === this.options.initialValue)
    this.cursor = seeded >= 0 ? seeded : 0
  }

  private moveCursor(view: readonly SelectRow[], movement: number): void {
    if (view.length === 0) return
    if (!Number.isFinite(movement)) {
      const target = movement < 0
        ? view.findIndex(row => row.disabled !== true)
        : view.findLastIndex(row => row.disabled !== true)
      if (target < 0 || target === this.cursor) return
      this.cursor = target
      const row = view[target]!
      this.options.onHighlight?.(row)
      this.options.onCursorChanged?.(target, view)
      this.focusCursor()
      return
    }
    const direction = movement < 0 ? -1 : 1
    let remaining = Math.max(1, Math.abs(movement))
    let next = this.cursor
    let target = -1
    while (remaining > 0) {
      const candidate = next + direction
      if (candidate < 0 || candidate >= view.length) break
      next = candidate
      if (view[next]!.disabled !== true) {
        target = next
        remaining -= 1
      }
    }
    if (target < 0 || target === this.cursor) return
    this.cursor = target
    const row = view[target]!
    this.options.onHighlight?.(row)
    this.options.onCursorChanged?.(target, view)
    this.focusCursor()
  }

  private focusCursor(): void {
    const selected = this.filtered()[this.cursor]
    if (selected === undefined) this.adapter.invalidate()
    else this.adapter.focus({ controlId: 'select-list', itemId: selected.value })
  }

  private onEvent(event: MayflyUiEvent): void {
    if (event.kind === 'activate' && event.controlId === 'select-list-clear-filter') {
      this.search.clear()
      this.filterEditing = false
      this.reseedCursor()
      const view = this.filtered()
      this.options.onCursorChanged?.(this.cursor, view)
      this.focusCursor()
      return
    }
    if (event.kind !== 'selection-change' || event.controlId !== 'select-list' || typeof event.value !== 'string') return
    const row = this.filtered().find(candidate => candidate.value === event.value)
    if (row === undefined) return
    if (row.disabled === true) this.options.onBlockedSelect?.(row)
    else this.options.onSelect(row)
  }
}
