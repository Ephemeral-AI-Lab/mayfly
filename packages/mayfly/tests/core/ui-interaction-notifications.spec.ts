/** Structured notification ownership, visibility clocks, bounds, and cleanup.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-notifications
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { admitNotificationMessage, UiNotificationOwner, UiNotificationStore } from '../../src/core/ui-interaction-notifications.ts'
import { UiInteractionService } from '../../src/core/ui-interaction-state.ts'
import { createInteractionNotificationOwner, currentNotificationScope } from '../../src/interaction/notifications.ts'

const app = { kind: 'app' as const, targetId: 'test' }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('notification records', () => {
  it('admits bounded text and degrades invalid messages and details', () => {
    expect(admitNotificationMessage('message')).toBe('message')
    expect(() => admitNotificationMessage(42)).toThrow('UI feedback must be bounded text')
    const changed = vi.fn()
    const store = new UiNotificationStore(changed)
    store.report('invalid', { owner: 'owner', scope: app, operationId: 'operation' }, { severity: 'success', message: 42 as never })
    expect(store.get('invalid')).toMatchObject({
      owner: 'owner', operationId: 'operation', severity: 'error', message: 'The operation returned invalid feedback', visibleMs: 0,
    })
    store.report('invalid-detail', { owner: 'owner', scope: app }, { severity: 'info', message: 'valid', detail: 42 as never })
    expect(store.get('invalid-detail')).toMatchObject({ severity: 'error' })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(store.snapshot()).toHaveLength(2)
    store.setVisible(false)
  })

  it('accrues each visible interval once across reports, snapshots, and hiding', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const store = new UiNotificationStore(vi.fn())
    store.report('work', { owner: 'owner', scope: app }, { severity: 'warning', message: 'One' })
    await vi.advanceTimersByTimeAsync(1_000)
    store.report('work', { owner: 'owner', scope: app }, { severity: 'warning', message: 'Two' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.snapshot()[0]!.visibleMs).toBe(2_000)
    store.setVisible(false)
    expect(store.snapshot()[0]!.visibleMs).toBe(2_000)
  })

  it('restarts settled progress and pauses accumulated visibility while hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const changed = vi.fn()
    const store = new UiNotificationStore(changed)
    store.report('work', { owner: 'owner', scope: app }, { severity: 'info', purpose: 'progress', message: 'Working' })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(store.snapshot()[0]!.visibleMs).toBe(8_000)
    const settledAt = Date.now()
    store.report('work', { owner: 'owner', scope: app }, { severity: 'success', message: 'Finished', detail: 'details' })
    expect(store.snapshot()[0]).toMatchObject({ createdAt: settledAt, visibleMs: 0, detail: 'details' })
    store.setVisible(false)
    store.setVisible(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.snapshot()[0]!.visibleMs).toBe(0)
    store.report('work', { owner: 'owner', scope: app }, { severity: 'info', message: 'Updated' })
    expect(store.snapshot()[0]!.visibleMs).toBe(0)
    store.setVisible(true)
    store.setVisible(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.get('work')).toBeUndefined()
  })

  it('retains critical and progress records and expires success and info records', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const store = new UiNotificationStore(vi.fn())
    store.report('warning', { owner: 'owner', scope: app }, { severity: 'warning', message: 'Warning' })
    store.report('error', { owner: 'owner', scope: app }, { severity: 'error', message: 'Error' })
    store.report('progress', { owner: 'owner', scope: app }, { severity: 'info', purpose: 'progress', message: 'Progress' })
    store.report('success', { owner: 'owner', scope: app }, { severity: 'success', message: 'Success' })
    store.report('info', { owner: 'owner', scope: app }, { severity: 'info', message: 'Info' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.snapshot().map(record => record.id)).toEqual(['warning', 'error', 'progress'])
  })

  it('ignores a stale timer callback after the record is replaced', () => {
    const callbacks: (() => void)[] = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callbacks.push(callback); return callbacks.length as never }) as never)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    const store = new UiNotificationStore(vi.fn())
    store.report('same', { owner: 'owner', scope: app }, { severity: 'success', message: 'First' })
    store.report('same', { owner: 'owner', scope: app }, { severity: 'success', message: 'Second' })
    callbacks[0]!()
    expect(store.get('same')?.message).toBe('Second')
    callbacks[1]!()
    expect(store.get('same')).toBeUndefined()
  })

  it('trims handled and ordinary records while retaining critical capacity', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const store = new UiNotificationStore(vi.fn())
    for (let index = 0; index < 63; index += 1) {
      store.report(`critical-${index}`, { owner: 'owner', scope: app }, { severity: index % 2 === 0 ? 'warning' : 'error', message: String(index) })
    }
    store.report('handled', { owner: 'owner', scope: app }, { severity: 'error', message: 'Handled' })
    store.handle('handled')
    store.report('first', { owner: 'owner', scope: app }, { severity: 'info', message: 'First' })
    expect(store.snapshot()).toHaveLength(64)
    expect(store.get('handled')).toBeUndefined()
    expect(store.get('first')).toBeDefined()

    store.report('progress-a', { owner: 'owner', scope: app }, { severity: 'info', purpose: 'progress', message: 'A' })
    store.report('progress-b', { owner: 'owner', scope: app }, { severity: 'info', purpose: 'progress', message: 'B' })
    expect(store.snapshot()).toHaveLength(65)
  })

  it('clears, handles, and disposes records idempotently', () => {
    const changed = vi.fn()
    const store = new UiNotificationStore(changed)
    store.clear('missing')
    store.report('one', { owner: 'one', scope: app }, { severity: 'error', message: 'One' })
    store.report('two', { owner: 'two', scope: app }, { severity: 'success', message: 'Two' })
    store.handle('missing')
    store.handle('one')
    store.handle('one')
    expect(store.get('one')?.state).toBe('handled')
    store.clear('two', false)
    store.clearOwner('missing')
    store.clearOwner('one')
    expect(store.snapshot()).toEqual([])
    store.report('timer', { owner: 'one', scope: app }, { severity: 'success', message: 'Timer' })
    store.dispose()
    store.dispose()
    store.setVisible(false)
    store.report('late', { owner: 'one', scope: app }, { severity: 'info', message: 'Late' })
    expect(store.snapshot()).toEqual([])
  })
})

describe('notification owners', () => {
  it('scopes ids and retires only its own records', () => {
    const store = new UiNotificationStore(vi.fn())
    const first = new UiNotificationOwner('first', store)
    const second = new UiNotificationOwner('second', store)
    first.report('one', app, { severity: 'error', message: 'One' })
    second.report('two', app, { severity: 'warning', message: 'Two' }, 'operation')
    first.handle('one')
    expect(store.get('first/one')).toMatchObject({ state: 'handled' })
    first.clear('one')
    first.report('again', app, { severity: 'info', message: 'Again' })
    first.clearAll()
    first.dispose()
    first.dispose()
    first.clearAll()
    first.report('late', app, { severity: 'info', message: 'Late' })
    expect(store.snapshot().map(record => record.id)).toEqual(['second/two'])
    second.dispose()
  })

  it('binds an interaction owner to its Cordis Fiber and supports all helpers', async () => {
    const ctx = new Context()
    const interaction = new UiInteractionService(ctx)
    expect(currentNotificationScope(ctx, 'application')).toEqual({ kind: 'app', targetId: 'application' })
    ctx.provide('mayflyCurrentAgent', { current: () => ({ id: 'session' }) } as never)
    expect(currentNotificationScope(ctx, 'application')).toEqual({ kind: 'session', sessionId: 'session' })
    const owner = createInteractionNotificationOwner(ctx, 'producer', 'application')
    owner.report('one', { severity: 'info', message: 'One' })
    owner.clear('one')
    owner.report('two', { severity: 'error', message: 'Two' }, app, 'explicit')
    owner.clearAll()
    expect(interaction.notificationSnapshot()).toEqual([])
    await ctx.fiber.dispose()
    interaction.dispose()

    const absent = new Context()
    const unavailable = createInteractionNotificationOwner(absent, 'absent')
    unavailable.report('one', { severity: 'info', message: 'One' })
    unavailable.clear('one')
    unavailable.clearAll()
    await absent.fiber.dispose()
  })
})
