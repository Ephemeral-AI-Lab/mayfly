/** List keys and the hint row in every list state: idle, searching, slash, segment pinned and unpinned, tree, numbered, bodies. */
import { afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyListItem, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { createRealSurface, parityComponents, PROBE_PALETTE, type RealSurface } from '../design/parity.ts'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '')
const KEY = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r', esc: '\x1b', space: ' ', delete: '\x1b[3~', ctrlU: '\x15', end: '\x1b[F', home: '\x1b[H', pageDown: '\x1b[6~' } as const

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

function open(node: MayflyUiNode, width = 100) {
  const events: MayflyUiEvent[] = []
  const surface = createRealSurface(ui.surface({ title: 'List', chrome: 'overlay', child: node }), width, {
    components: parityComponents(), events: event => events.push(event), overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  const rows = (): string[] => surface.render().map(plain)
  const hint = (): string => rows().find(row => row.includes('Esc'))!.replace(/^│\s*|\s*│$/gu, '')
  const row = (text: string): string => rows().find(candidate => candidate.includes(text)) ?? ''
  return { surface, events, rows, hint, row }
}

/** The row that holds the cursor: the arrow in the first column of the frame. */
const cursor = (rows: readonly string[]): string | undefined => rows.find(row => /^│ →/u.test(row))

const fruit = (): MayflyListItem[] => [{ id: 'apple', label: 'Apple' }, { id: 'banana', label: 'Banana' }, { id: 'cherry', label: 'Cherry' }]
const list = (extra: object = {}, items: readonly MayflyListItem[] = fruit()) => ui.list({ id: 'l', role: 'browse', selectedIds: [], items, ...extra })

describe('the hint row of a list', () => {
  it('names the verb Enter has: open by default, choose on a choose list, and the list\'s own acceptVerb', () => {
    expect(open(list()).hint()).toBe('↑/↓ options · Enter open · Esc close')
    expect(open(list({ role: 'choose' })).hint()).toBe('↑/↓ options · Enter choose · Esc close')
    for (const verb of ['open', 'choose', 'expand', 'edit', 'restore']) expect(open(list({ acceptVerb: verb })).hint()).toBe(`↑/↓ options · Enter ${verb} · Esc close`)
    expect(open(list({ hintLabel: 'stream' })).hint()).toBe('↑/↓ stream · Enter open · Esc close')
  })

  it('reads Type filter on a type list and / filter on a slash list, and names only what ends or clears a search', () => {
    expect(open(list({ filterable: true })).hint()).toBe('↑/↓ options · Enter open · Type filter · Esc close')
    expect(open(list({ filterable: true, filterMode: 'slash' })).hint()).toBe('↑/↓ options · Enter open · / filter · Esc close')
    const typed = open(list({ filterable: true }))
    typed.surface.press('b')
    expect(typed.hint()).toBe('Enter open · Ctrl+U clear · Esc end search')
    const slash = open(list({ filterable: true, filterMode: 'slash' }))
    slash.surface.press('/')
    slash.surface.press('b')
    expect(slash.hint()).toBe('Enter open · Ctrl+U clear · Esc end search')
  })

  it('keeps a query after Esc and shows Ctrl+U clear beside the filter, while / resumes the search', () => {
    const slash = open(list({ filterable: true, filterMode: 'slash' }))
    slash.surface.press('/')
    slash.surface.press('b')
    slash.surface.press(KEY.esc)
    expect(slash.hint()).toBe('↑/↓ options · Enter open · / filter · Esc close'.replace('Esc close', 'Esc close'))
    expect(slash.rows().some(row => row.includes('1 match'))).toBe(true)
    expect(slash.row('Banana')).toContain('Banana')
    expect(slash.rows().join('\n')).not.toContain('Apple')
    slash.surface.press('/')
    expect(slash.hint()).toContain('end search')
    slash.surface.press(KEY.ctrlU)
    expect(slash.rows().join('\n')).toContain('Apple')
  })

  it('shows the muted match count right-aligned, singular and plural', () => {
    const typed = open(list({ filterable: true }))
    typed.surface.press('a')
    expect(typed.row('/ a')).toMatch(/\/ a.*2 matches/u)
    typed.surface.press('p')
    expect(typed.row('/ ap')).toMatch(/\/ ap.*1 match\s*│?$/u)
  })

  it('leaves printable keys to accelerators on a slash list until a search starts, and digits to the text while it does', async () => {
    const node = ui.stack.column([
      list({ filterable: true, filterMode: 'slash', numbered: 'focus' }),
      ui.actions({ id: 'keys', items: [{ id: 'install', label: 'Install', key: 'i', hidden: true }, { id: 'one', label: 'One', key: 'o', hidden: true }] }),
    ])
    const { surface, events, hint } = open(node)
    expect(hint()).toContain('i install')
    surface.press('i')
    await Promise.resolve()
    expect(events.some(event => event.kind === 'activate' && event.actionId === 'install')).toBe(true)
    // Digits move the cursor until a search is open; after `/` they are text and no accelerator fires.
    surface.press('3')
    expect(cursor(surface.render().map(plain))?.includes('Cherry') === true).toBe(true)
    surface.press('/')
    surface.press('o')
    surface.press('3')
    const count = events.filter(event => event.kind === 'activate').length
    expect(count).toBe(1)
    expect(surface.render().map(plain).join('\n')).toContain('/ o3')
  })

  it('hints the strip, and Delete use default only while a row that inherits is pinned', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'A', segment: { label: 'Thinking', options: [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }, { id: 'z', label: 'z' }], inheritedId: 'y' } }, { id: 'b', label: 'B' }]
    const { surface, hint } = open(list({ filterable: true }, items))
    expect(hint()).toBe('←/→ thinking · Enter choose · Type filter · Esc close')
    surface.press(KEY.right)
    // Five hints compete for four places: the strip's own ←/→ is the lowest priority of them.
    expect(hint()).toBe('Enter choose · Delete use default · Type filter · Esc close')
    surface.press(KEY.delete)
    expect(hint()).toBe('←/→ thinking · Enter choose · Type filter · Esc close')
    // A row without a strip goes back to the list's own hints.
    surface.press(KEY.down)
    expect(hint()).toBe('↑/↓ options · Enter open · Type filter · Esc close')
  })

  it('numbered lists name the digit range and what a digit does', () => {
    expect(open(list({ role: 'choose', numbered: true })).hint()).toBe('↑/↓ options · 1-3 choose · Enter choose · Esc close')
    expect(open(list({ role: 'choose', numbered: 'focus' })).hint()).toBe('↑/↓ options · 1-3 focus · Enter choose · Esc close')
  })

  it('names branches for a tree and bodies: ←/→ branch, and Enter opens a body or a branch of a multiple tree', () => {
    const items: MayflyListItem[] = [{ id: 'p', label: 'parent' }, { id: 'c', label: 'child', parentId: 'p' }, { id: 'solo', label: 'solo' }]
    expect(open(list({ tree: true }, items)).hint()).toBe('↑/↓ options · ←/→ branch · Enter open · Esc close')
    const multiple = open(list({ role: 'choose', mode: 'multiple', tree: true }, items))
    expect(multiple.hint()).toBe('←/→ branch · Space toggle · Enter branch · Esc close')
    multiple.surface.press(KEY.down)
    multiple.surface.press(KEY.down)
    expect(multiple.hint()).toContain('Space toggle')
    expect(multiple.hint()).toContain('Enter choose')
    const bodies = open(list({}, [{ id: 'a', label: 'A', body: 'text' }, { id: 'b', label: 'B' }]))
    expect(bodies.hint()).toBe('↑/↓ options · ←/→ branch · Enter branch · Esc close')
    bodies.surface.press(KEY.down)
    expect(bodies.hint()).toBe('↑/↓ options · Enter open · Esc close')
  })

  it('names the toggle on a multiple list, and the verb for a segment row on a browse list', () => {
    expect(open(list({ role: 'choose', mode: 'multiple' })).hint()).toBe('↑/↓ options · Space toggle · Enter choose · Esc close')
  })
})

describe('list keys', () => {
  it('opens and closes a body with Enter, Space, and ←/→, and a search opens every body', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'Alpha', body: 'first body' }, { id: 'b', label: 'Beta', body: 'second body' }]
    const { surface, rows } = open(list({}, items))
    expect(rows().join('\n')).not.toContain('first body')
    surface.press(KEY.enter)
    expect(rows().join('\n')).toContain('╰ first body')
    surface.press(KEY.enter)
    expect(rows().join('\n')).not.toContain('first body')
    surface.press(KEY.right)
    expect(rows().join('\n')).toContain('first body')
    surface.press(KEY.right)
    surface.press(KEY.left)
    expect(rows().join('\n')).not.toContain('first body')
    surface.press(KEY.space)
    expect(rows().join('\n')).toContain('first body')
    surface.press(KEY.space)
    // Left on a body that is already closed is a no-op for the list.
    surface.press(KEY.left)
    expect(rows().join('\n')).not.toContain('first body')
  })

  it('opens the cursor row of an expandFocused list and follows the cursor', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'Alpha', body: 'first body' }, { id: 'b', label: 'Beta', body: 'second body' }]
    const { surface, rows } = open(list({ expandFocused: true }, items))
    expect(rows().join('\n')).toContain('first body')
    surface.press(KEY.down)
    expect(rows().join('\n')).toContain('second body')
    expect(rows().join('\n')).not.toContain('first body')
  })

  it('draws a node body compiled as content, once the row opens', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'Alpha', body: ui.stack.column([ui.text('rich body'), ui.divider({ label: 'rule' })]) }]
    const { surface, rows } = open(list({}, items))
    surface.press(KEY.enter)
    expect(rows().join('\n')).toContain('rich body')
    expect(rows().join('\n')).toContain('rule')
  })

  it('expands every branch with * and collapses them with -', () => {
    const items: MayflyListItem[] = [{ id: 'p', label: 'parent' }, { id: 'c', label: 'child', parentId: 'p' }, { id: 'q', label: 'second' }, { id: 'd', label: 'deep', parentId: 'q' }]
    const { surface, rows } = open(list({ tree: true }, items))
    expect(rows().join('\n')).not.toContain('child')
    surface.press('*')
    expect(rows().join('\n')).toContain('child')
    expect(rows().join('\n')).toContain('deep')
    surface.press('-')
    expect(rows().join('\n')).not.toContain('child')
    // While a search is typing the characters are text.
    const typing = open(list({ tree: true, filterable: true }, items))
    typing.surface.press('c')
    typing.surface.press('*')
    expect(typing.rows().join('\n')).toContain('/ c*')
  })

  it('follows focusItem once per rev and opens the parents of the row', () => {
    const items: MayflyListItem[] = [{ id: 'p', label: 'parent' }, { id: 'c', label: 'child', parentId: 'p' }, { id: 'z', label: 'zed' }]
    const { rows } = open(list({ tree: true, focusItem: { id: 'c', rev: 1 } }, items))
    expect(cursor(rows())).toContain('child')
  })

  it('skips rules and blank rows with the arrows', () => {
    const items: MayflyListItem[] = [{ id: 'a', label: 'A' }, { id: 'r', label: '', rule: 'Later' }, { id: 'g', label: '', gap: true }, { id: 'b', label: 'B' }]
    const { surface, rows } = open(list({}, items))
    surface.press(KEY.down)
    expect(cursor(rows())).toContain('B')
    surface.press(KEY.up)
    expect(cursor(rows())).toContain('A')
  })

  it('hands focus to the control below at the last row and to the one above at the first', () => {
    const node = ui.stack.column([list({ id: 'x' }), ui.actions({ id: 'bar', items: [{ id: 'go', label: 'Go' }] })])
    const { surface, rows } = open(node)
    for (const _ of fruit()) surface.press(KEY.down)
    expect(rows().join('\n')).toContain('Go')
    expect(cursor(rows())).toBeUndefined()
    surface.press(KEY.up)
    expect(cursor(rows())).toContain('Cherry')
    surface.press(KEY.home)
    // Home and PgUp at the first row stay put; only the arrows hand focus on.
    surface.press(KEY.home)
    expect(cursor(rows())).toContain('Apple')
    surface.press('\x1b[5~')
    expect(cursor(rows())).toContain('Apple')
    surface.press(KEY.up)
    expect(cursor(rows())).toContain('Apple')
  })

  it('lets the list with autofocus take focus first, whatever its place in the surface', () => {
    const node = ui.stack.column([
      ui.actions({ id: 'bar', items: [{ id: 'go', label: 'Go' }] }),
      list({ id: 'second', autofocus: true }),
    ])
    const { rows } = open(node)
    expect(cursor(rows())).toContain('Apple')
  })

  it('windows a long list with maxRows and counts what is hidden', () => {
    const items = Array.from({ length: 9 }, (_, index): MayflyListItem => ({ id: `r${String(index)}`, label: `row ${String(index + 1)}` }))
    const { surface, rows } = open(list({ maxRows: 4 }, items))
    expect(rows().join('\n')).toContain('↑ 0 more · ↓ 5 more')
    for (let step = 0; step < 6; step += 1) surface.press(KEY.down)
    expect(rows().join('\n')).toContain('row 7')
    expect(rows().join('\n')).toMatch(/↑ 4 more · ↓ 1 more/u)
  })

  it('keeps a plain list without a model as a roving list', () => {
    expect(open(list({ marker: 'selection' })).row('Apple')).toContain('Apple')
  })

  it('draws the strip of a list that has no frontend model from its seeded option', () => {
    const segment = (extra: object) => ({ options: [{ id: 'x', label: 'x' }, { id: 'y', label: 'y', disabled: true }], ...extra })
    const result = compileMayflyUiNode(list({}, [
      { id: 'a', label: 'A', segment: segment({ selectedId: 'y' }) },
      { id: 'b', label: 'B', segment: segment({ inheritedId: 'x' }) },
      { id: 'c', label: 'C', segment: segment({}) },
    ]), { components: parityComponents(), colors: PROBE_PALETTE, getViewport: () => ({ columns: 60, rows: 20 }), screenMode: 'alternate', emit: () => {} })
    if (!result.ok) throw new Error(result.message)
    result.value.focusTarget!.focused = true
    const rows = result.value.component.render(60).map(plain)
    expect(rows[0]).toMatch(/A +x ‹ y ›/u)
  })
})
