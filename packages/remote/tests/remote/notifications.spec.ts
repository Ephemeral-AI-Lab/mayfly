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
  it('preserves extension feedback independently and clears it on exact Host/Session retirement', async () => {
    const test = await fixture()
    test.notifications.report('definition', { severity: 'error', message: 'Extension failed', detail: 'full diagnostic detail', tail: 'retry' })
    test.notifications.notice.set('separate command')
    expect(test.ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({
      scope: { kind: 'session', sessionId: 'one' }, message: 'Extension failed', detail: 'full diagnostic detail', tail: 'retry',
    }))
    test.notifications.notice.set('')
    expect(test.node()).toContain('Extension failed')
    const activity = test.ctx.mayflyUiInteraction.createNotificationOwner('activity')
    activity.report('native', { kind: 'session', sessionId: 'one' }, { severity: 'info', message: 'Native activity' })
    test.notifications.clear()
    expect(test.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([
      expect.objectContaining({ message: 'Native activity' }),
    ])
    activity.dispose()
    test.notifications.report('definition', { severity: 'error', message: 'Extension failed again' })
    test.present({ hostKey: 'other', sessionId: 'one' })
    expect(test.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
    test.present({})
    test.notifications.report('action', { severity: 'success', message: 'Action completed' })
    expect(test.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([
      expect.objectContaining({ scope: { kind: 'app', targetId: 'prompt' }, severity: 'success', message: 'Action completed' }),
    ])
    test.notifications.dispose()
    test.notifications.report('late', { severity: 'error', message: 'Retired callback' })
    test.notifications.clear()
    expect(test.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })

  it('keeps multiline command detail in an app notice before a Session is selected', async () => {
    const test = await fixture()
    test.present({})
    test.notifications.notice.set('First line\n  second line\r\nthird line', 'error')
    expect(test.node()).toContain('First line · second line · third line')
    expect(test.ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({
      scope: { kind: 'app', targetId: 'prompt' }, severity: 'error',
      message: 'First line · second line · third line', detail: 'First line\n  second line\nthird line',
    }))
    test.notifications.notice.set('Could not copy', 'error', 'complete native clipboard failure')
    expect(test.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([expect.objectContaining({
      severity: 'error', message: 'Could not copy', detail: 'complete native clipboard failure',
    })])
  })

  it('shows the newest equal-severity notice even when an older record was inserted later', async () => {
    const test = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    const owner = test.ctx.mayflyUiInteraction.createNotificationOwner('chronology')
    try {
      vi.setSystemTime(2000)
      owner.report('new', { kind: 'app', targetId: 'test' }, { severity: 'warning', message: 'newest warning' })
      vi.setSystemTime(1000)
      owner.report('old', { kind: 'app', targetId: 'test' }, { severity: 'warning', message: 'older warning' })
      expect(test.node()).toContain('newest warning')
      expect(test.node()).not.toContain('older warning')
      expect(test.node()).toContain('+1')
    } finally { owner.dispose() }
  })

  it.each(['view', 'search'] as const)('leaves %s hints to the focused surface while preserving notices', async mode => {
    const test = await fixture()
    test.notifications.notice.set('Surface owns its keys')
    test.ctx.emit('mayfly/focus-mode-changed', mode)
    expect(test.node()).toContain('Surface owns its keys')
    expect(test.node()).not.toContain('Esc back')
    expect(test.node()).not.toContain('Esc end search')
    expect(test.node()).not.toContain('Alt+↑ conversation')
  })
  it('renders success feedback and clears only its own command notice while retaining session activity', async () => {
    const test = await fixture()
    const activity = test.ctx.mayflyUiInteraction.createNotificationOwner('activity')
    activity.report('activity', { kind: 'session', sessionId: 'one' }, { severity: 'info', message: 'Session resumed' })
    test.notifications.notice.set('Switched to pro (deepseek) · thinking high', 'success')
    expect(test.node()).toContain('Switched to pro')
    expect(test.ctx.mayflyUiInteraction.notificationSnapshot()).toContainEqual(expect.objectContaining({ severity: 'success' }))
    test.notifications.notice.set('')
    expect(test.node()).not.toContain('Switched to pro')
    expect(test.node()).toContain('Session resumed')
    activity.dispose()
  })

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
