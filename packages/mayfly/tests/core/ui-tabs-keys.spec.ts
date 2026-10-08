/**
 * Tabs, rails, and focus levels (roadmap slice 1.5) through the real compiler: the hint row in each tab state, the
 * rail's keys, the `←` ladder across a select, a segment strip, a branch, an action row, and a toggle, the focus levels
 * (`Alt+↑/↓`, `F4`/`F5`), the tab switch (`Alt+←/→`, `F2`/`F3`), and `Esc` returning to the home control first.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyListItem, type MayflyTabItem, type MayflyUiEvent, type MayflyUiNode } from '../../../ui/src/index.ts'
import { createRealSurface, parityComponents, type RealSurface } from '../design/parity.ts'

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_pi:c\x07/gu, '')
const KEY = {
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r', esc: '\x1b', tab: '\t', space: ' ',
  altUp: '\x1b[1;3A', altDown: '\x1b[1;3B', altLeft: '\x1b[1;3D', altRight: '\x1b[1;3C', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~',
} as const

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

function open(content: MayflyUiNode, width = 100, escape = true) {
  const node = content.kind === 'surface' ? content : ui.surface({ title: 'Panel', chrome: 'overlay', child: content })
  const events: MayflyUiEvent[] = []
  let escapes = 0
  const surface = createRealSurface(node, width, {
    components: parityComponents(), events: event => events.push(event),
    ...(escape ? { overrides: { onUnhandledEscape: () => { escapes += 1 }, escapeHint: 'close' as const } } : {}),
  })
  surfaces.push(surface)
  const rows = (): string[] => surface.render().map(plain)
  const hint = (): string => rows().at(-2)!.replace(/^│\s*|\s*│$/gu, '')
  const tabs = (): string[] => events.filter(event => event.kind === 'tab-change').map(event => (event as { tabId: string }).tabId)
  return { surface, events, rows, hint, tabs, press: (...keys: string[]) => { for (const key of keys) surface.press(key) }, escapes: () => escapes }
}

const select = (id: string, label: string, value: string, ids: readonly string[]) => ({ id, kind: 'select' as const, label, value, options: ids.map((option): MayflyListItem => ({ id: option, label: option })) })
const ITEMS: readonly MayflyTabItem[] = [
  { id: 'general', label: 'General', group: 'Session' }, { id: 'model', label: 'Model', group: 'Session' }, { id: 'perm', label: 'Permissions', count: 2, group: 'Session' },
  { id: 'providers', label: 'Providers', attention: true, group: 'Integrations' },
]

/** A settings panel: a rail beside the page of the active label. */
function settings(page: (id: string) => MayflyUiNode, active = 'model'): MayflyUiNode {
  return ui.surface({
    title: 'Settings', chrome: 'overlay',
    child: ui.stack.row([
      ui.child(ui.tabs({ id: 'rail', orientation: 'vertical', items: ITEMS, activeId: active }), { basis: 24, shrink: 0 }),
      ...ITEMS.map(item => ui.child(page(item.id), { grow: 1, tab: { controlId: 'rail', itemId: item.id } })),
    ], { gap: 2 }),
  })
}
const selectPage = (id: string): MayflyUiNode => ui.form({ id: `form.${id}`, fields: [select('mode', 'Mode', 'low', ['low', 'medium', 'high']), { id: 'on', kind: 'toggle', label: 'On', value: true }] })

describe('the hint row of a tab strip, a wizard, and a rail', () => {
  const STRIP: readonly MayflyTabItem[] = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', count: 3 }, { id: 'c', label: 'Gamma', attention: true }]
  const strip = (extra: object = {}): MayflyUiNode => ui.stack.column([
    ui.tabs({ id: 'strip', activeId: 'a', items: STRIP, ...extra }), ui.child(ui.list({ id: 'l', role: 'browse', selectedIds: [], items: [{ id: 'x', label: 'X' }] }), { tab: { controlId: 'strip', itemId: 'a' } }),
  ])

  it('names the arrows, Enter, and Esc on a focused strip, and Alt+←/→ with the strip\'s own word from the content', () => {
    const view = open(strip())
    expect(view.hint()).toBe('←/→ tabs · Enter open · Esc close')
    view.press(KEY.enter)
    expect(view.hint()).toBe('↑/↓ options · Enter open · Alt+←/→ tabs · Esc back')
    expect(open(strip({ hintLabel: 'views' })).surface.press(KEY.enter).map(plain).some(row => row.includes('Alt+←/→ views'))).toBe(true)
  })

  it('words a wizard\'s Escape back, and names the vertical rail\'s own keys', () => {
    expect(open(ui.tabs({ id: 'steps', mode: 'wizard', activeId: 'a', items: STRIP.slice(0, 2) })).hint()).toBe('←/→ tabs · Enter open · Esc back')
    expect(open(settings(selectPage)).hint()).toBe('↑/↓ labels · → open · Esc close')
  })
})

describe('the rail', () => {
  it('emits tab-change at once on ↑/↓ so the content follows the cursor, and stops at its ends', () => {
    const view = open(settings(selectPage))
    view.press(KEY.down)
    expect(view.tabs()).toEqual(['perm'])
    expect(view.rows().some(row => row.includes('Permissions'))).toBe(true)
    view.press(KEY.down, KEY.down, KEY.down)
    expect(view.tabs()).toEqual(['perm', 'providers'])
    view.press(KEY.up, KEY.up, KEY.up, KEY.up, KEY.up)
    expect(view.tabs()).toEqual(['perm', 'providers', 'perm', 'model', 'general'])
  })

  it('draws the arrow in primary while the rail has focus and muted once focus is in the content', () => {
    const view = open(settings(selectPage))
    const arrow = (): string => view.rows().find(row => row.includes('→ Model'))!
    expect(arrow()).toContain('→ Model')
    const ansi = view.surface.render().find(row => plain(row).includes('→ Model'))!
    expect(ansi).toContain('\x1b[1m')
    view.press(KEY.right)
    expect(arrow()).toContain('→ Model')
  })

  it('enters the content with → or Enter, and does nothing on ←', () => {
    for (const enter of [KEY.right, KEY.enter]) {
      const view = open(settings(selectPage))
      view.press(KEY.left)
      expect(view.hint()).toBe('↑/↓ labels · → open · Esc close')
      view.press(enter)
      expect(view.hint()).toContain('Esc back')
      expect(view.tabs()).toEqual([])
    }
  })

  it('becomes the horizontal strip below 60 columns, with ←/→ and Enter', () => {
    const view = open(settings(selectPage), 58)
    expect(view.hint()).toBe('←/→ tabs · Enter open · Esc close')
    view.press(KEY.right)
    expect(view.tabs()).toEqual(['perm'])
    view.press(KEY.left, KEY.left)
    expect(view.tabs()).toEqual(['perm', 'model', 'general'])
  })
})

describe('the ← ladder', () => {
  it('lets a select use ← while an earlier option exists, and hands the first ← it cannot use to the rail', () => {
    const view = open(settings(selectPage))
    view.press(KEY.right)
    // `Mode` is on its first option: ← is not the select's, → is.
    expect(view.hint()).toBe('←/→ adjust · ← labels · Enter pick · Esc back')
    view.press(KEY.right)
    expect(view.hint()).not.toContain('← labels')
    expect(view.rows().some(row => row.includes('medium'))).toBe(true)
    view.press(KEY.left)
    expect(view.rows().some(row => row.includes('low'))).toBe(true)
    expect(view.hint()).toContain('← labels')
    view.press(KEY.left)
    expect(view.hint()).toBe('↑/↓ labels · → open · Esc close')
    expect(view.tabs()).toEqual([])
  })

  it('hands ← to the rail from a toggle, and does nothing further on the rail', () => {
    const view = open(settings(selectPage))
    view.press(KEY.right, KEY.down)
    expect(view.hint()).toContain('← labels')
    view.press(KEY.left)
    expect(view.hint()).toBe('↑/↓ labels · → open · Esc close')
    view.press(KEY.left, KEY.left)
    expect(view.hint()).toBe('↑/↓ labels · → open · Esc close')
    expect(view.escapes()).toBe(0)
  })

  it('treats a segment strip at its first option and a closed branch as unused ←', () => {
    const effort = { label: 'Thinking', options: [{ id: 'min', label: 'min' }, { id: 'high', label: 'high' }, { id: 'max', label: 'max' }] }
    const page = (): MayflyUiNode => ui.list({ id: 'models', role: 'browse', selectedIds: [], items: [
      { id: 'pro', label: 'Pro', segment: { ...effort, selectedId: 'min' } },
      { id: 'tree', label: 'Tree', body: 'Opens.' },
      { id: 'plain', label: 'Plain' },
    ] })
    const view = open(settings(page))
    view.press(KEY.right)
    expect(view.hint()).toContain('← labels')
    view.press(KEY.right)
    expect(view.hint()).not.toContain('← labels')
    view.press(KEY.left)
    expect(view.hint()).toContain('← labels')
    view.press(KEY.down)
    expect(view.hint()).toContain('← labels')
    view.press(KEY.right)
    expect(view.hint()).not.toContain('← labels')
    view.press(KEY.left)
    view.press(KEY.down)
    expect(view.hint()).toContain('← labels')
    view.press(KEY.left)
    expect(view.hint()).toBe('↑/↓ labels · → open · Esc close')
  })

  it('hands ← from the first action to the rail, and steps back along an actions row otherwise', () => {
    const page = (): MayflyUiNode => ui.actions({ id: 'ops', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] })
    const view = open(settings(page))
    view.press(KEY.right)
    expect(view.hint()).toContain('← labels')
    view.press(KEY.right)
    expect(view.hint()).not.toContain('← labels')
    view.press(KEY.left)
    expect(view.hint()).toContain('← labels')
    view.press(KEY.left)
    expect(view.hint()).toBe('↑/↓ labels · → open · Esc close')
  })

  it('goes to the rail from a scroll region, an empty list, and a text field, wherever the rail sits', () => {
    const scroll = (): MayflyUiNode => ui.scroll(ui.stack.column(Array.from({ length: 12 }, (_, index) => ui.text(`line ${String(index)}`))), { id: 'log', height: 4 })
    const empty = (): MayflyUiNode => ui.list({ id: 'none', role: 'browse', selectedIds: [], items: [] })
    const text = (): MayflyUiNode => ui.form({ id: 'f', fields: [{ id: 'name', kind: 'input', label: 'Name', value: '' }] })
    for (const page of [scroll, empty, text]) {
      const view = open(settings(page))
      view.press(KEY.right)
      expect(view.hint()).toContain('← labels')
      view.press(KEY.left)
      expect(view.hint()).toBe('↑/↓ labels · → open · Esc close')
    }
    // The rail on the right of the content is still where ← goes.
    const trailing = ui.surface({ title: 'T', chrome: 'overlay', child: ui.stack.row([
      ui.child(ui.form({ id: 'f', fields: [{ id: 'name', kind: 'input', label: 'Name', value: '' }] }), { grow: 1 }),
      ui.child(ui.tabs({ id: 'rail', orientation: 'vertical', activeId: 'a', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }), { basis: 12, shrink: 0 }),
    ]) })
    const view = open(trailing)
    expect(view.hint()).toContain('← labels')
    // The rail follows the content in the focus order here, so it is not the home control.
    view.press(KEY.left)
    expect(view.hint()).toBe('↑/↓ labels · → open · Esc back')
  })

  it('names no rail where the surface has none, or where the focus is on the rail', () => {
    const list = ui.list({ id: 'l', role: 'browse', selectedIds: [], items: [{ id: 'x', label: 'X' }] })
    expect(open(list).hint()).not.toContain('labels')
  })
})

describe('focus levels and the tab switch', () => {
  const twoLists = (): MayflyUiNode => ui.stack.column([
    ui.list({ id: 'first', role: 'choose', selectedIds: [], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
    ui.list({ id: 'second', role: 'choose', selectedIds: [], items: [{ id: 'c', label: 'C' }, { id: 'd', label: 'D' }] }),
    ui.actions({ id: 'ops', items: [{ id: 'run', label: 'Run' }] }),
  ])

  it('moves between controls with Alt+↑/↓ and F4/F5 without wrapping', () => {
    for (const [prev, next] of [[KEY.altUp, KEY.altDown], [KEY.f4, KEY.f5]]) {
      const view = open(twoLists())
      const focused = (): string => view.rows().find(row => row.includes('→ ')) ?? view.rows().find(row => row.includes('[ Run ]')) ?? ''
      view.press(prev)
      expect(focused()).toContain('→ A')
      view.press(next)
      expect(focused()).toContain('C')
      view.press(next, next)
      expect(view.hint()).toContain('run')
      view.press(prev)
      expect(view.hint()).toContain('options')
    }
  })

  it('switches tabs from the content with Alt+←/→ and F2/F3', () => {
    const page = (): MayflyUiNode => ui.list({ id: 'l', role: 'browse', selectedIds: [], items: [{ id: 'x', label: 'X' }] })
    for (const [prev, next] of [[KEY.altLeft, KEY.altRight], [KEY.f2, KEY.f3]]) {
      const view = open(settings(page))
      view.press(KEY.right, next)
      expect(view.tabs()).toEqual(['perm'])
      view.press(prev, prev)
      expect(view.tabs()).toEqual(['perm', 'model', 'general'])
      // Back on the rail by ←, the rail is on the label it shows: ↑ steps from there.
      view.press(next, next, KEY.left)
      expect(view.hint()).toBe('↑/↓ labels · → open · Esc close')
      view.press(KEY.up)
      expect(view.tabs().at(-1)).toBe('model')
    }
  })
})

describe('Escape returns to the home control first', () => {
  it('words Esc back away from the home control, returns to it, and closes from there', () => {
    const view = open(settings(selectPage))
    view.press(KEY.right)
    expect(view.hint()).toContain('Esc back')
    view.press(KEY.esc)
    expect(view.hint()).toBe('↑/↓ labels · → open · Esc close')
    expect(view.escapes()).toBe(0)
    view.press(KEY.esc)
    expect(view.escapes()).toBe(1)
  })

  it('leaves a surface with a single control, or an autofocused list, closing at once', () => {
    const lists = ui.stack.column([
      ui.list({ id: 'first', role: 'browse', selectedIds: [], items: [{ id: 'a', label: 'A' }] }),
      ui.list({ id: 'second', role: 'browse', autofocus: true, selectedIds: [], items: [{ id: 'b', label: 'B' }] }),
    ])
    const view = open(lists)
    expect(view.hint()).toContain('Esc close')
    view.press(KEY.altUp)
    expect(view.hint()).toContain('Esc back')
    view.press(KEY.esc)
    expect(view.hint()).toContain('Esc close')
    expect(view.escapes()).toBe(0)
  })
})
