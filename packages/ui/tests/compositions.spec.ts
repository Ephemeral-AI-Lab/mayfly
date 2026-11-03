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

  it('keeps omitted decoration absent and preserves an explicit hint policy', () => {
    const node = compose.panel({ title: 'Minimal', escapeLabel: 'back', body: ui.text('body'), hint: 'none' })
    expect(node).toMatchObject({ title: 'Minimal', escapeLabel: 'back', hint: 'none' })
    for (const key of ['subtitle', 'badges', 'footer']) expect(node).not.toHaveProperty(key)
    expect(compose.panel({ title: 'Auto', escapeLabel: 'close', body: ui.text('body') })).not.toHaveProperty('hint')
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

  it('addresses note and choice submissions under caller ids without granting unrelated form reads', () => {
    const choice = compose.decisionLane({ id: 'approval', title: 'Allow?', choices: [{ id: 'allow', label: 'Allow' }], acceptActionId: 'approve' })
    expect(stack(choice).children.at(-1)!.node).toMatchObject({ items: [{ id: 'approve', selections: [{ controlId: 'approval.options', pagePath: [] }] }] })
    const note = compose.decisionLane({ id: 'reply', title: 'Explain', body: ui.text('body'), note: { id: 'answer', label: 'Answer', placeholder: 'Reason' }, sendActionId: 'reply.send' })
    expect(stack(note).children[1]!.node).toMatchObject({ fields: [{ id: 'answer', placeholder: 'Reason' }] })
    expect(stack(note).children.at(-1)!.node).toMatchObject({ items: [{ id: 'reply.send', read: [{ pagePath: [], formId: 'reply.note' }] }] })
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

  it('keeps a one-row decision actionable with custom labels and no danger styling', () => {
    const node = compose.decisionStrip({ title: 'Continue?', yesLabel: 'Continue', noLabel: 'Stay', actionsId: 'confirm' })
    expect(node.child).toMatchObject({ kind: 'actions', id: 'confirm', items: [{ id: DECISION_YES, label: 'Continue', hintLabel: 'continue' }, { id: DECISION_NO, label: 'Stay', hintLabel: 'stay' }] })
    expect(JSON.stringify(node)).not.toContain('danger')
    expect(compose.decisionStrip({ title: 'Default?' }).child).toMatchObject({ id: 'mayfly.decision' })
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
    expect(compose.tabs({ tabs: { id: 'custom', activeId: 'a', items: [{ id: 'a', label: 'A' }] }, pages: { a: page }, gap: 0, pageGrow: true, pageMinSize: 5 })).toMatchObject({ gap: 0, children: [expect.anything(), expect.objectContaining({ minSize: 5 })] })
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

  it('accepts live content or available pages exclusively and preserves a separator-free rail', () => {
    const rail = { id: 'rail', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'missing', label: 'Missing' }] }
    const body = ui.text('live')
    expect(() => compose.rail({ rail })).toThrow('exactly one')
    expect(() => compose.rail({ rail, pages: {}, content: body })).toThrow('exactly one')
    const content = compose.rail({ rail, content: body, railWidth: 17, separator: false })
    expect(content).toMatchObject({ gap: 2, children: [expect.objectContaining({ basis: 17 }), expect.objectContaining({ node: body, grow: 1 })] })
    expect(content).not.toHaveProperty('rule')
    const pages = compose.rail({ rail, pages: { one: body } }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(pages.children).toHaveLength(2)
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

  it('keeps a native narrow list fallback and supports explicit custom or absent separators', () => {
    const list = ui.text('list'), narrow = ui.text('narrow'), detail = ui.text('detail'), separator = ui.text('divider')
    const only = compose.browser({ list, listNarrow: narrow, narrow: 'detail', breakpoint: 60, listWidth: 22 }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(only.children).toHaveLength(2)
    expect(only.children[0]).toMatchObject({ basis: 22, when: { minWidth: 60 } })
    expect(only.children[1]).toMatchObject({ node: narrow, when: { maxWidth: 59 } })
    const custom = compose.browser({ list, detail, separator }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(custom.children[1]).toMatchObject({ node: separator, basis: 1 })
    expect(custom.children.at(-1)!.node).toBe(list)
    expect(custom).not.toHaveProperty('rule')
    const noRule = compose.browser({ list, detail, separator: false }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(noRule.children).toHaveLength(3)
    expect(noRule).toMatchObject({ gap: 2 })
  })
})

describe('compose.wizard', () => {
  it('requires steps and submits single-step form/list addresses on the root page', () => {
    expect(() => compose.wizard({ steps: [] })).toThrow('at least one step')
    const node = compose.wizard({ steps: [{ id: 'one', label: 'One', body: ui.text('body'), forms: ['form'], lists: ['choices'] }], submitActionId: 'finish' }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(node.children[1]!.node).toMatchObject({ kind: 'actions', items: [{ id: 'wizard.next.one', submit: [{ formId: 'form', pagePath: [] }], selections: [{ controlId: 'choices', pagePath: [] }] }] })
  })
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

  it('preserves step settlement, back restrictions and precise review form/list addresses', () => {
    const node = compose.wizard({
      id: 'questions', activeId: 'two', hintLabel: 'question', submitActionId: 'submit-all',
      steps: [
        { id: 'one', label: 'One', body: ui.text('one'), forms: ['answer'], settle: true },
        { id: 'two', label: 'Two', body: ui.text('two'), lists: ['pick'], settle: true, holdBack: true },
        { id: 'three', label: 'Three', body: ui.text('three'), settle: true },
        { id: 'four', label: 'Four', body: ui.text('four'), forms: ['note'] },
      ],
      review: { label: 'Review', skippedLabel: 'skipped', submitLabel: 'Send', items: [{ stepId: 'one', label: 'Answer', source: { kind: 'form', formId: 'answer', fieldId: 'text' } }, { stepId: 'two', label: 'Pick', source: { kind: 'list', controlId: 'pick' } }] },
    }) as Extract<MayflyUiNode, { kind: 'stack' }>
    const tabs = node.children[0]!.node
    expect(tabs).toMatchObject({ activeId: 'two', hintLabel: 'question', items: [{ id: 'one' }, { id: 'two' }, { id: 'three', backId: 'two' }, { id: 'four', backId: 'three' }, { id: 'questions.review', backId: 'four' }] })
    const first = node.children[2]!.node as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(first.children[1]!.node).toMatchObject({ items: [{ submit: [{ formId: 'answer', pagePath: [{ controlId: 'questions', itemId: 'one' }] }] }] })
    const second = node.children[3]!.node as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(second.children[1]!.node).toMatchObject({ items: [{ selections: [{ controlId: 'pick', pagePath: [{ controlId: 'questions', itemId: 'two' }] }] }] })
    const fourth = node.children[5]!.node as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(fourth.children[1]!.node).toMatchObject({ items: [{ navigate: [{ controlId: 'questions', itemId: 'questions.review' }], read: [{ formId: 'note', pagePath: [{ controlId: 'questions', itemId: 'four' }] }] }] })
    const review = node.children.at(-1)!.node as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(review.children[0]!.node).toMatchObject({ items: [{ source: { kind: 'form', formId: 'answer', fieldId: 'text' } }, { source: { kind: 'list', controlId: 'pick' } }] })
    const withoutReview = compose.wizard({ steps: [{ id: 'a', label: 'A', body: ui.text('a'), forms: ['f'] }, { id: 'b', label: 'B', body: ui.text('b') }] })
    expect(JSON.stringify(withoutReview)).toContain('wizard.next.b')
    expect(JSON.stringify(withoutReview)).not.toContain('wizard.review')
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

  it('handles empty, path and unprefixed rows, bounded lists and the focused problem', () => {
    expect(compose.completionPalette({ items: [], wait: 'unused' })).toMatchObject({ children: [] })
    const items = [{ id: 'path', label: '/host/file.ts', path: true, source: 'Host', focused: true, problem: 'Permission required' }, { id: 'plain', label: 'plain', typedPrefix: 'mismatch' }, { id: 'empty-prefix', label: 'text', typedPrefix: '' }]
    const all = compose.completionPalette({ items, maxRows: 3 }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(all.children).toHaveLength(4)
    expect(all.children.at(-1)!.node).toMatchObject({ content: '    Permission required', tone: 'danger' })
    const bounded = compose.completionPalette({ items, maxRows: 1 }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(bounded.children[1]!.node).toMatchObject({ content: '  +2 more' })
    expect(JSON.stringify(all.children[0]!.node)).toContain('"overflow":"start"')
    expect(JSON.stringify(all.children[1]!.node)).not.toContain('strong')
  })
})

describe('compose.statusPage', () => {
  const tabs = { id: 'status-tabs', activeId: 'one', items: [{ id: 'one', label: 'One' }] }
  it('requires an explicit body and accepts field rows, live body or sized tab pages with a footer', () => {
    expect(() => compose.statusPage({ tabs })).toThrow('needs rows, a body, or pages')
    const rows = compose.statusPage({ tabs, rows: [{ label: 'State', value: [{ text: 'Idle' }] }] }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(rows.children[2]!.node).toMatchObject({ kind: 'fields', rows: [{ label: 'State', value: [{ text: 'Idle' }] }] })
    const body = ui.text('live'), footer = ui.text('footer')
    const live = compose.statusPage({ tabs, body, footer }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(live.children[2]!.node).toBe(body)
    expect(live.children[3]!.node).toBe(footer)
    const pages = compose.statusPage({ tabs, pages: { one: body } }) as Extract<MayflyUiNode, { kind: 'stack' }>
    expect(pages.children).toHaveLength(1)
    expect(JSON.stringify(pages)).toContain('"minSize":1')
  })
})
