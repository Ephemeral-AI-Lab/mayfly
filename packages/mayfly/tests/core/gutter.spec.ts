/**
 * The `GutterComponent` (D29, consumed in S21): the kimi one-column gutter
 * wrapper — the child renders at `width - 2n` and every row gains the
 * leading gutter column, styling untouched, with `invalidate` forwarded.
 */

import { describe, expect, it } from 'vitest'
import { GutterComponent } from '../../src/core/gutter.ts'
import type { MayflyComponent } from '../../src/core/types.ts'

/** A fixed-rows child recording renders and invalidations. */
function child(rows: string[]): MayflyComponent & { invalidated: number } {
  const state = { invalidated: 0 }
  return {
    render: (): string[] => rows,
    invalidate: (): void => {
      state.invalidated += 1
    },
    get invalidated(): number {
      return state.invalidated
    },
  } as MayflyComponent & { invalidated: number }
}

describe('GutterComponent', () => {
  it('squeezes the child by two columns and pads the left gutter', () => {
    const rendered: number[] = []
    const inner = child(['aaa', 'bbb'])
    const wrapped = new GutterComponent({
      render: (width) => {
        rendered.push(width)
        return inner.render(width)
      },
      invalidate: () => inner.invalidate(),
    })
    expect(wrapped.render(10)).toEqual([' aaa', ' bbb'])
    // The child saw `width - 2` — the squeeze is the right margin.
    expect(rendered).toEqual([8])
  })

  it('keeps blank rows as single gutter columns and honors a custom n', () => {
    const wrapped = new GutterComponent(child(['']), 2)
    expect(wrapped.render(10)).toEqual(['  '])
  })

  it('forwards invalidate to the wrapped child', () => {
    const inner = child(['x'])
    const wrapped = new GutterComponent(inner)
    wrapped.invalidate()
    expect(inner.invalidated).toBe(1)
  })
})
