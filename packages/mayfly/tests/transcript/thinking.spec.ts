/**
 * The thinking block: live tail-window rendering with the spinner timer,
 * in-place finalization with the folded preview and expansion hint, the
 * blank-reasoning zero-row settle, and dispose discipline. Width behavior
 * asserts against pi-tui's own width helpers (the D48 real-semantics swap).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setThinkingTimers,
  ThinkingComponent,
  THINKING_PREVIEW_LINES,
  type ThinkingTimers,
} from '../../src/transcript/thinking.ts'
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

  setInterval(callback: () => void, _ms: number): ReturnType<typeof setInterval> {
    this.ticks.push(callback)
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
  it('reuses wrapped reasoning across spinner ticks, but recomputes for text, width, and invalidation', () => {
    const timers = new FakeTimers()
    setThinkingTimers(timers)
    const components = fakeMayflyComponents()
    const wrap = vi.spyOn(components, 'wrapText')
    const item = thinkingItem({ text: 'thinking '.repeat(1_000), streaming: true })
    const component = new ThinkingComponent(item, COLORS, components)
    const first = component.render(80)
    for (let i = 0; i < 5; i += 1) {
      timers.ticks[0]!()
      const frame = component.render(80)
      expect(frame[1]).not.toBe(first[1])
      expect(frame.slice(2)).toEqual(first.slice(2))
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

  it('renders the live spinner row over the reasoning\'s tail window', () => {
    const timers = new FakeTimers()
    setThinkingTimers(timers)
    const component = new ThinkingComponent(
      thinkingItem({ text: SIX_WORDS, streaming: true }),
      tagged(),
      fakeMayflyComponents(),
    )
    expect(timers.ticks).toHaveLength(1)
    // The tagged rows measure past twenty columns, so the spinner row's
    // structure asserts at a width it fits.
    const wide = component.render(40)
    expect(wide[0]).toBe('')
    expect(wide[1]).toBe('[M]⠋[/M] [M]thinking...[/M]')
    // The tail window folds at a narrow width: identity colors, the last
    // two wrapped words only, italic-indent styled and width-safe.
    const narrow = new ThinkingComponent(
      thinkingItem({ text: SIX_WORDS, streaming: true }),
      COLORS,
      fakeMayflyComponents(),
    ).render(5)
    expect(narrow).toEqual([
      '',
      '⠋ \x1b[0m...\x1b[0m',
      '  \x1b[3ml4\x1b[23m',
      '  \x1b[3ml5\x1b[23m',
    ])
    // A tick advances the frame and nudges a redraw.
    const renders: number[] = []
    const animating = new ThinkingComponent(
      thinkingItem({ text: 'x', streaming: true }),
      COLORS,
      fakeMayflyComponents(),
      () => { renders.push(1) },
    )
    timers.ticks[2]!()
    expect(animating.render(30)[1]).toBe('⠙ thinking...')
    expect(renders).toHaveLength(1)
  })

  it('finalizes in place: bullet, folded preview, and the expansion hint', () => {
    const component = new ThinkingComponent(
      thinkingItem({ text: SIX_WORDS }),
      tagged(),
      fakeMayflyComponents(),
    )
    const wide = component.render(40)
    expect(wide[0]).toBe('')
    expect(wide[1]).toBe('[M]● [/M]\x1b[3m[M]l0 l1 l2 l3 l4 l5[/M]\x1b[23m')
    // Folding asserts at a narrow width with identity colors: two preview
    // rows then the expansion hint, every row within the given width.
    const narrow = new ThinkingComponent(
      thinkingItem({ text: SIX_WORDS }),
      COLORS,
      fakeMayflyComponents(),
    ).render(5)
    expect(narrow).toEqual([
      '',
      '● \x1b[3ml0\x1b[23m',
      '  \x1b[3ml1\x1b[23m',
      '  ..\x1b[0m…\x1b[0m',
    ])
    // Expansion opens the full body; short bodies never fold.
    component.setExpanded(true)
    expect(component.render(40)).toEqual([
      '',
      '[M]● [/M]\x1b[3m[M]l0 l1 l2 l3 l4 l5[/M]\x1b[23m',
    ])
    const short = new ThinkingComponent(
      thinkingItem({ text: 'one line only' }),
      tagged(),
      fakeMayflyComponents(),
    )
    expect(short.render(40)).toEqual(['', '[M]● [/M]\x1b[3m[M]one line only[/M]\x1b[23m'])
  })

  it('renders zero rows for a blank finalized block and a bare live one', () => {
    // The authoritative rewrite emptied the streamed reasoning.
    const blank = new ThinkingComponent(thinkingItem({ text: '' }), tagged(), fakeMayflyComponents())
    expect(blank.render(40)).toEqual([])
    // An empty live item (only constructible directly) still shows the row.
    const empty = new ThinkingComponent(
      thinkingItem({ text: '', streaming: true }),
      tagged(),
      fakeMayflyComponents(),
    )
    expect(empty.render(40)).toEqual(['', '[M]⠋[/M] [M]thinking...[/M]', '  \x1b[3m[M][/M]\x1b[23m'])
  })

  it('bounds an oversized finalized reasoning render to the retained tail', () => {
    const item = thinkingItem({ text: `${'x'.repeat(STREAMING_RENDER_MAX_CHARS * 3 + 1)}\n${'x'.repeat(STREAMING_RENDER_MAX_CHARS - 1)}`, streaming: false })
    const lines = new ThinkingComponent(item, COLORS, fakeMayflyComponents()).render(80)
    expect(lines.join('')).toContain('earlier characters')
    expect(lines.length).toBeLessThan(500)
    new ThinkingComponent(thinkingItem({ text: 'x'.repeat(STREAMING_RENDER_MAX_CHARS * 2), streaming: false }), COLORS, fakeMayflyComponents()).render(80)
  })

  it('truncates the expansion hint to the available width', () => {
    const component = new ThinkingComponent(
      thinkingItem({ text: SIX_WORDS }),
      COLORS,
      fakeMayflyComponents(),
    )
    // Width 6 leaves 4 for the hint: three kept characters plus the
    // ellipsis (reset-wrapped by pi-tui even inside the tag markers).
    expect(component.render(6).at(-1)).toBe('  ...\x1b[0m…\x1b[0m')
    // Width 3 leaves a single column: the bare ellipsis.
    expect(component.render(3).at(-1)).toBe('  \x1b[0m…\x1b[0m')
  })

  it('stands the spinner down once the item finalizes, and on dispose', () => {
    const timers = new FakeTimers()
    setThinkingTimers(timers)
    const item = thinkingItem({ text: 'x', streaming: true })
    const renders: number[] = []
    const component = new ThinkingComponent(item, COLORS, fakeMayflyComponents(), () => { renders.push(1) })
    item.streaming = false
    // The first tick after the finalize notices and retires the timer
    // without animating or nudging a redraw.
    timers.ticks[0]!()
    expect(timers.cleared).toBe(1)
    expect(renders).toHaveLength(0)
    // dispose stops whatever remains (also idempotent on a stopped timer).
    component.dispose()
    expect(timers.cleared).toBe(1)

    const live = new ThinkingComponent(
      thinkingItem({ text: 'x', streaming: true }),
      COLORS,
      fakeMayflyComponents(),
    )
    live.dispose()
    expect(timers.cleared).toBe(2)
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

  it('starts no timer for a finalized item and animates with the default timers', async () => {
    const timers = new FakeTimers()
    setThinkingTimers(timers)
    new ThinkingComponent(thinkingItem({ text: 'done' }), COLORS, fakeMayflyComponents())
    expect(timers.ticks).toHaveLength(0)

    setThinkingTimers(undefined)
    const renders: number[] = []
    const live = new ThinkingComponent(
      thinkingItem({ text: 'live', streaming: true }),
      COLORS,
      fakeMayflyComponents(),
      () => { renders.push(1) },
    )
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(renders.length).toBeGreaterThan(0)
    live.dispose()
  })
})

describe('THINKING_PREVIEW_LINES', () => {
  it('is the kimi constant: two', () => {
    expect(THINKING_PREVIEW_LINES).toBe(2)
  })
})
