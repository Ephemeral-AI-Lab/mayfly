/**
 * The compiled stacks: the rows are pi-tui's rows, a horizontal stack splices a row once, and every stack places its
 * children so a moving cell can be judged against the scroll view around it.
 */
import { HStack, ScrollView, VStack, type Component } from '@earendil-works/pi-tui'
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { describe, expect, it } from 'vitest'
import { ColumnStack, ROW_STACK_ENTRIES, RowStack, onScreen, placeChild } from '../../src/core/ui-stacks.ts'

/** A leaf that counts its renders and answers each width with the same array, as a retained leaf does. */
function leaf(rows: (width: number) => string[]): Component & { renders: number } {
  const known = new Map<number, string[]>()
  const component = {
    renders: 0,
    render(width: number): string[] {
      component.renders += 1
      let lines = known.get(width)
      if (lines === undefined) { lines = rows(width); known.set(width, lines) }
      return lines
    },
    invalidate(): void {},
  }
  return component
}
const rows = (...lines: string[]): Component & { renders: number } => leaf(() => lines)
const styled = (text: string): string => `\x1b[38;2;10;20;30m${text}\x1b[39m`

type Options = Parameters<VStack['addChild']>[1]
function pair<Stack extends VStack | HStack>(mine: Stack, theirs: VStack | HStack, children: readonly (readonly [() => Component, Options?])[]): Stack {
  for (const [child, options] of children) {
    mine.addChild(child(), options)
    theirs.addChild(child(), options)
  }
  return mine
}

describe('ColumnStack', () => {
  it('paints the rows of a VStack: gaps, a child cut to its basis, a child padded to it, and a hidden child', () => {
    for (const gap of [0, 1, 2]) {
      const theirs = new VStack([], { gap })
      const mine = pair(new ColumnStack([], { gap }), theirs, [
        [() => rows('one', 'two', 'three')],
        [() => rows('cut a', 'cut b', 'cut c'), { basis: 2 }],
        [() => rows('pad'), { basis: 3 }],
        [() => rows('never'), { visible: () => false }],
        [() => rows(styled('last'))],
      ])
      for (const width of [0, 1, 12, 40]) expect(mine.render(width), `gap ${String(gap)} width ${String(width)}`).toEqual(theirs.render(width))
    }
    expect(new ColumnStack().render(10)).toEqual([])
  })

  it('remembers the row each child starts at', () => {
    const first = rows('a', 'b')
    const second = rows('c')
    const third = rows('d', 'e')
    const stack = new ColumnStack([], { gap: 1 })
    stack.addChild(first)
    stack.addChild(second, { basis: 3 })
    stack.addChild(third)
    stack.render(20)
    const scroll = new ScrollView(stack, { scrollbar: 'hidden' })
    placeChild(stack, scroll, 0)
    renderLayoutFrame(scroll, 20, 3, () => {})
    // Rows 0-1, a gap, rows 3-5, a gap, rows 7-8: the window shows rows 0 to 2.
    expect(onScreen(first, 2)).toBe(true)
    expect(onScreen(second, 3)).toBe(false)
    expect(onScreen(third, 2)).toBe(false)
    scroll.scrollTo(6)
    expect(onScreen(first, 2)).toBe(false)
    expect(onScreen(second, 3)).toBe(false)
    expect(onScreen(third, 2)).toBe(true)
    scroll.scrollTo(2)
    expect(onScreen(second, 3)).toBe(true)
  })
})

describe('RowStack', () => {
  it('paints the rows of an HStack for every alignment, gap, and kind of basis', () => {
    for (const align of ['stretch', 'start', 'center', 'end'] as const) {
      for (const gap of [0, 1]) {
        const theirs = new HStack([], { gap, align })
        const mine = pair(new RowStack([], { gap, align }), theirs, [
          [() => rows(styled('left')), { basis: 6, grow: 0, shrink: 1 }],
          [() => rows('middle one', '中文 two', 'three'), { basis: 0, grow: 1, shrink: 1, minSize: 1 }],
          [() => leaf(width => [`w${String(width)}`.slice(0, width), 'auto']), {}],
          [() => rows('never'), { visible: () => false }],
          [() => rows('gone'), { basis: 0, grow: 0, shrink: 1 }],
        ])
        for (const width of [0, 1, 7, 24, 60]) expect(mine.render(width), `${align} gap ${String(gap)} width ${String(width)}`).toEqual(theirs.render(width))
      }
    }
    const hidden = new RowStack()
    hidden.addChild(rows('never'), { visible: () => false })
    expect(hidden.render(10)).toEqual([])
    expect(new RowStack().render(10)).toEqual([])
  })

  it('does not render a child of fixed basis to measure it, and measures a content-sized child once per rows', () => {
    const fixed = rows('fixed')
    const sized = rows('sized by content')
    const stack = new RowStack()
    stack.addChild(fixed, { basis: 8, grow: 0, shrink: 1 })
    stack.addChild(sized)
    const first = stack.render(40)
    // The fixed child is rendered at its own width only; the other at the full width, then at the width it was given.
    expect(fixed.renders).toBe(1)
    expect(sized.renders).toBe(2)
    expect(stack.render(40)).toEqual(first)
    expect(fixed.renders).toBe(2)
  })

  it('splices a row again only when the row or what is under it changed', () => {
    let tail = 'tail 0'
    const body = leaf(() => ['same row', 'same row', tail])
    const stack = new RowStack()
    stack.addChild(rows(''), { basis: 2, grow: 0, shrink: 1 })
    stack.addChild(body, { basis: 0, grow: 1, shrink: 1, minSize: 1 })
    const memo = stack as unknown as { remembered: number }
    stack.render(30)
    const spliced = memo.remembered
    stack.render(30)
    expect(memo.remembered).toBe(spliced)
    tail = 'tail 1'
    const fresh = leaf(() => ['same row', 'same row', tail])
    stack.removeChild(body)
    stack.addChild(fresh, { basis: 0, grow: 1, shrink: 1, minSize: 1 })
    stack.render(30)
    expect(memo.remembered).toBe(spliced + 1)
  })

  it('starts its memo over when it is full, and still paints the rows of an HStack', () => {
    const many = Array.from({ length: ROW_STACK_ENTRIES + 10 }, (_, index) => `row ${String(index)}`)
    const theirs = new HStack()
    const mine = pair(new RowStack(), theirs, [[() => rows(''), { basis: 1, grow: 0, shrink: 1 }], [() => leaf(() => many), { basis: 0, grow: 1, shrink: 1 }]])
    const memo = mine as unknown as { remembered: number }
    expect(mine.render(20)).toEqual(theirs.render(20))
    expect(memo.remembered).toBeGreaterThan(ROW_STACK_ENTRIES)
    expect(mine.render(21)).toEqual(theirs.render(21))
    expect(memo.remembered).toBeLessThanOrEqual(ROW_STACK_ENTRIES + 11)
  })

  it('places each child at the row its alignment gives it', () => {
    const tall = rows('1', '2', '3', '4', '5', '6')
    const short = rows('s')
    const stack = new RowStack([], { align: 'end' })
    stack.addChild(tall, { basis: 3, grow: 0, shrink: 1 })
    stack.addChild(short, { basis: 3, grow: 0, shrink: 1 })
    stack.render(10)
    const scroll = new ScrollView(stack, { scrollbar: 'hidden' })
    placeChild(stack, scroll, 0)
    renderLayoutFrame(scroll, 10, 2, () => {})
    // The short child sits on the last row of six, below a window of two.
    expect(onScreen(tall, 6)).toBe(true)
    expect(onScreen(short, 1)).toBe(false)
  })
})

describe('onScreen', () => {
  it('counts a component as on screen until a laid-out scroll view around it shows other rows', () => {
    const cell = rows('moving')
    expect(onScreen(cell, 1), 'nothing placed it').toBe(true)
    const column = new ColumnStack()
    for (let index = 0; index < 20; index += 1) column.addChild(rows(`row ${String(index)}`))
    column.addChild(cell)
    column.render(20)
    expect(onScreen(cell, 1), 'no scroll view holds it').toBe(true)
    const scroll = new ScrollView(column, { scrollbar: 'hidden' })
    placeChild(column, scroll, 0)
    expect(onScreen(cell, 1), 'the view has no window yet').toBe(true)
    renderLayoutFrame(scroll, 20, 5, () => {})
    expect(onScreen(cell, 1)).toBe(false)
    scroll.scrollToEnd()
    expect(onScreen(cell, 1)).toBe(true)
  })

  it('judges a cell inside two scroll views against both windows', () => {
    const cell = rows('moving')
    const inner = new ColumnStack()
    for (let index = 0; index < 4; index += 1) inner.addChild(rows(`inner ${String(index)}`))
    inner.addChild(cell)
    const innerScroll = new ScrollView(inner, { scrollbar: 'hidden' })
    placeChild(inner, innerScroll, 0)
    const outer = new ColumnStack()
    for (let index = 0; index < 10; index += 1) outer.addChild(rows(`outer ${String(index)}`))
    outer.addChild(innerScroll, { basis: 3 })
    const outerScroll = new ScrollView(outer, { scrollbar: 'hidden' })
    placeChild(outer, outerScroll, 0)
    renderLayoutFrame(outerScroll, 20, 4, () => {})
    outer.render(20)
    inner.render(20)
    // In view of the inner window only once that is scrolled to its end, and of the outer one only at its end.
    expect(onScreen(cell, 1)).toBe(false)
    innerScroll.scrollToEnd()
    expect(onScreen(cell, 1)).toBe(false)
    outerScroll.scrollToEnd()
    expect(onScreen(cell, 1)).toBe(true)
    innerScroll.scrollToStart()
    expect(onScreen(cell, 1)).toBe(false)
  })

  it('keeps a placement that did not change, and gives up on a chain that never ends', () => {
    const child = rows('a')
    const parent = rows('b')
    placeChild(child, parent, 2)
    placeChild(child, parent, 2)
    placeChild(parent, child, 0)
    expect(onScreen(child, 1)).toBe(true)
  })
})
