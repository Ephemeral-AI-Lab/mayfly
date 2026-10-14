/** The list painter: rows from their state bits, bodies, wrapping, windowing over rows of varying height, and the strip ladder. */
import { describe, expect, it, vi } from 'vitest'
import { ui, type MayflyListItem, type MayflyListSegment } from '../../../ui/src/index.ts'
import { renderList, type ListRenderExtras, type PatternFocus } from '../../src/core/ui-patterns.ts'
import type { ListRowSpec } from '../../src/core/ui-list-paint.ts'
import { UiRowCache } from '../../src/core/ui-row-cache.ts'
import { isVirtualRows, virtualRows } from '../../src/core/ui-rows.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { identity, plain, plainColors } from '../helpers.ts'

const colors = plainColors()
const tagged = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : (value: string) => `<${String(key)}>${value}</>` }) as unknown as MayflySemanticColors
const idle: PatternFocus = { key: '', focused: false, marker: '|' }
const on = (key: string): PatternFocus => ({ key, focused: true, marker: '|' })

const specs = (items: readonly MayflyListItem[], extra: Partial<ListRowSpec> = {}): ListRowSpec[] => items.map((item, position) => ({ item, depth: 0, last: false, expandable: false, open: false, position, ...extra }))

describe('list rows', () => {
  it('draws the gutter, indent, tree guides, disclosure, and the cursor row bold with its arrow only while focused', () => {
    const items: MayflyListItem[] = [
      { id: 'a', label: 'Alpha', indent: 2 },
      { id: 'b', label: 'Beta' },
      { id: 'c', label: 'Gamma' },
    ]
    const rows: ListRowSpec[] = [
      { item: items[0]!, depth: 0, last: false, expandable: true, open: true, position: 0 },
      { item: items[1]!, depth: 1, last: false, expandable: false, open: false, position: 1 },
      { item: items[2]!, depth: 2, last: true, expandable: true, open: false, position: 2 },
    ]
    const node = ui.list({ id: 'tree', role: 'browse', tree: true, selectedIds: [], items })
    const extras: ListRenderExtras = { rows, cursorId: 'b' }
    expect(plain(renderList(node, 40, 10, idle, colors, 0, undefined, extras))).toEqual(['    ▾ Alpha', '  │ Beta', '    ╰ ▸ Gamma'])
    expect(plain(renderList(node, 40, 10, on('b'), colors, 0, undefined, extras))[1]).toBe('→|│ Beta')
    // A selection list keeps a muted arrow after focus leaves.
    const selection = ui.list({ id: 'rail', role: 'browse', marker: 'selection', selectedIds: [], items })
    expect(plain(renderList(selection, 40, 10, idle, colors, 0, undefined, extras))[1]).toBe('→ │ Beta')
    expect(renderList(selection, 40, 10, idle, tagged, 0, undefined, extras)[1]).toContain('\x1b[1m<muted>→</>\x1b[22m')
    expect(renderList(selection, 40, 10, on('b'), tagged, 0, undefined, extras)[1]).toContain('\x1b[1m<primary>→</>\x1b[22m')
    // The open parent shows its disclosure in primary only on the cursor row.
    expect(renderList(node, 40, 10, idle, tagged, 0, undefined, { ...extras, cursorId: 'a' })[0]).toContain('<primary>▾</>')
    expect(renderList(node, 40, 10, idle, tagged, 0, undefined, extras)[0]).toContain('<muted>▾</>')
  })

  it('draws label spans, badge, meter, detail, the disabled reason, and the right spans (rightFocus under the cursor)', () => {
    const items: MayflyListItem[] = [
      { id: 'a', label: 'Alpha', labelSpans: [{ text: 'Al', styles: ['strong'] }, { text: 'pha', tone: 'accent' }], badge: 'new', meter: { value: 1, max: 4 }, detail: '— already dashed', right: [{ text: '1.4.0', tone: 'muted' }], rightFocus: [{ text: 'Enter', tone: 'primary' }] },
      { id: 'b', label: 'Beta', meter: { value: 3, max: 4, width: 4, tone: 'success' }, detailSpans: [{ text: 'spans' }] },
      { id: 'c', label: 'Gamma', disabled: true, detail: 'kept', disabledReason: 'retired' },
      { id: 'd', label: 'Delta', detailSpans: [] },
    ]
    const node = ui.list({ id: 'rows', role: 'browse', selectedIds: [], items })
    const idleRows = plain(renderList(node, 80, 10, idle, colors, 0, undefined, { rows: specs(items) }))
    expect(idleRows[0]).toBe('  Alpha [new] ▰▰▱▱▱▱▱▱ — already dashed'.padEnd(75) + '1.4.0')
    expect(idleRows[1]).toBe('  Beta ▰▰▰▱ — spans')
    expect(idleRows[2]).toBe('  Gamma — kept — retired')
    expect(idleRows[3]).toBe('  Delta')
    const cursorRows = plain(renderList(node, 80, 10, on('a'), colors, 0, undefined, { rows: specs(items), cursorId: 'a' }))
    expect(cursorRows[0]).toMatch(/^→\|Alpha .* Enter$/u)
    // Narrow rows drop the detail and the reason but keep the badge, the meter, and the right spans.
    expect(plain(renderList(node, 30, 10, idle, colors, 0, undefined, { rows: specs(items) }))[0]).toBe('  Alpha [new] ▰▰▱▱▱▱▱▱   1.4.0')
    expect(plain(renderList(node, 30, 10, idle, colors, 0, undefined, { rows: specs(items) }))[2]).toBe('  Gamma')
    // A row too wide for its right spans is cut with an ellipsis, in the style the cut left open.
    const cut = renderList(node, 20, 10, idle, tagged, 0, undefined, { rows: specs(items) })[0]!
    expect(visibleWidth(cut)).toBeLessThanOrEqual(20)
    expect(cut).toContain('…')
  })

  it('draws the check column for choose lists, marks on a single list, and a tri-state parent of a multiple tree', () => {
    const items: MayflyListItem[] = [
      { id: 'p', label: 'parent' },
      { id: 'c1', label: 'one', parentId: 'p' },
      { id: 'c2', label: 'two', parentId: 'p' },
      { id: 'q', label: 'solo' },
    ]
    const tree = ui.list({ id: 'tree', role: 'choose', mode: 'multiple', tree: true, selectedIds: ['c1'], items })
    expect(plain(renderList(tree, 40, 10, idle, colors, 0, undefined, { rows: specs(items) }))).toEqual(['  ◐ parent', '  ○ one'.replace('○', '●'), '  ○ two', '  ○ solo'])
    const marks = ui.list({ id: 'marks', role: 'choose', marks: true, selectedIds: ['q'], items })
    expect(plain(renderList(marks, 40, 10, idle, colors, 0, undefined, { rows: specs(items) }))[3]).toBe('  ● solo')
    expect(plain(renderList(marks, 40, 10, idle, colors, 0, undefined, { rows: specs(items) }))[0]).toBe('  ○ parent')
    expect(renderList(marks, 40, 10, idle, tagged, 0, undefined, { rows: specs(items) })[3]).toContain('<primary>●</>')
    expect(renderList(marks, 40, 10, idle, tagged, 0, undefined, { rows: specs(items) })[0]).toContain('<muted>○</>')
    // A disabled row never takes the cursor, and its mark is muted.
    const disabled = [{ id: 'x', label: 'X', disabled: true }] satisfies MayflyListItem[]
    expect(renderList(ui.list({ id: 'd', role: 'choose', marks: true, selectedIds: ['x'], items: disabled }), 40, 10, on('x'), tagged, 0, undefined, { rows: specs(disabled), cursorId: 'x' })[0]).toContain('<muted>●</>')
  })

  it('numbers rows by their visible position and leaves a position past nine unnumbered', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
    const node = ui.list({ id: 'n', role: 'choose', numbered: true, selectedIds: [], items })
    expect(plain(renderList(node, 20, 5, idle, colors, 8, undefined))).toEqual(['  9  A', '  B'])
  })

  it('wraps a row under its own prefix, cuts at wrapMax with a count, and keeps the row cache honest', () => {
    const long = 'one two three four five six seven eight nine ten'
    const items: MayflyListItem[] = [{ id: 'a', label: long, wrap: true }, { id: 'b', label: long, wrap: true, wrapMax: 2 }, { id: 'c', label: 'short', wrap: true, wrapMax: 3 }]
    const node = ui.list({ id: 'w', role: 'browse', selectedIds: [], items })
    const rows = plain(renderList(node, 20, 20, idle, colors, 0, undefined, { rows: specs(items) }))
    expect(rows.slice(0, 3)).toEqual(['  one two three four', '  five six seven', '  eight nine ten'])
    expect(rows.slice(3, 6)).toEqual(['  one two three four', '  five six seven', '  ▸ 1 more lines · Enter'])
    expect(rows[6]).toBe('  short')
    const translate = vi.fn((key: string, values?: Readonly<Record<string, string | number>>) => `${key}:${String(values?.count)}`)
    expect(plain(renderList(node, 20, 20, idle, colors, 0, undefined, { rows: specs(items), translate }))[5]).toContain('▸ {count} more lines · Enter:1')
  })

  it('hangs the continuation lines under the text after a leading glyph, and keeps the fold row there', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: '» one two three four five six seven eight nine ten eleven twelve', wrap: true, hang: 2, wrapMax: 3 }, { id: 'b', label: '» 请把这一段说明翻译成中文并且保留标点', wrap: true, hang: 2 }]
    const node = ui.list({ id: 'h', role: 'browse', selectedIds: [], items })
    const rows = plain(renderList(node, 20, 20, idle, colors, 0, undefined, { rows: specs(items) }))
    expect(rows.slice(0, 4)).toEqual(['  » one two three', '    four five six', '    seven eight nine', '    ▸ 2 more lines · Enter'])
    // A wide character never starts a line past the width, and the lines hang under the first character after the glyph.
    expect(rows.slice(4).every(row => visibleWidth(row) <= 20)).toBe(true)
    expect(rows.slice(5).every(row => row.startsWith('    '))).toBe(true)
  })

  it('draws rules, blank rows, and group headings that carry no cursor', () => {
    const items: MayflyListItem[] = [
      { id: 'r', label: '', rule: 'Today', group: 'G' },
      { id: 'r2', label: '', rule: '' },
      { id: 'a', label: 'A', group: 'G' },
      { id: 'g', label: '', gap: true },
      { id: 'b', label: 'B', group: 'H' },
    ]
    const node = ui.list({ id: 'rules', role: 'browse', selectedIds: [], items })
    expect(plain(renderList(node, 20, 20, idle, colors, 0, undefined, { rows: specs(items) }))).toEqual(['G', `  ${'─'.repeat(12)} Today`, `  ${'─'.repeat(18)}`, '  A', '', 'H', '  B'])
  })

  it('draws a string body behind guides, always-open text, and a node body through the callback', () => {
    const items: MayflyListItem[] = [
      { id: 'a', label: 'A', body: 'line one\nline two', indent: 1 },
      { id: 'b', label: 'B', body: 'always\nopen', bodyAlways: true },
      { id: 'c', label: 'C', body: ui.text('node body') },
      { id: 'd', label: 'D', body: ui.text('node body'), bodyAlways: true, indent: 2 },
      { id: 'e', label: 'E', body: ui.text('closed'), },
    ]
    const node = ui.list({ id: 'bodies', role: 'browse', selectedIds: [], items })
    const open = specs(items).map(row => row.item.id === 'e' ? row : { ...row, expandable: row.item.bodyAlways !== true, open: true })
    const body = vi.fn((_item: MayflyListItem, width: number) => [`body@${String(width)}`])
    const rows = plain(renderList(node, 30, 40, idle, colors, 0, undefined, { rows: open, body }))
    expect(rows).toEqual([
      '   ▾ A', '     │ line one', '     ╰ line two',
      '  B', '       always', '       open',
      '  ▾ C', '    ╰ body@24',
      '    D', '    body@26',
      '  E',
    ])
    // Without a painter a node body draws nothing, and a closed row draws no body at all.
    expect(plain(renderList(node, 30, 40, idle, colors, 0, undefined, { rows: open }))).not.toContain('    ╰ body@24')
    expect(body).toHaveBeenCalledTimes(2)
  })

  it('serves rows and bodies from the memo, repainting only the rows whose bits changed', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'A', body: ui.text('x') }, { id: 'b', label: 'B' }]
    const node = ui.list({ id: 'memo', role: 'browse', selectedIds: [], items })
    const counters = createWorkCounters()
    const memo = { cache: new UiRowCache(), counters }
    const extras = (cursorId: string): ListRenderExtras => ({ rows: specs(items).map(row => row.item.id === 'a' ? { ...row, expandable: true, open: true } : row), cursorId, body: () => ['one', 'two'] })
    renderList(node, 30, 20, on('a'), colors, 0, memo, extras('a'))
    expect(counters.rowsPainted).toBe(1 + 2 + 1)
    renderList(node, 30, 20, on('a'), colors, 0, memo, extras('a'))
    expect(counters.rowsPainted).toBe(4)
    renderList(node, 30, 20, on('b'), colors, 0, memo, extras('b'))
    expect(counters.rowsPainted, 'the cursor moved: two item rows repaint, the body does not').toBe(6)
  })
})

describe('a body at any size', () => {
  const openItem = (body: string): MayflyListItem[] => [{ id: 'a', label: 'A', body }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]
  const openRows = (items: readonly MayflyListItem[]): ListRowSpec[] => specs(items).map(row => row.item.id === 'a' ? { ...row, expandable: true, open: true } : row)

  it('paints only the window rows of a hundred-thousand-line string body, scanning its lines once', () => {
    const body = Array.from({ length: 100_000 }, (_, index) => `body line ${String(index)}`).join('\n')
    const items = openItem(body)
    const node = ui.list({ id: 'big', role: 'browse', selectedIds: [], items })
    const muted = vi.fn(identity)
    const spy = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : key === 'muted' ? muted : identity }) as unknown as MayflySemanticColors
    const counters = createWorkCounters()
    const memo = { cache: new UiRowCache(), counters }
    const extras = (cursorId: string): ListRenderExtras => ({ rows: openRows(items), cursorId })
    const rows = plain(renderList(node, 30, 6, idle, spy, 0, memo, extras('a')))
    expect(rows).toEqual([
      '  ▾ A',
      '    │ body line 0',
      '    │ body line 1',
      '    │ body line 2',
      '    │ body line 3',
      '    │ body line 4',
    ])
    // The scan runs once per admitted item, and only the window's rows are produced.
    expect(counters.linesEstimated).toBe(100_000)
    expect(counters.rowsMaterialized).toBe(5)
    const calls = muted.mock.calls.length
    expect(calls).toBeLessThan(30)
    // A second paint serves the memo: no rescan, no repainted body row.
    renderList(node, 30, 6, idle, spy, 0, memo, extras('a'))
    expect(counters.linesEstimated).toBe(100_000)
    expect(counters.rowsMaterialized).toBe(5)
    expect(muted.mock.calls.length).toBe(calls)
    // Moving the cursor to the next row shifts the window over the body's tail: the last line carries ╰.
    const tail = plain(renderList(node, 30, 4, idle, spy, 0, memo, extras('b')))
    expect(tail).toEqual(['    │ body line 99998', '    ╰ body line 99999', '  B', '  C'])
  })

  it('keeps an empty string body as one guided row', () => {
    const items = openItem('')
    const node = ui.list({ id: 'empty', role: 'browse', selectedIds: [], items })
    const rows = plain(renderList(node, 30, 6, idle, colors, 0, undefined, { rows: openRows(items), cursorId: 'a' }))
    expect(rows[1]).toBe('    ╰ ')
    expect(rows[2]).toBe('  B')
  })

  it('windows a virtual node body without materializing it or counting its length as painted rows', () => {
    const reads: number[] = []
    const bodyRows = virtualRows({
      length: 50_000,
      row(index) { reads.push(index); return `deep row ${String(index)}` },
    })
    const items = openItem('')
    items[0] = { id: 'a', label: 'A', body: ui.text('x') }
    const node = ui.list({ id: 'vnode', role: 'browse', selectedIds: [], items })
    const counters = createWorkCounters()
    const memo = { cache: new UiRowCache(), counters }
    const body = vi.fn((_item: MayflyListItem, _width: number) => bodyRows)
    const rows = plain(renderList(node, 30, 4, idle, colors, 0, memo, { rows: openRows(items), cursorId: 'a', body }))
    expect(rows).toEqual(['  ▾ A', '    │ deep row 0', '    │ deep row 1', '    │ deep row 2'])
    expect(reads).toEqual([0, 1, 2])
    // The row cache stored the facade itself: its estimated length is not painted work.
    expect(counters.rowsPainted).toBe(3)
    renderList(node, 30, 4, idle, colors, 0, memo, { rows: openRows(items), cursorId: 'a', body })
    expect(body).toHaveBeenCalledTimes(1)
    expect(reads).toEqual([0, 1, 2])
  })

  it('keeps a bodyAlways body virtual under its own indent', () => {
    const body = Array.from({ length: 1000 }, (_, index) => `always line ${String(index)}`).join('\n')
    const items: MayflyListItem[] = [{ id: 'a', label: 'A', body, bodyAlways: true }, { id: 'b', label: 'B' }]
    const node = ui.list({ id: 'always', role: 'browse', selectedIds: [], items })
    const counters = createWorkCounters()
    const memo = { cache: new UiRowCache(), counters }
    const rows = specs(items).map(row => ({ ...row, open: true }))
    const painted = renderList(node, 30, 3, idle, colors, 0, memo, { rows, cursorId: 'a' })
    expect(plain(painted)).toEqual(['  A', '       always line 0', '       always line 1'])
    expect(counters.rowsMaterialized).toBe(2)
    expect(isVirtualRows(memo.cache.readLines(colors, items[0]!, 'body\x0130\x010\x010', () => [], counters))).toBe(true)
  })
})

describe('a body that leads its row', () => {
  it('has no head line: the lead follows the cursor gutter, the body takes the rest, and its other rows sit under it', () => {
    const items: MayflyListItem[] = [
      { id: 'a', label: '', body: ui.text('first row\nsecond row'), bodyAlways: true, bodyLead: [{ text: '● ' }] },
      { id: 'b', label: 'B' },
    ]
    const node = ui.list({ id: 'lead', role: 'browse', selectedIds: [], items })
    const rows = specs(items).map(row => row.item.id === 'a' ? { ...row, open: true } : row)
    const body = vi.fn((_item: MayflyListItem, width: number) => [`first@${String(width)}`, 'second'])
    expect(plain(renderList(node, 30, 10, idle, colors, 0, undefined, { rows, cursorId: 'b', body }))).toEqual(['  ● first@26', '    second', '  B'])
    // The cursor arrow rides the first row, and a wide lead narrows the body by its own width.
    expect(plain(renderList(node, 30, 10, on('a'), colors, 0, undefined, { rows, cursorId: 'a', body }))[0]).toBe('→|● first@26')
    const wide: MayflyListItem[] = [{ id: 'w', label: '', body: ui.text('x'), bodyAlways: true, bodyLead: [{ text: '✻ ' }, { text: '思考' }, { text: '  ' }] }]
    const wideBody = vi.fn((_item: MayflyListItem, width: number) => [`w@${String(width)}`, 'next'])
    expect(plain(renderList(ui.list({ id: 'w', role: 'browse', selectedIds: [], items: wide }), 30, 10, idle, colors, 0, undefined, { rows: specs(wide).map(row => ({ ...row, open: true })), body: wideBody }))).toEqual(['  ✻ 思考  w@20', '          next'])
  })

  it('keeps the leaded rows in the row cache and a body that paints nothing as the lead alone', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: '', body: ui.text('x'), bodyAlways: true, bodyLead: [{ text: '● ' }] }]
    const node = ui.list({ id: 'cache', role: 'browse', selectedIds: [], items })
    const rows = specs(items).map(row => ({ ...row, open: true }))
    const memo = { cache: new UiRowCache(), counters: createWorkCounters() }
    const body = vi.fn(() => ['row'])
    renderList(node, 30, 10, idle, colors, 0, memo, { rows, body })
    renderList(node, 30, 10, idle, colors, 0, memo, { rows, body })
    expect(body).toHaveBeenCalledTimes(1)
    expect(plain(renderList(node, 30, 10, idle, colors, 0, undefined, { rows, body: () => [] }))).toEqual(['  ● '])
  })
})

describe('legacy rows without a model', () => {
  it('draws a row with a body as closed unless it is always open, and a strip view with nothing active', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'A', body: 'text' }, { id: 'b', label: 'B', body: 'always', bodyAlways: true }]
    expect(plain(renderList(ui.list({ id: 'l', role: 'browse', selectedIds: [], items }), 30, 10, idle, colors))).toEqual(['  ▸ A', '  B', '       always'])
    const stripped: MayflyListItem[] = [{ id: 's', label: 'S', segment: { options: [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }] } }]
    const rows = plain(renderList(ui.list({ id: 's', role: 'browse', selectedIds: [], items: stripped }), 30, 10, on('s'), colors, 0, undefined, { rows: specs(stripped), cursorId: 's', segment: row => ({ segment: row.segment!, pinned: null, active: undefined }) }))
    expect(rows[0]).toContain('x y')
  })
})

describe('list windows', () => {
  const many = Array.from({ length: 12 }, (_, index): MayflyListItem => ({ id: `r${String(index)}`, label: `row ${String(index + 1)}` }))
  const node = (extra = {}) => ui.list({ id: 'win', role: 'browse', selectedIds: [], items: many, ...extra })

  it('windows a maxRows list around the cursor and counts what is hidden', () => {
    const rows = specs(many)
    expect(plain(renderList(node({ maxRows: 4 }), 30, 40, idle, colors, 0, undefined, { rows, cursorId: 'r0' }))).toEqual(['  row 1', '  row 2', '  row 3', '  row 4', '   ↑ 0 more · ↓ 8 more'])
    expect(plain(renderList(node({ maxRows: 4 }), 30, 40, idle, colors, 0, undefined, { rows, cursorId: 'r6' }))).toEqual(['  row 5', '  row 6', '  row 7', '  row 8', '   ↑ 4 more · ↓ 4 more'])
    expect(plain(renderList(node({ maxRows: 4 }), 30, 40, idle, colors, 0, undefined, { rows, cursorId: 'r11' }))).toEqual(['  row 9', '  row 10', '  row 11', '  row 12', '   ↑ 8 more · ↓ 0 more'])
    // Items outside the materialized window count as hidden too, and a short list shows no row at all.
    expect(plain(renderList(node({ maxRows: 4 }), 30, 40, idle, colors, 0, undefined, { rows: rows.slice(4, 8), cursorId: 'r5', before: 4, after: 4, total: 12 })).at(-1)).toBe('   ↑ 4 more · ↓ 4 more')
    expect(plain(renderList(node({ maxRows: 2 }), 30, 40, idle, colors, 0, undefined, { rows: rows.slice(4, 8), cursorId: 'r6', before: 4, after: 4, total: 12 })).at(-1)).toBe('   ↑ 5 more · ↓ 5 more')
    expect(plain(renderList(node({ maxRows: 20 }), 30, 40, idle, colors, 0, undefined, { rows, cursorId: 'r0' }))).toHaveLength(12)
    const translate = (key: string, values?: Readonly<Record<string, string | number>>): string => `${key} ${String(values?.above)}/${String(values?.below)}`
    expect(plain(renderList(node({ maxRows: 4 }), 30, 40, idle, colors, 0, undefined, { rows, cursorId: 'r0', translate })).at(-1)).toBe('   ↑ {above} more · ↓ {below} more 0/8')
    // A group heading counts as a row of its own.
    const grouped = many.slice(0, 6).map((item, index) => ({ ...item, group: index < 3 ? 'A' : 'B' }))
    const windowed = plain(renderList(ui.list({ id: 'g', role: 'browse', maxRows: 3, selectedIds: [], items: grouped }), 30, 40, idle, colors, 0, undefined, { rows: specs(grouped), cursorId: 'r0' }))
    expect(windowed).toEqual(['A', '  row 1', '  row 2', '   ↑ 0 more · ↓ 5 more'])
  })

  it('windows rows of different heights by line, keeping the cursor row whole', () => {
    const items: MayflyListItem[] = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', body: 'one\ntwo\nthree' },
      { id: 'c', label: 'C' },
      { id: 'd', label: 'D' },
    ]
    const rows = specs(items).map(row => row.item.id === 'b' ? { ...row, expandable: true, open: true } : row)
    const list = ui.list({ id: 'tall', role: 'browse', selectedIds: [], items })
    expect(plain(renderList(list, 30, 4, idle, colors, 0, undefined, { rows, cursorId: 'b' }))).toEqual(['  A', '  ▾ B', '    │ one', '    │ two'])
    expect(plain(renderList(list, 30, 3, idle, colors, 0, undefined, { rows, cursorId: 'd' }))).toEqual(['    ╰ three', '  C', '  D'])
    // A missing cursor shows the top, and a non-finite height is one row.
    expect(plain(renderList(list, 30, 2, idle, colors, 0, undefined, { rows, cursorId: 'gone' }))).toEqual(['  A', '  ▾ B'])
    expect(renderList(list, 30, Number.NaN, idle, colors, 0, undefined, { rows })).toHaveLength(1)
  })
})

describe('the segment strip on a row', () => {
  const effort = (inheritedId?: string) => ({ label: 'Thinking', options: [{ id: 'min', label: 'min' }, { id: 'high', label: 'high' }, { id: 'max', label: 'max' }], ...(inheritedId === undefined ? {} : { inheritedId }) })
  const item = (id: string, label: string, segment?: MayflyListSegment): MayflyListItem => ({ id, label, ...(segment === undefined ? {} : { segment }) })
  const view = (pinned: string | null, segment: MayflyListSegment) => ({ segment, pinned, active: pinned ?? segment.inheritedId })

  it('rides the focused row at the right edge when it fits, with (default) first and without it second', () => {
    const items = [item('a', 'Model A', effort('high')), item('b', 'Model B')]
    const node = ui.list({ id: 'm', role: 'browse', selectedIds: [], items })
    const segment = (row: MayflyListItem) => row.segment === undefined ? undefined : view(null, row.segment)
    const wide = plain(renderList(node, 60, 10, on('a'), colors, 0, undefined, { rows: specs(items), cursorId: 'a', segment }))
    expect(wide).toEqual(['→|Model A'.padEnd(60 - 'min ‹ high (default) › max'.length) + 'min ‹ high (default) › max', '  Model B'])
    // The strip shows on the focused row only.
    expect(plain(renderList(node, 60, 10, idle, colors, 0, undefined, { rows: specs(items), cursorId: 'a', segment }))[0]).toBe('  Model A')
    const narrower = plain(renderList(node, 34, 10, on('a'), colors, 0, undefined, { rows: specs(items), cursorId: 'a', segment }))
    expect(narrower[0]).toBe('→|Model A'.padEnd(34 - 'min ‹ high › max'.length) + 'min ‹ high › max')
    // The footer is reserved while no row has focus, so focus never moves a row.
    const tight = plain(renderList(node, 24, 10, idle, colors, 0, undefined, { rows: specs(items), cursorId: 'a', segment }))
    expect(tight).toEqual(['  Model A', '  Model B', '', ''])
    // At 24 columns the strip no longer shares the line: it folds into the footer around its active token.
    const footer = plain(renderList(node, 24, 10, on('a'), colors, 0, undefined, { rows: specs(items), cursorId: 'a', segment }))
    expect(footer.slice(0, 3)).toEqual(['→|Model A', '  Model B', ''])
    expect(footer[3]).toBe('  min ‹ high (default) › max'.length <= 24 ? '  min ‹ high (default) › max' : footer[3])
  })

  it('moves the strip to the reserved footer when the row cannot share its line, with the caption while it fits', () => {
    const items = [item('a', 'DeepSeek/DeepSeek-V41-Flash [current] — 977k context', effort('high'))]
    const node = ui.list({ id: 'm', role: 'browse', selectedIds: [], items })
    const segment = (row: MayflyListItem) => row.segment === undefined ? undefined : view(null, row.segment)
    const rows = plain(renderList(node, 62, 10, on('a'), colors, 0, undefined, { rows: specs(items), cursorId: 'a', segment }))
    expect(rows.slice(1)).toEqual(['', '  Thinking: min ‹ high (default) › max'])
    // The caption falls to the segment's label, then to a translated default.
    const unlabeled = [item('a', 'DeepSeek/DeepSeek-V41-Flash [current] — 977k context', { options: effort('high').options, inheritedId: 'high' })]
    const bare = (row: MayflyListItem) => row.segment === undefined ? undefined : view(null, row.segment)
    expect(plain(renderList(ui.list({ id: 'u', role: 'browse', selectedIds: [], items: unlabeled }), 62, 10, on('a'), colors, 0, undefined, { rows: specs(unlabeled), cursorId: 'a', segment: bare, segmentLabel: 'Effort' })).at(-1)).toBe('  Effort: min ‹ high (default) › max')
    expect(plain(renderList(ui.list({ id: 'u', role: 'browse', selectedIds: [], items: unlabeled }), 62, 10, on('a'), colors, 0, undefined, { rows: specs(unlabeled), cursorId: 'a', segment: bare })).at(-1)).toBe('  Options: min ‹ high (default) › max')
  })
})

describe('the selection band and find marks of a list', () => {
  // The band paints through `selectedBg`; a tagged palette makes it visible in the frame.
  const rows = (items: MayflyListItem[], open: ReadonlySet<string> = new Set()): ListRowSpec[] => specs(items).map(row => ({ ...row, open: open.has(row.item.id) }))

  it('bands the cursor row and every row under it, following the chain from a body to its call to the head', () => {
    const items: MayflyListItem[] = [
      { id: 'head', label: 'Head' },
      { id: 'call', label: 'Call', under: 'head' },
      { id: 'deep', label: 'Deep', under: 'call' },
      { id: 'free', label: 'Free' },
    ]
    const node = ui.list({ id: 'band', role: 'browse', marker: 'band', selectedIds: [], items })
    const painted = renderList(node, 30, 10, on('head'), tagged, 0, undefined, { rows: rows(items), cursorId: 'head' })
    expect(painted).toHaveLength(4)
    expect(painted[0]).toContain('<selectedBg>')
    expect(painted[1]).toContain('<selectedBg>')
    expect(painted[2]).toContain('<selectedBg>')
    expect(painted[3]).not.toContain('<selectedBg>')
  })

  it('draws the band inset one column at each edge and no arrow, and only while the list has focus', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }]
    const node = ui.list({ id: 'band', role: 'browse', marker: 'band', selectedIds: [], items })
    const focused = renderList(node, 20, 10, on('a'), tagged, 0, undefined, { rows: rows(items), cursorId: 'a' })
    expect(focused[0]!.startsWith(' <selectedBg>')).toBe(true)
    expect(focused[0]!.endsWith('</> ')).toBe(true)
    expect(focused[0]).not.toContain('→')
    expect(visibleWidth(renderList(node, 20, 10, on('a'), colors, 0, undefined, { rows: rows(items), cursorId: 'a' })[0]!)).toBe(20)
    const blurred = renderList(node, 20, 10, idle, tagged, 0, undefined, { rows: rows(items), cursorId: 'a' })
    expect(blurred.join('\n')).not.toContain('<selectedBg>')
  })

  it('keeps a wide label whole inside the band at 40 and 60 columns', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: '中文标题很长很长' }, { id: 'b', label: '体', under: 'a' }]
    const node = ui.list({ id: 'band', role: 'browse', marker: 'band', selectedIds: [], items })
    for (const width of [40, 60]) {
      const painted = renderList(node, width, 10, on('a'), colors, 0, undefined, { rows: rows(items), cursorId: 'a' })
      expect(painted).toHaveLength(2)
      for (const row of painted) expect(visibleWidth(row)).toBe(width)
    }
  })

  it('marks every match of the pattern in the painted rows, and leaves the rows without a match as they were', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'needle one' }, { id: 'b', label: 'hay' }, { id: 'c', label: 'a needle' }]
    const node = ui.list({ id: 'find', role: 'browse', selectedIds: [], items, highlight: { pattern: 'needle' } })
    const painted = renderList(node, 40, 10, idle, colors, 0, undefined, { rows: rows(items) })
    expect(painted[0]).toBe('  \x1b[7mneedle\x1b[27m one')
    expect(painted[1]).toBe('  hay')
    expect(painted[2]).toBe('  a \x1b[7mneedle\x1b[27m')
  })

  it('draws the current match of the cursor block stronger, the first of the block counted head first', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'hit head', body: 'x hit\nhit y', bodyAlways: true }]
    const node = ui.list({ id: 'current', role: 'browse', selectedIds: [], items, highlight: { pattern: 'hit', current: 1 } })
    const painted = renderList(node, 40, 10, on('a'), colors, 0, undefined, { rows: rows(items, new Set(['a'])), cursorId: 'a' })
    // The head's match is nth 0, the body's first line nth 1: only that one is drawn stronger.
    expect(painted.join('\n')).toContain('\x1b[7m\x1b[1m\x1b[4mhit\x1b[24m\x1b[22m\x1b[27m')
    expect(painted[0]).toContain('\x1b[7mhit\x1b[27m')
    expect(painted[0]).not.toContain('\x1b[4m')
  })

  it('windows a tall block on its current match, so a match deep in the body is in view', () => {
    const body = Array.from({ length: 200 }, (_, index) => index === 150 ? 'deep needle' : `line ${String(index)}`).join('\n')
    const items: MayflyListItem[] = [{ id: 'a', label: 'tall', body, bodyAlways: true }]
    const node = ui.list({ id: 'tall', role: 'browse', selectedIds: [], items, highlight: { pattern: 'needle', current: 0 } })
    const painted = renderList(node, 40, 5, on('a'), colors, 0, undefined, { rows: rows(items, new Set(['a'])), cursorId: 'a' })
    expect(painted).toHaveLength(5)
    expect(painted.join('\n')).toContain('\x1b[4mneedle')
  })

  it('keeps the unmarked rows of a memo when the pattern goes away, and paints the marks on the next pass', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'needle' }]
    const memo = { cache: new UiRowCache(), counters: createWorkCounters() }
    const marked = renderList(ui.list({ id: 'memo', role: 'browse', selectedIds: [], items, highlight: { pattern: 'needle' } }), 30, 5, idle, colors, 0, memo, { rows: rows(items) })
    expect(marked[0]).toContain('\x1b[7m')
    const plainRow = renderList(ui.list({ id: 'memo', role: 'browse', selectedIds: [], items }), 30, 5, idle, colors, 0, memo, { rows: rows(items) })
    expect(plainRow[0]).toBe('  needle')
  })
})
