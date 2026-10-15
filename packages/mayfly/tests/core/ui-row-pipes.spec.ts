/**
 * Row pipes: a virtual array flows a window through pi-tui's layout and through every Mayfly pipe, so a document of a
 * million rows costs the rows on screen, not the document. pi-tui's own access pattern is pinned: the layout reads a
 * leaf's `lines.length` for the height, runs the cursor-marker `findIndex` only when a leaf is clipped below its
 * length, and indexes the rows its clip covers — an upgrade that starts iterating rows differently fails here.
 */
import { ScrollView, type Component } from '@earendil-works/pi-tui'
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { describe, expect, it } from 'vitest'
import { clampRowsToWidth, padColumns } from '../../src/core/chrome.ts'
import { glyphRows } from '../../src/core/glyphs.ts'
import { ScrollRegion, type ScrollMemory } from '../../src/core/ui-scroll-region.ts'
import { ColumnStack, RowStack } from '../../src/core/ui-stacks.ts'
import { isVirtualRows, materializedRows, virtualRows } from '../../src/core/ui-rows.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth } from '../../src/core/width.ts'

/** A leaf whose rows come from a counting source: `reads` records every row pi-tui or a pipe asked for. */
function virtualLeaf(length: number): { readonly component: Component, readonly rows: string[], readonly reads: number[] } {
  const reads: number[] = []
  const rows = virtualRows({
    length,
    markerFree: true,
    row(index) { reads.push(index); return `row ${String(index)}` },
  })
  return { component: { render: () => rows, invalidate: () => {} }, rows, reads }
}

const components = { visibleWidth, truncateToWidth } as MayflyComponents
const colors = { primary: (text: string) => text, muted: (text: string) => text } as MayflySemanticColors

describe('pi-tui layout over a virtual leaf', () => {
  it('reads only the rows the scroll window covers', () => {
    const leaf = virtualLeaf(1_000_000)
    const scroll = new ScrollView(leaf.component, { scrollbar: 'hidden' })
    const frame = renderLayoutFrame(scroll, 20, 10, () => {})
    expect(frame.lines).toEqual(Array.from({ length: 10 }, (_, index) => `row ${String(index)}`))
    expect(leaf.reads).toEqual(Array.from({ length: 10 }, (_, index) => index))
    scroll.scrollTo(500_000)
    const second = renderLayoutFrame(scroll, 20, 10, () => {})
    expect(second.lines).toEqual(Array.from({ length: 10 }, (_, index) => `row ${String(index + 500_000)}`))
    expect(leaf.reads.slice(10).every(index => index >= 499_999 && index < 500_010)).toBe(true)
    expect(leaf.reads.length).toBeLessThanOrEqual(21)
  })

  it('pins the leaf clip: pi-tui scans a clipped leaf for the cursor marker on the array itself', () => {
    const leaf = virtualLeaf(1_000_000)
    // A leaf taller than its allocation is clipped: the layout asks `findIndex(CURSOR_MARKER)` and every row it must
    // test is produced — the scan a windowed leaf outside a scroll cannot afford, and the reason content clamps its
    // reported length before it reaches this path.
    const frame = renderLayoutFrame(leaf.component, 20, 10, () => {})
    expect(frame.lines.length).toBe(10)
    expect(leaf.reads.length).toBe(1_000_000)
  })
})

describe('stacks over a virtual leaf', () => {
  it('ColumnStack answers a lazy concat of its children', () => {
    const head = virtualLeaf(3)
    const body = virtualLeaf(1_000_000)
    const stack = new ColumnStack()
    stack.addChild(head.component)
    stack.addChild(body.component)
    const rows = stack.render(20)
    expect(isVirtualRows(rows)).toBe(true)
    expect(rows.length).toBe(1_000_003)
    expect(rows[0]).toBe('row 0')
    expect(head.reads).toEqual([0])
    expect(body.reads).toEqual([])
    expect(rows[999_999]).toBe('row 999996')
    expect(body.reads).toEqual([999_996])
    expect(materializedRows(rows)).toBe(2)
  })

  it('ColumnStack keeps its window inside a scroll', () => {
    const body = virtualLeaf(1_000_000)
    const stack = new ColumnStack()
    stack.addChild({ render: () => ['head'], invalidate: () => {} })
    stack.addChild(body.component)
    const scroll = new ScrollView(stack, { scrollbar: 'hidden' })
    // The scroll learns its content height from the first layout, so the window moves on the second.
    renderLayoutFrame(scroll, 20, 10, () => {})
    const seen = body.reads.length
    scroll.scrollTo(500_000)
    const frame = renderLayoutFrame(scroll, 20, 10, () => {})
    expect(frame.lines).toEqual(Array.from({ length: 10 }, (_, index) => `row ${String(index + 499_999)}`))
    expect(body.reads.slice(seen).every(index => index >= 499_998 && index < 500_010)).toBe(true)
    expect(body.reads.length - seen).toBeLessThanOrEqual(11)
  })

  it('RowStack splices only the rows someone reads', () => {
    const side = virtualLeaf(1_000_000)
    const stack = new RowStack()
    stack.addChild({ render: () => ['x'], invalidate: () => {} }, { basis: 3, grow: 0, shrink: 1 })
    stack.addChild(side.component, { basis: 0, grow: 1, shrink: 1, minSize: 1 })
    const rows = stack.render(20)
    expect(isVirtualRows(rows)).toBe(true)
    expect(rows.length).toBe(1_000_000)
    expect(rows[999_999]).toContain('row 999999')
    expect(side.reads).toEqual([999_999])
    expect(materializedRows(rows)).toBe(1)
  })
})

describe('ScrollRegion over a virtual leaf', () => {
  const region = (child: Component, memory: ScrollMemory = { offset: 0, following: undefined, away: 0 }): ScrollRegion => new ScrollRegion({
    child,
    memory,
    height: 6,
    expandedHeight: 14,
    fit: false,
    pill: false,
    follow: false,
    scrollbar: true,
    more: false,
    moreText: String,
    expanded: () => false,
    colors,
    components,
    pillText: count => `${String(count)} new`,
  })

  it('reads only its viewport plus the bar row', () => {
    const leaf = virtualLeaf(1_000_000)
    const view = region(leaf.component)
    const rows = view.render(20)
    expect(rows.length).toBe(6)
    expect(leaf.reads.length).toBeLessThanOrEqual(6)
    view.scrollToEnd()
    const end = view.render(20)
    expect(end[5]).toContain('row 999999')
    expect(leaf.reads.length).toBeLessThanOrEqual(12)
  })
})

describe('ScrollRegion that counts the rows below', () => {
  const counted = (child: Component, offset = 0): ScrollRegion => new ScrollRegion({
    child, memory: { offset, following: undefined, away: 0 }, height: 4, expandedHeight: 9, fit: false, pill: false, follow: false, scrollbar: false,
    more: true, moreText: count => `↓ ${String(count)} more`, expanded: () => false, colors, components, pillText: String,
  })
  const leaf = (count: number): Component => ({ render: () => Array.from({ length: count }, (_, index) => `row ${String(index)}`), invalidate: () => {} })

  it('puts the count of the rows still below on the last row, and follows the scroll', () => {
    const view = counted(leaf(10))
    expect(view.render(20).map(row => row.trimEnd())).toEqual(['row 0', 'row 1', 'row 2', '↓ 7 more'])
    view.scrollBy(2)
    expect(view.render(20).map(row => row.trimEnd())).toEqual(['row 2', 'row 3', 'row 4', '↓ 5 more'])
  })

  it('is content again once the end is reached, and says nothing when everything fits', () => {
    const view = counted(leaf(10))
    view.render(20)
    view.scrollToEnd()
    expect(view.render(20).map(row => row.trimEnd())).toEqual(['row 6', 'row 7', 'row 8', 'row 9'])
    expect(counted(leaf(3)).render(20).map(row => row.trimEnd())).toEqual(['row 0', 'row 1', 'row 2', ''])
  })

  it('keeps a one-row viewport as content: there is no room for the count', () => {
    const one = new ScrollRegion({
      child: leaf(5), memory: { offset: 0, following: undefined, away: 0 }, height: 1, expandedHeight: 1, fit: false, pill: false, follow: false, scrollbar: false,
      more: true, moreText: count => `↓ ${String(count)} more`, expanded: () => false, colors, components, pillText: String,
    })
    expect(one.render(20).map(row => row.trimEnd())).toEqual(['row 0'])
  })
})

describe('chrome pipes', () => {
  it('glyphRows, padColumns, and clampRowsToWidth keep a facade lazy', () => {
    const leaf = virtualLeaf(1_000_000)
    for (const rows of [
      glyphRows(leaf.rows, 'ascii'),
      padColumns(leaf.rows, 4),
      clampRowsToWidth(leaf.rows, 20, (text, target) => truncateToWidth(text, target)),
    ]) {
      expect(isVirtualRows(rows)).toBe(true)
      expect(rows.length).toBe(1_000_000)
    }
    const rows = padColumns(leaf.rows, 4)
    expect(rows[500_000]).toBe('    row 500000')
    expect(leaf.reads).toEqual([500_000])
  })
})
