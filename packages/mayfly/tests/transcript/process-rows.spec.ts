/** Turn header and process-title rows: labels, counts, the opt-in running clock, and static titles.
 * @module @ephemeral-ai/mayfly/tests/transcript/process-rows
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflySemanticColors } from '../../src/core/index.ts'
import {
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
  clearedIntervals = 0
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> {
    this.intervals.push({ callback, ms })
    return this.intervals.length as unknown as ReturnType<typeof setInterval>
  }
  clearInterval(): void { this.clearedIntervals += 1 }
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

  it('runs and retires the clock on the default timers', () => {
    vi.useFakeTimers()
    try {
      const ticks: number[] = []
      const component = new TurnHeaderComponent(colors, fakeMayflyComponents(), () => ticks.push(1))
      component.update(header({ running: true, startedAt: Date.now() }))
      vi.advanceTimersByTime(TURN_CLOCK_INTERVAL_MS)
      expect(ticks).toHaveLength(1)
      expect(component.render(80)[1]).toBe('▾ Deep diving for 1s')
      component.update(header({ startedAt: 0, endedAt: 1_000 }))
      vi.advanceTimersByTime(TURN_CLOCK_INTERVAL_MS * 3)
      expect(ticks).toHaveLength(1)
      component.dispose()
    } finally { vi.useRealTimers() }
  })
})

describe('ProcessTitleComponent', () => {
  const title = (overrides: Partial<ProcessTitleItem>): ProcessTitleItem => ({
    kind: 'process-title', id: 'p', turn: 1, seq: 1,
    summary: summarizeProcess([{ activity: 'commands', running: false }]), ...overrides,
  })

  it('renders a static past-tense title with its failures', () => {
    const component = new ProcessTitleComponent(colors, fakeMayflyComponents())
    expect(component.render(80)).toEqual([])
    component.update(title({ summary: summarizeProcess([{ activity: 'read', running: false, failed: true }, { activity: 'search', running: false }]) }))
    expect(component.render(80)).toEqual(['', '▸ Read files and searched code · 1 failed'])
    expect(component.render(80)).toBe(component.render(80))
    component.invalidate()
    expect(component.render(80)).toEqual(['', '▸ Read files and searched code · 1 failed'])
    // A newer summary replaces the title at once: nothing holds or ticks.
    component.update(title({}))
    expect(component.render(80)).toEqual(['', '▸ Ran commands'])
    for (const width of [1, 5, 12]) {
      for (const row of component.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
    }
  })

  it('drives the opt-in running header from the default timers', () => {
    vi.useFakeTimers()
    try {
      const ticks: number[] = []
      const clock = new TurnHeaderComponent(colors, fakeMayflyComponents(), () => ticks.push(2))
      clock.update(header({ running: true, startedAt: Date.now() }))
      vi.advanceTimersByTime(TURN_CLOCK_INTERVAL_MS)
      expect(ticks).toEqual([2])
      clock.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
