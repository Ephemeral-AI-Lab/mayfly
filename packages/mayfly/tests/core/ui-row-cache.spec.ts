/** The list row memo: rows come back as painted, a state change repaints only what it touches, and a palette change repaints all. */
import { describe, expect, it } from 'vitest'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { renderList, type PatternFocus } from '../../src/core/ui-patterns.ts'
import { UiRowCache } from '../../src/core/ui-row-cache.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'

const palette = (name: string): MayflySemanticColors => new Proxy({ logoGradient: [(value: string) => value] }, {
  get: (target, key) => key === 'logoGradient' ? target.logoGradient : (value: string) => `<${name}:${String(key)}>${value}</>`,
}) as MayflySemanticColors

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

  it('counts a painted row once and repaints only the two rows a cursor move changes', () => {
    const colors = palette('a')
    const counters = createWorkCounters()
    const memo = { cache: new UiRowCache(), counters }
    renderList(list, 80, 20, focusOn('a'), colors, 0, memo)
    expect(counters.rowsPainted).toBe(4)
    renderList(list, 80, 20, focusOn('a'), colors, 0, memo)
    expect(counters.rowsPainted).toBe(4)
    renderList(list, 80, 20, focusOn('b'), colors, 0, memo)
    expect(counters.rowsPainted, 'a is painted resting, b focused').toBe(6)
    renderList(list, 80, 20, focusOn('a'), colors, 0, memo)
    expect(counters.rowsPainted, 'both looks are still remembered').toBe(6)
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
    const counters = createWorkCounters()
    const item = {}
    const read = (key: string): string => cache.read(colors, item, key, () => key, counters)
    for (const key of ['1', '2', '3', '4', '5', '6', '7']) read(key)
    expect(counters.rowsPainted).toBe(7)
    read('7')
    expect(counters.rowsPainted, 'the newest look is kept').toBe(7)
    read('1')
    expect(counters.rowsPainted, 'the oldest look was dropped').toBe(8)
  })
})
