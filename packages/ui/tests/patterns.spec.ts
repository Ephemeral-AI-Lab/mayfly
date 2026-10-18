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
      accelerators: [{ id: 'copy', label: 'Copy name', key: 'c', hintLabel: 'copy name' }, { id: 'other', label: 'Other', key: 'o' }],
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
      ui.child(list, { basis: 58, shrink: 0, when: { minWidth: 100 } }),
      ui.child(detail, { basis: 0, grow: 1, when: { minWidth: 100 } }),
      ui.child(list, { grow: 1, when: { maxWidth: 99 } }),
    ], { gap: 2 }))
    expectDeepFrozen(view)
    expect(view.children[0]!.node).toBe(list)
    expect(view.children[2]!.node).toBe(list)
  })

  it('takes the list width and the breakpoint', () => {
    const view = patterns.splitView({ list, detail, listWidth: 40, breakpoint: 80 })
    expect(view.children.map(child => [child.basis, child.grow, child.when])).toEqual([
      [40, undefined, { minWidth: 80 }], [0, 1, { minWidth: 80 }], [undefined, 1, { maxWidth: 79 }],
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
    expect(imports).toEqual(['./builders.ts', './contracts.ts', './interaction.ts'])
  })
})

describe('patterns.wizard', () => {
  const step = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, body: ui.text(id), ...extra })

  it('is a step strip, a spacer, and one tab page per step; the last step without a review submits', () => {
    const pages = [step('one', 'One'), step('two', 'Two')]
    const wizard = patterns.wizard({ title: 'Setup', steps: pages })
    const next = (id: string, extra: Record<string, unknown>) => ({ id: `wizard.next.${id}`, label: 'Next', hidden: true, ...extra })
    expect(wizard).toEqual(ui.surface({
      title: 'Setup', chrome: 'overlay', escapeLabel: 'cancel',
      child: ui.stack.column([
        ui.tabs({ id: 'wizard', mode: 'wizard', activeId: 'one', hintLabel: 'step', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two', backId: 'one' }] }),
        ui.spacer(),
        ui.child(ui.stack.column([ui.text('one'), ui.actions({ id: 'wizard.keys.one', items: [next('one', { navigate: [{ controlId: 'wizard', itemId: 'two' }] })] })]), { tab: { controlId: 'wizard', itemId: 'one' } }),
        ui.child(ui.stack.column([ui.text('two'), ui.actions({ id: 'wizard.keys.two', items: [next('two', { label: 'Submit', intent: 'primary', submit: [] })] })]), { tab: { controlId: 'wizard', itemId: 'two' } }),
      ]),
    }))
    expectDeepFrozen(wizard)
    expect(patterns.wizardNext('wizard', 'two')).toBe('wizard.next.two')
  })

  it('carries a step\'s forms and lists on its next action, settles a step through the consumer, and reviews every answer', () => {
    const one = step('one', 'Name', { forms: ['name'], lists: ['pick'] })
    const two = step('two', 'Note', { settle: true, holdBack: true, forms: ['note'], lists: ['tag'] })
    const review = {
      label: 'Review', skippedLabel: 'Skipped', submitLabel: 'Create',
      items: [
        { stepId: 'one', label: 'Name', source: { kind: 'list' as const, controlId: 'pick' } },
        { stepId: 'two', label: 'Note', source: { kind: 'form' as const, formId: 'note', fieldId: 'text' } },
      ],
    }
    const wizard = patterns.wizard({ id: 'wiz', title: 'New thing', badges: [{ text: 'new' }], steps: [one, two], activeId: 'two', review, submitActionId: 'create', hintLabel: 'stage' })
    const pathOne = [{ controlId: 'wiz', itemId: 'one' }]
    const pathTwo = [{ controlId: 'wiz', itemId: 'two' }]
    const submit = {
      id: 'create', label: 'Create', hidden: true, intent: 'primary' as const,
      submit: [{ pagePath: pathOne, formId: 'name' }, { pagePath: pathTwo, formId: 'note' }],
      selections: [{ pagePath: pathOne, controlId: 'pick' }, { pagePath: pathTwo, controlId: 'tag' }],
    }
    expect(wizard).toEqual(ui.surface({
      title: 'New thing', chrome: 'overlay', escapeLabel: 'cancel', badges: [{ text: 'new' }],
      child: ui.stack.column([
        ui.tabs({
          id: 'wiz', mode: 'wizard', activeId: 'two', hintLabel: 'stage',
          items: [{ id: 'one', label: 'Name' }, { id: 'two', label: 'Note' }, { id: 'wiz.review', label: 'Review', review: true, backId: 'two' }],
        }),
        ui.spacer(),
        ui.child(ui.stack.column([one.body, ui.actions({ id: 'wiz.keys.one', items: [{
          id: 'wiz.next.one', label: 'Next', hidden: true,
          read: [{ pagePath: pathOne, formId: 'name' }],
          navigate: pathTwo,
        }] })]), { tab: { controlId: 'wiz', itemId: 'one' } }),
        ui.child(ui.stack.column([two.body, ui.actions({ id: 'wiz.keys.two', items: [{
          id: 'wiz.next.two', label: 'Next', hidden: true, intent: 'primary' as const,
          submit: [{ pagePath: pathTwo, formId: 'note' }],
          selections: [{ pagePath: pathTwo, controlId: 'tag' }],
        }] })]), { tab: { controlId: 'wiz', itemId: 'two' } }),
        ui.child(ui.stack.column([
          ui.review({
            id: 'wiz.review', tabsId: 'wiz', skippedLabel: 'Skipped', submitLabel: 'Create', submitActionId: 'create', autofocus: true,
            items: [
              { id: 'one', label: 'Name', source: { kind: 'list', pagePath: pathOne, controlId: 'pick' } },
              { id: 'two', label: 'Note', source: { kind: 'form', pagePath: pathTwo, formId: 'note', fieldId: 'text' } },
            ],
          }),
          ui.actions({ id: 'wiz.keys.review', items: [submit] }),
        ]), { tab: { controlId: 'wiz', itemId: 'wiz.review' } }),
      ]),
    }))
    expectDeepFrozen(wizard)
  })

  it('shows one step alone with no strip, and submits its forms and selections at once', () => {
    const only = step('only', 'Only', { forms: ['name'], lists: ['pick'] })
    const wizard = patterns.wizard({ id: 'solo', title: 'One', steps: [only], badges: [{ text: 'solo' }] })
    expect(wizard).toEqual(ui.surface({
      title: 'One', chrome: 'overlay', escapeLabel: 'cancel', badges: [{ text: 'solo' }],
      child: ui.stack.column([only.body, ui.actions({ id: 'solo.keys.only', items: [{
        id: 'solo.next.only', label: 'Submit', hidden: true, intent: 'primary',
        submit: [{ pagePath: [], formId: 'name' }],
        selections: [{ pagePath: [], controlId: 'pick' }],
      }] })]),
    }))
  })

  it('gives a settling step with nothing to submit a plain next action, with no navigation of its own', () => {
    const steps = [step('a', 'A'), step('b', 'B', { settle: true }), step('c', 'C')]
    const middlePage = column(patterns.wizard({ title: 'W', steps })).children[3]!.node as Extract<MayflyUiNode, { kind: 'stack' }>
    const next = middlePage.children[1]!.node
    expect(next).toEqual(ui.actions({ id: 'wizard.keys.b', items: [{ id: 'wizard.next.b', label: 'Next', hidden: true, intent: 'primary' }] }))
  })

  it('refuses a wizard with no steps', () => {
    expect(() => patterns.wizard({ title: 'Empty', steps: [] })).toThrow('wizard needs at least one step')
  })
})

describe('patterns.splitView branches', () => {
  it('takes a separator between list and detail, and a compact list below its own width', () => {
    const list = ui.list({ id: 'sv', role: 'browse', selectedIds: [], items })
    const detail = ui.text('detail')
    const separator = ui.text('│')
    const compact = ui.list({ id: 'sv-compact', role: 'browse', selectedIds: [], items: [] })
    const view = patterns.splitView({ list, detail, separator, compactList: compact, compactBelow: 40, breakpoint: 90, listWidth: 30 })
    expect(view.children.map(child => ({ ...child, node: child.node.kind }))).toEqual([
      { node: 'list', basis: 30, shrink: 0, when: { minWidth: 90 } },
      { node: 'text', basis: 1, shrink: 0, when: { minWidth: 90 } },
      { node: 'text', basis: 0, grow: 1, when: { minWidth: 90 } },
      { node: 'list', grow: 1, when: { minWidth: 40, maxWidth: 89 } },
      { node: 'list', grow: 1, when: { maxWidth: 39 } },
    ])
    expect(view.children[4]!.node).toBe(compact)
    expect(view.children[3]!.node).toBe(list)
  })
})

describe('patterns.wizard navigation branches', () => {
  const tabbed = [ { id: 'a', label: 'A', body: ui.text('a') }, { id: 'b', label: 'B', body: ui.text('b') } ]

  it('sends the last step before a review to the review page, and drops optional badges from a lone step', () => {
    const review = { label: 'Review', skippedLabel: 'Skipped', submitLabel: 'Done', items: [] }
    const wizard = patterns.wizard({ title: 'Reviewed', steps: tabbed, review })
    const pages = column(wizard).children
    const last = pages[3]!.node as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(last.children[1]!.node).toEqual(ui.actions({ id: 'wizard.keys.b', items: [{
      id: 'wizard.next.b', label: 'Next', hidden: true, navigate: [{ controlId: 'wizard', itemId: 'wizard.review' }],
    }] }))
    const lone = patterns.wizard({ title: 'Lone', steps: [tabbed[0]!] })
    expect(lone).toEqual(ui.surface({ title: 'Lone', chrome: 'overlay', escapeLabel: 'cancel', child: ui.stack.column([tabbed[0]!.body, ui.actions({ id: 'wizard.keys.a', items: [{ id: 'wizard.next.a', label: 'Submit', hidden: true, intent: 'primary', submit: [] }] })]) }))
  })
})
