import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as Frontend from '@ephemeral-ai/mayfly/frontend'
import * as MayflyUiProvider from '@ephemeral-ai/mayfly-ui/provider'
import { RemoteNotifications, type RemoteNotificationPresentation } from '../../src/remote/notifications.ts'

const disposers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.useRealTimers()
})

async function fixture() {
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  await ctx.plugin(MayflyUiProvider)
  await ctx.plugin(Frontend)
  let presentation: RemoteNotificationPresentation = { sessionId: 'one' }
  const notifications = new RemoteNotifications(ctx, () => presentation)
  disposers.push(() => { notifications.dispose() })
  const node = () => JSON.stringify(ctx.mayflyPanes.list().find(entry => entry.id === 'mayfly.pane.notification')?.node ?? null)
  return { ctx, notifications, node, present(next: RemoteNotificationPresentation) { presentation = next; notifications.refresh() } }
}

describe('Remote notification row', () => {
  it('keeps the exact reference idle hint, scopes notices to the displayed Session, and hides behind panels', async () => {
    const test = await fixture()
    expect(test.node()).toContain('Alt+↑ conversation · Alt+↓ view')
    const other = test.ctx.mayflyUiInteraction.createNotificationOwner('other')
    other.report('notice', { kind: 'session', sessionId: 'two' }, { severity: 'error', message: 'another session' })
    const visible = test.ctx.mayflyUiInteraction.createNotificationOwner('visible')
    visible.report('notice', { kind: 'session', sessionId: 'one' }, { severity: 'warning', message: 'retrying · 1/5', tail: '1/5' })
    test.notifications.notice.set('low priority')
    test.notifications.refresh()
    expect(test.node()).toContain('retrying')
    expect(test.node()).toContain('+1')
    expect(test.node()).not.toContain('another session')
    test.present({ sessionId: 'two' })
    expect(test.node()).toContain('another session')
    test.ctx.emit('mayfly/panel-open-changed', true)
    expect(test.node()).toBe('null')
    test.ctx.emit('mayfly/panel-open-changed', false)
    expect(test.node()).toContain('another session')
    visible.dispose()
    other.dispose()
  })

  it('rotates running hints, respects quiet hints, and stops all clock and event work after disposal', async () => {
    const test = await fixture()
    vi.useFakeTimers()
    test.present({ running: true })
    vi.advanceTimersByTime(15_000)
    expect(test.node()).toContain('Ctrl+Enter steer · Esc interrupt')
    test.present({ running: true, quietHints: 'off' })
    expect(test.node()).toContain('Alt+↑ conversation · Alt+↓ view')
    test.present({ running: false })
    expect(vi.getTimerCount()).toBe(0)
    test.present({ running: true })
    test.notifications.dispose()
    test.notifications.dispose()
    expect(vi.getTimerCount()).toBe(0)
    test.ctx.emit('mayfly/prompt-wait-changed', 'late')
    test.notifications.notice.set('late')
    test.notifications.refresh()
    expect(test.node()).toBe('null')
    expect(test.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })

  it('follows prompt history, token, wait, tail, side toggle, locale, and conversation cursor modes', async () => {
    const test = await fixture()
    test.ctx.emit('mayfly/prompt-hint-changed', 'Ctrl+G opens · Backspace removes')
    expect(test.node()).toContain('Ctrl+G opens')
    test.ctx.emit('mayfly/prompt-recall-changed', { index: 2, total: 4 })
    expect(test.node()).toContain('↑ history 2/4')
    test.ctx.emit('mayfly/prompt-wait-changed', 'Reading the clipboard…')
    test.ctx.emit('mayfly/content-tail-changed', 'Back to bottom · Ctrl+↓')
    expect(test.node()).toContain('Reading the clipboard…')
    expect(test.node()).toContain('Back to bottom')
    test.ctx.emit('mayfly/prompt-wait-changed', undefined)
    test.ctx.emit('mayfly/prompt-recall-changed', undefined)
    test.ctx.emit('mayfly/prompt-hint-changed', undefined)
    test.present({ toggle: 'F7 btw · F8 close' })
    expect(test.node()).toContain('F7 btw · F8 close')
    expect(test.node()).not.toContain('Alt+↑ conversation')
    test.ctx.emit('mayfly/content-tail-changed', undefined)
    test.ctx.emit('mayfly/focus-mode-changed', 'conversation')
    expect(test.node()).toContain('Esc back')
    test.ctx.emit('mayfly/focus-row-changed', 'queued')
    expect(test.node()).toContain('s send now')
    test.ctx.emit('mayfly/focus-row-changed', 'steering')
    expect(test.node()).not.toContain('s send now')
    test.ctx.emit('mayfly/focus-mode-changed', 'search-select')
    expect(test.node()).toContain('Esc end search')
    test.ctx.emit('mayfly/focus-mode-changed', 'prompt')
    test.present({})
    test.ctx.mayflyLocale.setPreference('zh')
    await vi.waitFor(() => { expect(test.node()).toContain('Alt+↑ 选对话 · Alt+↓ 选视图') })
  })
})
