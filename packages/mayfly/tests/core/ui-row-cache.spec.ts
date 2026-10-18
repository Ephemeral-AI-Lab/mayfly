/** The list row memo: rows come back as painted, a state change repaints only what it touches, and a palette change repaints all. */
import { describe, expect, it, vi } from 'vitest'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { renderList, type PatternFocus } from '../../src/core/ui/state/ui-patterns.ts'
import { UiRowCache } from '../../src/core/ui/paint/ui-row-cache.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'

const palette = (name: string): MayflySemanticColors => new Proxy({ logoGradient: [(value: string) => value] }, {
  get: (target, key) => key === 'logoGradient' ? target.logoGradient : (value: string) => `<${name}:${String(key)}>${value}</>`,
}) as unknown as MayflySemanticColors

const list = ui.list({
  id: 'rows', role: 'browse', mode: 'multiple', numbered: true, selectedIds: ['b'],
  items: [
    { id: 'a', label: 'Alpha', detail: 'first', group: 'One' },
    { id: 'b', label: 'Beta', detailSpans: [{ text: 'second', tone: 'muted' }], badge: 'new', group: 'One' },
    { id: 'c', label: 'Gamma', disabled: true, disabledReason: 'locked', group: 'Two' },
    { id: 'd', label: 'Delta', disabled: true, detail: 'kept' },
  ],
})
const focusOn = (key: string): PatternFocus => ({ key, focused: key !== '', marker: '|' })

describe('renderList with a row memo', () => {
  it('paints exactly the rows it paints without one, across focus, width, and numbering', () => {
    const colors = palette('a')
    const memo = { cache: new UiRowCache() }
    for (const width of [30, 80]) for (const key of ['', 'a', 'b', 'c', 'd']) for (const from of [0, 7]) {
      const expected = renderList(list, width, 20, focusOn(key), colors, from)
      expect(renderList(list, width, 20, focusOn(key), colors, from, memo), `${String(width)} ${key} ${String(from)}`).toEqual(expected)
      expect(renderList(list, width, 20, focusOn(key), colors, from, memo), 'a second paint is the same').toEqual(expected)
    }
  })

  it('serves a colors object only its own rows', () => {
    const memo = { cache: new UiRowCache() }
    const first = renderList(list, 80, 20, focusOn('a'), palette('a'), 0, memo)
    const second = renderList(list, 80, 20, focusOn('a'), palette('b'), 0, memo)
    expect(first.join('')).toContain('<a:')
    expect(second.join('')).toContain('<b:')
    expect(second.join('')).not.toContain('<a:')
  })

  it('keeps a bounded number of looks per item', () => {
    const cache = new UiRowCache()
    const colors = palette('a')
    const item = {}
    const paint = vi.fn((key: string) => key)
    const read = (key: string): string => cache.read(colors, item, key, () => paint(key))
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) read(key)
    expect(paint).toHaveBeenCalledTimes(9)
    read('9')
    expect(paint, 'the newest look is kept').toHaveBeenCalledTimes(9)
    read('1')
    expect(paint, 'the oldest look was dropped').toHaveBeenCalledTimes(10)
  })

  it('serves every line of a multi-line item again from the memo', () => {
    const cache = new UiRowCache()
    const colors = palette('a')
    const item = {}
    const paint = vi.fn(() => ['a', 'b', 'c'])
    const read = (): readonly string[] => cache.readLines(colors, item, 'k', paint)
    expect(read()).toEqual(['a', 'b', 'c'])
    expect(read()).toEqual(['a', 'b', 'c'])
    expect(paint).toHaveBeenCalledTimes(1)
  })
})
