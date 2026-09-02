/**
 * Flexible dock mount compatibility tests.
 *
 * @module @ephemeral-ai/mayfly/core/tests/dock
 */

import { describe, expect, it, vi } from 'vitest'
import { mountDockChild } from '../../src/core/dock.ts'
import type { MayflyComponent, MayflyScreen } from '../../src/core/types.ts'

const component: MayflyComponent = {
  render: () => ['dock'],
  invalidate: () => {},
}

describe('mountDockChild', () => {
  it('uses the shared allocator when the screen exposes it', () => {
    const dispose = vi.fn()
    const addDockChild = vi.fn(() => dispose)
    const addBottomChild = vi.fn(() => vi.fn())
    const screen = { addDockChild, addBottomChild } as unknown as MayflyScreen

    expect(mountDockChild(screen, component, { priority: 30 })).toBe(dispose)
    expect(addDockChild).toHaveBeenCalledWith(component, { priority: 30 })
    expect(addBottomChild).not.toHaveBeenCalled()
  })

  it('falls back to the legacy bottom mount for structural adapters', () => {
    const dispose = vi.fn()
    const addBottomChild = vi.fn(() => dispose)
    const screen = { addBottomChild } as unknown as MayflyScreen

    expect(mountDockChild(screen, component)).toBe(dispose)
    expect(addBottomChild).toHaveBeenCalledWith(component)
  })
})
