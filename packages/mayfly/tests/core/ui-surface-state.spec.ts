/** The renderer-private control and scroll stores, including generation checkpoints.
 * @module @ephemeral-ai/mayfly/tests/core/ui-surface-state
 */
import { describe, expect, it, vi } from 'vitest'
import type { Component } from '@earendil-works/pi-tui'
import { UiControlStore, type UiControlBinding, type UiScrollControl } from '../../src/core/ui-surface-state.ts'

const component = { render: () => [] } as unknown as Component

function binding(axis: UiControlBinding['axis']): UiControlBinding {
  return { component, axis }
}

function scroll(): UiScrollControl {
  return {
    viewportHeight: 4,
    scrollBy: vi.fn(),
    scrollToStart: vi.fn(),
    scrollToEnd: vi.fn(),
    setScrollbarActive: vi.fn(),
  }
}

describe('UiControlStore', () => {
  it('binds one binding under several keys and keeps scrolls under their own key', () => {
    const store = new UiControlStore()
    const control = binding('vertical')
    store.bind(['a', 'b'], control)
    const view = scroll()
    store.bindScroll('log', view)
    expect(store.bindings.get('a')).toBe(control)
    expect(store.bindings.get('b')).toBe(control)
    expect(store.scrolls.get('log')).toBe(view)
  })

  it('resets a generation by clearing both maps', () => {
    const store = new UiControlStore()
    store.bind(['a'], binding('horizontal'))
    store.bindScroll('log', scroll())
    store.resetGeneration()
    expect(store.bindings.size).toBe(0)
    expect(store.scrolls.size).toBe(0)
  })

  it('restores the bindings and scrolls of a checkpoint after later generations', () => {
    const store = new UiControlStore()
    const first = binding('horizontal')
    const firstScroll = scroll()
    store.bind(['a'], first)
    store.bindScroll('log', firstScroll)
    const restore = store.checkpoint()
    store.resetGeneration()
    const replacement = binding('none')
    store.bind(['a', 'b'], replacement)
    store.bindScroll('other', scroll())
    restore()
    expect(store.bindings.get('a')).toBe(first)
    expect(store.bindings.has('b')).toBe(false)
    expect(store.scrolls.get('log')).toBe(firstScroll)
    expect(store.scrolls.has('other')).toBe(false)
  })

  it('restores an empty checkpoint over a populated store', () => {
    const store = new UiControlStore()
    const restore = store.checkpoint()
    store.bind(['a'], binding('vertical'))
    restore()
    expect(store.bindings.size).toBe(0)
    expect(store.scrolls.size).toBe(0)
  })
})
