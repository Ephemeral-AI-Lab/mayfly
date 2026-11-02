/** Public surface transitions at dirty decisions, wizard boundaries, and late native replies.
 * @module @ephemeral-ai/mayfly/tests/core/ui-surface-boundaries
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiActionReply, type MayflyUiEventContext, type MayflyUiEventEndpoint, type MayflyUiNode } from '../../../ui/src/index.ts'
import * as provider from '../../../ui/src/provider.ts'
import * as frontend from '../../src/frontend/index.ts'
import { UiSurfaceModel, type UiSurfaceSnapshot } from '../../src/core/ui-interaction-surface.ts'
import { flush } from '../helpers.ts'

const cleanups: (() => void | Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const completed: MayflyUiEventEndpoint<MayflyUiNode | null>['prepare'] = async () => ({ reply: { kind: 'completed' }, publish: () => true })

function surface(node: MayflyUiNode, prepare = completed) {
  const snapshot: UiSurfaceSnapshot = {
    id: 'boundary', node, revision: 0, source: [], scope: { kind: 'app', targetId: 'boundary' },
    update: { reason: 'replace' }, definition: { onEvent: {} }, events: { prepare },
  }
  const model = new UiSurfaceModel('boundary', snapshot)
  cleanups.push(() => model.dispose())
  return { model, snapshot }
}

describe('retired decisions and exact selection reads', () => {
  it.each(['source', 'withdraw'] as const)('retires an open confirmation when its %s changes', async kind => {
    const prepare = vi.fn(completed)
    const node = ui.actions({ id: 'actions', items: [{ id: 'delete', label: 'Delete', confirm: 'Delete?' }] })
    const { model, snapshot } = surface(node, prepare)
    model.invoke('delete')
    expect(model.decisionNode).toBeDefined()
    model.receive({ ...snapshot, ...(kind === 'source' ? { source: [{ resourceId: 'settings', revision: 2 }] } : { node: null, revision: 1 }) })
    expect(model.decisionNode).toBeUndefined()
    model.answerDecision(true)
    await flush()
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each(['input', 'segment'] as const)('cancels a native read when the same selected row changes its %s', async kind => {
    const ctx = new Context()
    const api = await ctx.plugin(provider)
    cleanups.push(() => api.dispose())
    const front = await ctx.plugin(frontend)
    cleanups.push(() => front.dispose())
    await flush()
    const gate = Promise.withResolvers<MayflyUiActionReply>()
    let context: MayflyUiEventContext | undefined
    const list = { pagePath: [], controlId: 'answer' }
    const handle = ctx.mayflyOverlays.open({
      id: 'native-read',
      onEvent: { action: (_event, operation) => { context = operation; return gate.promise } },
    }, ui.stack.column([
      ui.list({ id: 'answer', role: 'choose', selectedIds: ['a'], items: [{
        id: 'a', label: 'A', ...(kind === 'input' ? { input: {} } : { segment: { selectedId: 'low', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] } }),
      }] }),
      ui.actions({ id: 'actions', items: [{ id: 'check', label: 'Check', selections: [list] }] }),
    ]))
    cleanups.push(() => handle.dispose())
    const model = ctx.mayflyUiInteraction.get('overlay', 'native-read')!
    if (kind === 'input') model.updateChoice(list, { kind: 'input', id: 'a', text: 'first answer' })
    model.invoke('check')
    await flush()
    expect(context?.signal.aborted).toBe(false)
    model.updateChoice(list, kind === 'input' ? { kind: 'input', id: 'a', text: 'new answer' } : { kind: 'segment', id: 'a', direction: 1 })
    expect(context?.signal.aborted).toBe(true)
    context?.report({ message: 'obsolete progress', severity: 'info' })
    gate.resolve({ kind: 'completed', feedback: { message: 'obsolete result', severity: 'success' }, dismiss: true })
    await flush(4)
    expect(ctx.mayflyUiInteraction.get('overlay', 'native-read')).toBe(model)
    expect(model.feedbackSnapshot()).toEqual([])
    expect(model.operationSnapshot()).toMatchObject([{ actionId: 'check', phase: 'cancelled' }])
  })

  it('deduplicates slider acceptance while its native reply is pending', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof completed>>>()
    const prepare = vi.fn(() => gate.promise)
    const { model } = surface(ui.slider({ id: 'level', levels: [{ id: 'low', label: 'Low' }] }), prepare)
    model.updateSlider({ pagePath: [], controlId: 'level' }, { kind: 'accept' })
    model.updateSlider({ pagePath: [], controlId: 'level' }, { kind: 'accept' })
    expect(prepare).toHaveBeenCalledOnce()
    gate.resolve({ reply: { kind: 'completed' }, publish: () => true })
    await flush()
    expect(model.operationSnapshot()).toMatchObject([{ phase: 'succeeded' }])
  })

  it('cancels an in-flight selection read when the selected identity changes', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof completed>>>()
    const publish = vi.fn(() => true)
    const list = { pagePath: [], controlId: 'rows' }
    const { model } = surface(ui.stack.column([
      ui.list({ id: 'rows', role: 'choose', selectedIds: ['a'], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run', selections: [list] }] }),
    ]), () => gate.promise)
    model.invoke('run')
    model.updateChoice(list, { kind: 'select', ids: ['b'] })
    gate.resolve({ reply: { kind: 'completed' }, publish })
    await flush()
    expect(publish).not.toHaveBeenCalled()
    expect(model.operationSnapshot()).toMatchObject([{ phase: 'cancelled' }])
    expect(model.choice(list)?.selectedIds).toEqual(['b'])
  })

  it('reconciles a retained slider without changing the user pin', () => {
    const slider = (label: string) => ui.stack.column([
      ui.prompt({ id: 'prompt', value: '' }),
      ui.slider({ id: 'level', levels: [{ id: 'low', label }, { id: 'high', label: 'High' }], selectedId: 'low' }),
    ])
    const { model, snapshot } = surface(slider('Low'))
    const address = { pagePath: [], controlId: 'level' }
    model.updateSlider(address, { kind: 'step', delta: 1 })
    model.receive({ ...snapshot, node: slider('Minimum'), revision: 1 })
    expect(model.slider(address)).toMatchObject({ pinned: 'high', definition: { levels: [{ label: 'Minimum' }, { label: 'High' }] } })
  })

  it('uses the admitted choice cursor instead of a rule as initial focus', () => {
    const { model } = surface(ui.list({ id: 'rules', role: 'choose', items: [{ id: 'rule', label: 'Rule', rule: '─' }] }))
    expect(model.choice({ pagePath: [], controlId: 'rules' })).toBeDefined()
    expect(model.choice({ pagePath: [], controlId: 'rules' })?.focusedId).toBeUndefined()
    expect(model.focus).toBeUndefined()
  })
})

describe('wizard boundaries and confirmation facts', () => {
  const path = (itemId: string) => [{ controlId: 'steps', itemId }]
  const steps = { pagePath: [], controlId: 'steps' }

  it('keeps a partially read step unanswered and prefers the next page default action', () => {
    const first = { pagePath: path('one'), formId: 'first' }
    const { model } = surface(ui.stack.column([
      ui.tabs({ id: 'steps', mode: 'wizard', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.stack.column([
        ui.form({ id: 'first', fields: [{ kind: 'input', id: 'first-name', label: 'First', value: 'ready' }] }),
        ui.form({ id: 'second', fields: [{ kind: 'input', id: 'second-name', label: 'Second', value: 'unread' }] }),
        ui.actions({ id: 'first-actions', items: [{ id: 'next', label: 'Next', read: [first], navigate: path('two') }] }),
      ]), { tab: path('one')[0]! }),
      ui.child(ui.actions({ id: 'second-actions', items: [{ id: 'finish', label: 'Finish', defaultFocus: true }] }), { tab: path('two')[0]! }),
    ]))
    model.invoke('next', path('one'))
    expect(model.activeTab(steps)).toBe('two')
    expect(model.completedSteps(steps)).toEqual([])
    expect(model.focus).toEqual({ pagePath: path('two'), controlId: 'finish' })
  })

  it('does not answer an empty step through its own navigating action', () => {
    const { model } = surface(ui.stack.column([
      ui.tabs({ id: 'steps', mode: 'wizard', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.actions({ id: 'actions', items: [{ id: 'next', label: 'Next', navigate: path('two') }] }), { tab: path('one')[0]! }),
    ]))
    model.invoke('next', path('one'))
    expect(model.activeTab(steps)).toBe('two')
    expect(model.completedSteps(steps)).toEqual([])
  })

  it.each([false, true])('answers a selection-only wizard step only when selected=%s', async selected => {
    const choice = { pagePath: path('one'), controlId: 'answer' }
    const node = ui.stack.column([
      ui.tabs({ id: 'steps', mode: 'wizard', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.stack.column([
        ui.list({ id: 'answer', role: 'choose', selectedIds: selected ? ['a'] : [], items: [{ id: 'a', label: 'A' }] }),
        ui.actions({ id: 'actions', items: [{ id: 'next', label: 'Next', navigate: path('two') }, { id: 'native', label: 'Native next' }] }),
      ]), { tab: path('one')[0]! }),
      ui.child(ui.form({ id: 'details', fields: [{ kind: 'input', id: 'note', label: 'Note', value: '' }] }), { tab: path('two')[0]! }),
    ])
    const { model } = surface(node, async () => ({ reply: { kind: 'accepted', node, source: [], navigate: path('two') }, publish: () => true }))
    model.invoke('next', path('one'))
    expect(model.focus).toEqual({ pagePath: path('two'), controlId: 'note' })
    expect(model.completedSteps(steps)).toEqual(selected ? ['one'] : [])
    model.activateTab(steps, 'one')
    model.invoke('native', path('one'))
    await flush()
    expect(model.activeTab(steps)).toBe('two')
    expect(model.completedSteps(steps)).toEqual(selected ? ['one'] : [])
    expect(model.choice(choice)?.selectedIds).toEqual(selected ? ['a'] : [])
  })

  it('blocks the wizard on a required selection and clears completion after its mode changes', () => {
    const tree = (mode: 'wizard' | 'tabs') => ui.stack.column([
      ui.tabs({ id: 'steps', mode, activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.list({ id: 'required', role: 'choose', minSelected: 1, items: [{ id: 'a', label: 'A' }] }), { tab: path('one')[0]! }),
    ])
    const { model, snapshot } = surface(tree('wizard'))
    model.emit({ kind: 'tab-change', ...steps, tabId: 'two' })
    expect(model.activeTab(steps)).toBe('one')
    expect(model.feedbackSnapshot().at(-1)?.message).toContain('Select at least')
    model.updateChoice({ pagePath: path('one'), controlId: 'required' }, { kind: 'select', ids: ['a'] })
    model.emit({ kind: 'tab-change', ...steps, tabId: 'two' })
    expect(model.completedSteps(steps)).toEqual(['one'])
    model.receive({ ...snapshot, node: tree('tabs'), revision: 1 })
    expect(model.completedSteps(steps)).toEqual([])
  })

  it('runs an accepted page action under ordinary tabs without inventing wizard completion', async () => {
    const node = ui.stack.column([
      ui.tabs({ id: 'steps', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.child(ui.actions({ id: 'actions', items: [{ id: 'next', label: 'Next' }] }), { tab: path('one')[0]! }),
    ])
    const { model } = surface(node, async () => ({ reply: { kind: 'accepted', node, source: [], navigate: path('two') }, publish: () => true }))
    model.invoke('next', path('one'))
    await flush()
    expect(model.activeTab(steps)).toBe('two')
    expect(model.completedSteps(steps)).toEqual([])
  })

  it('shows structured row confirmation with its own labels before publishing an acceptance', async () => {
    const prepare = vi.fn(completed)
    const { model } = surface(ui.list({ id: 'rows', role: 'choose', items: [{ id: 'a', label: 'A', confirm: { title: 'Take A?', detail: 'One choice', confirmLabel: 'Take', cancelLabel: 'Keep' } }] }), prepare)
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'rows', selectedIds: ['a'] })
    expect(model.decisionNode).toMatchObject({ title: 'Take A?' })
    expect(prepare).not.toHaveBeenCalled()
    model.answerDecision(true)
    await flush()
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('carries the exact segment selected by a form-independent action', async () => {
    const prepare = vi.fn(completed)
    const { model } = surface(ui.stack.column([
      ui.list({ id: 'rows', role: 'choose', selectedIds: ['a'], items: [{ id: 'a', label: 'A', segment: { selectedId: 'high', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] } }] }),
      ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run', selections: [{ pagePath: [], controlId: 'rows' }] }] }),
    ]), prepare)
    model.invoke('run')
    await flush()
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({ kind: 'activate', inputs: { selections: [{ selectedIds: ['a'], segmentId: 'high' }] } })
    expect(model.operationSnapshot()).toMatchObject([{ phase: 'succeeded' }])
  })
})

describe('review trees', () => {
  it('renders missing, null, and unanswered typed sources through footer and unchanged wrappers', () => {
    const pagePath = [{ controlId: 'steps', itemId: 'one' }]
    const review = ui.review({
      id: 'review', tabsId: 'steps', skippedLabel: 'Not answered', submitLabel: 'Finish', submitActionId: 'finish',
      items: [
        { id: 'one', label: 'Missing field', source: { kind: 'form', pagePath, formId: 'answer', fieldId: 'missing' } },
        { id: 'two', label: 'Null field', source: { kind: 'form', pagePath, formId: 'answer', fieldId: 'nullable' } },
        { id: 'three', label: 'Missing row', source: { kind: 'list', pagePath, controlId: 'rows' } },
      ],
    })
    const { model } = surface(ui.stack.column([
      ui.tabs({ id: 'steps', activeId: 'one', items: [{ id: 'one', label: 'One' }] }),
      ui.child(ui.stack.column([
        ui.form({ id: 'answer', fields: [{ kind: 'select', id: 'nullable', label: 'Nullable', value: null, options: [{ id: 'a', label: 'A' }] }] }),
        ui.list({ id: 'rows', role: 'choose', mode: 'multiple', selectedIds: ['missing', 'typed'], items: [{ id: 'typed', label: 'Typed', input: {} }] }),
        ui.surface({ title: 'Footer review', child: ui.text('Unchanged child'), footer: review }),
        ui.surface({ title: 'No footer', child: ui.text('Unchanged surface') }),
        ui.surface({ title: 'Static footer', child: ui.text('Unchanged body'), footer: ui.text('Unchanged footer') }),
        ui.scroll(ui.text('Unchanged scroll')),
      ]), { tab: pagePath[0]! }),
    ]))
    expect(model.node?.kind).toBe('stack')
    expect(JSON.stringify(model.node)).toContain('Not answered')
    expect(model.choice({ pagePath, controlId: 'review' })).toBeDefined()
    model.emit({ kind: 'selection-accept', pagePath, controlId: 'review', selectedIds: [] })
    model.emit({ kind: 'selection-accept', pagePath, controlId: 'review', selectedIds: ['step:one'] })
    expect(model.focus).toMatchObject({ pagePath, controlId: 'rows', itemId: 'typed' })
  })
})
