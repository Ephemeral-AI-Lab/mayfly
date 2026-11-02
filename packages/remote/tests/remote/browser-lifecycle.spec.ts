import { describe, expect, it, vi } from 'vitest'
import type { RemoteFeatureContext } from '../../src/remote/features/contracts.ts'
import { openRemoteBrowser, type RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
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
    expect(test.handle.close).toHaveBeenCalledOnce()
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
