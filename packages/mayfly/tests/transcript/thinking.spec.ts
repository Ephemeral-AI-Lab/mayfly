/**
 * The thinking block: the captionless live `✻` tail over the reasoning's last
 * wrapped lines (no clock: the activity row owns elapsed time), the one-row
 * settled form with its duration and policy-gated preview, Ctrl-O expansion
 * and scope-aware hints, and the blank-reasoning zero-row renders. Width
 * behavior asserts against pi-tui's own width helpers.
 */

import { describe, expect, it, vi } from 'vitest'
import { ThinkingComponent, THINKING_PREVIEW_LINES } from '../../src/transcript/thinking.ts'
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
  diffGutter: id, diffMeta: id, diffAddedBg: id, diffRemovedBg: id,
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

function thinkingItem(partial: Partial<TranscriptThinkingItem> = {}): TranscriptThinkingItem {
  return { kind: 'thinking', seq: 1, turn: 1, step: 1, text: 'thought', streaming: false, ...partial }
}

/** Six wrap-separated words of reasoning; at width 6 each wraps alone. */
const SIX_WORDS = 'l0 l1 l2 l3 l4 l5'

describe('ThinkingComponent', () => {
  it('wraps only a newline-aligned tail while streaming long reasoning, with exact fallbacks', () => {
    const components = fakeMayflyComponents()
    const wrap = vi.spyOn(components, 'wrapText')
    const long = `${'earlier reasoning line\n'.repeat(400)}penultimate thought\nfinal thought`
    const live = new ThinkingComponent(thinkingItem({ text: long, streaming: true }), COLORS, components)
    const plain = (rows: readonly string[]): string[] => rows.map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
    expect(plain(live.render(40))).toEqual(['', '✻ penultimate thought', '  final thought'])
    expect(wrap.mock.calls.every(([text]) => text.length < 400)).toBe(true)
    // A tail of trailing blank lines falls back to the whole text.
    const blankTail = new ThinkingComponent(thinkingItem({ text: `real thought\n${' \n'.repeat(400)}`, streaming: true }), COLORS, components)
    expect(plain(blankTail.render(40))).toEqual(['', '✻ real thought'])
    // One unbroken paragraph has no line boundary to cut at.
    const unbroken = new ThinkingComponent(thinkingItem({ text: `${'word '.repeat(400)}end`, streaming: true }), COLORS, components)
    expect(unbroken.render(40).at(-1)).toContain('end')
  })

  it('reuses wrapped reasoning across renders, but recomputes for text, width, and invalidation', () => {
    const components = fakeMayflyComponents()
    const wrap = vi.spyOn(components, 'wrapText')
    const item = thinkingItem({ text: 'thinking '.repeat(1_000), streaming: true })
    const component = new ThinkingComponent(item, COLORS, components)
    const first = component.render(80)
    component.invalidate()
    wrap.mockClear()
    expect(component.render(80)).toEqual(first)
    expect(component.render(80)).toBe(component.render(80))
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
  })

  it('renders the live tail without a caption or clock: the marker leads the last wrapped lines', () => {
    const now = vi.spyOn(Date, 'now')
    const component = new ThinkingComponent(thinkingItem({ text: SIX_WORDS, streaming: true }), COLORS, fakeMayflyComponents())
    expect(component.render(5)).toEqual(['', '✻ \x1b[3ml4\x1b[23m', '  \x1b[3ml5\x1b[23m'])
    // Marker and body are muted; the body is italic.
    expect(new ThinkingComponent(thinkingItem({ text: 'x', streaming: true }), tagged(), fakeMayflyComponents()).render(40))
      .toEqual(['', '[M]✻ [/M]\x1b[3m[M]x[/M]\x1b[23m'])
    // Nothing reads the clock: the activity row owns elapsed time.
    expect(now).not.toHaveBeenCalled()
    now.mockRestore()
    // Trailing blank lines never take a tail slot; one line fits on the marker row.
    expect(new ThinkingComponent(thinkingItem({ text: 'only\n\n', streaming: true }), COLORS, fakeMayflyComponents()).render(40))
      .toEqual(['', '✻ \x1b[3monly\x1b[23m'])
    expect(new ThinkingComponent(thinkingItem({ text: SIX_WORDS, streaming: true }), COLORS, fakeMayflyComponents()).render(40))
      .toEqual(['', `✻ \x1b[3m${SIX_WORDS}\x1b[23m`])
  })

  it('settles into one row with its duration, previewing the first line when the policy allows', () => {
    const component = new ThinkingComponent(thinkingItem({ text: SIX_WORDS, durationMs: 4_200 }), tagged(), fakeMayflyComponents())
    expect(component.render(120)).toEqual(['', '[M]✻ [/M][M]Thought for 4s · [/M]\x1b[3m[M]l0 l1 l2 l3 l4 l5[/M]\x1b[23m[T] · Ctrl+O to expand[/T]'])
    // Without a recorded span the duration reads as a while; sub-second spans round up.
    expect(new ThinkingComponent(thinkingItem({ text: 'x' }), COLORS, fakeMayflyComponents()).render(80)[1]).toBe('✻ Thought for a while · \x1b[3mx\x1b[23m · Ctrl+O to expand')
    expect(new ThinkingComponent(thinkingItem({ text: 'x', durationMs: 200 }), COLORS, fakeMayflyComponents()).render(80)[1]).toContain('Thought for 1s')
    // Compact drops the preview; out of Ctrl-O's reach the hint goes.
    const bare = new ThinkingComponent(thinkingItem({ text: 'x', durationMs: 2_000 }), COLORS, fakeMayflyComponents(), () => false)
    expect(bare.render(80)).toEqual(['', '✻ Thought for 2s · Ctrl+O to expand'])
    bare.setScope({ hint: false })
    expect(bare.render(80)).toEqual(['', '✻ Thought for 2s'])
    // A hint that would not fit whole is dropped rather than cut.
    expect(new ThinkingComponent(thinkingItem({ text: 'x', durationMs: 2_000 }), COLORS, fakeMayflyComponents(), () => false).render(20)).toEqual(['', '✻ Thought for 2s'])
    // Ctrl-O opens the complete body under the title.
    component.setExpanded(true)
    expect(component.render(40)).toEqual(['', '[M]✻ [/M][M]Thought for 4s[/M]', '  \x1b[3m[M]l0 l1 l2 l3 l4 l5[/M]\x1b[23m'])
  })

  it('localizes the settled title', () => {
    const t = (key: string, values?: Record<string, string | number>) => interpolateLocaleMessage(TRANSCRIPT_LOCALE.zh[key] ?? key, values)
    expect(new ThinkingComponent(thinkingItem({ text: 'x', durationMs: 3_000 }), COLORS, fakeMayflyComponents(), () => false, t).render(40)[1]).toBe('✻ 已思考 3s · 按 Ctrl+O 展开')
  })

  it('renders zero rows for blank reasoning, live or finalized', () => {
    expect(new ThinkingComponent(thinkingItem({ text: '' }), tagged(), fakeMayflyComponents()).render(40)).toEqual([])
    expect(new ThinkingComponent(thinkingItem({ text: '', streaming: true }), tagged(), fakeMayflyComponents()).render(40)).toEqual([])
    expect(new ThinkingComponent(thinkingItem({ text: ' \n ', streaming: true }), tagged(), fakeMayflyComponents()).render(40)).toEqual([])
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
})

describe('THINKING_PREVIEW_LINES', () => {
  it('keeps two live tail lines', () => {
    expect(THINKING_PREVIEW_LINES).toBe(2)
  })
})
