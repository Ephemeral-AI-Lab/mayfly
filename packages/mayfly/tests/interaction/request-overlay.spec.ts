/** Native result admission, retry, and cancellation races over real UI registrations.
 * @module @ephemeral-ai/mayfly/tests/interaction/request-overlay
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiEventContext, type MayflyUiNode } from '../../../ui/src/index.ts'
import { requestOverlay } from '../../src/interaction/request-overlay.ts'
import { requestFixture, flushRequests } from './request-fixture.ts'
import * as uiProvider from '../../../ui/src/provider.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }
const node = ui.actions({ id: 'actions', items: [{ id: 'accept', label: 'Accept' }, { id: 'other', label: 'Other' }] })
const context = (signal = new AbortController().signal): MayflyUiEventContext => ({ surfaceId: 'request', revision: 0, source: [{ resourceId: 'request', revision: 1 }], operationId: 'native-result', signal, report: vi.fn() })
const silentSignal = (state: { aborted: boolean }) => ({
  get aborted() { return state.aborted },
  addEventListener() {}, removeEventListener() {}, throwIfAborted() { if (state.aborted) throw new Error('aborted') },
}) as unknown as AbortSignal

describe('request overlay lifecycle', () => {
  it('does not mount pre-aborted or stale requests', async () => {
    const bench = await setup()
    const signal = AbortSignal.abort()
    const cancelled = vi.fn((reason: string) => reason)
    const first = requestOverlay(bench.ctx, { id: 'request', title: 'Request', signal, view: () => node, answer: () => 'yes', cancelled })
    await expect(first.result).resolves.toBe('abort')
    first.cancel()
    const second = requestOverlay(bench.ctx, { id: 'request', title: 'Request', agent: bench.other, view: () => node, answer: () => 'yes', cancelled })
    await expect(second.result).resolves.toBe('stale')
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
    expect(cancelled).toHaveBeenCalledTimes(2)
  })

  it('admits one result among competing decisions and fences late callback references', async () => {
    const bench = await setup()
    const accepted = vi.fn()
    const request = requestOverlay(bench.ctx, { id: 'request', title: 'Request', view: () => node, answer: event => event.kind === 'activate' ? event.actionId : undefined, accepted, cancelled: reason => reason })
    const entry = bench.ctx.mayflyOverlays.list()[0]!
    const model = bench.model('request')
    model.invoke('accept')
    model.invoke('other')
    await expect(request.result).resolves.toBe('accept')
    expect(accepted).toHaveBeenCalledOnce()
    const event = { kind: 'activate' as const, pagePath: [], controlId: 'accept', actionId: 'accept' }
    expect(await entry.definition.onEvent!.action!(event, context())).toEqual({ kind: 'cancelled' })
    expect((await entry.events.prepare(event, context())).publish()).toBe(false)
    request.cancel()
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('releases a failed admission and accepts a corrected retry without an earlier native settlement', async () => {
    const bench = await setup()
    let invalid = false
    const accepted = vi.fn()
    const request = requestOverlay(bench.ctx, {
      id: 'request', title: 'Request', view: () => invalid ? { kind: 'unsupported' } as unknown as MayflyUiNode : node,
      answer: () => 'answer', accepted, cancelled: reason => reason,
    })
    const model = bench.model('request')
    invalid = true
    model.invoke('accept')
    await flushRequests()
    expect(accepted).not.toHaveBeenCalled()
    expect(model.feedbackSnapshot()).not.toEqual([])
    expect(model.disposed).toBe(false)
    invalid = false
    model.invoke('accept')
    await expect(request.result).resolves.toBe('answer')
    expect(accepted).toHaveBeenCalledOnce()
  })

  it('withdraws prepared results when the native request aborts or its registration disappears', async () => {
    const bench = await setup()
    const abort = new AbortController()
    const accepted = vi.fn()
    const request = requestOverlay(bench.ctx, { id: 'request', title: 'Request', signal: abort.signal, view: () => node, answer: () => 'yes', accepted, cancelled: reason => reason })
    const entry = bench.ctx.mayflyOverlays.list()[0]!
    const prepared = await entry.events.prepare({ kind: 'activate', pagePath: [], controlId: 'accept', actionId: 'accept' }, context())
    abort.abort()
    await expect(request.result).resolves.toBe('abort')
    expect(prepared.publish()).toBe(false)
    const second = requestOverlay(bench.ctx, { id: 'request', title: 'Request', view: () => node, answer: () => 'yes', accepted, cancelled: reason => reason })
    bench.ctx.mayflyOverlays.close('request')
    await expect(second.result).resolves.toBe('unload')
    expect(accepted).not.toHaveBeenCalled()
  })

  it.each(['abort', 'agent'] as const)('rechecks native authority after closing UI triggers %s', async mode => {
    const bench = await setup()
    const abort = new AbortController()
    const accepted = vi.fn()
    bench.ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind !== 'remove' || delta.id !== 'request') return
      if (mode === 'abort') abort.abort()
      else bench.ctx.mayflyCurrentAgent.select(bench.other)
    })
    const request = requestOverlay(bench.ctx, { id: 'request', title: 'Request', agent: bench.agent, signal: abort.signal, view: () => node, answer: () => 'yes', accepted, cancelled: reason => reason })
    bench.model('request').invoke('accept')
    await expect(request.result).resolves.toBe(mode === 'abort' ? 'abort' : 'stale')
    expect(accepted).not.toHaveBeenCalled()
  })

  it('contains native settlement exceptions and continues subsequent requests', async () => {
    const bench = await setup()
    const request = requestOverlay(bench.ctx, { id: 'request', title: 'Request', view: () => node, answer: () => 'yes', accepted: () => { throw new Error('native write failed') }, cancelled: reason => reason })
    bench.model('request').invoke('accept')
    await expect(request.result).rejects.toThrow('native write failed')
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('supports dynamic titles, explicit dismissal policy, ignored actions, and dismiss settlement', async () => {
    const bench = await setup()
    const request = requestOverlay(bench.ctx, {
      id: 'request', title: () => 'Dynamic request', dismissal: 'discard', view: () => node,
      answer: () => undefined, cancelled: reason => reason,
    })
    const entry = bench.ctx.mayflyOverlays.list()[0]!
    expect(entry.definition).toMatchObject({ dismissal: 'discard' })
    expect(JSON.stringify(entry.node)).toContain('Dynamic request')
    const action = entry.definition.onEvent!.action!
    expect(await action({ kind: 'activate', pagePath: [], controlId: 'other', actionId: 'other' }, context())).toEqual({ kind: 'completed' })
    expect(await action({ kind: 'dismiss', pagePath: [] }, context())).toEqual({ kind: 'cancelled' })
    await expect(request.result).resolves.toBe('dismiss')
    expect(await action({ kind: 'dismiss', pagePath: [] }, context())).toEqual({ kind: 'cancelled' })
  })

  it('rejects an action when native Agent authority changed without a notification', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(uiProvider)
    const agent = { id: 'agent' } as never
    const other = { id: 'other' } as never
    let reads = 0
    ctx.provide('mayflyCurrentAgent', {
      current: () => ++reads === 1 ? agent : other,
      subscribe: () => () => {},
    } as never)
    const cancelled = vi.fn((reason: string) => reason)
    const request = requestOverlay(ctx, { id: 'request', title: 'Request', agent, view: () => node, answer: () => 'yes', cancelled })
    const entry = ctx.mayflyOverlays.list()[0]!
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'accept', actionId: 'accept' }, context())).toEqual({ kind: 'cancelled' })
    await expect(request.result).resolves.toBe('stale')
  })

  it('settles stale when the selected Agent changes while idle', async () => {
    const bench = await setup()
    const request = requestOverlay(bench.ctx, { id: 'request', title: 'Request', agent: bench.agent, view: () => node, answer: () => 'yes', cancelled: reason => reason })
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    await expect(request.result).resolves.toBe('stale')
  })

  it('rechecks a silently aborted native signal before handling an action', async () => {
    const bench = await setup()
    const state = { aborted: false }
    const request = requestOverlay(bench.ctx, { id: 'request', title: 'Request', signal: silentSignal(state), view: () => node, answer: () => 'yes', cancelled: reason => reason })
    const entry = bench.ctx.mayflyOverlays.list()[0]!
    state.aborted = true
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'accept', actionId: 'accept' }, context())).toEqual({ kind: 'cancelled' })
    await expect(request.result).resolves.toBe('abort')
  })

  it.each(['abort', 'stale'] as const)('rechecks %s authority before ack settlement', async mode => {
    const bench = await setup()
    const state = { aborted: false }
    let current = bench.agent
    vi.spyOn(bench.ctx.mayflyCurrentAgent, 'current').mockImplementation(() => current)
    bench.ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind !== 'upsert' || delta.entry.update.reason !== 'ack') return
      if (mode === 'abort') state.aborted = true
      else current = bench.other
    })
    const request = requestOverlay(bench.ctx, {
      id: 'request', title: 'Request', agent: bench.agent, signal: silentSignal(state), view: () => node,
      answer: () => 'yes', cancelled: reason => reason,
    })
    bench.model('request').invoke('accept')
    await expect(request.result).resolves.toBe(mode)
  })

  it('classifies removal as abort when an earlier registry listener aborts first', async () => {
    const bench = await setup()
    const state = { aborted: false }
    bench.ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'remove' && delta.id === 'request') state.aborted = true })
    const request = requestOverlay(bench.ctx, { id: 'request', title: 'Request', signal: silentSignal(state), view: () => node, answer: () => 'yes', cancelled: reason => reason })
    bench.ctx.mayflyOverlays.close('request')
    await expect(request.result).resolves.toBe('abort')
  })
})
