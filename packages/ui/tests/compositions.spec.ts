import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  compose,
  DECISION_NO,
  DECISION_YES,
  ui,
  type MayflySurfaceNode,
  type MayflyUiNode,
} from '../src/index.ts'

const stack = (node: MayflyUiNode) => (node as MayflySurfaceNode).child as Extract<MayflyUiNode, { kind: 'stack' }>
const column = (node: MayflyUiNode) => node as Extract<MayflyUiNode, { kind: 'stack' }>
const row = (node: MayflyUiNode) => node as Extract<MayflyUiNode, { kind: 'stack' }>

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child, seen)
}

describe('compose.panel', () => {
  it('is one overlay surface with the caller title, escape word, and body', () => {
    const body = ui.text('body')
    const panel = compose.panel({ title: 'Model', subtitle: 'Choose one', badges: [{ text: 'live' }], escapeLabel: 'close', body, footer: ui.text('footer') })
    expect(panel).toMatchObject({
      kind: 'surface', chrome: 'overlay', title: 'Model', subtitle: 'Choose one', escapeLabel: 'close',
      badges: [{ text: 'live' }],
    })
    expect(panel.child).toBe(body)
    expect(panel.footer).toEqual(ui.text('footer'))
  })
})

describe('compose.decisionLane', () => {
  it('builds one lane with a numbered choice list, a note, and hidden actions', () => {
    const panel = compose.decisionLane({
      title: 'Decide', badges: [{ text: '1 of 2 waiting' }],
      choices: [{ id: 'allow', label: 'Allow' }, { id: 'reject', label: 'Reject' }],
      note: { id: 'note', label: 'Feedback' },
      keys: [{ id: 'open', label: 'Open', semantic: 'external', hintLabel: 'open' }],
      escapeLabel: 'reject',
    })
    expect(panel).toMatchObject({ kind: 'surface', chrome: 'lane', title: 'Decide', escapeLabel: 'reject' })
    const kinds = stack(panel).children.map(child => child.node.kind)
    expect(kinds).toEqual(['list', 'form', 'actions'])
    expect(stack(panel).children[0]!.node).toMatchObject({
      id: 'decision.options', role: 'choose', numbered: true, acceptActionId: 'decision.choose',
    })
    expect(stack(panel).children[1]!.node).toMatchObject({ id: 'decision.note', enterSubmits: 'decision.send' })
    expect(stack(panel).children[2]!.node).toMatchObject({
      id: 'decision.keys',
      items: [
        expect.objectContaining({ id: 'decision.choose', hidden: true }),
        expect.objectContaining({ id: 'decision.send', hidden: true }),
        expect.objectContaining({ id: 'open', hidden: true, semantic: 'external' }),
      ],
    })
  })

  it('can allow the lane to take the whole editor slot and hide the status row', () => {
    const covered = compose.decisionLane({ title: 'Questions', body: ui.text('question'), coverStatus: true })
    expect(covered).toMatchObject({ kind: 'surface', chrome: 'lane', coverStatus: true })
    expect(compose.decisionLane({ title: 'Plan', body: ui.text('plan') })).not.toHaveProperty('coverStatus')
  })

  it('takes exactly one of body or choices', () => {
    expect(() => compose.decisionLane({ title: 'Both', body: ui.text('b'), choices: [] })).toThrow('exactly one')
    expect(() => compose.decisionLane({ title: 'Neither' })).toThrow('exactly one')
  })

  it('names the arm delay an overlay showing it unprompted sets', () => {
    expect(compose.decisionArmMs).toBe(300)
    expect(Object.isFrozen(compose)).toBe(true)
  })
})

describe('compose.decisionStrip', () => {
  it('is a lane surface with y/n hidden actions and Esc no', () => {
    const strip = compose.decisionStrip({ title: 'Stop?', detail: 'The job ends', danger: true })
    expect(strip).toMatchObject({ kind: 'surface', chrome: 'lane', title: 'Stop?', escapeLabel: 'no' })
    const children = stack(strip).children.map(child => child.node)
    expect(children[0]).toMatchObject({ kind: 'text', tone: 'warning' })
    expect(children[1]).toMatchObject({
      kind: 'actions',
      items: [
        expect.objectContaining({ id: DECISION_YES, key: 'y', hidden: true, intent: 'danger' }),
        expect.objectContaining({ id: DECISION_NO, key: 'n', hidden: true }),
      ],
    })
  })
})

describe('compose.tabs', () => {
  it('puts a horizontal tab strip over arbitrary pages, with one gap row by default', () => {
    const browse = ui.text('browse')
    const updates = ui.text('updates')
    const node = compose.tabs({
      tabs: { id: 'plugin-tabs', activeId: 'browse', items: [{ id: 'browse', label: 'Browse' }, { id: 'updates', label: 'Updates' }] },
      pages: { browse, updates },
    })
    expect(node).toMatchObject({ kind: 'stack', direction: 'column', gap: 1 })
    const children = (node as Extract<MayflyUiNode, { kind: 'stack' }>).children
    expect(children[0]!.node).toMatchObject({ kind: 'tabs', id: 'plugin-tabs', activeId: 'browse' })
    expect(children[1]).toMatchObject({ node: browse, tab: { controlId: 'plugin-tabs', itemId: 'browse' } })
    expect(children[2]).toMatchObject({ node: updates, tab: { controlId: 'plugin-tabs', itemId: 'updates' } })
  })

  it('lets a page grow for stats, and skips tabs with no page', () => {
    const page = ui.text('page')
    const node = compose.tabs({
      tabs: { id: 'stats-tabs', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'missing', label: 'Missing' }] },
      pages: { one: page }, pageGrow: true,
    })
    const children = (node as Extract<MayflyUiNode, { kind: 'stack' }>).children
    expect(children).toHaveLength(2)
    expect(children[1]).toMatchObject({ node: page, grow: 1, minSize: 1 })
  })
})

describe('compose.rail', () => {
  const rail = { id: 'rail', activeId: 'a', items: [{ id: 'a', label: 'Alpha', count: 2 }, { id: 'b', label: 'Beta' }] }

  it('puts a vertical rail beside one page per label, and keeps the rail from shrinking', () => {
    const pageA = ui.text('a')
    const pageB = ui.text('b')
    const node = compose.rail({ rail, pages: { a: pageA, b: pageB } })
    expect(node).toMatchObject({ kind: 'stack', direction: 'row', gap: 3, rule: 'column' })
    expectDeepFrozen(node)
    const children = (node as Extract<MayflyUiNode, { kind: 'stack' }>).children
    expect(children[0]).toMatchObject({ node: { kind: 'tabs', orientation: 'vertical', id: 'rail' }, basis: 26, shrink: 0 })
    expect(children[1]).toMatchObject({ node: pageA, grow: 1, tab: { controlId: 'rail', itemId: 'a' } })
    expect(children[2]).toMatchObject({ node: pageB, grow: 1, tab: { controlId: 'rail', itemId: 'b' } })
  })

  it('takes one node as the active label\'s content, a rail width, and labels without a page get none', () => {
    const content = ui.text('live')
    const single = compose.rail({ rail, content, railWidth: 30 })
    const children = (single as Extract<MayflyUiNode, { kind: 'stack' }>).children
    expect(children.map(child => ({ ...child, node: child.node.kind }))).toEqual([
      { node: 'tabs', basis: 30, shrink: 0 },
      { node: 'text', grow: 1 },
    ])
    expect(children[1]!.node).toBe(content)
    const partial = compose.rail({ rail, pages: { b: content } })
    expect((partial as Extract<MayflyUiNode, { kind: 'stack' }>).children).toHaveLength(2)
    expect((partial as Extract<MayflyUiNode, { kind: 'stack' }>).children[1]!.node).toBe(content)
  })
})

describe('compose.browser', () => {
  const list = ui.list({ id: 'sv', role: 'browse', selectedIds: [], items: [{ id: 'a', label: 'A' }] })
  const detail = ui.text('detail')

  it('shows list and detail side by side from the breakpoint, and one narrow page', () => {
    const node = compose.browser({ list, detail, narrow: 'detail' })
    const children = (node as Extract<MayflyUiNode, { kind: 'stack' }>).children
    expect(node).toMatchObject({ kind: 'stack', direction: 'row', gap: 3, rule: 'column' })
    expect(children[0]).toMatchObject({ node: list, basis: 58, grow: 0, shrink: 0, when: { minWidth: 100 } })
    expect(children[1]).toMatchObject({ node: detail, grow: 1, when: { minWidth: 100 } })
    expect(children[2]).toMatchObject({ node: detail, grow: 1, when: { maxWidth: 99 } })
  })

  it('draws the list and detail from the breakpoint and the list alone below it, without the column rule', () => {
    const view = compose.browser({ list, detail, separator: false })
    expect(view).toEqual(ui.stack.row([
      ui.child(list, { basis: 58, grow: 0, shrink: 0, when: { minWidth: 100 } }),
      ui.child(detail, { basis: 0, grow: 1, when: { minWidth: 100 } }),
      ui.child(list, { grow: 1, when: { maxWidth: 99 } }),
    ], { gap: 2 }))
    expectDeepFrozen(view)
    expect(row(view).children[0]!.node).toBe(list)
    expect(row(view).children[2]!.node).toBe(list)
  })

  it('takes the list width and the breakpoint', () => {
    const view = row(compose.browser({ list, detail, listWidth: 40, breakpoint: 80, separator: false }))
    expect(view.children.map(child => [child.basis, child.grow, child.when])).toEqual([
      [40, 0, { minWidth: 80 }], [0, 1, { minWidth: 80 }], [undefined, 1, { maxWidth: 79 }],
    ])
  })

  it('takes a separator between the list and the detail, and a distinct narrow list page', () => {
    const separator = ui.text('│')
    const narrow = ui.list({ id: 'sv-narrow', role: 'browse', selectedIds: [], items: [] })
    const view = row(compose.browser({ list, listNarrow: narrow, detail, separator, breakpoint: 90, listWidth: 30 }))
    expect(view.children.map(child => ({ ...child, node: child.node.kind }))).toEqual([
      { node: 'list', basis: 30, grow: 0, shrink: 0, when: { minWidth: 90 } },
      { node: 'text', basis: 1, grow: 0, shrink: 0, when: { minWidth: 90 } },
      { node: 'text', basis: 0, grow: 1, when: { minWidth: 90 } },
      { node: 'list', grow: 1, when: { maxWidth: 89 } },
    ])
    expect(view.children[3]!.node).toBe(narrow)
  })
})

describe('compose.wizard', () => {
  const step = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, body: ui.text(id), ...extra })

  it('drops the strip and review for one step', () => {
    const node = compose.wizard({ id: 'w', steps: [{ id: 'one', label: 'One', body: ui.text('one') }] })
    expect(node).toMatchObject({ kind: 'stack', direction: 'column' })
    expect((node as Extract<MayflyUiNode, { kind: 'stack' }>).children.some(child => child.node.kind === 'tabs')).toBe(false)
  })

  it('adds a step strip and a review page for several steps', () => {
    const node = compose.wizard({
      id: 'w',
      steps: [{ id: 'one', label: 'One', body: ui.text('one'), lists: ['pick'] }, { id: 'two', label: 'Two', body: ui.text('two'), lists: ['pick'] }],
      review: { label: 'Review', skippedLabel: 'skipped', submitLabel: 'Submit', items: [{ stepId: 'one', label: 'One', source: { kind: 'list', controlId: 'pick' } }] },
    })
    const children = (node as Extract<MayflyUiNode, { kind: 'stack' }>).children
    expect(children.map(child => child.node.kind)).toContain('tabs')
    expect(children.some(child => child.node.kind === 'stack' && child.node.children.some(grandchild => grandchild.node.kind === 'review'))).toBe(true)
  })

  it('is a step strip, a spacer, and one tab page per step; the last step without a review submits', () => {
    const pages = [step('one', 'One'), step('two', 'Two')]
    const wizard = compose.wizard({ steps: pages })
    const next = (id: string, extra: Record<string, unknown>) => ({ id: `wizard.next.${id}`, label: 'Next', hidden: true, ...extra })
    expect(wizard).toEqual(ui.stack.column([
      ui.tabs({ id: 'wizard', mode: 'wizard', activeId: 'one', hintLabel: 'step', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two', backId: 'one' }] }),
      ui.spacer(),
      ui.child(ui.stack.column([ui.text('one'), ui.actions({ id: 'wizard.keys.one', items: [next('one', { navigate: [{ controlId: 'wizard', itemId: 'two' }] })] })]), { tab: { controlId: 'wizard', itemId: 'one' } }),
      ui.child(ui.stack.column([ui.text('two'), ui.actions({ id: 'wizard.keys.two', items: [next('two', { label: 'Submit', intent: 'primary', submit: [] })] })]), { tab: { controlId: 'wizard', itemId: 'two' } }),
    ]))
    expectDeepFrozen(wizard)
    expect(compose.wizardNext('wizard', 'two')).toBe('wizard.next.two')
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
    const wizard = compose.wizard({ id: 'wiz', steps: [one, two], activeId: 'two', review, submitActionId: 'create', hintLabel: 'stage' })
    const pathOne = [{ controlId: 'wiz', itemId: 'one' }]
    const pathTwo = [{ controlId: 'wiz', itemId: 'two' }]
    const submit = {
      id: 'create', label: 'Create', hidden: true, intent: 'primary' as const,
      submit: [{ pagePath: pathOne, formId: 'name' }, { pagePath: pathTwo, formId: 'note' }],
      selections: [{ pagePath: pathOne, controlId: 'pick' }, { pagePath: pathTwo, controlId: 'tag' }],
    }
    expect(wizard).toEqual(ui.stack.column([
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
    ]))
    expectDeepFrozen(wizard)
  })

  it('shows one step alone with no strip, and submits its forms and selections at once', () => {
    const only = step('only', 'Only', { forms: ['name'], lists: ['pick'] })
    const wizard = compose.wizard({ id: 'solo', steps: [only] })
    expect(wizard).toEqual(ui.stack.column([only.body, ui.actions({ id: 'solo.keys.only', items: [{
      id: 'solo.next.only', label: 'Submit', hidden: true, intent: 'primary',
      submit: [{ pagePath: [], formId: 'name' }],
      selections: [{ pagePath: [], controlId: 'pick' }],
    }] })]))
  })

  it('gives a settling step with nothing to submit a plain next action, with no navigation of its own', () => {
    const steps = [step('a', 'A'), step('b', 'B', { settle: true }), step('c', 'C')]
    const middlePage = column(compose.wizard({ steps })).children[3]!.node as Extract<MayflyUiNode, { kind: 'stack' }>
    const next = middlePage.children[1]!.node
    expect(next).toEqual(ui.actions({ id: 'wizard.keys.b', items: [{ id: 'wizard.next.b', label: 'Next', hidden: true, intent: 'primary' }] }))
  })

  it('refuses a wizard with no steps', () => {
    expect(() => compose.wizard({ steps: [] })).toThrow('wizard needs at least one step')
  })

  it('sends the last step before a review to the review page, and drops the strip from a lone step', () => {
    const tabbed = [ { id: 'a', label: 'A', body: ui.text('a') }, { id: 'b', label: 'B', body: ui.text('b') } ]
    const review = { label: 'Review', skippedLabel: 'Skipped', submitLabel: 'Done', items: [] }
    const wizard = compose.wizard({ steps: tabbed, review })
    const pages = column(wizard).children
    const last = pages[3]!.node as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(last.children[1]!.node).toEqual(ui.actions({ id: 'wizard.keys.b', items: [{
      id: 'wizard.next.b', label: 'Next', hidden: true, navigate: [{ controlId: 'wizard', itemId: 'wizard.review' }],
    }] }))
    const lone = compose.wizard({ steps: [tabbed[0]!] })
    expect(lone).toEqual(ui.stack.column([tabbed[0]!.body, ui.actions({ id: 'wizard.keys.a', items: [{ id: 'wizard.next.a', label: 'Submit', hidden: true, intent: 'primary', submit: [] }] })]))
  })
})

describe('compose.statusPage', () => {
  const tabs = { id: 'st', activeId: 'overview', items: [{ id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage' }] }

  it('is a tab strip, a spacer, and the key/value rows', () => {
    const rows = [{ label: 'Provider', value: [{ text: 'DeepSeek' }] }]
    const page = compose.statusPage({ tabs, rows })
    expect(page).toEqual(ui.stack.column([ui.tabs(tabs), ui.spacer(), ui.fields(rows)]))
    expectDeepFrozen(page)
  })

  it('shows a body instead of the rows, with a footer', () => {
    const body = ui.text('body')
    const footer = ui.text('footer')
    const page = compose.statusPage({ tabs, rows: [], body, footer })
    expect(column(page).children.map(child => child.node.kind)).toEqual(['tabs', 'spacer', 'text', 'text'])
    expect(column(page).children[2]!.node).toBe(body)
    expect(column(page).children[3]!.node).toBe(footer)
  })

  it('links one page to each tab it has content for', () => {
    const page = compose.statusPage({ tabs, pages: { usage: ui.text('usage') } })
    const inner = column(page).children[0]!.node as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(column(page).children).toHaveLength(1)
    expect(inner.children.map(child => child.tab)).toEqual([undefined, { controlId: 'st', itemId: 'usage' }])
    const both = compose.statusPage({ tabs, pages: { overview: ui.text('o'), usage: ui.text('u') } })
    expect((column(both).children[0]!.node as Extract<MayflyUiNode, { kind: 'stack' }>).children).toHaveLength(3)
  })

  it('refuses a page with nothing under the strip', () => {
    expect(() => compose.statusPage({ tabs })).toThrow('statusPage needs rows, a body, or pages')
  })
})

describe('compose.completionPalette', () => {
  it('draws a focused row, typed prefix, detail, right cue, and wait note', () => {
    const node = compose.completionPalette({
      items: [{ id: 'a', label: 'alpha', detail: 'a detail', right: 'Ctrl+G', focused: true, typedPrefix: 'al' }],
      wait: 'Waiting for the file',
    })
    const rows = (node as Extract<MayflyUiNode, { kind: 'stack' }>).children.map(child => child.node)
    expect(rows[0]).toMatchObject({ kind: 'stack', direction: 'row' })
    expect(rows.at(-1)).toMatchObject({ kind: 'text', tone: 'muted' })
  })
})

describe('compose source', () => {
  it('is built only from the public builders: no renderer, Cordis, or core import', () => {
    const source = readFileSync(new URL('../src/compositions.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/^\} from '([^']+)'|^import [^\n]* from '([^']+)'/gmu)].map(match => match[1] ?? match[2])
    expect(imports).toEqual(['./builders.ts', './contracts.ts', './interaction.ts'])
  })
})
