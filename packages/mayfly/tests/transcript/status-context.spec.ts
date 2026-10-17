/**
 * `mayfly-status-context` plugin: the context-occupancy footer entry over the
 * native token-meter projections. Covers the snapshot-then-subscribe attach,
 * the prompt-size occupancy (`projectedTokens`, else `pressureTokens`), the
 * 1024-base `k`/`M` formatting boundaries and the percent math, the advertised
 * window and its `ctx N` degradation, live `contextPressure`/`tokenUsage`
 * changes, the cumulative cache-read share, session-change rebinding, and the
 * text tier.
 */

import { describe, expect, it } from 'vitest'
import type { ContextBreakdownProjection, ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter'
import * as context from '../../src/transcript/status-context.ts'
import { SHED } from '../../src/transcript/status-shed.ts'
import { resetSeq, userEvent } from './helpers.ts'
import { asAgent, bootStatusPlugin, COLORS, fakeAgent, type FakeAgent } from './status-fakes.ts'

/** The native token-meter projection face: one value set per Session and its change feed. */
class ContextProjectionFake {
  private readonly values = new Map<object, { readonly tokenUsage?: TokenUsageProjection, readonly contextPressure?: ContextPressureProjection, readonly contextBreakdown?: ContextBreakdownProjection }>()
  private readonly listeners = new Set<(session: unknown, key: string, value: unknown, seq: number) => void>()
  reads = 0

  set(session: object, value: { readonly tokenUsage?: TokenUsageProjection, readonly contextPressure?: ContextPressureProjection, readonly contextBreakdown?: ContextBreakdownProjection }): void {
    this.values.set(session, value)
  }

  snapshot(session: object, keys?: readonly string[]): { readonly asOfSeq: number, readonly values: Record<string, unknown> } {
    this.reads += 1
    const source = this.values.get(session) ?? {}
    return {
      asOfSeq: 0,
      values: Object.fromEntries(Object.entries(source).filter(([key]) => keys === undefined || keys.includes(key))),
    }
  }

  onChanged(listener: (session: unknown, key: string, value: unknown, seq: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(session: object, key: 'tokenUsage' | 'contextPressure' | 'contextBreakdown', value: TokenUsageProjection | ContextPressureProjection | ContextBreakdownProjection): void {
    this.values.set(session, { ...this.values.get(session), [key]: value })
    for (const listener of this.listeners) listener(session, key, value, 0)
  }
}

interface ContextBootOptions {
  readonly colors?: Record<string, string>
  readonly projection?: { readonly tokenUsage?: TokenUsageProjection, readonly contextPressure?: ContextPressureProjection, readonly contextBreakdown?: ContextBreakdownProjection }
}

async function bootContext(agent: FakeAgent | null, options: ContextBootOptions = {}) {
  const projections = new ContextProjectionFake()
  if (agent !== null && options.projection !== undefined) projections.set(agent.session, options.projection)
  const harness = await bootStatusPlugin(context, agent, {
    ...options.colors === undefined ? {} : { colors: options.colors },
    services: { sessionProjections: projections },
  })
  return { ...harness, projections }
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

/** Prompt-side cumulative usage: the cache bar's denominator. */
function totals(prompt: number, cacheRead: number): TokenUsageProjection {
  return { uncachedInputTokens: Math.max(0, prompt - cacheRead), outputTokens: 1, cacheReadTokens: cacheRead, cacheWriteTokens: 0 }
}

describe('mayfly-status-context', () => {
  it('renders nothing without a session or without native occupancy', async () => {
    const noSession = await bootStatusPlugin(context)
    expect(noSession.entry.render(80)).toBe('')
    expect(noSession.models.list()).toHaveLength(1)
    await noSession.dispose()

    resetSeq()
    const noUsage = await bootContext(fakeAgent([userEvent('hi')]))
    expect(noUsage.entry.render(80)).toBe('')
    await noUsage.dispose()
  })

  it('reads the native prompt pressure from the snapshot', async () => {
    resetSeq()
    const harness = await bootContext(fakeAgent([userEvent('hi')]), { projection: { contextPressure: { pressureTokens: 12_300 } } })
    expect(harness.entry.id).toBe('mayfly.status.context')
    expect(harness.entry.priority).toBe(6)
    expect(harness.entry.align).toBe('right')
    // With no window there is no share to draw: the plain prompt count.
    expect(harness.entry.render(80)).toBe('ctx 12k')
    await harness.dispose()
  })

  it('prefers projectedTokens for the occupancy and prefixes the cumulative cache share', async () => {
    resetSeq()
    const harness = await bootContext(fakeAgent([userEvent('hi')]), { projection: {
      contextPressure: { pressureTokens: 60_000, projectedTokens: 58_978, contextWindow: 131_072 },
      tokenUsage: totals(58_978, 48_378),
    } })
    // 48378/58978 = 82.03% → 82 (four of five cells); 58978 of 131072 is 45% rounded up (five of ten cells).
    expect(flat(harness.entry.render(80))).toBe('cache ▰▰▰▰▱ 82%  ctx ▰▰▰▰▰▱▱▱▱▱ 45%')
    await harness.dispose()
  })

  it('updates pressure and the cache share live, and drops the cache bar without prompt usage', async () => {
    resetSeq()
    const agent = fakeAgent([userEvent('hi')])
    const { screen, entry, dispose, projections } = await bootContext(agent, { projection: {
      contextPressure: { pressureTokens: 1_000, contextWindow: 4_096 },
      tokenUsage: totals(1_000, 0),
    } })
    expect(flat(entry.render(80))).toBe('cache ▱▱▱▱▱ 0%  ctx ▰▰▰▱▱▱▱▱▱▱ 25%')
    const baseline = screen.renderRequests.length

    projections.emit(agent.session, 'tokenUsage', totals(1_000, 1_000))
    expect(flat(entry.render(80))).toBe('cache ▰▰▰▰▰ 100%  ctx ▰▰▰▱▱▱▱▱▱▱ 25%')
    expect(screen.renderRequests.length).toBe(baseline + 1)

    projections.emit(agent.session, 'contextPressure', { pressureTokens: 2_000, contextWindow: 4_096 })
    expect(flat(entry.render(80))).toBe('cache ▰▰▰▰▰ 100%  ctx ▰▰▰▰▰▱▱▱▱▱ 49%')
    expect(screen.renderRequests.length).toBe(baseline + 2)

    // A tokenUsage without any prompt-side bucket leaves only the context bar.
    projections.emit(agent.session, 'tokenUsage', { uncachedInputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(flat(entry.render(80))).toBe('ctx ▰▰▰▰▰▱▱▱▱▱ 49%')
    expect(screen.renderRequests.length).toBe(baseline + 3)
    await dispose()
  })

  it('renders the occupancy percentage when the snapshot advertises a window', async () => {
    resetSeq()
    const text = (body: string): string => `[T]${body}[/T]`
    const harness = await bootContext(fakeAgent([userEvent('hi')]), {
      colors: { ...COLORS, text },
      projection: { contextPressure: { pressureTokens: 4_200, contextWindow: 8_192 } },
    })
    // 4200/8192 = 51.3% rounded up: the label and the percentage take the text tier, the bar its own tone.
    expect(harness.entry.render(80)).toBe('[T]ctx [/T]▰▰▰▰▰▱▱▱▱▱[T] 52%[/T]')
    await harness.dispose()
  })

  it('picks the window up live from contextPressure and drops it on a switch', async () => {
    resetSeq()
    const agent = fakeAgent([userEvent('hi')])
    const { screen, entry, dispose, projections } = await bootContext(agent, { projection: { contextPressure: { pressureTokens: 999 } } })
    expect(entry.render(80)).toBe('ctx 999')
    const baseline = screen.renderRequests.length

    projections.emit(agent.session, 'contextPressure', { pressureTokens: 999, contextWindow: 2_048 })
    expect(flat(entry.render(80))).toBe('ctx ▰▰▰▰▰▱▱▱▱▱ 49%')
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // A restated value requests no redraw.
    projections.emit(agent.session, 'contextPressure', { pressureTokens: 999, contextWindow: 2_048 })
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // A foreign session's window does not touch the entry.
    const other = fakeAgent([])
    projections.emit(other.session, 'contextPressure', { pressureTokens: 4_096, contextWindow: 4_096 })
    expect(flat(entry.render(80))).toBe('ctx ▰▰▰▰▰▱▱▱▱▱ 49%')

    // A model switch withdrawing the advertised window degrades the entry.
    projections.emit(agent.session, 'contextPressure', { pressureTokens: 999 })
    expect(entry.render(80)).toBe('ctx 999')
    expect(screen.renderRequests.length).toBe(baseline + 2)
    await dispose()
  })

  it('ignores a dishonest advertised window and keeps the degraded form', async () => {
    resetSeq()
    const harness = await bootContext(fakeAgent([userEvent('hi')]), { projection: { contextPressure: { pressureTokens: 500, contextWindow: 0 } } })
    expect(harness.entry.render(80)).toBe('ctx 500')
    await harness.dispose()
  })

  it('tracks live increments on the attached session only', async () => {
    resetSeq()
    const agent = fakeAgent([userEvent('hi')])
    const { screen, entry, dispose, projections } = await bootContext(agent, { projection: { contextPressure: { pressureTokens: 999 } } })
    expect(entry.render(80)).toBe('ctx 999')
    const baseline = screen.renderRequests.length

    // A foreign session's pressure is ignored.
    const other = fakeAgent([])
    projections.emit(other.session, 'contextPressure', { pressureTokens: 5 })
    expect(entry.render(80)).toBe('ctx 999')
    expect(screen.renderRequests.length).toBe(baseline)

    projections.emit(agent.session, 'contextPressure', { pressureTokens: 1_500 })
    expect(entry.render(80)).toBe('ctx 1.5k')
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // A restated occupancy requests no redraw.
    projections.emit(agent.session, 'contextPressure', { pressureTokens: 1_500 })
    expect(screen.renderRequests.length).toBe(baseline + 1)
    await dispose()
  })

  it('rebinds on test/session-changed and goes quiet on a session with no occupancy', async () => {
    resetSeq()
    const first = fakeAgent([userEvent('hi')])
    const { ctx, screen, entry, dispose, projections } = await bootContext(first, { projection: { contextPressure: { pressureTokens: 500 } } })
    expect(entry.render(80)).toBe('ctx 500')

    resetSeq()
    const second = fakeAgent([userEvent('fresh')])
    const baseline = screen.renderRequests.length
    ctx.emit('test/session-changed', asAgent(second))
    expect(entry.render(80)).toBe('')
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // The stale subscription to the first session stays inert.
    projections.emit(first.session, 'contextPressure', { pressureTokens: 9_000 })
    expect(entry.render(80)).toBe('')

    projections.emit(second.session, 'contextPressure', { pressureTokens: 42 })
    expect(entry.render(80)).toBe('ctx 42')
    await dispose()
  })

  it('re-reads the window off the new session on test/session-changed', async () => {
    resetSeq()
    const first = fakeAgent([userEvent('hi')])
    const { ctx, entry, dispose, projections } = await bootContext(first, { projection: { contextPressure: { pressureTokens: 500 } } })
    expect(entry.render(80)).toBe('ctx 500')

    resetSeq()
    const second = fakeAgent([userEvent('hi')])
    projections.set(second.session, { contextPressure: { pressureTokens: 2_048, contextWindow: 4_096 } })
    ctx.emit('test/session-changed', asAgent(second))
    expect(flat(entry.render(80))).toBe('ctx ▰▰▰▰▰▱▱▱▱▱ 50%')
    await dispose()
  })

  it('honors the width budget: the plain count fits or goes whole, and the bars give way in rank order', async () => {
    resetSeq()
    const plain = await bootContext(fakeAgent([userEvent('hi')]), { projection: { contextPressure: { pressureTokens: 999 } } })
    expect(plain.entry.render(7)).toBe('ctx 999')
    expect(plain.entry.render(6)).toBe('')
    await plain.dispose()

    resetSeq()
    const cached = await bootContext(fakeAgent([userEvent('hi')]), { projection: {
      contextPressure: { pressureTokens: 58_978, contextWindow: 131_072 },
      tokenUsage: totals(58_978, 48_378),
    } })
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
      const harness = await bootContext(fakeAgent([userEvent('hi')]), { projection: {
        contextPressure: { pressureTokens: used, contextWindow: 1000 },
        ...cacheRead === undefined ? {} : { tokenUsage: totals(used, cacheRead) },
      } })
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
    expect((await toneOf(100, 20)).cache).toBe('danger')
    expect((await toneOf(100, 59)).cache).toBe('warning')
    expect((await toneOf(100, 60)).cache).toBe('success')
  })

  it('unregisters the entry when the fiber unloads', async () => {
    resetSeq()
    const harness = await bootContext(fakeAgent([userEvent('hi')]), { projection: { contextPressure: { pressureTokens: 1 } } })
    expect(harness.models.list()).toHaveLength(1)
    await harness.dispose()
    expect(harness.models.list()).toHaveLength(0)
  })
})
