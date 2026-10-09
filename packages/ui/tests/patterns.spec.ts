import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isWireSnapshot, patterns, ui, type MayflyListItem, type MayflySurfaceNode, type MayflyUiNode } from '../src/index.ts'

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child, seen)
}

const options: readonly MayflyListItem[] = [{ id: 'keep', label: 'Keep' }, { id: 'delete', label: 'Delete', detail: 'cannot be undone' }]
const items = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] as const
const note = ui.text('note')
const column = (node: MayflyUiNode) => (node as MayflySurfaceNode).child as Extract<MayflyUiNode, { kind: 'stack' }>

describe('patterns.decisionPanel', () => {
  it('is a grant-first overlay: the focused choice list, digits by position, Esc rejects', () => {
    const panel = patterns.decisionPanel({ title: 'Delete branch?', options })
    expect(panel).toEqual(ui.surface({
      title: 'Delete branch?', chrome: 'overlay', escapeLabel: 'reject',
      child: ui.stack.column([ui.list({ id: 'decision.options', autofocus: true, role: 'choose', numbered: 'focus', selectedIds: [], items: options })]),
    }))
    expectDeepFrozen(panel)
    expect(isWireSnapshot(panel)).toBe(true)
  })

  it('adds the preview, badges, the note field, and hidden accelerators in order, under the given id', () => {
    const panel = patterns.decisionPanel({
      id: 'branch', title: 'Delete branch?', badges: [{ text: '1 of 2 waiting', tone: 'muted' }], preview: [note, ui.richText([{ text: 'warning' }])],
      options, input: { id: 'why', label: 'Note', placeholder: 'optional' }, instant: true, escapeLabel: 'cancel', chrome: 'surface',
      accelerators: [{ id: 'copy', label: 'Copy name', key: 'c', hintLabel: 'copy name' }, { id: 'other', label: 'Other', key: 'o', hidden: false }],
    })
    expect(panel).toMatchObject({ title: 'Delete branch?', chrome: 'surface', escapeLabel: 'cancel', badges: [{ text: '1 of 2 waiting', tone: 'muted' }] })
    const children = column(panel).children.map(child => child.node)
    expect(children.map(node => node.kind)).toEqual(['text', 'rich-text', 'list', 'form', 'actions'])
    expect(children[2]).toMatchObject({ id: 'branch.options', numbered: true, autofocus: true, role: 'choose' })
    expect(children[3]).toEqual(ui.form({ id: 'branch.input', fields: [{ id: 'why', kind: 'input', label: 'Note', value: '', placeholder: 'optional' }] }))
    expect(children[4]).toEqual(ui.actions({ id: 'branch.keys', items: [
      { id: 'copy', label: 'Copy name', key: 'c', hintLabel: 'copy name', hidden: true },
      { id: 'other', label: 'Other', key: 'o', hidden: true },
    ] }))
    expect(children[0]).toBe(note)
  })

  it('leaves out an empty accelerator list and an absent placeholder', () => {
    const panel = patterns.decisionPanel({ title: 'Ask', options, input: { id: 'why', label: 'Note' }, accelerators: [] })
    const kinds = column(panel).children.map(child => child.node.kind)
    expect(kinds).toEqual(['list', 'form'])
    expect(column(panel).children[1]!.node).toEqual(ui.form({ id: 'decision.input', fields: [{ id: 'why', kind: 'input', label: 'Note', value: '' }] }))
  })

  it('names the arm delay an overlay showing it unprompted sets', () => {
    expect(patterns.decisionArmMs).toBe(300)
    expect(Object.isFrozen(patterns)).toBe(true)
  })
})

describe('patterns.railPanel', () => {
  const rail = { id: 'rail', activeId: 'a', items: [{ id: 'a', label: 'Alpha', count: 2 }, { id: 'b', label: 'Beta' }] }

  it('puts a vertical rail beside one page per label, and keeps the rail from shrinking', () => {
    const pageA = ui.text('a')
    const pageB = ui.text('b')
    const panel = patterns.railPanel({ title: 'Workspaces', rail, content: { a: pageA, b: pageB } })
    expect(panel).toMatchObject({ title: 'Workspaces', chrome: 'overlay' })
    expect(panel).not.toHaveProperty('escapeLabel')
    const row = column(panel)
    expect(row).toMatchObject({ direction: 'row', gap: 2 })
    expect(row.children.map(child => ({ ...child, node: child.node.kind }))).toEqual([
      { node: 'tabs', basis: 26, shrink: 0 },
      { node: 'text', grow: 1, tab: { controlId: 'rail', itemId: 'a' } },
      { node: 'text', grow: 1, tab: { controlId: 'rail', itemId: 'b' } },
    ])
    expect(row.children[0]!.node).toEqual(ui.tabs({ ...rail, orientation: 'vertical' }))
    expectDeepFrozen(panel)
  })

  it('takes one node as the active label\'s content, a rail width, badges, and an Esc word; labels without a page get none', () => {
    const content = ui.text('live')
    const single = patterns.railPanel({ title: 'Sessions', badges: [{ text: '3' }], rail, content, railWidth: 30, escapeLabel: 'close' })
    expect(single).toMatchObject({ badges: [{ text: '3' }], escapeLabel: 'close' })
    expect(column(single).children.map(child => ({ ...child, node: child.node.kind }))).toEqual([{ node: 'tabs', basis: 30, shrink: 0 }, { node: 'text', grow: 1 }])
    expect(column(single).children[1]!.node).toBe(content)
    const partial = patterns.railPanel({ title: 'Sessions', rail, content: { b: content } })
    expect(column(partial).children).toHaveLength(2)
  })
})

describe('patterns.splitView', () => {
  const list = ui.list({ id: 'sv', role: 'browse', selectedIds: [], items })
  const detail = ui.text('detail')

  it('shows list and detail from the breakpoint and the list alone below it', () => {
    const view = patterns.splitView({ list, detail })
    expect(view).toEqual(ui.stack.row([
      ui.child(list, { basis: 58, when: { minWidth: 100 } }),
      ui.child(detail, { grow: 1, when: { minWidth: 100 } }),
      ui.child(list, { grow: 1, when: { maxWidth: 99 } }),
    ], { gap: 2 }))
    expectDeepFrozen(view)
    expect(view.children[0]!.node).toBe(list)
    expect(view.children[2]!.node).toBe(list)
  })

  it('takes the list width and the breakpoint', () => {
    const view = patterns.splitView({ list, detail, listWidth: 40, breakpoint: 80 })
    expect(view.children.map(child => [child.basis, child.grow, child.when])).toEqual([
      [40, undefined, { minWidth: 80 }], [undefined, 1, { minWidth: 80 }], [undefined, 1, { maxWidth: 79 }],
    ])
  })
})

describe('patterns.statusPage', () => {
  const tabs = { id: 'st', activeId: 'overview', items: [{ id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage' }] }

  it('is a tab strip, a spacer, and the key/value rows', () => {
    const rows = [{ label: 'Provider', value: [{ text: 'DeepSeek' }] }]
    const page = patterns.statusPage({ title: 'Status', tabs, rows })
    expect(page).toEqual(ui.surface({ title: 'Status', chrome: 'overlay', child: ui.stack.column([ui.tabs(tabs), ui.spacer(), ui.fields(rows)]) }))
    expectDeepFrozen(page)
  })

  it('shows a body instead of the rows, with badges and a footer', () => {
    const body = ui.text('body')
    const footer = ui.text('footer')
    const page = patterns.statusPage({ title: 'Status', badges: [{ text: 'live' }], tabs, rows: [], body, footer })
    expect(page).toMatchObject({ badges: [{ text: 'live' }], footer })
    expect(column(page).children.map(child => child.node.kind)).toEqual(['tabs', 'spacer', 'text'])
    expect(column(page).children[2]!.node).toBe(body)
  })

  it('links one page to each tab it has content for', () => {
    const page = patterns.statusPage({ title: 'Status', tabs, pages: { usage: ui.text('usage') } })
    expect(column(page).children.map(child => child.tab)).toEqual([undefined, undefined, { controlId: 'st', itemId: 'usage' }])
    const both = patterns.statusPage({ title: 'Status', tabs, pages: { overview: ui.text('o'), usage: ui.text('u') } })
    expect(column(both).children).toHaveLength(4)
  })

  it('refuses a page with nothing under the strip', () => {
    expect(() => patterns.statusPage({ title: 'Status', tabs })).toThrow('statusPage needs rows, a body, or pages')
  })
})

describe('pattern source', () => {
  it('is built only from the public builders: no renderer, Cordis, or core import', () => {
    const source = readFileSync(new URL('../src/patterns.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/^\} from '([^']+)'|^import [^\n]* from '([^']+)'/gmu)].map(match => match[1] ?? match[2])
    expect(imports).toEqual(['./builders.ts', './contracts.ts'])
    expect(source).not.toMatch(/kind: '(?:text|rich-text|stack|surface|list|form|actions|tabs|fields|spacer)'/u)
  })
})
