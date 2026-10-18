/** The tab painters: the strip and its folds, the wizard, and the rail with its headings, arrow, counts, clip, and row cache. */
import { describe, expect, it } from 'vitest'
import { ui, type MayflyTabItem } from '../../../ui/src/index.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { isRail, paintTabs, tabsShape, type TabsFocus } from '../../src/core/ui-tabs-paint.ts'
import { UiRowCache } from '../../src/core/ui-row-cache.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { plain, plainColors } from '../helpers.ts'

/** A palette that gives each tone its own SGR color, so a row's styling is exact and its width unchanged. */
const CODES: Readonly<Record<string, number>> = { primary: 35, muted: 90, text: 37, warning: 33, success: 32 }
const tagged = new Proxy({ logoGradient: [(v: string) => v] }, {
  get: (target, key) => key === 'logoGradient' ? target.logoGradient : (value: string) => `\x1b[${String(CODES[String(key)] ?? 39)}m${value}\x1b[39m`,
}) as unknown as MayflySemanticColors
/** The expected look of a piece in a tone. */
const tone = (name: keyof typeof CODES, value: string): string => `\x1b[${String(CODES[name])}m${value}\x1b[39m`
const bare = plainColors()
const idle: TabsFocus = { key: '', focused: false, marker: '|' }
const focus = (key: string): TabsFocus => ({ key, focused: true, marker: '|' })
const strong = (value: string): string => `\x1b[1m${value}\x1b[22m`

const ITEMS: readonly MayflyTabItem[] = [
  { id: 'general', label: 'General', group: 'Session' }, { id: 'model', label: 'Model', group: 'Session' }, { id: 'perm', label: 'Permissions', count: 2, group: 'Session' },
  { id: 'providers', label: 'Providers', attention: true, group: 'Integrations' }, { id: 'mcp', label: 'MCP', count: '4/9', group: 'Integrations' },
]
const rail = (extra: Partial<Parameters<typeof ui.tabs>[0]> = {}) => ui.tabs({ id: 'rail', orientation: 'vertical', activeId: 'model', items: ITEMS, ...extra })

describe('the strip', () => {
  const items: readonly MayflyTabItem[] = [{ id: 'a', label: 'Alpha', count: 12 }, { id: 'b', label: 'Beta', count: '2/6' }, { id: 'c', label: 'Gamma', attention: true }, { id: 'd', label: 'Delta' }]

  it('draws the selected tab as an inverse chip and the other counts muted', () => {
    const rows = paintTabs(ui.tabs({ id: 's', activeId: 'a', items }), 100, idle, tagged)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('\x1b[7m')
    expect(rows[0]).toContain(tone('primary', ' Alpha 12 '))
    expect(rows[0]).toContain(`${tone('muted', 'Beta')} ${tone('muted', '2/6')}`)
    expect(rows[0]).toContain(`\x1b[1m${tone('warning', '!')}\x1b[22m`)
    expect(plain(rows)).toEqual([' Alpha 12    Beta 2/6   Gamma !   Delta'])
    expect(plain(paintTabs(ui.tabs({ id: 's', activeId: 'c', items: [{ id: 'c', label: 'Gamma', count: 4, attention: true }] }), 100, idle, tagged))).toEqual([' Gamma ! '])
  })

  it('keeps the selected chip independent of focus and draws no underline', () => {
    const focused = paintTabs(ui.tabs({ id: 's', activeId: 'b', items }), 100, focus('b'), tagged)
    expect(focused).toHaveLength(1)
    expect(focused[0]).toContain('\x1b[7m')
    expect(focused[0]).toContain(tone('primary', ' Beta 2/6 '))
    expect(focused[0]).not.toContain('━')
    const resting = paintTabs(ui.tabs({ id: 's', activeId: 'b', items }), 100, idle, tagged)
    expect(resting).toEqual(focused)
  })

  it('folds around the active tab and keeps the chip inside the width', () => {
    const node = (activeId: string) => ui.tabs({ id: 's', activeId, items })
    const folded = (activeId: string, width: number): string => plain(paintTabs(node(activeId), width, idle, tagged))[0]!
    expect(folded('a', 30)).toContain('Alpha 12')
    expect(folded('a', 30)).toContain('Beta 2/6')
    expect(folded('a', 30)).toContain('+2')
    expect(folded('b', 30)).toContain('Beta 2/6')
    expect(folded('a', 20)).toContain('+3')
    expect(folded('a', 9).startsWith('‹')).toBe(true)
    expect(folded('d', 20)).toContain('Delta')
    for (const width of [1, 2, 3, 5, 9, 16, 24, 30]) for (const activeId of ['a', 'b', 'c', 'd']) expect(visibleWidth(paintTabs(node(activeId), width, focus(activeId), bare)[0]!)).toBeLessThanOrEqual(width)
  })

  it('keeps folded rows inside the width, with the active label visible', () => {
    const wide = ui.tabs({ id: 'wide', activeId: 'a', items: [{ id: 'a', label: 'Aa' }, { id: 'b', label: 'Bb' }, { id: 'c', label: 'LongLabelXXX' }] })
    expect(visibleWidth(plain(paintTabs(wide, 16, focus('a'), bare))[0]!)).toBeLessThanOrEqual(16)
    expect(visibleWidth(plain(paintTabs(wide, 14, focus('a'), bare))[0]!)).toBeLessThanOrEqual(14)
    const pair = ui.tabs({ id: 'pair', activeId: 'x', items: [{ id: 'x', label: 'Extended' }, { id: 'y', label: 'Yonder' }] })
    expect(plain(paintTabs(pair, 17, idle, tagged))).toHaveLength(1)
    expect(plain(paintTabs(pair, 16, idle, tagged))[0]).toContain('+1')
    expect(visibleWidth(paintTabs(ui.tabs({ id: 'one', activeId: 'x', items: [{ id: 'x', label: 'A very long label indeed' }] }), 12, idle, bare)[0]!)).toBeLessThanOrEqual(12)
    expect(plain(paintTabs(ui.tabs({ id: 'one', activeId: 'x', items: [{ id: 'x', label: 'A very long label indeed' }] }), 30, idle, bare))).toEqual([' A very long label indeed '])
  })

  it('marks wizard steps and keeps its rule plain while focused', () => {
    const wizard = ui.tabs({ id: 'w', mode: 'wizard', activeId: 'two', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }, { id: 'three', label: 'Three' }] })
    expect(plain(paintTabs(wizard, 80, idle, tagged, ['one']))).toEqual(['✓ One  ›  ● Two  ›  ○ Three'.padEnd(77) + '2/3', '          ━━━━━'])
    const focused = paintTabs(wizard, 80, focus('two'), tagged, ['one'])
    expect(focused[1]).not.toContain('\x1b[1m')
    expect(focused[1]).toContain(`${tone('primary', '━━━━━')}`)
    expect(plain(paintTabs(wizard, 12, idle, tagged))).toEqual(['‹ ● Two  +2 '])
  })
})

describe('the rail', () => {

  it('draws upper-cased group headings, the arrow on the active label, and counts or `!` right-aligned', () => {
    expect(plain(paintTabs(rail(), 24, idle, tagged)).map(row => row.trimEnd())).toEqual([
      ' SESSION', '  General', '→ Model', '  Permissions          2', ' INTEGRATIONS', '  Providers            !', '  MCP                4/9',
    ])
    // Item rows fill the width; a heading is only as long as its text.
    expect(paintTabs(rail(), 24, idle, bare).filter(row => !row.startsWith(' ') || row.startsWith('  ')).map(visibleWidth)).toEqual([24, 24, 24, 24, 24])
  })

  it('paints the arrow and label primary and bold while the rail has focus, and muted and plain once focus leaves', () => {
    const focused = paintTabs(rail(), 24, focus('model'), tagged)[2]!
    expect(focused).toBe(`${strong(`${tone('primary', '→')}`)} ${strong(`${tone('primary', 'Model')}`)}${' '.repeat(16)}|`)
    const resting = paintTabs(rail(), 24, idle, tagged)[2]!
    expect(resting).toBe(`${strong(`${tone('muted', '→')}`)} ${strong(`${tone('text', 'Model')}`)}${' '.repeat(16)} `)
    expect(paintTabs(rail(), 24, { key: 'model', focused: false, marker: '|' }, tagged)[2]).toBe(resting)
    const idleRow = paintTabs(rail(), 24, focus('model'), tagged)[1]!
    expect(idleRow).toBe(`  ${tone('text', 'General')}${' '.repeat(15)}`)
    expect(paintTabs(rail(), 24, idle, tagged)[0]).toBe(`${tone('muted', ' SESSION')}`)
    expect(paintTabs(rail(), 24, idle, tagged)[3]).toBe(`  ${tone('text', 'Permissions')}${' '.repeat(10)}${tone('muted', '2')}`)
    expect(paintTabs(rail(), 24, idle, tagged)[5]).toBe(`  ${tone('text', 'Providers')}${' '.repeat(12)}\x1b[1m${tone('warning', '!')}\x1b[22m`)
  })

  it('mutes a disabled label, and keeps an item without a group under the heading before it', () => {
    const items: readonly MayflyTabItem[] = [{ id: 'a', label: 'A', group: 'One' }, { id: 'b', label: 'B', disabled: true }, { id: 'c', label: 'C', group: 'One' }, { id: 'd', label: 'D', group: 'Two' }]
    const rows = paintTabs(rail({ items, activeId: 'a' }), 12, idle, tagged)
    expect(plain(rows).map(row => row.trimEnd())).toEqual([' ONE', '→ A', '  B', '  C', ' TWO', '  D'])
    expect(rows[2]).toContain(`${tone('muted', 'B')}`)
  })

  it('keeps the distinguishing end of a label with `clip: start`, and ellipsises the end otherwise', () => {
    const path = '/home/ubuntu/dev/mayfly/packages/mayfly'
    const items: readonly MayflyTabItem[] = [{ id: 'a', label: path, clip: 'start', count: 7 }, { id: 'b', label: path }]
    const [start, end] = plain(paintTabs(rail({ items, activeId: 'b' }), 24, idle, tagged))
    expect(start).toBe('  …ly/packages/mayfly  7')
    expect(end).toBe('→ /home/ubuntu/dev/may… ')
    for (const row of paintTabs(rail({ items }), 24, idle, bare)) expect(visibleWidth(row)).toBeLessThanOrEqual(24)
  })

  it('stays inside any width, down to nothing', () => {
    for (const width of [1, 2, 3, 4, 5, 6, 8, 12, 24, 80]) for (const state of [idle, focus('model')]) for (const row of paintTabs(rail(), width, state, bare)) expect(visibleWidth(row), `width ${String(width)}`).toBeLessThanOrEqual(width)
    expect(paintTabs(rail(), Number.NaN, idle, bare)[1]!.length).toBeLessThanOrEqual(1)
  })

  it('answers unchanged items from the row cache and repaints only the two items a cursor move changes', () => {
    const cache = new UiRowCache()
    const counters = createWorkCounters()
    const options = { cache, counters }
    // One admitted node: its items keep their identity across paints, which is what the cache keys on.
    const node = rail()
    const first = paintTabs(node, 24, focus('model'), tagged, [], options)
    const painted = counters.rowsPainted
    expect(painted).toBe(first.length)
    expect(paintTabs(node, 24, focus('model'), tagged, [], options)).toEqual(first)
    expect(counters.rowsPainted).toBe(painted)
    // The cursor moves from `model` to `perm`: two items repaint (and their headings with them); the rest is served.
    paintTabs({ ...node, activeId: 'perm' }, 24, focus('perm'), tagged, [], options)
    expect(counters.rowsPainted - painted).toBe(2)
    // Another width and another palette are different looks.
    paintTabs(node, 12, idle, tagged, [], options)
    expect(counters.rowsPainted - painted).toBe(2 + first.length)
    const before = counters.rowsPainted
    paintTabs(node, 24, focus('model'), bare, [], options)
    expect(counters.rowsPainted - before).toBe(first.length)
  })

  it('paints without a cache when the caller passes none', () => {
    expect(paintTabs(rail(), 24, idle, bare)).toHaveLength(7)
  })
})

describe('the shape of a rail', () => {
  it('is a rail only from 60 columns, and only a vertical, non-wizard strip', () => {
    expect(isRail(rail(), 60)).toBe(true)
    expect(isRail(rail(), 59)).toBe(false)
    expect(isRail(ui.tabs({ id: 's', activeId: 'a', items: [{ id: 'a', label: 'A' }] }), 120)).toBe(false)
    expect(isRail({ orientation: 'vertical', mode: 'wizard' }, 120)).toBe(false)
  })

  it('draws below 60 columns as the horizontal strip, keeping the node when nothing changes', () => {
    const node = rail()
    expect(tabsShape(node, 80)).toBe(node)
    expect(tabsShape(node, 59)).toMatchObject({ orientation: 'horizontal', items: node.items })
    const strip = ui.tabs({ id: 's', activeId: 'a', items: [{ id: 'a', label: 'A' }] })
    expect(tabsShape(strip, 20)).toBe(strip)
  })
})
