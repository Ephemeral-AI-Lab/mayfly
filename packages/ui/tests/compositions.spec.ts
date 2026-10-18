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
  it('puts a vertical rail beside one page per label', () => {
    const pageA = ui.text('a')
    const pageB = ui.text('b')
    const node = compose.rail({
      rail: { id: 'rail', activeId: 'a', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      pages: { a: pageA, b: pageB },
    })
    expect(node).toMatchObject({ kind: 'stack', direction: 'row', gap: 3, rule: 'column' })
    const children = (node as Extract<MayflyUiNode, { kind: 'stack' }>).children
    expect(children[0]!.node).toMatchObject({ kind: 'tabs', orientation: 'vertical', id: 'rail' })
    expect(children[1]).toMatchObject({ node: pageA, grow: 1, tab: { controlId: 'rail', itemId: 'a' } })
    expect(children[2]).toMatchObject({ node: pageB, grow: 1, tab: { controlId: 'rail', itemId: 'b' } })
  })
})

describe('compose.browser', () => {
  it('shows list and detail side by side from the breakpoint, and one narrow page', () => {
    const list = ui.list({ id: 'list', role: 'browse', selectedIds: [], items: [{ id: 'a', label: 'A' }] })
    const detail = ui.text('detail')
    const node = compose.browser({ list, detail, narrow: 'detail' })
    const children = (node as Extract<MayflyUiNode, { kind: 'stack' }>).children
    expect(node).toMatchObject({ kind: 'stack', direction: 'row', gap: 3, rule: 'column' })
    expect(children[0]).toMatchObject({ node: list, basis: 58, grow: 0, shrink: 0, when: { minWidth: 100 } })
    expect(children[1]).toMatchObject({ node: detail, grow: 1, when: { minWidth: 100 } })
    expect(children[2]).toMatchObject({ node: detail, grow: 1, when: { maxWidth: 99 } })
  })
})

describe('compose.wizard', () => {
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
