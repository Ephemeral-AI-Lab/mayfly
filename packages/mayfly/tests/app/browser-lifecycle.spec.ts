import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Provider from '@ephemeral-ai/mayfly-ui/provider'
import type { RemoteFeatureContext } from '../../src/app/features/contracts.ts'
import { openRemoteBrowser, type RemoteBrowserOptions } from '../../src/app/panels/browser.ts'
function fixture() {
  let registry: (delta: { kind: string, id: string }) => void = () => {}
  let locale: () => void = () => {}
  let revision = 1
  let current = true
  const effects = new Set<() => void>()
  const handle = { closed: false, set: vi.fn(), close: vi.fn(() => { handle.closed = true; registry({ kind: 'remove', id: 'test' }) }) }
  const offRegistry = vi.fn(), offLocale = vi.fn()
  const ctx = {
    mayflyOverlays: {
      open: vi.fn((_options: unknown, _node: unknown) => handle),
      subscribe: vi.fn((listener: typeof registry) => { registry = listener; return offRegistry }),
    },
    effect: vi.fn((effect: () => () => void) => { const off = effect(); effects.add(off); return off }),
  }
  const context = { ctx, subscribeLocale: vi.fn((listener: () => void) => { locale = listener; return offLocale }) } as unknown as RemoteFeatureContext
  const abort = new AbortController()
  const action = vi.fn(async () => ({ kind: 'completed' as const }))
  const observe = vi.fn(), closed = vi.fn(), back = vi.fn(() => false)
  const options: RemoteBrowserOptions = { id: 'test', scope: { kind: 'app', targetId: 'test' }, signal: abort.signal, isCurrent: () => current, source: () => [{ resourceId: 'settings/test', revision }], dismissal: 'confirm-dirty', view: () => ({ kind: 'text', content: String(revision) }), action, observe, onClosed: closed, back }
  const panel = openRemoteBrowser(context, options)
  const callbacks = () => ctx.mayflyOverlays.open.mock.calls[0]![0] as { source: unknown, dismissal: unknown, onEvent: { observe(event: unknown): void, action(event: unknown, context: unknown): Promise<unknown> } }
  const act = (event: unknown, signal = new AbortController().signal) => callbacks().onEvent.action(event, { signal })
  return { panel, options, handle, closed, action, observe, abort, offRegistry, offLocale, callbacks, act, locale: () => locale(), setRevision: (next: number) => { revision = next }, retire: () => { current = false }, emit: (kind: string, id: string) => registry({ kind, id }), back, effects }
}

describe('generation-owned wire browser', () => {
  it('carries dynamic native sources and dirty-form policy into initial and refreshed snapshots', () => {
    const test = fixture()
    expect(test.callbacks()).toMatchObject({ source: [{ resourceId: 'settings/test', revision: 1 }], dismissal: 'confirm-dirty' })
    test.setRevision(2)
    test.panel.refresh()
    expect(test.handle.set).toHaveBeenCalledWith({ kind: 'text', content: '2' }, { source: [{ resourceId: 'settings/test', revision: 2 }] })
    test.locale()
    expect(test.handle.set).toHaveBeenCalledTimes(2)
    test.panel.close()
    expect(test.offRegistry).toHaveBeenCalledOnce()
    expect(test.offLocale).toHaveBeenCalledOnce()
    expect(test.closed).toHaveBeenCalledOnce()
    test.panel.refresh(); test.panel.close(); test.abort.abort()
    test.emit('remove', 'test')
    expect(test.handle.close).toHaveBeenCalledOnce()
  })

  it('completes an optional action without inventing a mutation and closes an already removed handle', async () => {
    const test = fixture()
    delete (test.options as { action?: RemoteBrowserOptions['action'] }).action
    expect(await test.act({ kind: 'activate' })).toEqual({ kind: 'completed' })
    // A native registry removal may have been queued before its callback reaches this owner.
    test.handle.closed = true
    test.panel.refresh()
    test.panel.close()
    expect(test.handle.close).not.toHaveBeenCalled()
    expect(test.closed).toHaveBeenCalledOnce()
    test.emit('remove', 'test')
    for (const cleanup of test.effects) cleanup()
    expect(test.closed).toHaveBeenCalledOnce()
  })

  it('forwards live actions and observations, leaves a back layer first, and drops retired actions', async () => {
    const test = fixture()
    test.callbacks().onEvent.observe({ kind: 'tab-change' })
    expect(test.observe).toHaveBeenCalledOnce()
    expect(await test.act({ kind: 'activate' })).toEqual({ kind: 'completed' })
    test.back.mockReturnValueOnce(true)
    expect(await test.act({ kind: 'dismiss' })).toEqual({ kind: 'completed', dismiss: false })
    expect(test.panel.closed).toBe(false)
    test.retire()
    test.callbacks().onEvent.observe({ kind: 'tab-change' })
    expect(test.observe).toHaveBeenCalledOnce()
    expect(await test.act({ kind: 'activate' })).toEqual({ kind: 'cancelled', dismiss: true })
    test.panel.refresh()
    expect(test.handle.set).not.toHaveBeenCalled()
    test.abort.abort()
    expect(test.panel.closed).toBe(true)
  })

  it('closes exactly once on dismissal and ignores unrelated registry removals or aborted actions', async () => {
    const test = fixture()
    test.emit('remove', 'other')
    test.emit('update', 'test')
    expect(test.panel.closed).toBe(false)
    const abort = new AbortController(); abort.abort()
    expect(await test.act({ kind: 'activate' }, abort.signal)).toEqual({ kind: 'cancelled', dismiss: true })
    expect(test.action).not.toHaveBeenCalled()
    expect(await test.act({ kind: 'dismiss' })).toEqual({ kind: 'completed' })
    expect(test.panel.closed).toBe(true)
    expect(await test.act({ kind: 'activate' })).toEqual({ kind: 'cancelled', dismiss: true })
    expect(test.closed).toHaveBeenCalledOnce()
  })
})

describe('browser mount cancellation through the actual overlay provider', () => {
  async function context() {
    const ctx = new Context()
    await ctx.plugin(Provider)
    return ctx
  }

  it('never opens or subscribes for an already aborted caller', async () => {
    const ctx = await context()
    const abort = new AbortController()
    abort.abort()
    const view = vi.fn(() => ({ kind: 'text' as const, content: 'closed' }))
    const subscribeLocale = vi.fn(() => () => {})
    const closed = vi.fn()
    try {
      const panel = openRemoteBrowser({ ctx, subscribeLocale }, { id: 'pre-aborted', scope: { kind: 'app', targetId: 'test' }, signal: abort.signal, isCurrent: () => true, view, onClosed: closed })
      expect(panel.closed).toBe(true)
      panel.close()
      panel.refresh()
      expect(view).not.toHaveBeenCalled()
      expect(subscribeLocale).not.toHaveBeenCalled()
      expect(ctx.mayflyOverlays.list()).toEqual([])
      expect(closed).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
    expect(closed).toHaveBeenCalledOnce()
  })

  it.each(['remove', 'abort'] as const)('retires a panel closed synchronously during provider publication: %s', async reason => {
    const ctx = await context()
    const abort = new AbortController()
    const closed = vi.fn()
    const subscribeLocale = vi.fn(() => () => {})
    const off = ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind !== 'upsert') return
      if (reason === 'remove') ctx.mayflyOverlays.close(delta.entry.id)
      else abort.abort()
    })
    try {
      const panel = openRemoteBrowser({ ctx, subscribeLocale }, { id: 'mount-close', scope: { kind: 'app', targetId: 'test' }, signal: abort.signal, isCurrent: () => true, view: () => ({ kind: 'text', content: 'mount' }), onClosed: closed })
      expect(panel.closed).toBe(true)
      expect(ctx.mayflyOverlays.list()).toEqual([])
      expect(subscribeLocale).not.toHaveBeenCalled()
      expect(closed).toHaveBeenCalledOnce()
    } finally { off(); await ctx.fiber.dispose() }
    expect(closed).toHaveBeenCalledOnce()
  })

  it('releases a locale lease acquired while its immediate snapshot closes the panel', async () => {
    const ctx = await context()
    const abort = new AbortController()
    const closed = vi.fn()
    const offLocale = vi.fn()
    let views = 0
    const subscribeLocale = (refresh: () => void) => { refresh(); return offLocale }
    try {
      const panel = openRemoteBrowser({ ctx, subscribeLocale }, {
        id: 'locale-close', scope: { kind: 'app', targetId: 'test' }, signal: abort.signal, isCurrent: () => true,
        view: () => { if (++views === 2) abort.abort(); return { kind: 'text', content: 'locale snapshot' } },
        onClosed: closed,
      })
      expect(views).toBe(2)
      expect(panel.closed).toBe(true)
      expect(ctx.mayflyOverlays.list()).toEqual([])
      expect(offLocale).toHaveBeenCalledOnce()
      expect(closed).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
    expect(closed).toHaveBeenCalledOnce()
  })
})
