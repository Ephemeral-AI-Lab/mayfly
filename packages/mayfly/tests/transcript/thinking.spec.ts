/**
 * The thinking block: the live `✻ Thinking` header over the reasoning tail
 * with its one-second refresh, the one-row settled form with its duration and
 * policy-gated preview, Ctrl-O expansion and scope-aware hints, the
 * blank-reasoning zero-row settle, and dispose discipline. Width behavior
 * asserts against pi-tui's own width helpers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setThinkingTimers,
  ThinkingComponent,
  THINKING_PREVIEW_LINES,
  THINKING_REFRESH_MS,
  type ThinkingTimers,
} from '../../src/transcript/thinking.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import { TRANSCRIPT_LOCALE } from '../../src/transcript/locale.ts'
import { STREAMING_RENDER_MAX_CHARS } from '../../src/transcript/components.ts'
import type { MayflySemanticColors } from '../../src/core/index.ts'
import type { TranscriptThinkingItem } from '../../src/transcript/types.ts'
import { fakeMayflyComponents } from './helpers.ts'

/** Identity colors: assertions see structure, not escape codes. */
const id = (text: string): string => text
const COLORS = {
  text: id, textStrong: id, muted: id, textMuted: id, accent: id, primary: id, border: id,
  borderFocus: id,
  success: id, error: id, warning: id, selectedBg: id, roleUser: id, shellMode: id,
  mdHeading: id, mdLink: id, mdLinkUrl: id, mdCode: id, mdCodeBlock: id,
  mdCodeBlockBorder: id, mdQuote: id, mdQuoteBorder: id, mdHr: id, mdListBullet: id,
  diffAdded: id, diffRemoved: id, diffAddedStrong: id, diffRemovedStrong: id,
  diffGutter: id, diffMeta: id,
}
// Structurally satisfies MayflySemanticColors; declared where consumed.

/** Tagged colors for role assertions. */
function tagged(): MayflySemanticColors {
  const tag = (letter: string) => (text: string): string => `[${letter}]${text}[/${letter}]`
  return {
    ...COLORS,
    muted: tag('M'),
    textMuted: tag('T'),
    primary: tag('P'),
  }
}

/** Fake timers recording interval creation/clearing; ticks run manually. */
class FakeTimers implements ThinkingTimers {
  readonly ticks: (() => void)[] = []
  cleared = 0

  readonly intervals: number[] = []

  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> {
    this.ticks.push(callback)
    this.intervals.push(ms)
    return this.ticks.length as unknown as ReturnType<typeof setInterval>
  }

  clearInterval(_handle: ReturnType<typeof setInterval>): void {
    this.cleared += 1
  }
}

afterEach(() => {
  setThinkingTimers(undefined)
})

function thinkingItem(partial: Partial<TranscriptThinkingItem> = {}): TranscriptThinkingItem {
  return { kind: 'thinking', seq: 1, turn: 1, step: 1, text: 'thought', streaming: false, ...partial }
}

/** Six wrap-separated words of reasoning; at width 6 each wraps alone. */
const SIX_WORDS = 'l0 l1 l2 l3 l4 l5'

describe('ThinkingComponent', () => {
  it('reuses wrapped reasoning across refresh ticks, but recomputes for text, width, and invalidation', () => {
    const timers = new FakeTimers()
    setThinkingTimers(timers)
    const components = fakeMayflyComponents()
    const wrap = vi.spyOn(components, 'wrapText')
    const item = thinkingItem({ text: 'thinking '.repeat(1_000), streaming: true })
    const component = new ThinkingComponent(item, COLORS, components)
    const first = component.render(80)
    for (let i = 0; i < 3; i += 1) {
      timers.ticks[0]!()
      expect(component.render(80).slice(2)).toEqual(first.slice(2))
    }
    expect(wrap).toHaveBeenCalledOnce()
    item.text += 'new thought'
    component.render(80)
    component.render(40)
    expect(wrap).toHaveBeenCalledTimes(3)
    item.streaming = false
    component.render(40)
    component.setExpanded(true)
    component.render(40)
    expect(wrap).toHaveBeenCalledTimes(3)
    component.invalidate()
    component.render(40)
    expect(wrap).toHaveBeenCalledTimes(4)
    component.dispose()
  })

  it('renders the live header with elapsed time over the reasoning\'s tail window', () => {
    const timers = new FakeTimers()
    setThinkingTimers(timers)
    const now = Date.now()
    const component = new ThinkingComponent(
      thinkingItem({ text: SIX_WORDS, streaming: true, startedAt: now - 6_500 }),
      tagged(),
      fakeMayflyComponents(),
    )
    expect(timers.intervals).toEqual([THINKING_REFRESH_MS])
    const wide = component.render(60)
    expect(wide[0]).toBe('')
    expect(wide[1]).toMatch(/^\[M\]✻ \[\/M\]\[M\]Thinking · [67]s\[\/M\]$/u)
    // The tail window keeps the last two wrapped words, italic-indented and width-safe.
    const narrow = new ThinkingComponent(thinkingItem({ text: SIX_WORDS, streaming: true }), COLORS, fakeMayflyComponents()).render(5)
    expect(narrow.slice(2)).toEqual(['  \x1b[3ml4\x1b[23m', '  \x1b[3ml5\x1b[23m'])
    // A tick nudges a redraw without animating a glyph.
    const renders: number[] = []
    new ThinkingComponent(thinkingItem({ text: 'x', streaming: true }), COLORS, fakeMayflyComponents(), () => { renders.push(1) })
    timers.ticks[2]!()
    expect(renders).toHaveLength(1)
  })

  it('settles into one row with its duration, previewing the first line when the policy allows', () => {
    const component = new ThinkingComponent(thinkingItem({ text: SIX_WORDS, durationMs: 4_200 }), tagged(), fakeMayflyComponents())
    expect(component.render(120)).toEqual(['', '[M]✻ [/M][M]Thought for 4s · [/M]\x1b[3m[M]l0 l1 l2 l3 l4 l5[/M]\x1b[23m[T] · ctrl+o to expand[/T]'])
    // Without a recorded span the duration reads as a while; sub-second spans round up.
    expect(new ThinkingComponent(thinkingItem({ text: 'x' }), COLORS, fakeMayflyComponents()).render(80)[1]).toBe('✻ Thought for a while · \x1b[3mx\x1b[23m · ctrl+o to expand')
    expect(new ThinkingComponent(thinkingItem({ text: 'x', durationMs: 200 }), COLORS, fakeMayflyComponents()).render(80)[1]).toContain('Thought for 1s')
    // Compact drops the preview; out of Ctrl-O's reach the hint goes.
    const bare = new ThinkingComponent(thinkingItem({ text: 'x', durationMs: 2_000 }), COLORS, fakeMayflyComponents(), undefined, () => false)
    expect(bare.render(80)).toEqual(['', '✻ Thought for 2s · ctrl+o to expand'])
    bare.setScope({ hint: false })
    expect(bare.render(80)).toEqual(['', '✻ Thought for 2s'])
    // A hint that would not fit whole is dropped rather than cut.
    expect(new ThinkingComponent(thinkingItem({ text: 'x', durationMs: 2_000 }), COLORS, fakeMayflyComponents(), undefined, () => false).render(20)).toEqual(['', '✻ Thought for 2s'])
    // Ctrl-O opens the complete body under the title.
    component.setExpanded(true)
    expect(component.render(40)).toEqual(['', '[M]✻ [/M][M]Thought for 4s[/M]', '  \x1b[3m[M]l0 l1 l2 l3 l4 l5[/M]\x1b[23m'])
  })

  it('localizes the header and settled title', () => {
    const t = (key: string, values?: Record<string, string | number>) => interpolateLocaleMessage(TRANSCRIPT_LOCALE.zh[key] ?? key, values)
    const live = new ThinkingComponent(thinkingItem({ text: 'x', streaming: true }), COLORS, fakeMayflyComponents(), undefined, () => true, t)
    expect(live.render(40)[1]).toBe('✻ 思考中')
    live.dispose()
    expect(new ThinkingComponent(thinkingItem({ text: 'x', durationMs: 3_000 }), COLORS, fakeMayflyComponents(), undefined, () => false, t).render(40)[1]).toBe('✻ 已思考 3s · 按 Ctrl-O 展开')
  })

  it('renders zero rows for a blank finalized block and a bare header for an empty live one', () => {
    expect(new ThinkingComponent(thinkingItem({ text: '' }), tagged(), fakeMayflyComponents()).render(40)).toEqual([])
    const empty = new ThinkingComponent(thinkingItem({ text: '', streaming: true }), tagged(), fakeMayflyComponents())
    expect(empty.render(40)).toEqual(['', '[M]✻ [/M][M]Thinking[/M]', '  \x1b[3m[M][/M]\x1b[23m'])
    empty.dispose()
  })

  it('bounds an oversized finalized reasoning render to the retained tail', () => {
    const item = thinkingItem({ text: `${'x'.repeat(STREAMING_RENDER_MAX_CHARS * 3 + 1)}\n${'x'.repeat(STREAMING_RENDER_MAX_CHARS - 1)}`, streaming: false })
    const component = new ThinkingComponent(item, COLORS, fakeMayflyComponents())
    component.setExpanded(true)
    const lines = component.render(80)
    expect(lines.join('')).toContain('earlier characters')
    expect(lines.length).toBeLessThan(500)
    new ThinkingComponent(thinkingItem({ text: 'x'.repeat(STREAMING_RENDER_MAX_CHARS * 2), streaming: false }), COLORS, fakeMayflyComponents()).render(80)
  })

  it('stands the refresh down once the item finalizes, and on dispose', () => {
    const timers = new FakeTimers()
    setThinkingTimers(timers)
    const item = thinkingItem({ text: 'x', streaming: true })
    const renders: number[] = []
    const component = new ThinkingComponent(item, COLORS, fakeMayflyComponents(), () => { renders.push(1) })
    item.streaming = false
    timers.ticks[0]!()
    expect(timers.cleared).toBe(1)
    expect(renders).toHaveLength(0)
    component.dispose()
    expect(timers.cleared).toBe(1)
    const live = new ThinkingComponent(thinkingItem({ text: 'x', streaming: true }), COLORS, fakeMayflyComponents())
    live.dispose()
    expect(timers.cleared).toBe(2)
    // A block that resumes streaming restarts its refresh on render; a settled render stops it.
    item.streaming = true
    component.render(40)
    expect(timers.ticks).toHaveLength(3)
    item.streaming = false
    component.render(40)
    expect(timers.cleared).toBe(3)
  })

  it('caches by item state and rebuilds after invalidate', () => {
    const component = new ThinkingComponent(thinkingItem({ text: 'a' }), COLORS, fakeMayflyComponents())
    expect(component.render(40)).toBe(component.render(40))
    component.setExpanded(true)
    expect(component.render(40)).toBe(component.render(40))
    component.invalidate()
    const rebuilt = component.render(40)
    expect(rebuilt).toEqual(component.render(40))
    expect(rebuilt.length).toBeGreaterThan(0)
  })

  it('starts no timer for a finalized item and refreshes with the default timers', async () => {
    const timers = new FakeTimers()
    setThinkingTimers(timers)
    new ThinkingComponent(thinkingItem({ text: 'done' }), COLORS, fakeMayflyComponents())
    expect(timers.ticks).toHaveLength(0)
    setThinkingTimers(undefined)
    vi.useFakeTimers()
    try {
      const renders: number[] = []
      const live = new ThinkingComponent(thinkingItem({ text: 'live', streaming: true }), COLORS, fakeMayflyComponents(), () => { renders.push(1) })
      vi.advanceTimersByTime(THINKING_REFRESH_MS)
      expect(renders).toHaveLength(1)
      live.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('THINKING_PREVIEW_LINES', () => {
  it('keeps two live tail lines', () => {
    expect(THINKING_PREVIEW_LINES).toBe(2)
  })
})
