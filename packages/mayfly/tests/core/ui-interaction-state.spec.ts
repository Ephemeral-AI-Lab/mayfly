/** Headless frontend and registry trajectories for stable UI interaction ownership.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-state
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import * as provider from '../../../ui/src/provider.ts'
import type { MayflyFormAddress, MayflyUiActionReply, MayflyUiEventHandlers, MayflyUiObservationReply } from '../../../ui/src/contracts.ts'
import * as frontend from '../../src/frontend/index.ts'
import { UiSurfaceModel, type UiSurfaceSnapshot } from '../../src/core/ui-interaction-surface.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
const address = (itemId = 'one'): MayflyFormAddress => ({ pagePath: [{ controlId: 'pages', itemId }], formId: 'config' })
const source = (revision: number) => [{ resourceId: 'settings', revision }]
const definition = (one = 'A', two = 'Z') => ui.stack.column([
  ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
  ui.child(ui.form({ id: 'config', fields: [{ kind: 'input', id: 'name', label: 'Name', value: one }] }), { tab: { controlId: 'pages', itemId: 'one' } }),
  ui.child(ui.form({ id: 'config', fields: [{ kind: 'input', id: 'name', label: 'Name', value: two }] }), { tab: { controlId: 'pages', itemId: 'two' } }),
  ui.actions({ id: 'actions', items: [
    { id: 'save', label: 'Save', submit: [address(), address('two')] },
    { id: 'delete', label: 'Delete', confirm: 'Delete this configuration?' },
  ] }),
])

async function setup(kind: 'pane' | 'overlay', onEvent?: MayflyUiEventHandlers) {
  const ctx = new Context()
  const api = await ctx.plugin(provider)
  cleanups.push(() => api.dispose())
  const front = await ctx.plugin(frontend)
  cleanups.push(() => front.dispose())
  await flush()
  const options = { id: 'same', source: source(1), scope: { kind: 'app' as const, targetId: 'profile' }, ...(onEvent === undefined ? {} : { onEvent }) }
  const handle = kind === 'pane' ? ctx.mayflyPanes.register({ ...options, placement: 'bottom' }, definition()) : ctx.mayflyOverlays.open(options, definition())
  const model = ctx.mayflyUiInteraction.get(kind, 'same')!
  expect(model).toBeDefined()
  return { ctx, api, front, handle, model }
}

function directSurface(
  node: import('@ephemeral-ai/mayfly-ui').MayflyUiNode | null,
  prepare: (event: import('@ephemeral-ai/mayfly-ui').MayflyUiEvent, context: import('@ephemeral-ai/mayfly-ui').MayflyUiEventContext) => Promise<{ readonly reply?: MayflyUiActionReply, readonly publish: () => boolean }>,
  bindings: ConstructorParameters<typeof UiSurfaceModel>[2] = {},
) {
  const snapshot = {
    id: 'direct', revision: 0, node, source: [], scope: { kind: 'app' as const, targetId: 'direct' }, update: { reason: 'replace' as const },
    definition: { onEvent: { action: () => ({ kind: 'completed' as const }) } },
    events: { prepare },
  } as UiSurfaceSnapshot
  return { model: new UiSurfaceModel('direct-instance', snapshot, bindings), snapshot }
}

describe.each(['pane', 'overlay'] as const)('%s frontend interaction', kind => {
  it.each(['submit', 'read'] as const)('keeps explicit %s validation errors when older field validation settles', async boundary => {
    const pending = Promise.withResolvers<MayflyUiObservationReply>()
    const unrelated = Promise.withResolvers<MayflyUiObservationReply>()
    const signals = new Map<string, AbortSignal>()
    const writes = vi.fn()
    const { model, handle } = await setup(kind, {
      observe: (event, context) => {
        signals.set(event.formId, context.signal)
        return event.formId === 'page' ? pending.promise : unrelated.promise
      },
      action: () => { writes(); return { kind: 'completed' } },
    })
    const target = { pagePath: [], formId: 'page' }
    handle.set(ui.stack.column([
      ui.form({ id: 'page', fields: [{ kind: 'number', id: 'value', label: 'Page', value: 1, min: 1 }] }),
      ui.form({ id: 'other', fields: [{ kind: 'input', id: 'other-value', label: 'Other', value: '' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save', [boundary]: [target] }] }),
    ]))
    model.edit({ ...target, fieldId: 'value' }, '0')
    model.edit({ pagePath: [], formId: 'other', fieldId: 'other-value' }, 'draft')
    await flush()
    model.invoke('save')
    expect(signals.get('page')!.aborted).toBe(true)
    expect(signals.get('other')!.aborted).toBe(false)
    pending.resolve({ kind: 'completed' })
    unrelated.resolve({ kind: 'invalid', errors: [{ pagePath: [], formId: 'other', fieldId: 'other-value', message: 'Other field rejected' }] })
    await flush()
    expect(model.form(target)!.fields.value).toMatchObject({ value: '0', error: 'Minimum: 1' })
    expect(model.form({ pagePath: [], formId: 'other' })!.fields['other-value']!.error).toBe('Other field rejected')
    expect(writes).not.toHaveBeenCalled()
  })

  it('cancels stale validation and progress when a field is reset through shared tools', async () => {
    const gate = Promise.withResolvers<MayflyUiObservationReply>()
    let signal!: AbortSignal
    let report!: (feedback: { severity: 'error', message: string }) => void
    const { model, handle } = await setup(kind, { observe: (event, context) => {
      if (event.kind === 'value-change' && event.value === 'typed') { signal = context.signal; report = context.report; return gate.promise }
      return { kind: 'completed' }
    } })
    handle.set(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'value', label: 'Value', value: 'base', resetValue: 'inherited' }] }))
    const address = { pagePath: [], formId: 'form', fieldId: 'value' }
    model.edit(address, 'typed')
    await flush()
    model.updateForm(address, { kind: 'reset', fieldId: 'value' })
    expect(signal.aborted).toBe(true)
    report({ severity: 'error', message: 'stale validation' })
    gate.resolve({ kind: 'invalid', errors: [{ ...address, message: 'old value is invalid' }] })
    await flush()
    expect(model.form(address)!.fields.value).toMatchObject({ value: 'inherited', change: 'reset' })
    expect(model.form(address)!.fields.value!.error).toBeUndefined()
    expect(model.feedbackSnapshot()).toEqual([])
  })

  it('validates wizard transitions locally and invalidates completed steps after edits or conflicts', async () => {
    const handler = vi.fn(() => ({ kind: 'completed' as const }))
    const { model, handle } = await setup(kind, { action: handler })
    const path = [{ controlId: 'steps', itemId: 'one' }]
    const target = { pagePath: path, formId: 'config' }
    const auxiliary = { pagePath: path, formId: 'auxiliary' }
    const view = (name = '', disabled = false, mode: 'wizard' | 'tabs' = 'wizard', label = 'One') => ui.stack.column([
      ui.tabs({ id: 'steps', mode, activeId: 'one', items: [{ id: 'one', label }, { id: 'two', label: 'Two', disabled }] }),
      ui.child(ui.stack.column([
        ui.form({ id: 'config', fields: [{ kind: 'input', id: 'name', label: 'Name', value: name, required: true }] }),
        ui.form({ id: 'auxiliary', fields: [{ kind: 'input', id: 'note', label: 'Note', value: '' }] }),
        ui.actions({ id: 'navigation', items: [
          { id: 'partial-next', label: 'Partial next', read: [target], navigate: [{ controlId: 'steps', itemId: 'two' }] },
          { id: 'next', label: 'Next', read: [target, auxiliary], navigate: [{ controlId: 'steps', itemId: 'two' }] },
        ] }),
      ]), { tab: path[0]! }),
    ])
    const steps = { pagePath: [], controlId: 'steps' }
    handle.set(view())
    model.invoke('partial-next', path)
    expect(model.activeTab(steps)).toBe('one')
    model.invoke('next', path)
    expect(model.activeTab(steps)).toBe('one')
    expect(model.completedSteps(steps)).toEqual([])
    expect(handler).not.toHaveBeenCalled()
    model.edit({ ...target, fieldId: 'name' }, 'draft')
    model.invoke('partial-next', path)
    expect(model.activeTab(steps)).toBe('two')
    expect(model.completedSteps(steps)).toEqual([])
    model.activateTab(steps, 'one')
    handle.set(view('', true))
    model.invoke('next', path)
    expect(model.activeTab(steps)).toBe('one')
    expect(model.completedSteps(steps)).toEqual([])
    expect(model.feedbackSnapshot().at(-1)?.message).toContain('destination')
    handle.set(view())
    model.invoke('next', path)
    expect(model.activeTab(steps)).toBe('two')
    expect(model.completedSteps(steps)).toEqual(['one'])
    expect(model.feedbackSnapshot()).toEqual([])
    handle.set(view('', false, 'wizard', 'Translated'))
    expect(model.completedSteps(steps)).toEqual(['one'])
    handle.set(view('external'))
    expect(model.completedSteps(steps)).toEqual([])
    model.updateForm(target, { kind: 'resolve-conflict', fieldId: 'name', choice: 'draft' })
    model.activateTab(steps, 'one')
    model.invoke('next', path)
    expect(model.completedSteps(steps)).toEqual(['one'])
    handle.set(view('external', false, 'tabs'))
    handle.set(view('external'))
    expect(model.completedSteps(steps)).toEqual([])
    await flush()
    expect(handler.mock.calls.every(call => (call as unknown as [{ kind: string }])[0].kind !== 'activate' && (call as unknown as [{ kind: string }])[0].kind !== 'submit')).toBe(true)
  })

  it('uses retained tab drafts and publishes one cross-page Save without any renderer', async () => {
    const write = vi.fn()
    const onEvent: MayflyUiEventHandlers = { action: event => {
      if (event.kind !== 'submit') return { kind: 'completed' }
      write(event.submission)
      return { kind: 'accepted', node: definition(String(event.submission.forms[0]!.fields[0]!.value), String(event.submission.forms[1]!.fields[0]!.value)), source: source(2) }
    } }
    const { model, ctx } = await setup(kind, onEvent)
    model.edit({ ...address(), fieldId: 'name' }, 'B')
    model.activateTab({ pagePath: [], controlId: 'pages' }, 'two')
    model.edit({ ...address('two'), fieldId: 'name' }, 'Y')
    model.activateTab({ pagePath: [], controlId: 'pages' }, 'one')
    expect(write).not.toHaveBeenCalled()
    expect(model.availableActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'save', verb: 'submit', enabled: true, pending: false, pagePath: [] }),
      expect.objectContaining({ actionId: 'delete', verb: 'activate', enabled: true, pending: false, pagePath: [] }),
    ]))
    model.invoke('save')
    expect(model.availableActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: 'save', enabled: false, pending: true }),
    ]))
    model.invoke('save')
    await flush()
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]![0].forms.map((form: { fields: { value: string }[] }) => form.fields[0]!.value)).toEqual(['B', 'Y'])
    expect(model.form(address())!.fields.name!.value).toBe('B')
    expect(model.dirty).toBe(false)
    expect(model.operationSnapshot().find(operation => operation.actionId === 'save')?.phase).toBe('succeeded')
    expect(ctx.mayflyUiInteraction.get(kind, 'same')).toBe(model)
    const entry = kind === 'pane' ? ctx.mayflyPanes.list()[0]! : ctx.mayflyOverlays.list()[0]!
    expect(entry.update.reason).toBe('ack')
    expect(entry.source).toEqual(source(2))
  })

  it('derives disabled and busy actions with reasons from the current revision', async () => {
    const { model, handle } = await setup(kind)
    handle.set(ui.actions({ id: 'actions', items: [
      { id: 'disabled', label: 'Disabled', disabled: true, disabledReason: 'Read only' },
      { id: 'busy', label: 'Busy', busy: true },
      { id: 'close', label: 'Close', dismiss: true },
    ] }))
    expect(model.availableActions()).toEqual([
      { actionId: 'disabled', pagePath: [], verb: 'activate', enabled: false, pending: false, targetRevision: model.revision, disabledReason: 'Read only' },
      { actionId: 'busy', pagePath: [], verb: 'activate', enabled: false, pending: true, targetRevision: model.revision },
      { actionId: 'close', pagePath: [], verb: 'dismiss', enabled: true, pending: false, targetRevision: model.revision },
    ])
  })

  it('uses the focused browse row as an action selection and keeps its stale check consistent', async () => {
    const received: string[][] = []
    const { model, handle } = await setup(kind, { action: event => {
      if (event.kind === 'activate') received.push([...(event.inputs?.selections?.[0]?.selectedIds ?? [])])
      return { kind: 'completed' }
    } })
    const list = { pagePath: [], controlId: 'catalog' }
    handle.set(ui.stack.column([
      ui.list({ id: 'catalog', role: 'browse', selectedIds: [], items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
      ui.actions({ id: 'actions', items: [{ id: 'open', label: 'Open', selections: [list] }] }),
    ]))
    model.invoke('open')
    await flush()
    expect(received).toEqual([['one']])
    expect(model.operationSnapshot().find(operation => operation.actionId === 'open')?.phase).toBe('succeeded')
  })

  it('keeps feedback ownership and severity independent across operations', async () => {
    const first = Promise.withResolvers<MayflyUiActionReply>()
    const second = Promise.withResolvers<MayflyUiActionReply>()
    let calls = 0
    const { model, handle } = await setup(kind, { action: event => {
      if (event.kind !== 'activate') return { kind: 'completed' }
      calls += 1
      return calls === 1 ? first.promise : second.promise
    } })
    handle.set(ui.actions({ id: 'actions', items: [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }] }))
    model.invoke('first')
    model.invoke('second')
    await flush()
    first.resolve({ kind: 'completed', feedback: { severity: 'error', message: 'Delete failed', detail: 'Keep this visible' } })
    second.resolve({ kind: 'completed', feedback: { severity: 'success', message: 'Save complete' } })
    await flush()
    expect(model.feedbackSnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', message: 'Delete failed', detail: 'Keep this visible', owner: model.instanceId, state: 'active' }),
      expect.objectContaining({ severity: 'success', message: 'Save complete', owner: model.instanceId }),
    ]))
    model.handleFeedback(`${model.instanceId}/1`)
    expect(model.feedbackSnapshot().find(item => item.message === 'Delete failed')?.state).toBe('handled')
  })

  it('pauses short feedback lifetime while an overlay is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { model, handle } = await setup(kind, { action: () => ({ kind: 'completed', feedback: { severity: 'success', message: 'Saved' } }) })
    handle.set(ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save' }] }))
    model.invoke('save')
    await flush()
    model.setVisible(false)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(model.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Saved' })]))
    model.setVisible(true)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(model.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Saved' })]))
    await vi.advanceTimersByTimeAsync(1)
    expect(model.feedbackSnapshot().some(item => item.message === 'Saved')).toBe(false)
    vi.useRealTimers()
  })

  it('keeps drafts through external data and requires an explicit conflict decision', async () => {
    const write = vi.fn()
    const { model, handle } = await setup(kind, { action: event => { if (event.kind === 'submit') { write(); return { kind: 'failed', message: 'Unavailable' } } return { kind: 'completed' } } })
    model.edit({ ...address(), fieldId: 'name' }, 'B')
    handle.set(definition('C', 'Q'), { reason: 'data', source: source(2) })
    expect(model.form(address())!.fields.name).toMatchObject({ value: 'B', baseline: 'A', conflict: true })
    expect(model.form(address('two'))!.fields.name!.value).toBe('Q')
    model.invoke('save')
    await flush()
    expect(write).not.toHaveBeenCalled()
    model.updateForm(address(), { kind: 'resolve-conflict', fieldId: 'name', choice: 'draft' })
    model.invoke('save')
    await flush()
    expect(write).toHaveBeenCalledOnce()
    expect(model.form(address())!.fields.name!.value).toBe('B')
    expect(model.form(address())!.pending).toBeUndefined()
    expect(model.feedbackSnapshot().some(item => item.message === 'Unavailable')).toBe(true)
  })

  it('routes asynchronous validation to the matching field revision and ignores old results', async () => {
    const old = Promise.withResolvers<MayflyUiObservationReply>()
    const recent = Promise.withResolvers<MayflyUiObservationReply>()
    const { model } = await setup(kind, { observe: event => event.kind === 'value-change' ? event.value === 'B' ? old.promise : recent.promise : undefined })
    model.edit({ ...address(), fieldId: 'name' }, 'B')
    await flush()
    model.edit({ ...address(), fieldId: 'name' }, 'C')
    recent.resolve({ kind: 'invalid', errors: [{ ...address(), fieldId: 'name', message: 'Current validation' }] })
    await flush()
    old.resolve({ kind: 'invalid', errors: [{ ...address(), fieldId: 'name', message: 'Obsolete validation' }] })
    await flush()
    expect(model.form(address())!.fields.name).toMatchObject({ value: 'C', error: 'Current validation' })
  })

  it('admits callback errors as semantic text before storing or painting them', async () => {
    const { model } = await setup(kind, { action: event => event.kind === 'submit' ? {
      kind: 'invalid', errors: [{ ...address(), fieldId: 'name', message: '\x1b[2JInvalid name' }],
      feedback: { severity: 'error', message: '\x1b[31mCheck the name', detail: '\x1b]0;changed\x07Details' },
    } : { kind: 'completed' } })
    model.invoke('save')
    await flush()
    expect(model.form(address())!.fields.name!.error).toBe('Invalid name')
    expect(model.feedbackSnapshot().at(-1)).toMatchObject({ message: 'Check the name', detail: 'Details' })
  })

  it('preserves newer authoritative data when an earlier Save acknowledgement arrives late', async () => {
    const gate = Promise.withResolvers<MayflyUiActionReply>()
    const { model, handle } = await setup(kind, { action: event => event.kind === 'submit' ? gate.promise : { kind: 'completed' } })
    model.edit({ ...address(), fieldId: 'name' }, 'B')
    model.invoke('save')
    await flush()
    handle.set(definition('C'), { reason: 'data', source: source(3) })
    gate.resolve({ kind: 'accepted', node: definition('B'), source: source(2) })
    await flush()
    expect(model.source).toEqual(source(3))
    expect(model.form(address())!.fields.name).toMatchObject({ value: 'B', conflict: true, definition: { value: 'C' } })
    expect(model.form(address())!.pending).toBeUndefined()
    expect(model.feedbackSnapshot().some(item => item.severity === 'warning')).toBe(true)
  })

  it('checks actual baselines when a resource has no native revision', async () => {
    const gate = Promise.withResolvers<MayflyUiActionReply>()
    const { model, handle } = await setup(kind, { action: event => event.kind === 'submit' ? gate.promise : { kind: 'completed' } })
    handle.set(definition(), { source: [] })
    model.edit({ ...address(), fieldId: 'name' }, 'B')
    model.invoke('save')
    await flush()
    handle.set(definition('C'), { source: [] })
    gate.resolve({ kind: 'accepted', node: definition('B'), source: [] })
    await flush()
    expect(model.form(address())!.fields.name).toMatchObject({ value: 'B', conflict: true, definition: { value: 'C' } })
    expect(model.feedbackSnapshot().some(item => item.severity === 'warning')).toBe(true)
  })

  it('admits only submitted hidden forms and rejects stale hidden baselines', async () => {
    const write = vi.fn()
    const hidden = (value: string) => ui.stack.column([
      ui.child(ui.form({ id: 'hidden', fields: [{ kind: 'input', id: 'value', label: 'Value', value }] }), { when: { minWidth: 100 } }),
      ui.child({ kind: 'text', content: 123 } as never, { when: { minWidth: 200 } }),
      ui.actions({ id: 'actions', items: [{ id: 'save-hidden', label: 'Save', submit: [{ pagePath: [], formId: 'hidden' }] }] }),
    ])
    const { model, handle } = await setup(kind, { action: event => {
      if (event.kind !== 'submit') return { kind: 'completed' }
      write(event.submission)
      return { kind: 'accepted', node: hidden('saved'), source: source(2) }
    } })
    handle.set(hidden('initial'))
    expect(model.form({ pagePath: [], formId: 'hidden' })).toBeUndefined()
    model.invoke('save-hidden')
    await flush()
    expect(write).toHaveBeenCalledOnce()
    expect(model.form({ pagePath: [], formId: 'hidden' })!.fields.value!.value).toBe('saved')
    model.edit({ pagePath: [], formId: 'hidden', fieldId: 'value' }, 'draft')
    handle.set(hidden('external'), { source: source(3) })
    model.invoke('save-hidden')
    await flush()
    expect(write).toHaveBeenCalledOnce()
    expect(model.form({ pagePath: [], formId: 'hidden' })!.fields.value).toMatchObject({ value: 'draft', conflict: true })
    handle.set(ui.stack.column([
      ui.child({ kind: 'form', id: 'hidden' } as never, { when: { minWidth: 100 } }),
      ui.actions({ id: 'actions', items: [] }),
    ]))
    expect(model.form({ pagePath: [], formId: 'hidden' })!.fields.value!.value).toBe('draft')
  })

  it('keeps renderer attach/detach independent of its live registration state', async () => {
    const { model, ctx, handle } = await setup(kind)
    let deliveries = 0
    const renderer = await ctx.plugin({ name: 'renderer-consumer', inject: ['mayflyUiInteraction'], apply(child: Context) {
      const interaction = child.mayflyUiInteraction
      child.effect(() => interaction.subscribe(() => { deliveries += 1 }))
    } })
    model.edit({ ...address(), fieldId: 'name' }, 'B')
    await renderer.dispose()
    const before = deliveries
    handle.set(definition('A'))
    expect(model.form(address())!.fields.name!.value).toBe('B')
    expect(deliveries).toBe(before)
    expect(ctx.mayflyUiInteraction.get(kind, 'same')).toBe(model)
    const snapshot = model.inspect()
    model.admitVisibleControls()
    model.admitVisibleControls()
    expect(model.inspect()).toEqual(snapshot)
  })

  it('creates distinct instances for replacement and same-name reopens and fences their old callbacks', async () => {
    const gate = Promise.withResolvers<MayflyUiActionReply>()
    const { model, handle, ctx } = await setup(kind, { action: event => event.kind === 'submit' ? gate.promise : { kind: 'completed' } })
    model.edit({ ...address(), fieldId: 'name' }, 'B')
    model.invoke('save')
    await flush()
    handle.set(definition('new'), { reason: 'replace', scope: { kind: 'session', sessionId: 'new-session' } })
    const replacement = ctx.mayflyUiInteraction.get(kind, 'same')!
    expect(replacement).not.toBe(model)
    expect(model.disposed).toBe(true)
    gate.resolve({ kind: 'accepted', node: definition('late'), source: source(2) })
    await flush()
    expect(replacement.form(address())!.fields.name!.value).toBe('new')
    handle.dispose()
    if (kind === 'pane') ctx.mayflyPanes.register({ id: 'same', placement: 'bottom' }, definition('reopened'))
    else ctx.mayflyOverlays.open({ id: 'same' }, definition('reopened'))
    model.invoke('save')
    expect(ctx.mayflyUiInteraction.get(kind, 'same')!.form(address())!.fields.name!.value).toBe('reopened')
  })

  it('returns from default-No confirmation without losing drafts and invokes Yes only once', async () => {
    const remove = vi.fn()
    const { model } = await setup(kind, { action: event => { if (event.kind === 'activate') remove(); return { kind: 'completed' } } })
    model.edit({ ...address(), fieldId: 'name' }, 'B')
    model.invoke('delete')
    expect(model.decisionNode).toMatchObject({ child: { items: [{ id: 'mayfly.decision.no', defaultFocus: true }, { id: 'mayfly.decision.yes' }] } })
    expect(remove).not.toHaveBeenCalled()
    model.answerDecision(false)
    expect(model.form(address())!.fields.name!.value).toBe('B')
    model.invoke('delete')
    model.answerDecision(true)
    model.answerDecision(true)
    await flush()
    expect(remove).toHaveBeenCalledOnce()
  })
})

it('isolates same public ids across registries and destroys all drafts on provider unload', async () => {
  const { ctx, api, model } = await setup('pane')
  ctx.mayflyOverlays.open({ id: 'same' }, definition('overlay'))
  const overlay = ctx.mayflyUiInteraction.get('overlay', 'same')!
  model.edit({ ...address(), fieldId: 'name' }, 'pane draft')
  expect(overlay.form(address())!.fields.name!.value).toBe('overlay')
  await api.dispose()
  expect(model.disposed).toBe(true)
  expect(overlay.disposed).toBe(true)
  expect(ctx.mayflyUiInteraction.list()).toEqual([])
})

it('releases deleted hidden fields without admitting their text and requires normal discard confirmation', async () => {
  const { model, handle, ctx } = await setup('overlay')
  model.edit({ ...address(), fieldId: 'name' }, 'draft')
  model.requestClose()
  model.answerDecision(false)
  expect(ctx.mayflyUiInteraction.get('overlay', 'same')).toBe(model)
  handle.set(ui.stack.column([
    ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }] }),
    ui.child(ui.form({ id: 'config', fields: [] }), { tab: { controlId: 'pages', itemId: 'one' }, when: { minWidth: 100 } }),
  ]))
  expect(model.form(address())!.fields).toEqual({})
  expect(model.form(address('two'))).toBeUndefined()
  model.requestClose()
  expect(ctx.mayflyUiInteraction.get('overlay', 'same')).toBeUndefined()
})

it('drops old snapshots and action bindings when a surface is disposed', async () => {
  const handler = vi.fn()
  const { model, handle } = await setup('overlay', { action: handler })
  handle.set(ui.form({ id: 'secret', fields: [{ kind: 'secret', id: 'key', label: 'Key', value: 'sensitive-initial-value' }] }))
  handle.dispose()
  expect(model.registration.node).toBeNull()
  expect(model.registration.definition.onEvent).toBeUndefined()
  expect(JSON.stringify(model.registration)).not.toContain('sensitive-initial-value')
  model.emit({ kind: 'activate', actionId: 'save', controlId: 'save', pagePath: [] })
  expect(handler).not.toHaveBeenCalled()
})

it('isolates background notification owners and pauses their visible lifetime', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const { ctx } = await setup('overlay')
  const first = ctx.mayflyUiInteraction.createNotificationOwner('first')
  const second = ctx.mayflyUiInteraction.createNotificationOwner('second')
  first.report('failure', { kind: 'app', targetId: 'profile' }, { severity: 'error', message: 'First failed', detail: 'full detail' }, 'first-op')
  second.report('work', { kind: 'session', sessionId: 'session' }, { severity: 'info', purpose: 'progress', message: 'Working' }, 'second-op')
  await vi.advanceTimersByTimeAsync(8_000)
  second.report('work', { kind: 'session', sessionId: 'session' }, { severity: 'success', message: 'Finished' }, 'second-op')
  expect(ctx.mayflyUiInteraction.notificationSnapshot()).toEqual(expect.arrayContaining([
    expect.objectContaining({ owner: first.id, operationId: 'first-op', severity: 'error', detail: 'full detail' }),
    expect.objectContaining({ owner: second.id, operationId: 'second-op', severity: 'success', visibleMs: 0 }),
  ]))
  ctx.mayflyUiInteraction.setNotificationVisibility(false)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(ctx.mayflyUiInteraction.notificationSnapshot().some(item => item.message === 'Finished')).toBe(true)
  first.dispose()
  expect(ctx.mayflyUiInteraction.notificationSnapshot().map(item => item.message)).toEqual(['Finished'])
  ctx.mayflyUiInteraction.setNotificationVisibility(true)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  second.dispose()
})

it('projects registry entries and contains observers across service disposal', async () => {
  const { ctx, model } = await setup('pane')
  ctx.mayflyOverlays.open({ id: 'overlay-service-test' }, ui.text('overlay'))
  await flush()
  expect(ctx.mayflyUiInteraction.list()).toHaveLength(2)
  expect(ctx.mayflyUiInteraction.list('pane')).toEqual([model])
  expect(ctx.mayflyUiInteraction.panes().map(entry => entry.id)).toEqual(['same'])
  expect(ctx.mayflyUiInteraction.overlays().map(entry => entry.id)).toEqual(['overlay-service-test'])

  const owner = ctx.mayflyUiInteraction.createNotificationOwner('service-test')
  owner.report('failure', { kind: 'app', targetId: 'test' }, { severity: 'error', message: 'Failure' })
  const notification = ctx.mayflyUiInteraction.notificationSnapshot()[0]!
  ctx.mayflyUiInteraction.handleNotification(notification.id)
  expect(ctx.mayflyUiInteraction.notificationSnapshot()[0]!.state).toBe('handled')

  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  ctx.mayflyUiInteraction.subscribe(() => { throw new Error('observer failed') })
  owner.report('again', { kind: 'app', targetId: 'test' }, { severity: 'info', message: 'Again' })
  expect(warn).toHaveBeenCalledWith('UI interaction observer failed', expect.any(Error))

  const snapshot = model.registration
  ctx.mayflyUiInteraction.dispose()
  ctx.mayflyUiInteraction.dispose()
  const off = ctx.mayflyUiInteraction.subscribe(() => {})
  off()
  expect(() => ctx.mayflyUiInteraction.upsert('pane', snapshot)).toThrow('disposed')
  ;(ctx.mayflyUiInteraction as unknown as { changed(): void }).changed()
})

it('handles null snapshots and exposes an inert endpoint after disposal', async () => {
  const { model, handle } = await setup('pane')
  const snapshot = model.registration
  expect(() => model.receive({ ...snapshot, events: { prepare: async () => ({ reply: undefined, publish: () => false }) } })).toThrow('new surface instance')
  model.moveDocument({ pagePath: [], controlId: 'missing' }, { blockId: 'missing', offset: 0, follow: 'none' })
  handle.set(null)
  expect(model.node).toBeNull()
  model.admitVisibleControls()
  model.dispose()
  model.dispose()
  const off = model.subscribe(() => {})
  off()
  model.setVisible(false)
  model.focusControl({ pagePath: [], controlId: 'missing' })
  model.receive(snapshot)
  model.updateForm(address(), { kind: 'edit', fieldId: 'name', value: 'late' })
  model.updateChoice({ pagePath: [], controlId: 'missing' }, { kind: 'focus', id: 'missing' })
  model.requestClose()
  model.cancelOperation('missing')
  model.admitVisibleControls()
  const prepared = await model.endpoint.prepare({ kind: 'dismiss', pagePath: [] }, { surfaceId: model.id, operationId: 'disposed', source: [], revision: 0, signal: new AbortController().signal, report: vi.fn() })
  expect(prepared.reply).toBeUndefined()
  expect(prepared.publish()).toBe(false)
  ;(model as unknown as { changed(): void }).changed()
})

it('derives read, navigate, loader, close, and document controls and removes stale choices', async () => {
  const { model, handle } = await setup('overlay')
  const target = { pagePath: [{ controlId: 'pages', itemId: 'one' }], formId: 'config' }
  handle.set(ui.stack.column([
    ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
    ui.child(ui.form({ id: 'config', cancelActionId: 'cancel', fields: [{ kind: 'select', id: 'choice', label: 'Choice', value: null, options: [{ id: 'a', label: 'A' }] }] }), { tab: { controlId: 'pages', itemId: 'one' } }),
    ui.child(ui.form({ id: 'config', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }), { tab: { controlId: 'pages', itemId: 'two' } }),
    ui.list({ id: 'browse', role: 'browse', selectedIds: [], items: [{ id: 'row', label: 'Row' }] }),
    ui.scroll(ui.text('document'), { id: 'document' }),
    ui.loader({ message: 'Loading', cancelActionId: 'stop-loading' }),
    ui.actions({ id: 'actions', items: [
      { id: 'cancel', label: 'Custom cancel' },
      { id: 'read', label: 'Read', read: [target] },
      { id: 'next', label: 'Next', navigate: [{ controlId: 'pages', itemId: 'two' }] },
    ] }),
  ]))
  expect(model.availableActions()).toEqual(expect.arrayContaining([
    expect.objectContaining({ actionId: 'cancel', verb: 'dismiss' }),
    expect.objectContaining({ actionId: 'read', verb: 'read' }),
    expect.objectContaining({ actionId: 'next', verb: 'navigate' }),
    expect.objectContaining({ actionId: 'stop-loading', verb: 'activate' }),
  ]))
  const document = model.document({ pagePath: [], controlId: 'document' })!
  model.moveDocument({ pagePath: [], controlId: 'document' }, { ...document.anchor!, offset: 2, follow: 'none' })
  expect(model.document({ pagePath: [], controlId: 'document' })!.anchor?.offset).toBe(2)
  model.updateForm({ pagePath: [], formId: 'missing' }, { kind: 'release', operationId: 'missing' })
  model.updateChoice({ pagePath: [], controlId: 'missing' }, { kind: 'focus', id: 'missing' })
  handle.set(ui.text('replacement'))
  expect(model.choice({ pagePath: [], controlId: 'browse' })).toBeUndefined()
})

it('routes direct value, submit, decision, and stale selection events', async () => {
  const actions = vi.fn(() => ({ kind: 'completed' as const }))
  const observations = vi.fn(() => ({ kind: 'completed' as const }))
  const { model, handle } = await setup('overlay', { action: actions, observe: observations })
  handle.set(ui.stack.column([
    ui.form({ id: 'form', submitActionId: 'save', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }),
    ui.list({ id: 'choose', role: 'choose', minSelected: 1, selectedIds: [], items: [{ id: 'one', label: 'One' }] }),
    ui.actions({ id: 'actions', items: [
      { id: 'confirmed', label: 'Confirmed', confirm: 'Proceed?' },
      { id: 'needs-selection', label: 'Needs selection', selections: [{ pagePath: [], controlId: 'missing' }] },
      { id: 'navigate-missing', label: 'Missing page', navigate: [{ controlId: 'missing', itemId: 'page' }] },
    ] }),
  ]))
  model.emit({ kind: 'value-change', pagePath: [], formId: 'form', controlId: 'name', value: 'typed', draftRevision: 1 })
  await flush()
  model.emit({ kind: 'submit', pagePath: [], controlId: 'form', submission: { actionId: 'save', draftRevision: 1, source: [], forms: [] } })
  await flush()
  expect(model.form({ pagePath: [], formId: 'form' })!.fields.name!.value).toBe('typed')
  expect(observations).toHaveBeenCalled()
  expect(actions).toHaveBeenCalled()

  model.invoke('confirmed')
  model.focusControl({ pagePath: [], controlId: 'mayfly.decision.yes' })
  model.emit({ kind: 'tab-change', pagePath: [], controlId: 'missing', tabId: 'missing' })
  expect(model.decisionNode).toBeDefined()
  model.emit({ kind: 'activate', pagePath: [], controlId: 'mayfly.decision', actionId: 'mayfly.decision.no' })
  expect(model.decisionNode).toBeUndefined()
  model.invoke('confirmed')
  model.emit({ kind: 'activate', pagePath: [], controlId: 'mayfly.decision', actionId: 'mayfly.decision.yes' })
  await flush()
  model.invoke('needs-selection')
  expect(model.feedbackSnapshot().at(-1)?.message).toBe('A selection is no longer available')
  model.invoke('navigate-missing')
  expect(model.feedbackSnapshot().at(-1)?.message).toBe('The destination page is unavailable')
  model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'missing', selectedIds: [] })
  model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'choose', selectedIds: [] })
  expect(model.feedbackSnapshot().at(-1)?.message).toContain('Select at least')
})

it('settles rejected publication and clears progress without leaving a running operation', async () => {
  const { model } = directSurface(ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }), async (_event, context) => {
    context.report({ severity: 'info', purpose: 'progress', message: 'Working' })
    return { reply: { kind: 'completed' }, publish: () => false }
  })
  model.invoke('run')
  await flush()
  expect(model.operationSnapshot()).toMatchObject([{ phase: 'succeeded' }])
  expect(model.feedbackSnapshot()).toEqual([])
})

it('fences a node publication when no node was ever admitted', async () => {
  const { model } = directSurface(null, async () => ({ reply: { kind: 'completed', node: ui.text('snapshot'), source: [] }, publish: () => true }))
  model.requestClose()
  await flush()
  expect(model.operationSnapshot()).toMatchObject([{ phase: 'succeeded' }])
  expect(model.feedbackSnapshot()).toEqual([])
})

it('cancels a pending direct operation and ignores its late report', async () => {
  const gate = Promise.withResolvers<{ reply: MayflyUiActionReply, publish: () => boolean }>()
  let eventContext!: import('@ephemeral-ai/mayfly-ui').MayflyUiEventContext
  const { model } = directSurface(ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }), async (_event, context) => {
    eventContext = context
    return gate.promise
  })
  model.invoke('run')
  await vi.waitFor(() => expect(eventContext).toBeDefined())
  const operation = model.operationSnapshot()[0]!
  model.cancelOperation(operation.id)
  eventContext.report({ severity: 'error', message: 'Late' })
  gate.resolve({ reply: { kind: 'completed' }, publish: () => true })
  await flush()
  expect(model.feedbackSnapshot()).toEqual([])
  expect(model.operationSnapshot()[0]!.phase).toBe('unknown')
})

it('closes a dismiss request with no reply and reports invalid returned snapshots', async () => {
  const close = vi.fn()
  const dismiss = directSurface(ui.text('body'), async () => ({ reply: undefined, publish: () => false }), { close })
  dismiss.model.requestClose()
  await flush()
  expect(close).toHaveBeenCalledOnce()

  const target = { pagePath: [], formId: 'form' }
  const node = ui.stack.column([
    ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }),
    ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save', submit: [target] }] }),
  ])
  const invalid = directSurface(node, async () => ({ reply: { kind: 'accepted', node: null, source: [] } as never, publish: () => true }))
  invalid.model.invoke('save')
  await flush()
  expect(invalid.model.feedbackSnapshot().at(-1)?.message).toBe('The action completed, but its result could not be displayed')
})

it('contains invalid and partial acknowledgement addresses', async () => {
  const target = { pagePath: [], formId: 'form' }
  const node = ui.stack.column([
    ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }),
    ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save', submit: [target] }] }),
  ])
  let mode: 'partial' | 'submit-invalid' | 'field-invalid' = 'partial'
  const direct = directSurface(node, async _event => {
    const reply: MayflyUiActionReply = mode === 'partial'
      ? { kind: 'failed', message: 'partial', node, source: [], acceptedFields: [{ pagePath: [], formId: 'missing', fieldId: 'name' }] }
      : mode === 'submit-invalid'
        ? { kind: 'invalid', errors: [{ pagePath: [], formId: 'missing', fieldId: 'name', message: 'Wrong form' }] }
        : { kind: 'invalid', errors: [{ pagePath: [], formId: 'form', fieldId: 'other', message: 'Wrong field' }] }
    return { reply, publish: () => true }
  })
  direct.model.invoke('save')
  await flush()
  expect(direct.model.feedbackSnapshot().at(-1)?.message).toBe('The action could not be completed')
  mode = 'submit-invalid'
  direct.model.invoke('save')
  await flush()
  expect(direct.model.feedbackSnapshot().at(-1)?.message).toBe('The action could not be completed')
  mode = 'field-invalid'
  direct.model.edit({ pagePath: [], formId: 'form', fieldId: 'name' }, 'changed')
  await flush()
  expect(direct.model.feedbackSnapshot().at(-1)?.message).toBe('The action could not be completed')
})

it('cancels stale read inputs and trims completed operation history', async () => {
  const target = { pagePath: [], formId: 'form' }
  const node = ui.stack.column([
    ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }),
    ui.actions({ id: 'actions', items: [{ id: 'read', label: 'Read', read: [target] }, { id: 'run', label: 'Run' }] }),
  ])
  const gate = Promise.withResolvers<{ reply: MayflyUiActionReply, publish: () => boolean }>()
  let pending = true
  const direct = directSurface(node, async event => pending && event.kind === 'activate' && event.actionId === 'read'
    ? gate.promise
    : { reply: { kind: 'completed' }, publish: () => true })
  direct.model.invoke('read')
  await flush()
  direct.model.edit({ pagePath: [], formId: 'form', fieldId: 'name' }, 'changed')
  pending = false
  gate.resolve({ reply: { kind: 'completed' }, publish: () => true })
  await flush()
  expect(direct.model.operationSnapshot()[0]!.phase).toBe('cancelled')

  for (let index = 0; index < 70; index += 1) {
    direct.model.invoke('run')
    await flush()
  }
  expect(direct.model.operationSnapshot()).toHaveLength(64)
})

it('reports observer failures through direct bindings', async () => {
  const onObserverError = vi.fn()
  const direct = directSurface(ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }), async () => ({ reply: { kind: 'completed' }, publish: () => true }), { onObserverError })
  direct.model.subscribe(() => { throw new Error('observer failed') })
  direct.model.invoke('run')
  await flush()
  expect(onObserverError).toHaveBeenCalledWith(expect.any(Error))
})

it('receives null, cached, invalid, and source-changing snapshots directly', () => {
  const node = ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] })
  const direct = directSurface(node, async () => ({ reply: { kind: 'completed' }, publish: () => true }))
  direct.model.receive({ ...direct.snapshot, revision: 1 })
  expect(direct.model.node).toEqual(node)
  direct.model.edit({ pagePath: [], formId: 'form', fieldId: 'name' }, 'draft')
  direct.model.requestClose()
  expect(direct.model.decisionNode).toBeDefined()
  direct.model.receive({ ...direct.snapshot, revision: 2, source: [{ resourceId: 'settings', revision: 2 }], node: { kind: 'unknown' } as never })
  expect(direct.model.node).toEqual(node)
  expect(direct.model.feedbackSnapshot().at(-1)?.severity).toBe('error')
  direct.model.receive({ ...direct.snapshot, revision: 3, source: [{ resourceId: 'settings', revision: 3 }], node })
  expect(direct.model.decisionNode).toBeUndefined()
  direct.model.receive({ ...direct.snapshot, revision: 4, node: null })
  expect(direct.model.node).toBeNull()
})

it('backs out of nested tabs before closing and keeps the nearest return target', async () => {
  const node = ui.stack.column([
    ui.tabs({ id: 'outer', activeId: 'two', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two', backId: 'one' }] }),
    ui.child(ui.stack.column([
      ui.tabs({ id: 'inner', activeId: 'b', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', backId: 'a' }] }),
      ui.child(ui.form({ id: 'inner-form', fields: [{ kind: 'input', id: 'value', label: 'Value', value: '' }] }), { tab: { controlId: 'inner', itemId: 'b' } }),
    ]), { tab: { controlId: 'outer', itemId: 'two' } }),
  ])
  const close = vi.fn()
  const direct = directSurface(node, async () => ({ reply: undefined, publish: () => false }), { close })
  expect(direct.model.backTarget()).toEqual([{ controlId: 'outer', itemId: 'two' }, { controlId: 'inner', itemId: 'a' }])
  direct.model.requestClose()
  expect(direct.model.activeTab({ pagePath: [{ controlId: 'outer', itemId: 'two' }], controlId: 'inner' })).toBe('a')
  expect(close).not.toHaveBeenCalled()
  direct.model.emit({ kind: 'tab-change', pagePath: [], controlId: 'outer', tabId: 'one' })
  direct.model.emit({ kind: 'dismiss', pagePath: [] })
  await flush()
  expect(close).toHaveBeenCalledOnce()
})

it('handles accepted null data and explicit navigation or dismissal replies', async () => {
  const close = vi.fn()
  const node = ui.stack.column([
    ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }),
    ui.actions({ id: 'actions', items: [
      { id: 'null', label: 'Null' },
      { id: 'navigate', label: 'Navigate' },
      { id: 'navigate-missing', label: 'Navigate missing' },
      { id: 'accepted-close', label: 'Accepted close' },
      { id: 'cancelled-close', label: 'Cancelled close' },
    ] }),
  ])
  const direct = directSurface(node, async event => {
    const action = event.kind === 'activate' ? event.actionId : ''
    const reply: MayflyUiActionReply = action === 'null'
      ? { kind: 'accepted', node: null, source: [] } as never
      : action === 'navigate'
        ? { kind: 'completed', navigate: [{ controlId: 'pages', itemId: 'two' }] }
        : action === 'navigate-missing'
          ? { kind: 'completed', navigate: [{ controlId: 'missing', itemId: 'page' }] }
        : action === 'accepted-close'
          ? { kind: 'accepted', node, source: [], dismiss: true }
          : { kind: 'cancelled', dismiss: true }
    return { reply, publish: () => true }
  }, { close })
  direct.model.emit({ kind: 'activate', pagePath: [], controlId: 'null', actionId: 'null' })
  await flush()
  direct.model.invoke('navigate')
  await flush()
  expect(direct.model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('two')
  direct.model.invoke('navigate-missing')
  await flush()
  expect(direct.model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('two')
  direct.model.invoke('accepted-close')
  await flush()
  direct.model.invoke('cancelled-close')
  await flush()
  expect(close.mock.calls.length).toBeGreaterThanOrEqual(2)
})

it('contains invalid reply nodes, direct errors, and publication-time disposal', async () => {
  const node = ui.actions({ id: 'actions', items: [{ id: 'invalid', label: 'Invalid' }, { id: 'error', label: 'Error' }, { id: 'dispose', label: 'Dispose' }] })
  let model!: UiSurfaceModel
  const direct = directSurface(node, async event => {
    const action = event.kind === 'activate' ? event.actionId : ''
    if (action === 'error') throw new Error('direct action failed')
    return action === 'invalid'
      ? { reply: { kind: 'accepted', node: { kind: 'unknown' } as never, source: [] }, publish: () => true }
      : { reply: { kind: 'completed' }, publish: () => { model.dispose(); return true } }
  })
  model = direct.model
  model.invoke('invalid')
  await flush()
  expect(model.feedbackSnapshot().at(-1)?.message).toBe('The action completed, but its result could not be displayed')
  model.invoke('error')
  await flush()
  expect(model.feedbackSnapshot().at(-1)?.message).toBe('direct action failed')
  model.invoke('dispose')
  await flush()
  expect(model.disposed).toBe(true)
})

it('marks a partial failure stale when unversioned source data changes', async () => {
  const target = { pagePath: [], formId: 'form' }
  const view = (value: string) => ui.stack.column([
    ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value }] }),
    ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save', submit: [target] }] }),
  ])
  const gate = Promise.withResolvers<{ reply: MayflyUiActionReply, publish: () => boolean }>()
  const direct = directSurface(view('old'), async () => gate.promise)
  direct.model.edit({ pagePath: [], formId: 'form', fieldId: 'name' }, 'draft')
  direct.model.invoke('save')
  await flush()
  direct.model.receive({ ...direct.snapshot, revision: 1, node: view('new') })
  gate.resolve({ reply: { kind: 'failed', message: 'Credential failed', node: view('old'), source: [], acceptedFields: [{ ...target, fieldId: 'name' }] }, publish: () => true })
  await flush()
  expect(direct.model.operationSnapshot()[0]!.phase).toBe('cancelled')
})

it('routes choice, browse, close, picker, missing-form, and back controls', async () => {
  const close = vi.fn()
  const page = [{ controlId: 'pages', itemId: 'two' }]
  const formAddress = { pagePath: page, formId: 'form' }
  const node = ui.stack.column([
    ui.tabs({ id: 'pages', activeId: 'one', items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two', backId: 'one' }] }),
    ui.child(ui.stack.column([
      ui.form({ id: 'form', fields: [{ kind: 'select', id: 'choice', label: 'Choice', value: null, options: [{ id: 'a', label: 'A' }] }] }),
      ui.actions({ id: 'page-actions', items: [{ id: 'tab-read', label: 'Tab read', read: [formAddress], navigate: [{ controlId: 'pages', itemId: 'one' }] }] }),
    ]), { tab: page[0]! }),
    ui.list({ id: 'browse', role: 'browse', selectedIds: [], items: [{ id: 'row', label: 'Row' }, { id: 'disabled', label: 'Disabled', disabled: true }] }),
    ui.list({ id: 'choose', role: 'choose', selectedIds: [], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
    ui.actions({ id: 'actions', items: [
      { id: 'close', label: 'Close', dismiss: true },
      { id: 'save', label: 'Save', submit: [formAddress] },
      { id: 'missing-form', label: 'Missing form', submit: [{ pagePath: [], formId: 'missing' }] },
    ] }),
  ])
  const events: import('@ephemeral-ai/mayfly-ui').MayflyUiEvent[] = []
  const direct = directSurface(node, async event => { events.push(event); return { reply: { kind: 'completed' }, publish: () => true } }, { close })
  expect(direct.model.completedSteps({ pagePath: [], controlId: 'pages' })).toEqual([])
  direct.model.updateChoice({ pagePath: [], controlId: 'choose' }, { kind: 'select', ids: ['a'] })
  expect(direct.model.dirty).toBe(true)
  direct.model.updateChoice({ pagePath: [], controlId: 'choose' }, { kind: 'select', ids: ['a'] })
  direct.model.emit({ kind: 'selection-toggle', pagePath: [], controlId: 'choose', selectedIds: ['b'] })
  direct.model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'browse', selectedIds: [] })
  direct.model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'browse', selectedIds: ['disabled'] })
  direct.model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'browse', selectedIds: ['row'] })
  await flush()
  expect(events.some(event => event.kind === 'selection-accept')).toBe(true)

  direct.model.emit({ kind: 'tab-change', pagePath: [], controlId: 'pages', tabId: 'two' })
  direct.model.updateForm(formAddress, { kind: 'begin-picker', fieldId: 'choice' })
  direct.model.invoke('save')
  await flush()
  expect(direct.model.form(formAddress)!.fields.choice!.picker).toBeUndefined()
  direct.model.invoke('missing-form')
  expect(direct.model.feedbackSnapshot().at(-1)?.message).toBe('A submitted form is unavailable or invalid')
  direct.model.updateForm(formAddress, { kind: 'submit', operationId: 'manual' })
  direct.model.invoke('save')
  direct.model.updateForm(formAddress, { kind: 'release', operationId: 'manual' })
  direct.model.invoke('tab-read', page)
  expect(direct.model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('one')
  direct.model.activateTab({ pagePath: [], controlId: 'pages' }, 'two')
  direct.model.requestClose()
  expect(direct.model.activeTab({ pagePath: [], controlId: 'pages' })).toBe('one')
  direct.model.invoke('close')
  direct.model.answerDecision(true)
  await flush()
  expect(close).toHaveBeenCalled()
})

it('covers baseline arrays and lists plus invalid observations without submissions', async () => {
  const node = ui.stack.column([
    ui.form({ id: 'form', fields: [
      { kind: 'input', id: 'z', label: 'Z', value: '' },
      { kind: 'multiselect', id: 'a', label: 'A', value: ['b', 'a'], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ] }),
    ui.list({ id: 'list', role: 'choose', mode: 'multiple', selectedIds: ['b', 'a'], items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }),
    ui.actions({ id: 'actions', items: [{ id: 'null', label: 'Null' }, { id: 'failed', label: 'Failed' }] }),
  ])
  const direct = directSurface(node, async event => {
    if (event.kind === 'value-change') return { reply: { kind: 'invalid', errors: [{ pagePath: [], formId: 'form', fieldId: 'z', message: 'Invalid' }] }, publish: () => true }
    if (event.kind === 'activate' && event.actionId === 'failed') return { reply: { kind: 'failed', message: 'Failed' }, publish: () => false }
    return { reply: { kind: 'accepted', node: null, source: [] } as never, publish: () => true }
  })
  direct.model.invoke('null')
  await flush()
  direct.model.invoke('failed')
  await flush()
  expect(direct.model.operationSnapshot().at(-1)?.phase).toBe('unknown')
  direct.model.edit({ pagePath: [], formId: 'form', fieldId: 'z' }, 'value')
  await flush()
  expect(direct.model.form({ pagePath: [], formId: 'form' })!.fields.z!.error).toBe('Invalid')
})

it('contains stale input snapshots and late endpoint rejection after cancellation', async () => {
  const formAddress = { pagePath: [], formId: 'form' }
  const node = ui.stack.column([
    ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }),
    ui.actions({ id: 'actions', items: [{ id: 'read', label: 'Read', read: [formAddress] }, { id: 'wait', label: 'Wait' }] }),
  ])
  let model!: UiSurfaceModel
  let mode: 'read' | 'wait' = 'read'
  const rejection = Promise.withResolvers<never>()
  const direct = directSurface(node, async _event => {
    if (mode === 'wait') return rejection.promise
    const form = model.form(formAddress)!
    const forms = (model as unknown as { forms: Map<string, typeof form> }).forms
    forms.set(forms.keys().next().value!, { ...form, draftRevision: form.draftRevision + 1 })
    return { reply: { kind: 'completed' }, publish: () => true }
  })
  model = direct.model
  model.invoke('read')
  await flush()
  expect(model.operationSnapshot()[0]!.phase).toBe('cancelled')
  mode = 'wait'
  model.invoke('wait')
  await flush()
  const waiting = model.operationSnapshot().at(-1)!
  model.cancelOperation(waiting.id)
  rejection.reject(new Error('late failure'))
  await flush()
  expect(model.feedbackSnapshot().some(item => item.message === 'late failure')).toBe(false)
})

it('retains a running operation while trimming later completed history', async () => {
  const gate = Promise.withResolvers<{ reply: MayflyUiActionReply, publish: () => boolean }>()
  let first = true
  const direct = directSurface(ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }, { id: 'quick', label: 'Quick' }] }), async event => {
    if (first && event.kind === 'activate' && event.actionId === 'run') { first = false; return gate.promise }
    return { reply: { kind: 'completed' }, publish: () => true }
  })
  direct.model.invoke('run')
  await flush()
  for (let index = 0; index < 70; index += 1) { direct.model.invoke('quick'); await flush() }
  expect(direct.model.operationSnapshot().some(operation => operation.phase === 'running')).toBe(true)
  gate.resolve({ reply: { kind: 'completed' }, publish: () => true })
  await flush()
})

it('deduplicates pending dismissals and accepts activate inputs without selections', async () => {
  const gate = Promise.withResolvers<{ reply: MayflyUiActionReply | undefined, publish: () => boolean }>()
  const close = vi.fn()
  const dismiss = directSurface(ui.text('body'), async () => gate.promise, { close })
  dismiss.model.requestClose()
  dismiss.model.requestClose()
  expect(dismiss.model.operationSnapshot()).toHaveLength(1)
  gate.resolve({ reply: undefined, publish: () => false })
  await flush()
  expect(close).toHaveBeenCalledOnce()

  const action = directSurface(ui.actions({ id: 'actions', items: [{ id: 'run', label: 'Run' }] }), async () => ({ reply: { kind: 'completed' }, publish: () => true }))
  action.model.emit({
    kind: 'activate', pagePath: [], controlId: 'run', actionId: 'run',
    inputs: { actionId: 'run', draftRevision: action.model.revision, source: [], forms: [] },
  })
  await flush()
  expect(action.model.operationSnapshot()).toMatchObject([{ actionId: 'run', phase: 'succeeded' }])
})

it('contains a malformed partial acknowledgement without source metadata', async () => {
  const target = { pagePath: [], formId: 'form' }
  const node = ui.stack.column([
    ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }),
    ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save', submit: [target] }] }),
  ])
  const direct = directSurface(node, async () => ({
    reply: { kind: 'failed', message: 'Malformed', node, acceptedFields: [] } as never,
    publish: () => false,
  }))
  direct.model.invoke('save')
  await flush()
  expect(direct.model.operationSnapshot()).toMatchObject([{ phase: 'unknown' }])
})

it('cancels an acknowledgement when a hidden submitted form reveals a newer schema', async () => {
  const target = { pagePath: [], formId: 'hidden' }
  const hidden = (includeNote: boolean) => ui.stack.column([
    ui.child(ui.form({ id: 'hidden', fields: [
      { kind: 'input', id: 'name', label: 'Name', value: '' },
      ...(includeNote ? [{ kind: 'input' as const, id: 'note', label: 'Note', value: '' }] : []),
    ] }), { when: { minWidth: 100 } }),
    ui.actions({ id: 'actions', items: [{ id: 'save', label: 'Save', submit: [target] }] }),
  ])
  const gate = Promise.withResolvers<{ reply: MayflyUiActionReply, publish: () => boolean }>()
  const publish = vi.fn(() => true)
  const direct = directSurface(hidden(false), async () => gate.promise)
  direct.model.invoke('save')
  await flush()
  direct.model.receive({ ...direct.snapshot, revision: 1, node: hidden(true), update: { reason: 'data' } })
  gate.resolve({ reply: { kind: 'accepted', node: hidden(true), source: [] }, publish })
  await flush()
  expect(publish).not.toHaveBeenCalled()
  expect(direct.model.form(target)!.fields.note).toBeDefined()
  expect(direct.model.operationSnapshot()).toMatchObject([{ phase: 'unknown' }])
})
