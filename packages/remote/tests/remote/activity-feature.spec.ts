/** Projection-derived activity, exact shared row height, and native decision presentation. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileMayflyUiNode, visibleWidth } from '@ephemeral-ai/mayfly/core'
import { ActivityRow } from '@ephemeral-ai/mayfly/editor-presentation'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { mountActivityFeature } from '../../src/remote/features/activity.ts'
import { approvalFixture, flushApproval } from './approval-feature-fixture.ts'
import { plain } from './render-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose(); vi.useRealTimers() })
async function fixture() {
  const f = await approvalFixture()
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
    f.ctx.emit('mayfly/panel-open-changed', true)
    expect(f.rows()).toEqual([])
    const pending = f.request()
    expect(f.rows()[1]).toContain('Waiting for your approval')
    f.model().requestClose(); await pending
    expect(f.rows()).toEqual([])
    f.ctx.emit('mayfly/panel-open-changed', false)
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
