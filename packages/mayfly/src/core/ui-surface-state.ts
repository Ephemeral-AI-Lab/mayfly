/** Renderer-private form, control, scroll, and virtual-list state stores.
 * @module @ephemeral-ai/mayfly/core/ui-surface-state
 */
import type { MayflyFormField, MayflyListNode } from '@ephemeral-ai/mayfly-ui'
import type { Component } from '@earendil-works/pi-tui'
import { admittedListIndex, admittedListItem } from './ui-validator.ts'
import { WindowController } from './window-controller.ts'

export interface UiControlBinding {
  readonly component: Component
  readonly axis: 'horizontal' | 'vertical' | 'none'
}

export interface UiScrollControl {
  readonly viewportHeight: number
  scrollBy(amount: number): void
  scrollToStart(): void
  scrollToEnd(): void
  setScrollbarActive(active: boolean): void
}

/** Compiled control and scroll handles for the current generation. */
export class UiControlStore {
  readonly bindings = new Map<string, UiControlBinding>()
  readonly scrolls = new Map<string, UiScrollControl>()

  bind(keys: readonly string[], binding: UiControlBinding): void {
    for (const key of keys) this.bindings.set(key, binding)
  }

  bindScroll(key: string, scroll: UiScrollControl): void { this.scrolls.set(key, scroll) }

  resetGeneration(): void {
    this.bindings.clear()
    this.scrolls.clear()
  }

  checkpoint(): () => void {
    const bindings = new Map(this.bindings)
    const scrolls = new Map(this.scrolls)
    return () => {
      this.bindings.clear(); for (const [key, value] of bindings) this.bindings.set(key, value)
      this.scrolls.clear(); for (const [key, value] of scrolls) this.scrolls.set(key, value)
    }
  }
}

interface SelectDraft {
  readonly canonical: string | null
  readonly value: string | null
  readonly editingOrigin: string | null | undefined
}

/** Canonical and local values for form controls across internal recompiles. */
export class UiFormStateStore {
  private readonly text = new Map<string, { canonical: string, value: string }>()
  private readonly selects = new Map<string, SelectDraft>()
  private readonly toggles = new Map<string, { canonical: boolean, value: boolean }>()

  value(field: MayflyFormField, stateKey: string): string | boolean | null {
    if (field.kind === 'toggle') {
      const current = this.toggles.get(stateKey)
      if (current !== undefined && current.canonical === field.value) return current.value
      this.toggles.set(stateKey, { canonical: field.value, value: field.value })
      return field.value
    }
    if (field.kind === 'select') {
      const current = this.selects.get(stateKey)
      if (current !== undefined && current.canonical === field.value) return current.value
      this.selects.set(stateKey, { canonical: field.value, value: field.value, editingOrigin: undefined })
      return field.value
    }
    const current = this.text.get(stateKey)
    if (current !== undefined && current.canonical === field.value) return current.value
    this.text.set(stateKey, { canonical: field.value, value: field.value })
    return field.value
  }

  setText(key: string, canonical: string, value: string): void { this.text.set(key, { canonical, value }) }

  setSelect(key: string, canonical: string | null, value: string | null): void {
    this.selects.set(key, { canonical, value, editingOrigin: this.selects.get(key)?.editingOrigin })
  }

  beginSelect(field: Extract<MayflyFormField, { readonly kind: 'select' }>, stateKey: string): void {
    const value = this.value(field, stateKey) as string | null
    this.selects.set(stateKey, { canonical: field.value, value, editingOrigin: value })
  }

  finishSelect(field: Extract<MayflyFormField, { readonly kind: 'select' }>, stateKey: string, cancel: boolean): string | null {
    const current = this.selects.get(stateKey)
    const candidate = current?.value ?? field.value
    const value = cancel && current?.editingOrigin !== undefined ? current.editingOrigin : candidate
    this.selects.set(stateKey, { canonical: field.value, value, editingOrigin: undefined })
    return value
  }

  cancelSelect(stateKey: string): void {
    const current = this.selects.get(stateKey)
    if (current?.editingOrigin !== undefined) {
      this.selects.set(stateKey, { canonical: current.canonical, value: current.editingOrigin, editingOrigin: undefined })
    }
  }

  setToggle(key: string, canonical: boolean, value: boolean): void { this.toggles.set(key, { canonical, value }) }

  resetExternal(): void {
    this.text.clear()
    this.selects.clear()
    this.toggles.clear()
  }

  evict(stateKey: string): void {
    this.text.delete(stateKey)
    this.selects.delete(stateKey)
    this.toggles.delete(stateKey)
  }

  checkpoint(): () => void {
    const text = new Map(this.text)
    const selects = new Map(this.selects)
    const toggles = new Map(this.toggles)
    return () => {
      this.text.clear(); for (const [key, value] of text) this.text.set(key, value)
      this.selects.clear(); for (const [key, value] of selects) this.selects.set(key, value)
      this.toggles.clear(); for (const [key, value] of toggles) this.toggles.set(key, value)
    }
  }
}

export interface UiVirtualListEntry {
  readonly index: number
  readonly item: NonNullable<ReturnType<typeof admittedListItem>>
}

export type UiListMovement = 'up' | 'down' | 'page-up' | 'page-down' | 'home' | 'end'

/** Bounded list windows and semantic cursor anchors across snapshot replacement. */
export class UiListStateStore {
  private readonly cursors = new Map<string, { items: MayflyListNode['items'], index: number, itemId?: string }>()
  private readonly windows = new Map<string, WindowController>()

  window(node: MayflyListNode, rowLimit: number): readonly UiVirtualListEntry[] {
    if (node.items.length === 0) return []
    const cursor = this.cursor(node)
    const visible = Math.max(1, Number.isFinite(rowLimit) ? Math.floor(rowLimit) : 20)
    let controller = this.windows.get(node.id)
    if (controller === undefined) {
      controller = new WindowController()
      this.windows.set(node.id, controller)
    }
    const size = Math.min(node.items.length, visible + 4)
    const start = controller.update(node.items.length, size, Math.max(0, cursor - Math.floor(size / 2))).offset
    return Array.from({ length: size }, (_, offset) => {
      const index = start + offset
      return { index, item: admittedListItem(node.items, index)! }
    })
  }

  move(node: MayflyListNode, from: number, movement: UiListMovement, pageSize: number): UiVirtualListEntry | undefined {
    if (node.items.length === 0) return undefined
    const direction = movement === 'up' || movement === 'page-up' || movement === 'end' ? -1 : 1
    let index = movement === 'home' ? -1 : movement === 'end' ? node.items.length : from
    let remaining = movement === 'page-up' || movement === 'page-down' ? Math.max(1, Math.floor(pageSize)) : 1
    let target: UiVirtualListEntry | undefined
    while (remaining > 0) {
      const candidate = index + direction
      if (candidate < 0 || candidate >= node.items.length) break
      index = candidate
      const item = admittedListItem(node.items, index)!
      if (item.disabled === true) continue
      target = { index, item }
      remaining -= 1
    }
    if (target === undefined) return undefined
    this.cursors.set(node.id, { items: node.items, index: target.index, itemId: target.item.id })
    return target
  }

  checkpoint(): () => void {
    const cursors = new Map(this.cursors)
    const windows = new Map([...this.windows].map(([key, value]) => [key, value.clone()] as const))
    return () => {
      this.cursors.clear()
      for (const [key, value] of cursors) this.cursors.set(key, value)
      this.windows.clear()
      for (const [key, value] of windows) this.windows.set(key, value)
    }
  }

  clear(): void { this.cursors.clear(); this.windows.clear() }

  private cursor(node: MayflyListNode): number {
    const previous = this.cursors.get(node.id)
    if (previous?.items === node.items && previous.index < node.items.length) return previous.index
    const anchor = previous?.itemId ?? node.selectedIds[0]
    let index = anchor === undefined ? 0 : admittedListIndex(node.items, anchor)
    if (index < 0) index = Math.min(previous?.index ?? 0, Math.max(0, node.items.length - 1))
    let item = admittedListItem(node.items, index)!
    if (item.disabled === true) {
      const replacement = this.findEnabled(node, index + 1, 1) ?? this.findEnabled(node, index - 1, -1)
      if (replacement !== undefined) {
        index = replacement.index
        item = replacement.item
      }
    }
    this.cursors.set(node.id, { items: node.items, index, itemId: item.id })
    return index
  }

  private findEnabled(node: MayflyListNode, start: number, direction: -1 | 1): UiVirtualListEntry | undefined {
    for (let index = start; index >= 0 && index < node.items.length; index += direction) {
      const item = admittedListItem(node.items, index)!
      if (item.disabled !== true) return { index, item }
    }
    return undefined
  }
}
