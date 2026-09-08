/** Renderer-private control and scroll bindings and virtual-list view contracts.
 * @module @ephemeral-ai/mayfly/core/ui-surface-state
 */
import type { Component } from '@earendil-works/pi-tui'
import type { admittedListItem } from './ui-validator.ts'

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

export interface UiVirtualListEntry {
  readonly index: number
  readonly item: NonNullable<ReturnType<typeof admittedListItem>>
}

export type UiListMovement = 'up' | 'down' | 'page-up' | 'page-down' | 'home' | 'end'
