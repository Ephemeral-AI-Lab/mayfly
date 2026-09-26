/** Turn header and process-title rows: labels, counts, clocks, and title holds.
 * @module @ephemeral-ai/mayfly/tests/transcript/process-rows
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflySemanticColors } from '../../src/core/index.ts'
import {
  PROCESS_TITLE_MINIMUM_MS,
  ProcessTitleComponent,
  setProcessRowTimers,
  TURN_CLOCK_INTERVAL_MS,
  TurnHeaderComponent,
  type ProcessRowTimers,
} from '../../src/transcript/process-rows.ts'
import type { ProcessTitleItem, TurnHeaderItem } from '../../src/transcript/process-groups.ts'
import { summarizeProcess } from '../../src/transcript/process-activity.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { COLORS } from './status-fakes.ts'

const colors = COLORS as MayflySemanticColors

class FakeRowTimers implements ProcessRowTimers {
  current = 0
  readonly intervals: { callback: () => void, ms: number }[] = []
  readonly timeouts: { callback: () => void, ms: number }[] = []
  clearedIntervals = 0
  clearedTimeouts = 0
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> {
    this.intervals.push({ callback, ms })
    return this.intervals.length as unknown as ReturnType<typeof setInterval>
  }
  clearInterval(): void { this.clearedIntervals += 1 }
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    this.timeouts.push({ callback, ms })
    return this.timeouts.length as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout(): void { this.clearedTimeouts += 1 }
  now(): number { return this.current }
}

afterEach(() => setProcessRowTimers(undefined))

const header = (overrides: Partial<TurnHeaderItem> = {}): TurnHeaderItem => ({
  kind: 'turn-header', id: 'h', turn: 1, seq: 1, running: false, toolCalls: 0, subagents: 0, folded: false, hint: false, ...overrides,
})

describe('TurnHeaderComponent', () => {
  it('labels closed turns by outcome with counts and the Ctrl-O hint', () => {
    const component = new TurnHeaderComponent(colors, fakeMayflyComponents(), () => {})
    expect(component.render(80)).toEqual([])
    component.update(header({ startedAt: 0, endedAt: 65_000, outcome: 'completed', toolCalls: 1, subagents: 1, folded: true, hint: true }))
    expect(component.render(80)).toEqual(['', '▸ Took 1m 5s · 1 tool call · 1 subagent · ctrl+o to expand'])
    component.update(header({ toolCalls: 3, subagents: 2 }))
    expect(component.render(80)[1]).toBe('▾ Worked · 3 tool calls · 2 subagents')
    component.update(header({ outcome: 'aborted' }))
    expect(component.render(80)[1]).toBe('▾ Stopped')
    component.update(header({ outcome: 'forked' }))
    expect(component.render(80)[1]).toBe('▾ Stopped')
    component.update(header({ outcome: 'error' }))
    expect(component.render(80)[1]).toBe('▾ Failed')
    component.invalidate()
    const narrow = component.render(4)
    expect(narrow).toHaveLength(2)
    expect(visibleWidth(narrow[1]!)).toBeLessThanOrEqual(4)
    component.dispose()
  })

  it('ticks a running clock each second and retires it when the turn closes', () => {
    const timers = new FakeRowTimers()
    setProcessRowTimers(timers)
    const ticks: number[] = []
    const component = new TurnHeaderComponent(colors, fakeMayflyComponents(), () => ticks.push(1))
    // Without a start time the running label is untimed and no clock starts.
    component.update(header({ running: true }))
    expect(component.render(80)[1]).toBe('▾ Deep diving...')
    expect(timers.intervals).toHaveLength(0)
    timers.current = 12_000
    // A running header carries no counts: the bottom dock owns live progress.
    component.update(header({ running: true, startedAt: 0, toolCalls: 2, subagents: 1 }))
    component.update(header({ running: true, startedAt: 0, toolCalls: 2, subagents: 1 }))
    expect(timers.intervals).toEqual([expect.objectContaining({ ms: TURN_CLOCK_INTERVAL_MS })])
    expect(component.render(80)[1]).toBe('▾ Deep diving for 12s')
    timers.intervals[0]!.callback()
    expect(ticks).toHaveLength(1)
    timers.current = 13_000
    expect(component.render(80)[1]).toBe('▾ Deep diving for 13s')
    component.update(header({ startedAt: 0, endedAt: 14_000, toolCalls: 2, subagents: 1 }))
    expect(component.render(80)[1]).toBe('▾ Took 14s · 2 tool calls · 1 subagent')
    expect(timers.clearedIntervals).toBe(1)
    component.dispose()
    expect(timers.clearedIntervals).toBe(1)
  })
})

describe('ProcessTitleComponent', () => {
  const title = (overrides: Partial<ProcessTitleItem>): ProcessTitleItem => ({
    kind: 'process-title', id: 'p', turn: 1, seq: 1, closed: false, liveDetail: true,
    summary: summarizeProcess([{ activity: 'commands', running: true, detail: 'pnpm test' }]), ...overrides,
  })

  it('renders closed and failed groups at once', () => {
    const component = new ProcessTitleComponent(colors, fakeMayflyComponents(), () => {})
    expect(component.render(80)).toEqual([])
    component.update(title({ closed: true, summary: summarizeProcess([{ activity: 'read', running: false, detail: 'a', failed: true }]) }))
    expect(component.render(80)).toEqual(['', '▸ Read files · 1 failed'])
    expect(component.render(80)).toBe(component.render(80))
    component.invalidate()
    expect(component.render(80)).toEqual(['', '▸ Read files · 1 failed'])
  })

  it('holds a running title for the minimum time before showing the next one', () => {
    const timers = new FakeRowTimers()
    setProcessRowTimers(timers)
    const ticks: number[] = []
    const component = new ProcessTitleComponent(colors, fakeMayflyComponents(), () => ticks.push(1))
    component.update(title({}))
    expect(component.render(80)[1]).toBe('▸ Running commands · pnpm test')
    timers.current = 50
    component.update(title({ summary: summarizeProcess([{ activity: 'read', running: true, detail: 'a.ts' }]) }))
    // Too soon: the previous title stays and one commit is scheduled.
    expect(component.render(80)[1]).toBe('▸ Running commands · pnpm test')
    component.render(81)
    expect(timers.timeouts).toEqual([expect.objectContaining({ ms: PROCESS_TITLE_MINIMUM_MS - 50 })])
    timers.current = PROCESS_TITLE_MINIMUM_MS
    timers.timeouts[0]!.callback()
    expect(ticks).toHaveLength(1)
    expect(component.render(80)[1]).toBe('▸ Reading files · a.ts')
    // Past the minimum the next title commits immediately.
    timers.current = 1_000
    component.update(title({ summary: summarizeProcess([{ activity: 'edit', running: true, detail: 'b.ts' }]) }))
    expect(component.render(80)[1]).toBe('▸ Editing files · b.ts')
    // A pending hold is cancelled on dispose.
    timers.current = 1_010
    component.update(title({ summary: summarizeProcess([{ activity: 'code', running: true, detail: 'x' }]) }))
    component.render(80)
    component.dispose()
    expect(timers.clearedTimeouts).toBeGreaterThan(0)
  })

  it('uses the default timers', () => {
    vi.useFakeTimers()
    try {
      const ticks: number[] = []
      const component = new ProcessTitleComponent(colors, fakeMayflyComponents(), () => ticks.push(1))
      component.update(title({}))
      component.render(80)
      component.update(title({ summary: summarizeProcess([{ activity: 'read', running: true, detail: 'a' }]) }))
      component.render(80)
      vi.advanceTimersByTime(PROCESS_TITLE_MINIMUM_MS)
      expect(ticks).toHaveLength(1)
      // A hold still pending when the row retires is cancelled.
      component.update(title({ summary: summarizeProcess([{ activity: 'edit', running: true, detail: 'b' }]) }))
      component.render(80)
      component.update(title({ summary: summarizeProcess([{ activity: 'code', running: true, detail: 'c' }]) }))
      component.render(80)
      component.dispose()
      vi.advanceTimersByTime(PROCESS_TITLE_MINIMUM_MS)
      expect(ticks).toHaveLength(1)
      const clock = new TurnHeaderComponent(colors, fakeMayflyComponents(), () => ticks.push(2))
      clock.update(header({ running: true, startedAt: Date.now() }))
      vi.advanceTimersByTime(TURN_CLOCK_INTERVAL_MS)
      expect(ticks).toEqual([1, 2])
      clock.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
