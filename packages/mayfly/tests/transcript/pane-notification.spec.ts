/**
 * Decision tests of the notification pane: which record the row shows (the most severe, then the newest, of the app
 * and the current session, with the count waiting behind it), that the pane republishes only when the row changes,
 * the chip and the keys and hint it carries from the content tail and the focus mode, and that unloading its Fiber
 * takes the row away.
 * @module transcript-pane-notification
 */

import { describe, expect, it } from 'vitest'
import type { MayflyFeedbackRecord } from '@ephemeral-ai/mayfly-ui'
import { mountNotificationPane, selectNotification } from '../../src/transcript/pane-notification.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'
import { bootPanePlugin, type PanePluginHarness } from './pane-fakes.ts'
import { fakeAgent, type FakeAgent } from './status-fakes.ts'

/** A lane record, as the lane keeps it: the scope, the severity, the message, and the creation time. */
function record(severity: MayflyFeedbackRecord['severity'], message: string, createdAt: number, scope: MayflyFeedbackRecord['scope'] = { kind: 'app', targetId: 'test' }): MayflyFeedbackRecord {
  return { id: `${message}/${String(createdAt)}`, owner: 'owner', scope, operationId: message, severity, message, createdAt, visibleMs: 0 } as unknown as MayflyFeedbackRecord
}

const session = (sessionId: string): MayflyFeedbackRecord['scope'] => ({ kind: 'session', sessionId } as MayflyFeedbackRecord['scope'])

describe('selectNotification', () => {
  it('shows nothing when the lane holds nothing for the app or the current session', () => {
    expect(selectNotification([], 'a')).toBeUndefined()
    expect(selectNotification([record('error', 'elsewhere', 1, session('b'))], 'a')).toBeUndefined()
  })

  it('shows the most severe record, then the newest, and counts the rest waiting behind it', () => {
    const records = [
      record('info', 'resumed', 1),
      record('warning', 'rate limited', 2),
      record('warning', 'context full', 3),
      record('success', 'saved', 4),
    ]
    expect(selectNotification(records, 'a')).toEqual({ severity: 'warning', message: 'context full', waiting: 3 })
    expect(selectNotification([record('info', 'only', 1)], 'a')).toEqual({ severity: 'info', message: 'only' })
  })

  it('reads the records of the app and of the current session only', () => {
    const records = [
      record('error', 'other session', 5, session('b')),
      record('info', 'this session', 1, session('a')),
      record('success', 'the app', 2),
    ]
    // The app's success outranks the session's info; the other session's error is not in the row at all.
    expect(selectNotification(records, 'a')).toEqual({ severity: 'success', message: 'the app', waiting: 1 })
    // With no current Agent, only the app's records show.
    expect(selectNotification(records, undefined)).toEqual({ severity: 'success', message: 'the app' })
  })
})

/** A lane the test drives: its records, and the listeners that hear each change. */
class HandLane {
  records: MayflyFeedbackRecord[] = []
  private readonly listeners = new Set<() => void>()
  notificationSnapshot(): readonly MayflyFeedbackRecord[] { return this.records }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(records: MayflyFeedbackRecord[]): void {
    this.records = records
    for (const listener of this.listeners) listener()
  }
}

async function boot(current: FakeAgent | null = fakeAgent([]), lane = new HandLane()): Promise<PanePluginHarness & { readonly lane: HandLane }> {
  const harness = await bootPanePlugin({
    name: 'pane-notification-under-test',
    inject: [],
    apply(ctx) {
      mountNotificationPane(ctx, transcriptTranslatorFake)
    },
  }, current, { mayflyUiInteraction: lane })
  return { ...harness, lane }
}

/** The node the pane publishes, as JSON, so a spec reads its texts without its shape. */
const nodeOf = (harness: PanePluginHarness): string => JSON.stringify(harness.ctx.mayflyPanes.list().find(entry => entry.id === 'mayfly.pane.notification')?.node ?? null)

describe('mayfly-pane-notification', () => {
  it('mounts one bottom row that teaches the focus keys while nothing needs reading', async () => {
    const harness = await boot()
    expect(harness.ctx.mayflyPanes.list().filter(entry => entry.id === 'mayfly.pane.notification')).toHaveLength(1)
    expect(harness.screen.paneLines().join('\n')).toContain('Alt+↑ conversation · Alt+↓ bar')
    await harness.dispose()
  })

  it('shows the lane notice for the current Agent, and the keys that leave the prompt when there is none', async () => {
    const current = fakeAgent([])
    const harness = await boot(current)
    expect(nodeOf(harness)).toContain('Alt+↑ conversation · Alt+↓ bar')
    harness.lane.set([record('warning', 'Context 93% full', 1)])
    expect(nodeOf(harness)).toContain('Context 93% full')
    expect(nodeOf(harness)).not.toContain('Alt+↑ conversation')
    await harness.dispose()
  })

  it('republishes only when the row it shows changes', async () => {
    const harness = await boot()
    let republished = 0
    // The registry replays its current entries to a new listener, so the count starts after that replay.
    const off = harness.ctx.mayflyPanes.subscribe(() => { republished += 1 })
    const start = republished
    harness.lane.set([record('info', 'elsewhere', 1, session('other'))])
    expect(republished).toBe(start)
    harness.lane.set([record('info', 'saved', 2)])
    expect(republished).toBe(start + 1)
    harness.lane.set([record('info', 'saved', 2), record('info', 'elsewhere', 1, session('other'))])
    expect(republished).toBe(start + 1)
    off()
    await harness.dispose()
  })

  it('carries the chip back to the stream from the content tail, centered, and drops it again', async () => {
    const harness = await boot()
    harness.ctx.emit('mayfly/content-tail-changed', 'Back to bottom · Ctrl+↓')
    expect(nodeOf(harness)).toContain('Back to bottom · Ctrl+↓')
    harness.ctx.emit('mayfly/content-tail-changed', undefined)
    expect(nodeOf(harness)).not.toContain('Back to bottom')
    await harness.dispose()
  })

  it('teaches the keys of a focus mode in the notice place, and the hint only at the prompt', async () => {
    const harness = await boot()
    harness.ctx.emit('mayfly/focus-mode-changed', 'conversation')
    expect(nodeOf(harness)).toContain('Enter expand · c copy · Ctrl+C JSON · Ctrl+G editor · ↑/↓ select · / ? search · Esc back')
    harness.ctx.emit('mayfly/focus-mode-changed', 'search-select')
    expect(nodeOf(harness)).toContain('Enter expand · c copy · Ctrl+C JSON · ↑/↓ or n/N match · / ? new search · Esc end search')
    harness.ctx.emit('mayfly/focus-mode-changed', 'prompt')
    expect(nodeOf(harness)).toContain('Alt+↑ conversation · Alt+↓ bar')
    await harness.dispose()
  })

  it('shows only the app records when no Agent is current, and the bar and search modes teach no keys', async () => {
    const harness = await boot(null, new HandLane())
    harness.lane.set([record('info', 'this session', 1, session('a')), record('success', 'the app', 2)])
    expect(nodeOf(harness)).toContain('the app')
    expect(nodeOf(harness)).not.toContain('this session')
    harness.ctx.emit('mayfly/focus-mode-changed', 'bar')
    expect(nodeOf(harness)).not.toContain('Alt+↑ conversation')
    expect(nodeOf(harness)).not.toContain('Enter expand')
    harness.ctx.emit('mayfly/focus-mode-changed', 'search')
    expect(nodeOf(harness)).not.toContain('Enter expand')
    await harness.dispose()
  })

  it('keeps the row and its focus keys when the editor has no lane to read', async () => {
    const harness = await bootPanePlugin({
      name: 'pane-notification-without-lane',
      inject: [],
      apply(ctx) {
        mountNotificationPane(ctx, transcriptTranslatorFake)
      },
    }, fakeAgent([]), {})
    expect(nodeOf(harness)).toContain('Alt+↑ conversation · Alt+↓ bar')
    await harness.dispose()
  })

  it('takes its row away when its Fiber unloads', async () => {
    const harness = await boot()
    expect(harness.ctx.mayflyPanes.list().some(entry => entry.id === 'mayfly.pane.notification')).toBe(true)
    await harness.dispose()
    expect(harness.ctx.mayflyPanes.list().some(entry => entry.id === 'mayfly.pane.notification')).toBe(false)
  })
})
