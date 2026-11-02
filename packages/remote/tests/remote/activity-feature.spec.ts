/** Projection-derived activity, exact shared row height, and native decision presentation. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { compileMayflyUiNode, visibleWidth } from '@ephemeral-ai/mayfly/core'
import { ActivityRow } from '@ephemeral-ai/mayfly/editor-presentation'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { mountActivityFeature } from '../../src/remote/features/activity.ts'
import { approvalFixture, flushApproval } from './approval-feature-fixture.ts'
import { plain } from './render-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); vi.useRealTimers() })
async function fixture(initial?: Readonly<Record<string, unknown>>, conversation?: unknown) {
  const f = await approvalFixture()
  if (initial !== undefined) f.facts.set(initial)
  if (conversation !== undefined) f.conversation.set(conversation)
  const dispose = mountActivityFeature(f.options)
  cleanups.push(async () => { dispose(); await f.cleanup() })
  const node = (): MayflyUiNode | null => f.ctx.mayflyPanes.list().find(pane => pane.id === 'mayfly.pane.activity')?.node ?? null
  const rows = (width = 80): string[] => {
    const value = node()
    if (value === null) return []
    const compiled = compileMayflyUiNode(value, { components: f.options.components, colors: f.options.colors, getViewport: () => ({ columns: width, rows: 24 }), screenMode: 'alternate', emit: () => {} })
    if (!compiled.ok) throw new Error(compiled.message)
    return plain(compiled.value.component.render(width))
  }
  const active = (turn = 1, extra: Readonly<Record<string, unknown>> = {}) => f.facts.set({ active: true, phase: 'tool', turn, flowDownChars: 0, inFlight: [{ callId: 'probe', name: 'ParityProbe' }], ...extra })
  const idle = (turn = 1) => f.facts.set({ active: false, phase: 'idle', turn, flowDownChars: 0, inFlight: [] })
  return { ...f, node, rows, active, idle, disposeActivity: dispose }
}

describe('Remote shared activity and approval waiting', () => {
  it('publishes the exact shared three-row tool model, retaining its teaching tip without a detail', async () => {
    const f = await fixture(); f.active()
    expect(f.node()).toEqual(ActivityRow({ phase: 'tool', label: 'Calling tools', tail: [], tip: 'Tip: Esc to interrupt the turn' }))
    expect(f.rows()).toHaveLength(3)
    expect(f.rows()[1]).toContain('Calling tools')
    expect(f.rows()[2]).toContain('Esc to interrupt the turn')
    f.idle()
    expect(f.node()).toBeNull()
    expect(f.rows()).toEqual([])
  })
  it.each([1, 8, 20, 39, 40, 80, 120])('preserves exactly three activity rows at width %s', async width => {
    const f = await fixture(); f.active(1, { inFlight: [{ callId: 'long', name: 'Bash', detail: 'A very long native tool detail: 你好 '.repeat(20) }] })
    const rows = f.rows(width)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => visibleWidth(row) <= width)).toBe(true)
  })
  it('presents the real native approval wait and restores tool activity when the request ends', async () => {
    const f = await fixture(); f.active()
    const pending = f.request({ reason: 'Approve the actual call' })
    expect(f.rows()[1]).toContain('Waiting for your approval')
    expect(f.rows()[1]).toContain('0s')
    expect(f.rows()[2]).toContain('Tip: Esc to interrupt the turn')
    f.model().requestClose(); await expect(pending).resolves.toBe('rejected')
    expect(f.rows()[1]).toContain('Calling tools')
    f.idle(); expect(f.rows()).toEqual([])
  })
  it('advances the common weighted rotation on a new turn and never rotates while idle', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const f = await fixture()
    f.active(); expect(f.rows()[2]).toContain('Esc to interrupt the turn')
    f.idle(); await vi.advanceTimersByTimeAsync(60_000)
    f.active(2)
    expect(f.rows()[2]).toContain('Ctrl+O to expand tool details')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.rows()[2]).not.toContain('Ctrl+O to expand tool details')
  })
  it('anchors elapsed time to native waiting, independent of the whole-turn clock', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000)
    const f = await fixture(); f.active(1, { turnStartedAt: 0 })
    const pending = f.request()
    expect(f.rows()[1]).toContain('approval · 0s')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.rows()[1]).toContain('approval · 2s')
    f.model().requestClose(); await pending
    vi.setSystemTime(20_000)
    const next = f.request()
    expect(f.rows()[1]).toContain('approval · 0s')
    f.model().requestClose(); await next
  })
  it('prefers current tool argument details while preparing tools retain the shared tip', async () => {
    const f = await fixture()
    f.active(1, { inFlight: [{ callId: 'real', name: 'Bash', detail: 'printf safe' }] })
    expect(f.rows()[2]).toContain('printf safe')
    expect(f.rows()[2]).not.toContain('Tip:')
    f.active(1, { inFlight: [{ callId: 'real', name: 'Bash', detail: 'not yet executing', preparing: true }] })
    expect(f.rows()[2]).toContain('Tip: Esc to interrupt the turn')
    expect(f.rows()[2]).not.toContain('not yet executing')
  })
  it('keeps waiting visible above a decision and hides activity beneath an ordinary panel', async () => {
    const f = await fixture(); f.active()
    f.ctx.emit('mayfly/editor-slot-swapped', true)
    expect(f.rows()).toEqual([])
    const pending = f.request()
    expect(f.rows()[1]).toContain('Waiting for your approval')
    f.model().requestClose(); await pending
    expect(f.rows()).toEqual([])
    f.ctx.emit('mayfly/editor-slot-swapped', false)
    expect(f.rows()[1]).toContain('Calling tools')
  })
  it('follows native user-question projection while selecting the localized approval label', async () => {
    const f = await fixture()
    f.questions.set({ active: [{ callId: 'native-question' }] })
    expect(f.rows()[1]).toContain('Waiting for your answer')
    f.questions.set({ active: [] }); expect(f.rows()).toEqual([])
    f.locale('zh')
    const pending = f.request()
    expect(f.rows()[1]).toContain('等待你的批准')
    f.model().requestClose(); await pending
  })
  it.each([1, 3])('reports native resumed history once for %s completed turns', async turn => {
    const f = await fixture({ active: false, phase: 'idle', turn, flowDownChars: 0, inFlight: [] })
    const notices = () => f.ctx.mayflyUiInteraction.notificationSnapshot().filter(record => record.message.startsWith('Resumed session'))
    expect(notices()).toHaveLength(1)
    expect(notices()[0]?.message).toBe(`Resumed session · ${String(turn)} ${turn === 1 ? 'turn' : 'turns'}`)
    f.reconnect()
    expect(notices()).toHaveLength(0)
    f.reconnect(); expect(notices()).toHaveLength(0)
  })
  it('never announces a fresh Session again when the person returns to its completed history', async () => {
    const f = await fixture({ active: false, phase: 'idle', turn: 0, flowDownChars: 0, inFlight: [] })
    f.active(1); f.idle(1)
    f.deselect(); f.selectSession(SessionId('same-session'))
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot().some(record => record.message.startsWith('Resumed session'))).toBe(false)
  })
  it('records the first active binding without announcing it later and distinguishes the same SessionId on another Host', async () => {
    const f = await fixture({ active: true, phase: 'tool', turn: 1, flowDownChars: 0, inFlight: [] })
    const notices = () => f.ctx.mayflyUiInteraction.notificationSnapshot().filter(record => record.message.startsWith('Resumed session'))
    expect(notices()).toEqual([])
    f.idle(1); f.rebind()
    expect(notices()).toEqual([])
    f.switchHost()
    expect(notices()).toHaveLength(1)
    expect(notices()[0]?.message).toBe('Resumed session · 1 turn')
  })
  it('uses the shared last-active message from the native history completion timestamp', async () => {
    vi.useFakeTimers(); vi.setSystemTime(600_000)
    const f = await fixture({ active: false, phase: 'idle', turn: 3, endedAt: 300_000, flowDownChars: 0, inFlight: [] })
    const notice = f.ctx.mayflyUiInteraction.notificationSnapshot().find(record => record.message.startsWith('Resumed session'))
    expect(notice?.message).toBe('Resumed session · 3 turns · last active 5m ago')
  })
  it('can announce readonly native Conversation history when the optional Facts projection is unavailable', async () => {
    const f = await fixture(undefined, { entries: [], turns: [{ turn: 2, startedAt: 0, endedAt: 1, outcome: 'completed' }], streaming: false })
    const notice = f.ctx.mayflyUiInteraction.notificationSnapshot().find(record => record.message.startsWith('Resumed session'))
    expect(notice?.message).toBe('Resumed session · 2 turns')
  })
  it('uses native thinking timestamps, the escalation ladder, writing counters, and the Session running fallback', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000)
    const f = await fixture()
    f.active(1, { phase: 'thinking', inFlight: [], outputProgress: { startedAt: 1_000, chars: 80 } })
    expect(f.rows()[1]).toContain('Pondering')
    await vi.advanceTimersByTimeAsync(5_000); expect(f.rows()[1]).toContain('Mulling')
    await vi.advanceTimersByTimeAsync(10_000); expect(f.rows()[1]).toContain('DeepThinking')
    await vi.advanceTimersByTimeAsync(30_000); expect(f.rows()[1]).toContain('Fathoming')
    f.active(1, { phase: 'composing', inFlight: [], turnStartedAt: 1_000, flowDownChars: 200 })
    expect(f.rows()[1]).toContain('Writing')
    expect(f.rows()[1]).toContain('45s')
    expect(f.rows()[1]).toContain('↓50')
    f.active(1, { phase: 'thinking', inFlight: [], outputProgress: undefined })
    expect(f.rows()[1]).toContain('Pondering')
    await vi.advanceTimersByTimeAsync(1_000); expect(f.rows()[1]).toContain('1s')
    f.facts.set(undefined); f.session.set({ running: true })
    expect(f.rows()[1]).toContain('Deep diving')
    f.session.set({ running: false }); expect(f.rows()).toEqual([])
  })
  it('keeps current native Facts authoritative when Session.running arrives before a new turn', async () => {
    const f = await fixture(); f.active(1); f.idle(1)
    f.session.set({ running: true })
    expect(f.rows()).toEqual([])
    f.active(2)
    expect(f.rows()[2]).toContain('Ctrl+O to expand tool details')
    f.idle(2)
    expect(f.rows()).toEqual([])
  })
  it('matches the reference rotation across native approval cancellation and editor-slot release', async () => {
    const f = await fixture(); f.active(1)
    const rejected = f.request()
    f.ctx.emit('mayfly/editor-slot-swapped', true)
    expect(f.rows()[2]).toContain('Esc to interrupt the turn')
    // A user answer closes the occupied slot before settling the native request.
    f.ctx.emit('mayfly/editor-slot-swapped', false)
    f.model().requestClose(); await rejected
    f.idle(1); f.active(2)
    const cancellation = new AbortController()
    const aborted = f.request({ signal: cancellation.signal })
    f.ctx.emit('mayfly/editor-slot-swapped', true)
    expect(f.rows()[2]).toContain('Ctrl+O to expand tool details')
    cancellation.abort(); await expect(aborted).resolves.toBe('cancelled')
    // A native cancellation clears the wait before the renderer releases its slot.
    expect(f.rows()).toEqual([])
    f.ctx.emit('mayfly/editor-slot-swapped', false)
    expect(f.rows()[2]).toContain('/plugin to browse and install plugins')
    f.idle(2); f.active(3)
    expect(f.rows()[2]).toContain('! to run a shell command')
  })
  it('keeps the first thinking stage when a native timestamp is slightly ahead of the local clock', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000)
    const f = await fixture(); f.active(1, { phase: 'thinking', inFlight: [], outputProgress: { startedAt: 2_000, chars: 0 } })
    expect(f.rows()[1]).toContain('Pondering')
    expect(f.rows()[1]).toContain('0s')
  })
  it('ignores locale callbacks queued before the activity owner was unloaded', async () => {
    const f = await fixture(); f.active()
    const callbacks = [...f.localeListeners]
    f.disposeActivity()
    for (const callback of callbacks) callback()
    expect(f.ctx.mayflyPanes.list()).toEqual([])
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })
  it('bounds in-flight tool details, drops empty values, and summarizes additional calls', async () => {
    const f = await fixture()
    f.active(1, { inFlight: ['one', 'two', 'three', 'four', '', 'one'].map((detail, index) => ({ callId: String(index), name: index % 2 === 0 ? 'bash' : 'read', detail })) })
    expect(f.rows()[1]).toContain('Running 6 tools')
    expect(f.rows()[2]).toContain('one · two · three +1 more')
    expect(f.rows()[2]).not.toContain('four')
  })
  it.each([
    [{ status: 429, reason: 'temporary pressure' }, 'rate limited · temporary pressure · retrying in 4s · 1/3'],
    [{ status: 503, reason: '' }, 'HTTP 503 · retrying in 4s · 1/3'],
    [{}, 'retrying in 4s · 1/3'],
  ])('reports the native retry countdown %j and withdraws it on settlement', async (extra, expected) => {
    vi.useFakeTimers(); vi.setSystemTime(10_000)
    const f = await fixture()
    f.active(1, { retrying: { at: 10_000, delayMs: 4_000, retry: 1, maxRetries: 3, ...extra } })
    const retry = () => f.ctx.mayflyUiInteraction.notificationSnapshot().find(record => record.tail === '1/3')
    expect(retry()?.message).toBe(expected)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(retry()?.message).toContain('retrying in 3s')
    f.locale('zh'); expect(retry()?.message).toContain('3 秒后重试')
    f.active(1); expect(retry()).toBeUndefined()
  })
  it('raises native context warnings only at threshold escalation and resets below the threshold', async () => {
    const f = await fixture()
    const context = () => f.ctx.mayflyUiInteraction.notificationSnapshot().find(record => record.message.includes('Context'))
    f.pressure.set({ pressureTokens: 91, contextWindow: 100 }); expect(context()).toBeUndefined()
    f.pressure.set({ pressureTokens: 92, contextWindow: 100 }); expect(context()?.message).toContain('92% full')
    f.pressure.set({ projectedTokens: 94, pressureTokens: 99, contextWindow: 100 }); expect(context()?.message).toContain('92% full')
    f.pressure.set({ projectedTokens: 95, contextWindow: 100 }); expect(context()?.message).toContain('95% full')
    f.pressure.set({ projectedTokens: 98, contextWindow: 100 }); expect(context()?.message).toContain('98% full')
    f.pressure.set({ contextWindow: 100 }); expect(context()).toBeUndefined()
    f.pressure.set({ projectedTokens: 92 }); expect(context()).toBeUndefined()
    f.pressure.set({ projectedTokens: 92, contextWindow: 100 }); expect(context()?.message).toContain('92% full')
  })
  it('ignores a queued projection callback after a new connection generation retires it', async () => {
    const f = await fixture(); f.active()
    const stale = [...f.facts.listeners, ...f.conversation.listeners, ...f.session.listeners]
    f.deselect(); for (const callback of stale) callback()
    expect(f.rows()).toEqual([])
    expect(f.ctx.mayflyUiInteraction.notificationSnapshot()).toEqual([])
  })
  it('drops projection listeners and activity on detach, ignoring late native facts', async () => {
    const f = await fixture(); f.active()
    expect(f.facts.listeners.size).toBe(1)
    f.detach()
    expect(f.rows()).toEqual([])
    expect(f.facts.listeners.size).toBe(0)
    f.active(2); expect(f.rows()).toEqual([])
    f.disposeActivity(); f.disposeActivity()
    f.ctx.emit('mayfly/decision-wait-changed', { kind: 'approval' })
    await flushApproval()
    expect(f.ctx.mayflyPanes.list().some(pane => pane.id === 'mayfly.pane.activity')).toBe(false)
  })
})
