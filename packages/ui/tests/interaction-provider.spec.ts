/** Integration evidence for registration-bound action settlement and refresh metadata.
 * @module @ephemeral-ai/mayfly-ui/tests/interaction-provider
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyUiActionHandler, MayflyUiActionReply, MayflyUiEvent, MayflyUiEventContext, MayflyUiNode, MayflyUiObservationHandler } from '../src/contracts.ts'
import { apply } from '../src/provider.ts'
import { UiEventEndpoint } from '../src/snapshot-events.ts'

const source = [{ resourceId: 'settings', revision: 1 }] as const
const initial: MayflyUiNode = { kind: 'text', content: 'baseline' }
const changed: MayflyUiNode = { kind: 'text', content: 'saved' }
const submit: MayflyUiEvent = {
  kind: 'submit', controlId: 'form', pagePath: [],
  submission: { actionId: 'save', draftRevision: 3, forms: [], source },
}
const activate: MayflyUiEvent = { kind: 'activate', controlId: 'refresh', actionId: 'refresh', pagePath: [] }
const valueChange: MayflyUiEvent = { kind: 'value-change', controlId: 'name', formId: 'form', value: 'changed', draftRevision: 4, pagePath: [] }
const context = (signal = new AbortController().signal): MayflyUiEventContext => ({
  surfaceId: 'config', source, signal, revision: 8, operationId: 'save-1', report: vi.fn(),
})
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(kind: 'pane' | 'overlay', onAction?: MayflyUiActionHandler, onObserve?: MayflyUiObservationHandler) {
  const ctx = new Context()
  const owner = await ctx.plugin({ name: 'ui-provider', apply })
  cleanups.push(() => owner.dispose())
  const definition = {
    id: 'config', source, scope: { kind: 'app' as const, targetId: 'profile' },
    ...(onAction === undefined && onObserve === undefined ? {} : { onEvent: { ...(onAction === undefined ? {} : { action: onAction }), ...(onObserve === undefined ? {} : { observe: onObserve }) } }),
  }
  const handle = kind === 'pane'
    ? ctx.mayflyPanes.register({ ...definition, placement: 'bottom' }, initial)
    : ctx.mayflyOverlays.open(definition, initial)
  const current = () => kind === 'pane' ? ctx.mayflyPanes.list()[0]! : ctx.mayflyOverlays.list()[0]!
  return { ctx, owner, handle, current }
}

describe.each(['pane', 'overlay'] as const)('%s action publication', kind => {
  it('validates explicit overlay dismissal policies', async () => {
    const { ctx } = await setup(kind)
    expect(() => ctx.mayflyOverlays.open({ id: 'bad', dismissal: 'unknown' as never }, initial)).toThrow('dismissal')
    const handle = ctx.mayflyOverlays.open({ id: 'request', dismissal: 'discard' }, initial)
    expect(ctx.mayflyOverlays.list().find(entry => entry.id === 'request')!.definition.dismissal).toBe('discard')
    handle.close()
  })

  it('publishes accepted snapshots once after explicit admission, without a renderer', async () => {
    const accepted = { kind: 'accepted' as const, node: changed, source: [{ resourceId: 'settings', revision: 2 }] }
    const handler = vi.fn(() => accepted)
    const { current } = await setup(kind, handler)
    const entry = current()
    const result = await entry.events.prepare(submit, context())
    expect(current()).toBe(entry)
    expect(Object.isFrozen(result.reply)).toBe(true)
    expect(Object.isFrozen(result.reply!.kind === 'accepted' && result.reply.node)).toBe(true)
    expect(result.publish()).toBe(true)
    expect(current()).toMatchObject({
      node: changed, revision: 1, source: accepted.source,
      update: { reason: 'ack', operationId: 'save-1', draftRevision: 3, source: accepted.source },
    })
    expect(result.publish()).toBe(false)
    expect(current().revision).toBe(1)
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0]![0]).not.toBe(submit)
  })

  it('keeps pending actions across data refresh and persists source and scope metadata', async () => {
    const gate = Promise.withResolvers<MayflyUiActionReply>()
    let signal!: AbortSignal
    const { current, handle } = await setup(kind, (_event, ctx) => { signal = ctx.signal; return gate.promise })
    const pending = current().events.prepare(submit, context())
    await Promise.resolve()
    handle.set(changed, { reason: 'data', source: [{ resourceId: 'settings', revision: 2 }] })
    expect(signal.aborted).toBe(false)
    handle.set(changed)
    if ('hide' in handle) { handle.hide(); handle.show(); handle.focus() }
    expect(current()).toMatchObject({ source: [{ resourceId: 'settings', revision: 2 }], scope: { kind: 'app', targetId: 'profile' } })
    gate.resolve({ kind: 'conflict', node: changed, source: [{ resourceId: 'settings', revision: 2 }], message: 'Changed elsewhere' })
    const reply = await pending
    expect(reply.publish()).toBe(true)
    expect(current().update.reason).toBe('data')
  })

  it.each(['replace', 'dispose', 'abort'] as const)('fences prepared and unfinished replies after %s', async reason => {
    const gate = Promise.withResolvers<MayflyUiActionReply>()
    let signal!: AbortSignal
    const { current, handle } = await setup(kind, (_event, ctx) => { signal = ctx.signal; return gate.promise })
    const controller = new AbortController()
    const entry = current()
    const pending = entry.events.prepare(submit, context(controller.signal))
    await Promise.resolve()
    if (reason === 'replace') handle.set(changed, { reason: 'replace', scope: { kind: 'session', sessionId: 'other' } })
    else if (reason === 'dispose') handle.dispose()
    else controller.abort()
    expect(signal.aborted).toBe(true)
    const result = await pending
    gate.resolve({ kind: 'accepted', node: changed, source: [] })
    expect(result.reply).toBeUndefined()
    expect(result.publish()).toBe(false)
    expect((await entry.events.prepare(activate, context(controller.signal))).publish()).toBe(false)
  })

  it('does not let a completed old registration publish into a reopened same-name surface', async () => {
    const { current, handle, ctx } = await setup(kind, () => ({ kind: 'accepted', node: changed, source: [] }))
    const result = await current().events.prepare(submit, context())
    handle.dispose()
    if (kind === 'pane') ctx.mayflyPanes.register({ id: 'config', placement: 'bottom' }, initial)
    else ctx.mayflyOverlays.open({ id: 'config' }, initial)
    expect(result.publish()).toBe(false)
    expect(current().node).toEqual(initial)
    expect(current().revision).toBe(0)
  })

  it('prevents observation reports after settlement or cancellation', async () => {
    const gate = Promise.withResolvers<MayflyUiActionReply>()
    let received!: MayflyUiEventContext
    const supplied = context()
    const { current } = await setup(kind, (_event, ctx) => {
      received = ctx
      ctx.report({ message: 'Saving', severity: 'info', purpose: 'progress' })
      return gate.promise
    })
    const pending = current().events.prepare(submit, supplied)
    await Promise.resolve()
    expect(supplied.report).toHaveBeenCalledOnce()
    gate.resolve({ kind: 'failed', message: 'Unavailable' })
    const result = await pending
    received.report({ message: 'Late', severity: 'success' })
    expect(supplied.report).toHaveBeenCalledOnce()
    expect(result.publish()).toBe(true)
    expect(current().node).toEqual(initial)
  })

  it('does not invoke a pre-aborted action and rejects an incorrectly addressed event', async () => {
    const handler = vi.fn()
    const { current } = await setup(kind, handler)
    const aborted = AbortSignal.abort()
    expect((await current().events.prepare(activate, context(aborted))).reply).toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
    await expect(current().events.prepare(activate, { ...context(), surfaceId: 'another' })).rejects.toThrow('another surface')
  })

  it('requires action settlements while observation handlers may return void', async () => {
    const { current } = await setup(kind)
    await expect(current().events.prepare(submit, context())).rejects.toThrow('structured reply')
    expect((await current().events.prepare(activate, context())).publish()).toBe(false)
    const action = await setup(kind, () => undefined as never)
    await expect(action.current().events.prepare(activate, context())).rejects.toThrow('structured reply')
    const observation = vi.fn(() => undefined)
    const observed = await setup(kind, undefined, observation)
    expect((await observed.current().events.prepare(valueChange, context())).publish()).toBe(false)
    expect(observation).toHaveBeenCalledOnce()
  })

  it('rejects snapshot publication and dismissal from observation handlers', async () => {
    const accepted = await setup(kind, undefined, () => ({ kind: 'accepted', node: changed, source: [] }) as never)
    await expect(accepted.current().events.prepare(valueChange, context())).rejects.toThrow('observations cannot publish')
    const dismissed = await setup(kind, undefined, () => ({ kind: 'completed', dismiss: true }) as never)
    await expect(dismissed.current().events.prepare(valueChange, context())).rejects.toThrow('observations cannot publish')
    const navigated = await setup(kind, undefined, () => ({ kind: 'completed', navigate: [{ controlId: 'pages', itemId: 'next' }] }) as never)
    await expect(navigated.current().events.prepare(valueChange, context())).rejects.toThrow('observations cannot publish')
  })

  it.each([
    null, 'invalid', { kind: 'unknown' },
    { kind: 'accepted', source: [] }, { kind: 'accepted', node: undefined, source: [] },
    { kind: 'accepted', node: changed, source: [{ resourceId: 'x', revision: false }] },
    { kind: 'invalid' }, { kind: 'invalid', errors: [] },
    { kind: 'conflict', node: changed, source: [], message: 1 },
    { kind: 'failed', message: 1 },
    { kind: 'completed', dismiss: 'yes' },
    { kind: 'failed', message: 'failure', dismiss: true },
    { kind: 'completed', navigate: 'next' },
    { kind: 'completed', navigate: [null] },
    { kind: 'completed', navigate: [{}] },
    { kind: 'completed', navigate: [{ controlId: 1, itemId: 'next' }] },
    { kind: 'completed', navigate: [{ controlId: 'pages', itemId: 1 }] },
    { kind: 'failed', message: 'failure', acceptedFields: 'invalid', node: changed, source: [] },
    { kind: 'failed', message: 'failure', acceptedFields: [] },
    { kind: 'failed', message: 'failure', acceptedFields: [], node: changed },
    { kind: 'completed' },
    { kind: 'failed', message: 'failure', feedback: null },
    { kind: 'failed', message: 'failure', feedback: { message: '', severity: 'error' } },
    { kind: 'failed', message: 'failure', feedback: { message: false, severity: 'error' } },
    { kind: 'failed', message: 'failure', feedback: { message: 'failed', severity: 'unknown' } },
    { kind: 'failed', message: 'failure', feedback: { message: 'failed', severity: 'error', purpose: 'unknown' } },
    { kind: 'failed', message: 'failure', feedback: { message: 'failed', severity: 'error', detail: 1 } },
  ])('contains invalid action reply %j before publication', async reply => {
    const { current } = await setup(kind, () => reply as never)
    const before = current()
    await expect(current().events.prepare(submit, context())).rejects.toThrow()
    expect(current()).toBe(before)
  })

  it('publishes partial failure state and contains structured field errors without implicit acknowledgement', async () => {
    const gate = vi.fn<MayflyUiActionHandler>()
    const { current } = await setup(kind, gate)
    gate.mockReturnValueOnce({ kind: 'failed', message: 'Credential write failed', node: changed, source: [{ resourceId: 'settings', revision: 'etag' }], feedback: { message: 'Partially saved', severity: 'warning', purpose: 'feedback', detail: 'The configuration was saved' } })
    expect((await current().events.prepare(submit, context())).publish()).toBe(true)
    expect(current()).toMatchObject({ node: changed, update: { reason: 'data' }, source: [{ resourceId: 'settings', revision: 'etag' }] })
    gate.mockReturnValueOnce({ kind: 'failed', message: 'Credential write failed', node: changed, source: [{ resourceId: 'settings', revision: 3 }], acceptedFields: [{ pagePath: [], formId: 'form', fieldId: 'name' }] })
    expect((await current().events.prepare(submit, context())).publish()).toBe(true)
    expect(current().update).toMatchObject({ reason: 'ack', acceptedFields: [{ fieldId: 'name' }] })
    gate.mockReturnValueOnce({ kind: 'failed', message: 'Retry failed', node: initial })
    expect((await current().events.prepare(submit, context())).publish()).toBe(true)
    expect(current().node).toEqual(initial)
    const before = current()
    gate.mockReturnValueOnce({ kind: 'invalid', errors: [{ pagePath: [], formId: 'form', fieldId: 'name', message: 'Invalid' }] })
    expect((await current().events.prepare(submit, context())).publish()).toBe(true)
    expect(current()).toBe(before)
    gate.mockReturnValueOnce({ kind: 'cancelled' })
    expect((await current().events.prepare(submit, context())).publish()).toBe(true)
    gate.mockReturnValueOnce({ kind: 'completed' })
    expect((await current().events.prepare(activate, context())).publish()).toBe(true)
    expect(current()).toBe(before)
  })

  it('suppresses actions replaced before handler entry and revokes reports made during cancellation', async () => {
    const handler = vi.fn<MayflyUiActionHandler>()
    const { current, handle } = await setup(kind, handler)
    const pending = current().events.prepare(submit, context())
    handle.set(changed, { reason: 'replace' })
    expect((await pending).publish()).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    const controller = new AbortController()
    const supplied = context(controller.signal)
    handler.mockImplementationOnce((_event, ctx) => {
      controller.abort()
      ctx.report({ message: 'No longer active', severity: 'info' })
      return { kind: 'cancelled' }
    })
    await current().events.prepare(submit, supplied)
    expect(supplied.report).not.toHaveBeenCalled()
  })

  it('rejects invalid snapshot updates atomically and cannot accept caller-manufactured acknowledgements', async () => {
    const { current, handle } = await setup(kind)
    const before = current()
    for (const update of [
      null, [], { eventRevision: 1 }, { reason: 'ack', operationId: 'fake' }, { reason: 'unknown' },
      { scope: { kind: 'app', targetId: 'other' } }, { reason: 'replace', scope: { kind: 'unknown' } },
      { source: null }, { source: [{ resourceId: 'x', revision: -1 }] },
      { source: [{ resourceId: 'x', revision: '' }] }, { source: [{ resourceId: 'Bad ID', revision: 1 }] },
      { source: [null] }, { source: [{ resourceId: 1, revision: 1 }] }, { source: [{ resourceId: 'x', revision: NaN }] },
      { source: [{ resourceId: 'x', revision: 1 }, { resourceId: 'x', revision: 2 }] },
      { reason: 'replace', scope: { kind: 'app' } }, { reason: 'replace', scope: { kind: 'app', targetId: '' } },
      { reason: 'replace', scope: { kind: 'session' } }, { reason: 'replace', scope: { kind: 'session', sessionId: '' } },
      { reason: 'replace', scope: { kind: 'panel', parent: null } },
      { reason: 'replace', scope: { kind: 'panel', parent: {} } },
      { reason: 'replace', scope: { kind: 'panel', parent: { kind: 'status', id: 'x' } } },
      { reason: 'replace', scope: { kind: 'panel', parent: { kind: 'overlay' } } },
      { reason: 'replace', scope: { kind: 'panel', parent: { kind: 'overlay', id: 'Bad ID' } } },
    ]) expect(() => handle.set(changed, update as never)).toThrow()
    expect(current()).toBe(before)
    handle.set(changed, { reason: 'replace', scope: { kind: 'panel', parent: { kind: 'overlay', id: 'parent' } } })
    expect(current().scope).toEqual({ kind: 'panel', parent: { kind: 'overlay', id: 'parent' } })
  })
})

it('settles editor extension actions with decorations through their own registration', async () => {
  const ctx = new Context()
  const owner = await ctx.plugin({ name: 'extension-provider', apply })
  cleanups.push(() => owner.dispose())
  ctx.mayflyEditorExtensions.register({ id: 'config', source, scope: { kind: 'app', targetId: 'extension' }, onEvent: { action: () => ({ kind: 'accepted', node: { hint: 'updated' }, source: [] }) } })
  const reply = await ctx.mayflyEditorExtensions.list()[0]!.events.prepare(activate, context())
  expect(reply.publish()).toBe(true)
  expect(ctx.mayflyEditorExtensions.list()[0]).toMatchObject({ decoration: { hint: 'updated' }, update: { reason: 'ack', draftRevision: 8 } })
  const events = new UiEventEndpoint('disposable', undefined, () => {})
  events.dispose()
  events.dispose()
})
