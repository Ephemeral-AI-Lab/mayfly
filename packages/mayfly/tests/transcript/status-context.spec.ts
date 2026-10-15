/**
 * `mayfly-status-context` plugin: the context-occupancy footer entry. Covers
 * the snapshot-then-subscribe attach, the disjoint input-side token sum, the
 * 1024-base `k`/`M` formatting boundaries and the percent math, the
 * advertised-window percentage and its `ctx N` degradation (snapshot,
 * `request/context` live updates, model-switch window drops), live
 * `session/event` increments, the `cache N%` prefix and its live updates,
 * session-change rebinding, and the text tier.
 */

import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as context from '../../src/transcript/status-context.ts'
import { SHED } from '../../src/transcript/status-shed.ts'
import { assistantEvent, reasoningDelta, resetSeq, userEvent } from './helpers.ts'
import { asAgent, bootStatusPlugin, COLORS, fakeAgent } from './status-fakes.ts'

/** An `assistant/message` event carrying token accounting. */
function usageEvent(turn: number, step: number, usage: TokenUsage): SessionEvent<'assistant/message'> {
  const base = assistantEvent(turn, step, [{ type: 'text', text: 'answer' }])
  return { ...base, data: { ...base.data, usage } }
}

/** A `request/context` event advertising a context window. */
function windowEvent(contextWindow?: number): SessionEvent<'request/context'> {
  return {
    type: 'request/context',
    data: { provider: 'deepseek', model: 'deepseek-chat', contextWindow },
  } as SessionEvent<'request/context'>
}

describe('contextTokens, formatTokens, contextPercent', () => {
  it('sums the disjoint input-side counts only', () => {
    expect(context.contextTokens({ inputTokens: 100, outputTokens: 50 })).toBe(100)
    expect(context.contextTokens({
      inputTokens: 100,
      outputTokens: 999,
      cacheReadTokens: 900,
      cacheWriteTokens: 200,
      reasoningTokens: 42,
    })).toBe(1200)
  })

  it('formats on the 1024 base: plain, k with one decimal, k rounded at 100k, M', () => {
    expect(context.formatTokens(0)).toBe('0')
    expect(context.formatTokens(1023)).toBe('1023')
    expect(context.formatTokens(1024)).toBe('1k')
    expect(context.formatTokens(1536)).toBe('1.5k')
    expect(context.formatTokens(12288)).toBe('12k')
    expect(context.formatTokens(12800)).toBe('12.5k')
    expect(context.formatTokens(1024 * 1024)).toBe('1M')
    expect(context.formatTokens(262144)).toBe('256k')
    expect(context.formatTokens(99 * 1024)).toBe('99k')
    expect(context.formatTokens(100 * 1024)).toBe('100k')
    expect(context.formatTokens(100.4 * 1024)).toBe('100k')
    expect(context.formatTokens(100.6 * 1024)).toBe('101k')
  })

  it('formats degenerate counts as zero', () => {
    expect(context.formatTokens(Number.NaN)).toBe('0')
    expect(context.formatTokens(-5)).toBe('0')
    expect(context.formatTokens(Number.POSITIVE_INFINITY)).toBe('0')
  })

  it('percentages round up, clamp, and floor at 1% for partial use', () => {
    expect(context.contextPercent(1, 100)).toBe(1)
    expect(context.contextPercent(0, 100)).toBe(0)
    expect(context.contextPercent(50, 100)).toBe(50)
    expect(context.contextPercent(50.5, 100)).toBe(51)
    expect(context.contextPercent(200, 100)).toBe(100)
    expect(context.contextPercent(100, 0)).toBe(0)
    expect(context.contextPercent(Number.NaN, 100)).toBe(0)
    expect(context.contextPercent(100, Number.NaN)).toBe(0)
  })

  it('cache shares round down, clamp, and zero out degenerate input', () => {
    expect(context.cachePercent(82, 100)).toBe(82)
    expect(context.cachePercent(999, 1000)).toBe(99)
    expect(context.cachePercent(1, 1000)).toBe(0)
    expect(context.cachePercent(100, 100)).toBe(100)
    expect(context.cachePercent(200, 100)).toBe(100)
    expect(context.cachePercent(0, 100)).toBe(0)
    expect(context.cachePercent(10, 0)).toBe(0)
    expect(context.cachePercent(Number.NaN, 100)).toBe(0)
    expect(context.cachePercent(10, Number.POSITIVE_INFINITY)).toBe(0)
  })
})

/** A painted entry without escape sequences or the blank cells the compiler pads it with. */
const ANSI = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu
const flat = (row: string): string => row.replace(ANSI, '').trimEnd()

describe('mayfly-status-context', () => {
  it('renders nothing without a session or without usage data', async () => {
    const noSession = await bootStatusPlugin(context)
    expect(noSession.entry.render(80)).toBe('')
    expect(noSession.models.list()).toHaveLength(1)
    await noSession.dispose()

    resetSeq()
    const noUsage = await bootStatusPlugin(context, fakeAgent([userEvent('hi')]))
    expect(noUsage.entry.render(80)).toBe('')
    await noUsage.dispose()
  })

  it('reads the latest step occupancy from the snapshot', async () => {
    resetSeq()
    const agent = fakeAgent([
      userEvent('hi'),
      usageEvent(1, 1, { inputTokens: 1000, outputTokens: 10 }),
      usageEvent(1, 2, { inputTokens: 11000, outputTokens: 10, cacheReadTokens: 1300 }),
      reasoningDelta(1, 3, 'thinking'),
    ])
    const harness = await bootStatusPlugin(context, agent)
    expect(harness.entry.id).toBe('mayfly.status.context')
    expect(harness.entry.priority).toBe(6)
    expect(harness.entry.align).toBe('right')
    // The entry shares the status row's one line, at its right edge. With no window there is no share to draw: the plain count.
    expect(harness.entry.render(80)).toBe('ctx 12k')
    await harness.dispose()
  })

  it('prefixes the cache-read share before the windowed readout', async () => {
    resetSeq()
    const agent = fakeAgent(
      [usageEvent(1, 1, { inputTokens: 10_600, outputTokens: 10, cacheReadTokens: 48_378, cacheWriteTokens: 0 })],
      { contextWindow: 131_072 },
    )
    const harness = await bootStatusPlugin(context, agent)
    // 48378/58978 = 82.03% → 82 (four of five cells); 58978 of 131072 is 45% rounded up (five of ten cells). No token counts in the row.
    expect(flat(harness.entry.render(80))).toBe('cache ▰▰▰▰▱ 82%  ctx ▰▰▰▰▰▱▱▱▱▱ 45%')
    await harness.dispose()
  })

  it('updates the cache share live and drops it when a step stops reporting reads', async () => {
    resetSeq()
    const agent = fakeAgent([usageEvent(1, 1, { inputTokens: 1000, outputTokens: 1 })], { contextWindow: 4096 })
    const { ctx, screen, entry, dispose } = await bootStatusPlugin(context, agent)
    expect(flat(entry.render(80))).toBe('ctx ▰▰▰▱▱▱▱▱▱▱ 25%')
    const baseline = screen.renderRequests.length

    ctx.emit('session/event', agent.session as unknown as Session, usageEvent(1, 2, { inputTokens: 0, outputTokens: 1, cacheReadTokens: 1000 }))
    expect(flat(entry.render(80))).toBe('cache ▰▰▰▰▰ 100%  ctx ▰▰▰▱▱▱▱▱▱▱ 25%')
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // Same occupancy, new cache share: a redraw is still requested.
    ctx.emit('session/event', agent.session as unknown as Session, usageEvent(1, 3, { inputTokens: 1000, outputTokens: 1, cacheReadTokens: 0 }))
    expect(flat(entry.render(80))).toBe('cache ▱▱▱▱▱ 0%  ctx ▰▰▰▱▱▱▱▱▱▱ 25%')
    expect(screen.renderRequests.length).toBe(baseline + 2)

    ctx.emit('session/event', agent.session as unknown as Session, usageEvent(1, 4, { inputTokens: 1000, outputTokens: 1 }))
    expect(flat(entry.render(80))).toBe('ctx ▰▰▰▱▱▱▱▱▱▱ 25%')
    expect(screen.renderRequests.length).toBe(baseline + 3)
    await dispose()
  })

  it('renders the occupancy percentage when the snapshot advertises a window', async () => {
    resetSeq()
    const agent = fakeAgent(
      [usageEvent(1, 1, { inputTokens: 4200, outputTokens: 10 })],
      { contextWindow: 8192 },
    )
    const text = (body: string): string => `[T]${body}[/T]`
    const harness = await bootStatusPlugin(context, agent, { colors: { ...COLORS, text } })
    // 4200/8192 = 51.3% rounded up: the label and the percentage take the text tier, the bar its own tone.
    expect(harness.entry.render(80)).toBe('[T]ctx [/T]▰▰▰▰▰▱▱▱▱▱[T] 52%[/T]')
    await harness.dispose()
  })

  it('picks the window up live from request/context and drops it on a switch', async () => {
    resetSeq()
    const agent = fakeAgent([usageEvent(1, 1, { inputTokens: 999, outputTokens: 1 })])
    const { ctx, screen, entry, dispose } = await bootStatusPlugin(context, agent)
    expect(entry.render(80)).toBe('ctx 999')
    const baseline = screen.renderRequests.length

    ctx.emit('session/event', agent.session as unknown as Session, windowEvent(2048))
    expect(flat(entry.render(80))).toBe('ctx ▰▰▰▰▰▱▱▱▱▱ 49%')
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // A restated window requests no redraw.
    ctx.emit('session/event', agent.session as unknown as Session, windowEvent(2048))
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // A foreign session's window does not touch the entry.
    const other = fakeAgent([])
    ctx.emit('session/event', other.session as unknown as Session, windowEvent(4096))
    expect(flat(entry.render(80))).toBe('ctx ▰▰▰▰▰▱▱▱▱▱ 49%')

    // A model switch withdrawing the advertised window degrades the entry.
    ctx.emit('session/event', agent.session as unknown as Session, windowEvent(undefined))
    expect(entry.render(80)).toBe('ctx 999')
    expect(screen.renderRequests.length).toBe(baseline + 2)
    await dispose()
  })

  it('ignores a dishonest advertised window and keeps the degraded form', async () => {
    resetSeq()
    const agent = fakeAgent(
      [usageEvent(1, 1, { inputTokens: 500, outputTokens: 1 })],
      { contextWindow: 0 },
    )
    const harness = await bootStatusPlugin(context, agent)
    expect(harness.entry.render(80)).toBe('ctx 500')
    await harness.dispose()
  })

  it('tracks live increments on the attached session only', async () => {
    resetSeq()
    const agent = fakeAgent([usageEvent(1, 1, { inputTokens: 999, outputTokens: 1 })])
    const { ctx, screen, entry, dispose } = await bootStatusPlugin(context, agent)
    expect(entry.render(80)).toBe('ctx 999')
    const baseline = screen.renderRequests.length

    // Events from another session and usage-less finalizes are ignored.
    const other = fakeAgent([])
    ctx.emit('session/event', other.session as unknown as Session, usageEvent(2, 1, { inputTokens: 5, outputTokens: 1 }))
    ctx.emit('session/event', agent.session as unknown as Session, userEvent('no accounting here'))
    ctx.emit('session/event', agent.session as unknown as Session, assistantEvent(1, 2, [{ type: 'text', text: 'no usage' }]))
    expect(entry.render(80)).toBe('ctx 999')
    expect(screen.renderRequests.length).toBe(baseline)

    ctx.emit('session/event', agent.session as unknown as Session, usageEvent(1, 3, { inputTokens: 1500, outputTokens: 1 }))
    expect(entry.render(80)).toBe('ctx 1.5k')
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // A restated occupancy requests no redraw.
    ctx.emit('session/event', agent.session as unknown as Session, usageEvent(1, 4, { inputTokens: 1500, outputTokens: 1 }))
    expect(screen.renderRequests.length).toBe(baseline + 1)
    await dispose()
  })

  it('rebinds on test/session-changed and goes quiet on a usage-less session', async () => {
    resetSeq()
    const first = fakeAgent([usageEvent(1, 1, { inputTokens: 500, outputTokens: 1 })])
    const { ctx, screen, entry, dispose } = await bootStatusPlugin(context, first)
    expect(entry.render(80)).toBe('ctx 500')

    resetSeq()
    const second = fakeAgent([userEvent('fresh')])
    const baseline = screen.renderRequests.length
    ctx.emit('test/session-changed', asAgent(second))
    expect(entry.render(80)).toBe('')
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // The stale subscription to the first session stays inert.
    ctx.emit('session/event', first.session as unknown as Session, usageEvent(2, 1, { inputTokens: 9000, outputTokens: 1 }))
    expect(entry.render(80)).toBe('')

    ctx.emit('session/event', second.session as unknown as Session, usageEvent(1, 1, { inputTokens: 42, outputTokens: 1 }))
    expect(entry.render(80)).toBe('ctx 42')
    await dispose()
  })

  it('re-reads the window off the new session on test/session-changed', async () => {
    resetSeq()
    const first = fakeAgent([usageEvent(1, 1, { inputTokens: 500, outputTokens: 1 })])
    const { ctx, entry, dispose } = await bootStatusPlugin(context, first)
    expect(entry.render(80)).toBe('ctx 500')

    resetSeq()
    const second = fakeAgent(
      [usageEvent(1, 1, { inputTokens: 2048, outputTokens: 1 })],
      { contextWindow: 4096 },
    )
    ctx.emit('test/session-changed', asAgent(second))
    expect(flat(entry.render(80))).toBe('ctx ▰▰▰▰▰▱▱▱▱▱ 50%')
    await dispose()
  })

  it('honors the width budget: the plain count fits or goes whole, and the bars give way in rank order', async () => {
    resetSeq()
    const agent = fakeAgent([usageEvent(1, 1, { inputTokens: 999, outputTokens: 1 })])
    const harness = await bootStatusPlugin(context, agent)
    expect(harness.entry.render(7)).toBe('ctx 999')
    expect(harness.entry.render(6)).toBe('')
    await harness.dispose()

    resetSeq()
    const cached = await bootStatusPlugin(context, fakeAgent(
      [usageEvent(1, 1, { inputTokens: 10_600, outputTokens: 1, cacheReadTokens: 48_378 })],
      { contextWindow: 131_072 },
    ))
    const full = 'cache ▰▰▰▰▱ 82%  ctx ▰▰▰▰▰▱▱▱▱▱ 45%'
    expect(flat(cached.entry.render(full.length))).toBe(full)
    // A narrower cell clips the full form; the ladder the entry sheds down is the row's (`SHED.cache`, `bar`, `context`).
    expect(flat(cached.entry.render(full.length - 1)).length).toBeLessThan(full.length)
    const node = cached.models.list()[0]!.node as unknown as { readonly kind: string, readonly narrower: readonly { readonly rank: number, readonly node: unknown }[] }
    expect(node.kind).toBe('shed')
    expect(node.narrower.map(form => form.rank)).toEqual([SHED.cache, SHED.bar, SHED.context])
    expect(node.narrower[1]!.node).toEqual({ kind: 'text', content: 'ctx 45%' })
    expect(node.narrower[2]!.node).toBeNull()
    await cached.dispose()
  })

  it('tones the bars: context warns from 70% and fails from 90%, the cache the other way round', async () => {
    const toneOf = async (used: number, cacheRead: number | undefined): Promise<{ readonly context: string, readonly cache?: string }> => {
      resetSeq()
      const harness = await bootStatusPlugin(context, fakeAgent(
        [usageEvent(1, 1, { inputTokens: used, outputTokens: 1, ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead } })],
        { contextWindow: 1000 },
      ))
      const node = harness.models.list()[0]!.node as unknown as { readonly node: { readonly kind: string, readonly tone?: string, readonly children?: readonly { readonly node: { readonly label: string, readonly tone: string } }[] } }
      await harness.dispose()
      const bars = node.node.kind === 'progress' ? [node.node as unknown as { label: string, tone: string }] : node.node.children!.map(child => child.node)
      return Object.fromEntries(bars.map(bar => [bar.label === 'ctx' ? 'context' : 'cache', bar.tone])) as { context: string, cache?: string }
    }
    expect((await toneOf(690, undefined)).context).toBe('primary')
    expect((await toneOf(700, undefined)).context).toBe('warning')
    expect((await toneOf(890, undefined)).context).toBe('warning')
    expect((await toneOf(900, undefined)).context).toBe('danger')
    // 20 of 100 cached → danger; 59 → warning; 60 → success.
    expect((await toneOf(80, 20)).cache).toBe('danger')
    expect((await toneOf(41, 59)).cache).toBe('warning')
    expect((await toneOf(40, 60)).cache).toBe('success')
  })

  it('unregisters the entry when the fiber unloads', async () => {
    resetSeq()
    const harness = await bootStatusPlugin(context, fakeAgent([usageEvent(1, 1, { inputTokens: 1, outputTokens: 1 })]))
    expect(harness.models.list()).toHaveLength(1)
    await harness.dispose()
    expect(harness.models.list()).toHaveLength(0)
  })
})
