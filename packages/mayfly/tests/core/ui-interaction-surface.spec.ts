/**
 * The surface model's drafts and actions: prompt and slider effects, declaration reconciliation, driven wizard steps,
 * reviews built from the drafts, dirty dismissal, and acknowledgement paths. No renderer is involved.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-surface
 */

import { describe, expect, it, vi } from 'vitest'
import { ui, type MayflyActionItem, type MayflySnapshotChange, type MayflyUiActionReply, type MayflyUiEvent, type MayflyUiEventContext, type MayflyUiNode } from '../../../ui/src/index.ts'
import { UiSurfaceModel, type UiSurfaceSnapshot } from '../../src/core/ui-interaction-surface.ts'
import { flush } from '../helpers.ts'

type Prepare = (event: MayflyUiEvent, context: MayflyUiEventContext) => Promise<{ readonly reply: MayflyUiActionReply | undefined, readonly publish: () => boolean }>

const completed: Prepare = async () => ({ reply: { kind: 'completed' }, publish: () => true })

function surface(node: MayflyUiNode | null, prepare: Prepare = completed, bindings: ConstructorParameters<typeof UiSurfaceModel>[2] = {}) {
  const events = { prepare }
  let revision = 0
  const snapshot = (next: MayflyUiNode | null, update: MayflySnapshotChange = { reason: 'replace' }): UiSurfaceSnapshot => ({
    id: 'surface', revision, node: next, source: [], scope: { kind: 'app', targetId: 'surface' }, update, definition: { onEvent: {} }, events,
  })
  const model = new UiSurfaceModel('instance', snapshot(node), bindings)
  return {
    model,
    snapshot,
    receive(next: MayflyUiNode | null, update: MayflySnapshotChange = { reason: 'data' }) {
      revision += 1
      model.receive(snapshot(next, update))
    },
  }
}

describe('prompt and slider drafts', () => {
  const promptAddress = { pagePath: [], controlId: 'ask' }

  it('turns every prompt reduction into its observation or handled event', async () => {
    const seen: MayflyUiEvent[] = []
    const node = ui.prompt({
      id: 'ask', value: '', tokens: [{ id: 'token', label: 'file' }], recall: [{ text: 'older' }],
      completions: { items: [{ id: 'complete', label: 'completion' }] },
    })
    const { model } = surface(node, async event => { seen.push(event); return { reply: { kind: 'completed' }, publish: () => true } })
    model.updatePrompt(promptAddress, { kind: 'edit', value: 'draft' })
    expect(model.prompt(promptAddress)?.text).toBe('draft')
    // Recall walks only an empty buffer.
    model.updatePrompt(promptAddress, { kind: 'edit', value: '' })
    model.updatePrompt(promptAddress, { kind: 'recall', direction: 'older' })
    expect(model.prompt(promptAddress)?.text).toBe('older')
    // An empty buffer selects the last token first, then removes it on the next press.
    model.updatePrompt(promptAddress, { kind: 'edit', value: '' })
    model.updatePrompt(promptAddress, { kind: 'backspace' })
    model.updatePrompt(promptAddress, { kind: 'backspace' })
    model.updatePrompt(promptAddress, { kind: 'complete-accept' })
    model.updatePrompt(promptAddress, { kind: 'complete-dismiss' })
    model.updatePrompt(promptAddress, { kind: 'edit', value: 'sent' })
    model.updatePrompt(promptAddress, { kind: 'submit' })
    await flush(3)
    expect(seen.map(event => event.kind)).toEqual(expect.arrayContaining(['value-change', 'recall-change', 'token-remove', 'completion-accept', 'completion-dismiss', 'submit']))
    const submit = seen.find(event => event.kind === 'submit') as Extract<MayflyUiEvent, { kind: 'submit' }>
    expect(submit).toMatchObject({ controlId: 'ask' })
    expect(submit.submission.forms[0]!.fields).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'text', value: 'sent' })]))
    expect(model.prompt(promptAddress)?.text).toBe('')
  })

  it('steps, pins, unpins, and accepts a slider through its model', async () => {
    const seen: MayflyUiEvent[] = []
    const address = { pagePath: [], controlId: 'level' }
    const node = ui.slider({ id: 'level', levels: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], selectedId: 'a', inheritedId: 'b' })
    const { model } = surface(node, async event => { seen.push(event); return { reply: { kind: 'completed' }, publish: () => true } })
    expect(model.slider(address)).toMatchObject({ pinned: 'a' })
    model.updateSlider(address, { kind: 'step', delta: 1 })
    // Stepping onto the inherited level unpins instead of pinning it.
    expect(model.slider(address)?.pinned).toBeNull()
    model.updateSlider(address, { kind: 'step', delta: 1 })
    expect(model.slider(address)?.pinned).toBe('c')
    model.updateSlider(address, { kind: 'edge', end: 'start' })
    expect(model.slider(address)?.pinned).toBe('a')
    model.updateSlider(address, { kind: 'unpin' })
    expect(model.slider(address)?.pinned).toBeNull()
    model.updateSlider(address, { kind: 'accept' })
    await flush(2)
    expect(seen.filter(event => event.kind === 'slider-accept').at(-1)).toMatchObject({ controlId: 'level', value: null })
  })

  it('drops prompt and slider drafts a republish no longer declares', () => {
    const node = ui.stack.column([
      ui.prompt({ id: 'ask', value: 'kept' }),
      ui.slider({ id: 'level', levels: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
      ui.list({ id: 'rows', role: 'browse', selectedIds: [], items: [{ id: 'a', label: 'A' }] }),
      ui.tabs({ id: 'pages', activeId: 'a', items: [{ id: 'a', label: 'A' }] }),
      ui.scroll(ui.text('scroll')),
    ])
    const { model, receive } = surface(node)
    const prompt = { pagePath: [], controlId: 'ask' }
    const slider = { pagePath: [], controlId: 'level' }
    const list = { pagePath: [], controlId: 'rows' }
    const tabs = { pagePath: [], controlId: 'pages' }
    expect(model.prompt(prompt)).toBeDefined()
    expect(model.slider(slider)).toBeDefined()
    expect(model.choice(list)).toBeDefined()
    expect(model.activeTab(tabs)).toBe('a')
    receive(ui.text('gone'))
    expect(model.prompt(prompt)).toBeUndefined()
    expect(model.slider(slider)).toBeUndefined()
    expect(model.choice(list)).toBeUndefined()
    expect(model.activeTab(tabs)).toBeUndefined()
    expect(model.node).toMatchObject({ kind: 'text' })
  })
})

describe('declaration reconciliation and driven wizard steps', () => {
  const page = (itemId: string) => [{ controlId: 'wiz', itemId }]
  const wizard = (activeId: string, name = '') => ui.stack.column([
    ui.tabs({ id: 'wiz', mode: 'wizard', activeId, items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
    ui.child(ui.form({ id: 'name', fields: [{ kind: 'input', id: 'text', label: 'Name', value: name }] }), { tab: page('one')[0]! }),
    ui.child(ui.text('second page'), { tab: page('two')[0]! }),
  ])

  it('follows a republished active step, marks the step it left answered, and moves focus there', () => {
    const { model, receive } = surface(wizard('one'))
    model.edit({ pagePath: page('one'), formId: 'name', fieldId: 'text' }, 'Ada')
    receive(wizard('two'))
    expect(model.activeTab({ pagePath: [], controlId: 'wiz' })).toBe('two')
    expect(model.completedSteps({ pagePath: [], controlId: 'wiz' })).toEqual(['one'])
    expect(model.focus).toMatchObject({ pagePath: [], controlId: 'wiz', itemId: 'two' })
  })

  it('validates every step passed when the strip moves several steps forward', () => {
    const node = ui.stack.column([
      ui.tabs({ id: 'steps', mode: 'wizard', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }, { id: 'three', label: 'Three' }] }),
      ui.child(ui.form({ id: 'name', fields: [{ kind: 'input', id: 'text', label: 'Name', value: '', required: true }] }), { tab: [{ controlId: 'steps', itemId: 'one' }][0]! }),
      ui.child(ui.form({ id: 'note', fields: [{ kind: 'input', id: 'text', label: 'Note', value: '', required: true }] }), { tab: [{ controlId: 'steps', itemId: 'two' }][0]! }),
      ui.child(ui.text('third'), { tab: [{ controlId: 'steps', itemId: 'three' }][0]! }),
    ])
    const { model } = surface(node)
    model.emit({ kind: 'tab-change', pagePath: [], controlId: 'steps', tabId: 'three' })
    expect(model.activeTab({ pagePath: [], controlId: 'steps' })).toBe('one')
    expect(model.feedbackSnapshot().at(-1)?.message).toBe('Fix the highlighted fields')
    // Filling the first form lets the move reach the second step, whose form is then the one that blocks.
    model.edit({ pagePath: [{ controlId: 'steps', itemId: 'one' }], formId: 'name', fieldId: 'text' }, 'filled')
    model.emit({ kind: 'tab-change', pagePath: [], controlId: 'steps', tabId: 'three' })
    expect(model.activeTab({ pagePath: [], controlId: 'steps' })).toBe('two')
    expect(model.form({ pagePath: [{ controlId: 'steps', itemId: 'one' }], formId: 'name' })?.fields.text?.error).toBeUndefined()
  })

  it('passes an empty step without answering it, through a driven move or a navigating action', () => {
    const page = (itemId: string) => [{ controlId: 'wiz', itemId }]
    const textWizard = (activeId: string) => ui.stack.column([
      ui.tabs({ id: 'wiz', mode: 'wizard', activeId, items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.text('first'), { tab: page('one')[0]! }),
      ui.child(ui.text('second'), { tab: page('two')[0]! }),
      ui.actions({ id: 'actions', items: [{ id: 'jump', label: 'Jump', navigate: page('two') }] }),
    ])
    const { model, receive } = surface(textWizard('one'))
    receive(textWizard('two'))
    expect(model.activeTab({ pagePath: [], controlId: 'wiz' })).toBe('two')
    expect(model.completedSteps({ pagePath: [], controlId: 'wiz' })).toEqual([])
    const jumping = surface(textWizard('one'))
    jumping.model.invoke('jump', page('one'))
    expect(jumping.model.activeTab({ pagePath: [], controlId: 'wiz' })).toBe('two')
    expect(jumping.model.completedSteps({ pagePath: [], controlId: 'wiz' })).toEqual([])
  })

  it('saves through the primary submit action of a form', () => {
    const target = { pagePath: [], formId: 'form' }
    const action = (id: string, extra: Partial<MayflyActionItem> = {}) => ({ id, label: id, submit: [target], ...extra })
    const node = ui.stack.column([
      ui.form({ id: 'form', fields: [{ kind: 'input', id: 'text', label: 'Text', value: '' }] }),
      ui.actions({ id: 'actions', items: [action('secondary'), action('primary', { intent: 'primary' }), action('disabled', { disabled: true })] }),
    ])
    const { model } = surface(node)
    expect(model.saveActionFor(target)).toBe('primary')
    expect(model.saveActionFor({ pagePath: [], formId: 'missing' })).toBeUndefined()
  })
})

describe('acknowledgements and fresh data', () => {
  it('applies a submitted form acknowledgement with the fields the reply accepted', async () => {
    const target = { pagePath: [], formId: 'form' }
    const node = ui.stack.column([
      ui.form({ id: 'form', fields: [{ kind: 'input', id: 'text', label: 'Name', value: '' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save', submit: [target] }] }),
    ])
    const events = { prepare: (async (event: MayflyUiEvent, context: { operationId: string }) => ({
      reply: { kind: 'accepted' as const, node, source: [] },
      publish: () => {
        direct.model.receive({ ...direct.snapshot(node), revision: 2, update: { reason: 'ack', operationId: context.operationId, draftRevision: (event as Extract<MayflyUiEvent, { kind: 'submit' }>).submission.draftRevision, source: [], acceptedFields: [{ ...target, fieldId: 'text' }] } })
        return true
      },
    })) as Prepare }
    let revision = 0
    const snapshot = (next: MayflyUiNode): UiSurfaceSnapshot => ({ id: 'ack', revision: revision++, node: next, source: [], scope: { kind: 'app', targetId: 'ack' }, update: { reason: 'replace' }, definition: { onEvent: {} }, events })
    const direct = { model: new UiSurfaceModel('ack', snapshot(node)), snapshot }
    direct.model.edit({ ...target, fieldId: 'text' }, 'typed')
    direct.model.invoke('save')
    await flush(3)
    expect(direct.model.form(target)?.fields.text).toBeDefined()
    expect(direct.model.operationSnapshot().at(-1)?.phase).toBe('succeeded')
    direct.model.dispose()
  })

  it('acknowledges a selection submitted with an action and a bare row acceptance', async () => {
    const list = { pagePath: [], controlId: 'pick' }
    const node = ui.stack.column([
      ui.list({ id: 'pick', role: 'choose', mode: 'multiple', selectedIds: [], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run', selections: [list] }] }),
    ])
    let revision = 0
    const events = { prepare: (async (event: MayflyUiEvent, context: { operationId: string }) => ({
      reply: { kind: 'accepted' as const, node, source: [] },
      publish: () => {
        model.receive({ ...snapshot(node), revision: ++revision, update: { reason: 'ack', operationId: context.operationId, draftRevision: event.kind === 'activate' ? event.inputs?.draftRevision ?? 0 : 0, source: [] } })
        return true
      },
    })) as Prepare }
    const snapshot = (next: MayflyUiNode): UiSurfaceSnapshot => ({ id: 'selection', revision, node: next, source: [], scope: { kind: 'app', targetId: 'selection' }, update: { reason: 'replace' }, definition: { onEvent: {} }, events })
    const model = new UiSurfaceModel('selection', snapshot(node))
    model.updateChoice(list, { kind: 'select', ids: ['a'] })
    model.invoke('run')
    await flush(3)
    expect(model.choice(list)?.selectedIds).toEqual(['a'])
    // A row acceptance starts no submission; its own acknowledgement still lands.
    // The acknowledged view carries the new row selection, which the ack then keeps.
    const accepted = ui.stack.column([
      ui.list({ id: 'pick', role: 'choose', mode: 'multiple', selectedIds: ['b'], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run', selections: [list] }] }),
    ])
    const ackEvents = { prepare: (async (event: MayflyUiEvent, context: { operationId: string }) => ({
      reply: { kind: 'accepted' as const, node: accepted, source: [] },
      publish: () => { model.receive({ ...snapshot(accepted), revision: ++revision, update: { reason: 'ack', operationId: context.operationId, draftRevision: event.kind === 'activate' ? event.inputs?.draftRevision ?? 0 : 0, source: [] } }); return true },
    })) as Prepare }
    const ackModel = new UiSurfaceModel('selection-ack', { ...snapshot(accepted), events: ackEvents })
    ackModel.emit({ kind: 'selection-accept', pagePath: [], controlId: 'pick', selectedIds: ['b'] })
    await flush(3)
    expect(ackModel.choice(list)?.selectedIds).toEqual(['b'])
    ackModel.dispose()
    model.dispose()
  })

  it('validates an invalid read reply on a field when there is no submission', async () => {
    const target = { pagePath: [], formId: 'form' }
    const node = ui.stack.column([
      ui.form({ id: 'form', fields: [{ kind: 'input', id: 'text', label: 'Name', value: 'x' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'read', label: 'Read', read: [target] }] }),
    ])
    const { model } = surface(node, async () => ({ reply: { kind: 'invalid', errors: [{ ...target, fieldId: 'text', message: 'Read rejected it' }] }, publish: () => true }))
    model.invoke('read')
    await flush(3)
    expect(model.form(target)?.fields.text?.error).toBe('Read rejected it')
    expect(model.feedbackSnapshot()).toEqual([])
  })

  it('reports focus changes as observations, not submissions', async () => {
    const seen: MayflyUiEvent[] = []
    const { model } = surface(ui.text('body'), async event => { seen.push(event); return { reply: { kind: 'completed' }, publish: () => true } })
    model.observeFocus({ pagePath: [], controlId: 'control', itemId: 'row' })
    await flush(2)
    expect(seen.filter(event => event.kind === 'focus-change')).toEqual([{ kind: 'focus-change', pagePath: [], controlId: 'control', itemId: 'row' }])
    expect(model.operationSnapshot().at(-1)?.phase).toBe('succeeded')
  })
})

describe('dirty dismissal and typed rows', () => {
  it('asks before discarding a dirty form and respects the answer', async () => {
    const close = vi.fn()
    const form = { pagePath: [], formId: 'form' }
    const node = ui.stack.column([
      ui.form({ id: 'form', fields: [{ kind: 'input', id: 'text', label: 'Name', value: '' }] }),
    ])
    const { model } = surface(node, completed, { close })
    model.edit({ ...form, fieldId: 'text' }, 'unsaved')
    expect(model.dirty).toBe(true)
    model.requestClose()
    expect(model.decisionNode).toBeDefined()
    expect(JSON.stringify(model.decisionNode)).toContain('Discard unsaved changes?')
    // A second close answers the open decision No instead of stacking another.
    model.requestClose()
    expect(model.decisionNode).toBeUndefined()
    expect(close).not.toHaveBeenCalled()
    model.requestClose()
    // A dismiss while the decision stands answers No.
    model.emit({ kind: 'dismiss', pagePath: [] })
    expect(model.decisionNode).toBeUndefined()
    expect(close).not.toHaveBeenCalled()
    model.requestClose()
    model.answerDecision(true)
    await flush(5)
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not accept a typed row with nothing typed, and runs the list accept action once it has text', async () => {
    const seen: MayflyUiEvent[] = []
    const node = ui.list({ id: 'answers', role: 'choose', selectedIds: [], items: [{ id: 'a', label: 'A', input: {} }, { id: 'b', label: 'B' }] })
    const { model } = surface(node, async event => { seen.push(event); return { reply: { kind: 'completed' }, publish: () => true } })
    const address = { pagePath: [], controlId: 'answers' }
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'answers', selectedIds: ['a'] })
    await flush()
    expect(seen).toEqual([])
    model.updateChoice(address, { kind: 'input', id: 'a', text: 'typed' })
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'answers', selectedIds: ['a'] })
    await flush(2)
    expect(seen.some(event => event.kind === 'selection-accept')).toBe(true)
  })

  it('runs a choose list\'s declared accept action instead of reporting the row', async () => {
    const seen: MayflyUiEvent[] = []
    const node = ui.stack.column([
      ui.list({ id: 'pick', role: 'choose', acceptActionId: 'take', selectedIds: [], items: [{ id: 'a', label: 'A' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'take', label: 'Take' }] }),
    ])
    const { model } = surface(node, async event => { seen.push(event); return { reply: { kind: 'completed' }, publish: () => true } })
    const address = { pagePath: [], controlId: 'pick' }
    model.updateChoice(address, { kind: 'select', ids: ['a'] })
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'pick', selectedIds: ['a'] })
    await flush(2)
    expect(seen.filter(event => event.kind === 'activate')).toMatchObject([{ actionId: 'take' }])
  })

  it('ignores a prompt or slider update while a decision is open', () => {
    const node = ui.stack.column([
      ui.prompt({ id: 'ask', value: '' }),
      ui.slider({ id: 'level', levels: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
      ui.form({ id: 'form', fields: [{ kind: 'input', id: 'text', label: 'Name', value: '' }] }),
    ])
    const { model } = surface(node)
    model.edit({ pagePath: [], formId: 'form', fieldId: 'text' }, 'dirty')
    model.requestClose()
    model.updatePrompt({ pagePath: [], controlId: 'ask' }, { kind: 'edit', value: 'ignored' })
    model.updateSlider({ pagePath: [], controlId: 'level' }, { kind: 'step', delta: 1 })
    expect(model.prompt({ pagePath: [], controlId: 'ask' })?.text).toBe('')
    model.answerDecision(false)
  })
})

describe('reviews built from the drafts', () => {
  const one = [{ controlId: 'wiz', itemId: 'one' }]
  function reviewSurface(extra: { readonly wrapped?: boolean; readonly translated?: boolean } = {}) {
    const form = ui.form({ id: 'name', fields: [{ kind: 'input', id: 'text', label: 'Name', value: '' }, { kind: 'multiselect', id: 'tags', label: 'Tags', value: [], options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] }] })
    const list = ui.list({ id: 'pick', role: 'choose', selectedIds: [], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', input: {} }] })
    const review = ui.review({
      id: 'wiz.review', tabsId: 'wiz', skippedLabel: 'Skipped', submitLabel: 'Create', submitActionId: 'submit', autofocus: true,
      items: [
        { id: 'one', label: 'Name', source: { kind: 'form', pagePath: one, formId: 'name', fieldId: 'text' } },
        { id: 'two', label: 'Tags', source: { kind: 'form', pagePath: one, formId: 'name', fieldId: 'tags' } },
        { id: 'three', label: 'Pick', source: { kind: 'list', pagePath: one, controlId: 'pick' } },
        { id: 'four', label: 'Typed', source: { kind: 'list', pagePath: one, controlId: 'missing' } },
      ],
    })
    const page = ui.stack.column([form, list])
    const tree = ui.stack.column([
      ui.tabs({ id: 'wiz', mode: 'wizard', activeId: 'one', items: [{ id: 'one', label: 'One' }] }),
      ui.child(page, { tab: one[0]! }),
      extra.wrapped === true ? ui.scroll(ui.surface({ title: 'Review', chrome: 'surface', child: review })) : review,
      ui.actions({ id: 'actions', items: [{ id: 'submit', label: 'Submit' }] }),
    ])
    return { model: surface(tree, completed, extra.translated === true ? { translate: (key, values) => `${key}${values?.count === undefined ? '' : `:${String(values.count)}`}` } : {}).model, tree }
  }

  it('lists every answer behind the longest label, marking skipped rows', () => {
    const { model } = reviewSurface()
    const address = { pagePath: [], controlId: 'pick' }
    model.edit({ pagePath: one, formId: 'name', fieldId: 'text' }, 'Ada')
    model.edit({ pagePath: one, formId: 'name', fieldId: 'tags' }, ['x', 'y'])
    model.updateChoice({ ...address, pagePath: one }, { kind: 'select', ids: ['a'] })
    const rendered = JSON.stringify(model.node)
    expect(rendered).toContain('Ada')
    expect(rendered).toContain('x · y')
    expect(rendered).toContain('Skipped')
    expect(rendered).toContain('Create')
    // A typed row shows what was typed, not its label.
    model.updateChoice({ ...address, pagePath: one }, { kind: 'select', ids: ['b'] })
    model.updateChoice({ ...address, pagePath: one }, { kind: 'input', id: 'b', text: 'typed answer' })
    expect(JSON.stringify(model.node)).toContain('typed answer')
    model.dispose()
  })

  it('returns to a step from its review row and submits from the last row', async () => {
    const seen: MayflyUiEvent[] = []
    const { model } = reviewSurface()
    model.updateChoice({ pagePath: one, controlId: 'pick' }, { kind: 'select', ids: ['a'] })
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'wiz.review', selectedIds: ['step:one'] })
    expect(model.activeTab({ pagePath: [], controlId: 'wiz' })).toBe('one')
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'wiz.review', selectedIds: ['nonsense'] })
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'wiz.review', selectedIds: ['submit'] })
    await flush(2)
    expect(model.feedbackSnapshot()).toEqual([])
    model.dispose()
    expect(seen).toEqual([])
  })

  it('rebuilds the review rows when a draft changes and keeps a wrapped review resolvable', () => {
    const { model } = reviewSurface({ wrapped: true })
    const before = JSON.stringify(model.node)
    model.edit({ pagePath: one, formId: 'name', fieldId: 'text' }, 'changed')
    const after = JSON.stringify(model.node)
    expect(after).not.toBe(before)
    expect(after).toContain('changed')
    model.dispose()
  })
})

describe('navigating actions and closed surfaces', () => {
  const one = [{ controlId: 'wiz', itemId: 'one' }]
  const two = [{ controlId: 'wiz', itemId: 'two' }]

  it('answers a wizard step through a navigating action and focuses the page\'s choose row', async () => {
    const form = { pagePath: one, formId: 'name' }
    const list = { pagePath: two, controlId: 'choose' }
    const node = ui.stack.column([
      ui.tabs({ id: 'wiz', mode: 'wizard', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.stack.column([
        ui.form({ id: 'name', fields: [{ kind: 'input', id: 'text', label: 'Name', value: 'filled' }] }),
        ui.actions({ id: 'step-one', items: [{ id: 'next', label: 'Next', read: [form], navigate: two }] }),
      ]), { tab: one[0]! }),
      ui.child(ui.stack.column([
        ui.list({ id: 'choose', role: 'choose', selectedIds: [], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', input: {} }] }),
      ]), { tab: two[0]! }),
      ui.actions({ id: 'root', items: [{ id: 'send', label: 'Send', selections: [list] }] }),
    ])
    const seen: MayflyUiEvent[] = []
    const { model } = surface(node, async event => { seen.push(event); return { reply: { kind: 'completed' }, publish: () => true } })
    model.invoke('next', one)
    expect(model.activeTab({ pagePath: [], controlId: 'wiz' })).toBe('two')
    expect(model.completedSteps({ pagePath: [], controlId: 'wiz' })).toEqual(['one'])
    expect(model.focus).toMatchObject({ pagePath: two, controlId: 'choose', itemId: 'a' })
    // A selected row with typed input sends both the choice and the typed text.
    model.updateChoice(list, { kind: 'select', ids: ['b'] })
    model.updateChoice(list, { kind: 'input', id: 'b', text: 'typed' })
    model.invoke('send')
    await flush(2)
    const sent = seen.find(event => event.kind === 'activate') as Extract<MayflyUiEvent, { kind: 'activate' }>
    expect(sent.inputs?.selections).toMatchObject([{ controlId: 'choose', selectedIds: ['b'], inputs: { b: 'typed' } }])
    model.dispose()
  })

  it('ignores tab activation while a decision stands and every request after disposal', () => {
    const node = ui.stack.column([
      ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.form({ id: 'form', fields: [{ kind: 'input', id: 'text', label: 'Name', value: '' }] }),
    ])
    const { model } = surface(node)
    model.edit({ pagePath: [], formId: 'form', fieldId: 'text' }, 'dirty')
    model.requestClose()
    model.activateTab({ pagePath: [], controlId: 'pages' }, 'two')
    expect(model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('one')
    model.answerDecision(false)
    model.dispose()
    expect(() => model.requestClose()).not.toThrow()
  })
})
