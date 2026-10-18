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
import { bootPanePlugin, FakeConversations, type PanePluginHarness } from './pane-fakes.ts'
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

  it('carries the tail of the record it shows, so a narrow row can keep the countdown', () => {
    const waiting = { ...record('warning', 'Rate limited · retrying in 9s · 1/5', 2), tail: 'retrying in 9s · 1/5' } as MayflyFeedbackRecord
    expect(selectNotification([record('info', 'resumed', 1), waiting], 'a')).toEqual({ severity: 'warning', message: 'Rate limited · retrying in 9s · 1/5', tail: 'retrying in 9s · 1/5', waiting: 1 })
    expect(selectNotification([waiting], 'a')).not.toHaveProperty('waiting')
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

async function boot(current: FakeAgent | null = fakeAgent([]), lane = new HandLane(), conversations = new FakeConversations()): Promise<PanePluginHarness & { readonly lane: HandLane, readonly conversations: FakeConversations }> {
  const harness = await bootPanePlugin({
    name: 'pane-notification-under-test',
    inject: ['mayflyConversations'],
    apply(ctx) {
      mountNotificationPane(ctx, transcriptTranslatorFake)
    },
  }, current, { mayflyUiInteraction: lane, mayflyConversations: conversations })
  return { ...harness, lane, conversations }
}

/** The node the pane publishes, as JSON, so a spec reads its texts without its shape. */
/** The admitted children of the row, in order: their first span's text and their priority. */
const partsOf = (harness: PanePluginHarness): { text: string, priority: number }[] => {
  const found: { text: string, priority: number }[] = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const record = node as { children?: { priority?: number, node: { kind?: string, spans?: { text: string }[] } }[] }
    for (const child of record.children ?? []) {
      if (child.priority !== undefined && child.node.kind === 'rich-text') found.push({ text: child.node.spans![0]!.text, priority: child.priority })
      walk(child.node)
    }
  }
  walk(harness.ctx.mayflyPanes.list().find(entry => entry.id === 'mayfly.pane.notification')?.node)
  return found
}
const nodeOf = (harness: PanePluginHarness): string => JSON.stringify(harness.ctx.mayflyPanes.list().find(entry => entry.id === 'mayfly.pane.notification')?.node ?? null)

describe('mayfly-pane-notification', () => {
  it('mounts one bottom row that teaches the focus keys while nothing needs reading', async () => {
    const harness = await boot()
    expect(harness.ctx.mayflyPanes.list().filter(entry => entry.id === 'mayfly.pane.notification')).toHaveLength(1)
    expect(harness.screen.paneLines().join('\n')).toContain('Alt+↑ conversation · Alt+↓ view')
    await harness.dispose()
  })

  it('shows the lane notice for the current Agent, and the keys that leave the prompt when there is none', async () => {
    const current = fakeAgent([])
    const harness = await boot(current)
    expect(nodeOf(harness)).toContain('Alt+↑ conversation · Alt+↓ view')
    harness.lane.set([record('warning', 'Context 93% full', 1)])
    expect(nodeOf(harness)).toContain('Context 93% full')
    expect(nodeOf(harness)).not.toContain('Alt+↑ conversation')
    // A record with a tail hands it to the line, which keeps it whole on a narrow row.
    harness.lane.set([{ ...record('warning', 'Rate limited · retrying in 9s · 1/5', 2), tail: 'retrying in 9s · 1/5' } as MayflyFeedbackRecord])
    expect(partsOf(harness).map(part => part.text)).toEqual(['⚠', 'Rate limited', '· retrying in 9s · 1/5'])
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

  it('teaches the keys of a focus mode as parts the row sheds by priority, Esc the last to go', async () => {
    const harness = await boot()
    const keys = (): { text: string, priority: number }[] => partsOf(harness).map(part => ({ ...part, text: part.text.replace(/^· /u, '') }))
    harness.ctx.emit('mayfly/focus-mode-changed', 'conversation')
    expect(keys().map(part => part.text)).toEqual(['↑/↓ select', 'Enter expand', 'c copy', '/ ? search', 'Ctrl+G editor', 'Ctrl+C JSON', 'Esc back'])
    const rank = (parts: { text: string, priority: number }[]) => parts.toSorted((left, right) => left.priority - right.priority).map(part => part.text)
    expect(rank(keys())).toEqual(['Esc back', '↑/↓ select', 'Enter expand', '/ ? search', 'c copy', 'Ctrl+G editor', 'Ctrl+C JSON'])
    harness.ctx.emit('mayfly/focus-mode-changed', 'search-select')
    expect(keys().map(part => part.text)).toEqual(['↑/↓ or n/N match', 'Enter expand', 'c copy', '/ ? new search', 'Ctrl+C JSON', 'Esc end search'])
    expect(rank(keys())[0]).toBe('Esc end search')
    harness.ctx.emit('mayfly/focus-mode-changed', 'prompt')
    expect(nodeOf(harness)).toContain('Alt+↑ conversation · Alt+↓ view')
    await harness.dispose()
  })

  it('names the other conversation and the close key while a side conversation is open, in the notice place', async () => {
    const harness = await boot()
    expect(nodeOf(harness)).not.toContain('F7')
    harness.conversations.open('side', 'btw')
    // The displayed side conversation closes with F8; F7 returns to the main one.
    expect(nodeOf(harness)).toContain('F7 main · F8 close')
    expect(nodeOf(harness)).not.toContain('Alt+↑ conversation')
    harness.conversations.back()
    // On the main conversation F7 names the side one, and F8 acts on it.
    expect(nodeOf(harness)).toContain('F7 btw · F8 close')
    harness.conversations.close()
    harness.conversations.open('child', 'subagent')
    harness.conversations.back()
    expect(nodeOf(harness)).toContain('F7 subagent · F8 detach')
    // A notice follows the toggle; the focus modes leave the toggle out.
    harness.lane.set([record('info', 'saved', 1)])
    expect(nodeOf(harness)).toContain('F7 subagent · F8 detach')
    expect(nodeOf(harness)).toContain('saved')
    harness.ctx.emit('mayfly/focus-mode-changed', 'conversation')
    expect(nodeOf(harness)).not.toContain('F7')
    await harness.dispose()
  })

  it('shows only the app records when no Agent is current, and the view and search modes teach no keys', async () => {
    const harness = await boot(null, new HandLane())
    harness.lane.set([record('info', 'this session', 1, session('a')), record('success', 'the app', 2)])
    expect(nodeOf(harness)).toContain('the app')
    expect(nodeOf(harness)).not.toContain('this session')
    harness.ctx.emit('mayfly/focus-mode-changed', 'view')
    expect(nodeOf(harness)).not.toContain('Alt+↑ conversation')
    expect(nodeOf(harness)).not.toContain('Enter expand')
    harness.ctx.emit('mayfly/focus-mode-changed', 'search')
    expect(nodeOf(harness)).not.toContain('Enter expand')
    await harness.dispose()
  })

  it('keeps the row and its focus keys when the editor has no lane to read', async () => {
    const harness = await bootPanePlugin({
      name: 'pane-notification-without-lane',
      inject: ['mayflyConversations'],
      apply(ctx) {
        mountNotificationPane(ctx, transcriptTranslatorFake)
      },
    }, fakeAgent([]), { mayflyConversations: new FakeConversations() })
    expect(nodeOf(harness)).toContain('Alt+↑ conversation · Alt+↓ view')
    await harness.dispose()
  })

  it('takes its row away when its Fiber unloads', async () => {
    const harness = await boot()
    expect(harness.ctx.mayflyPanes.list().some(entry => entry.id === 'mayfly.pane.notification')).toBe(true)
    await harness.dispose()
    expect(harness.ctx.mayflyPanes.list().some(entry => entry.id === 'mayfly.pane.notification')).toBe(false)
  })
})

describe('mayfly-pane-notification: the prompt row while the prompt waits', () => {
  it('shows the history position in place of the hint while recalling, and what the prompt waits on; both clear again', async () => {
    const harness = await boot()
    harness.ctx.emit('mayfly/prompt-hint-changed', 'a hint of the prompt')
    expect(nodeOf(harness)).toContain('a hint of the prompt')
    harness.ctx.emit('mayfly/prompt-recall-changed', { index: 1, total: 3 })
    expect(nodeOf(harness)).toContain('↑ history 1/3')
    expect(nodeOf(harness)).not.toContain('a hint of the prompt')
    harness.ctx.emit('mayfly/prompt-recall-changed', undefined)
    expect(nodeOf(harness)).toContain('a hint of the prompt')
    harness.ctx.emit('mayfly/prompt-wait-changed', 'waiting on approval')
    expect(nodeOf(harness)).toContain('waiting on approval')
    harness.ctx.emit('mayfly/prompt-wait-changed', undefined)
    expect(nodeOf(harness)).not.toContain('waiting on approval')
    await harness.dispose()
  })

  it('shows a notice in place of the prompt wait, and the prompt wait again once the notice is gone', async () => {
    const harness = await boot(fakeAgent([]), new HandLane())
    harness.ctx.emit('mayfly/prompt-wait-changed', 'waiting on approval')
    harness.lane.set([record('info', 'saved', 1)])
    expect(nodeOf(harness)).toContain('saved')
    expect(nodeOf(harness)).not.toContain('waiting on approval')
    harness.lane.set([])
    expect(nodeOf(harness)).toContain('waiting on approval')
    await harness.dispose()
  })

  it('teaches the queued and steering rows their own verbs in conversation focus', async () => {
    const harness = await boot()
    const keys = (): string[] => partsOf(harness).map(part => part.text.replace(/^· /u, ''))
    harness.ctx.emit('mayfly/focus-mode-changed', 'conversation')
    harness.ctx.emit('mayfly/focus-row-changed', 'queued')
    expect(keys()).toEqual(['e edit', 's send now', 'd cancel', 'Enter expand', 'c copy', '↑/↓ select', 'Esc back'])
    harness.ctx.emit('mayfly/focus-row-changed', 'steering')
    expect(keys()).toEqual(['e edit', 'd cancel', 'Enter expand', 'c copy', '↑/↓ select', 'Esc back'])
    await harness.dispose()
  })

  it('stows the row while an editor panel is open and restores it when the panel closes', async () => {
    const harness = await boot()
    expect(nodeOf(harness)).not.toBe('null')
    harness.ctx.emit('mayfly/panel-open-changed', true)
    expect(nodeOf(harness)).toBe('null')
    harness.ctx.emit('mayfly/panel-open-changed', false)
    expect(nodeOf(harness)).toContain('Alt+↑ conversation')
    await harness.dispose()
  })
})
