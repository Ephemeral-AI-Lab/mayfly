/**
 * `mayfly-status-context` plugin: enhancement footer entry showing the context
 * occupancy of the selected Session at the right edge of the one status row
 * (priority 6). Occupancy is the native `contextPressure` projection's
 * provider-reported prompt size (`projectedTokens`, else `pressureTokens`);
 * output and reasoning tokens are new generation, not occupied context. When
 * the projection also carries a `contextWindow`, the entry draws two cell
 * bars, `cache ▰▰▱▱▱ 40%  ctx ▰▰▱▱▱▱▱▱▱▱ 18%`: the context bar's share is rounded
 * up (a non-zero share is at least 1, clamped to 100) and its tone warns from
 * 70% and turns to danger from 90%; the cache bar is the session's cache-read
 * share of its prompt-side `tokenUsage`, rounded down so a partial hit never
 * reads as 100%, in a tone that warns under 60% and turns to danger under 30%
 * (a low hit rate is a costlier prompt), and is omitted before any prompt-side
 * usage is recorded. A crowded row gives up the cache bar, then turns the
 * context bar into `ctx 18%`, then hides the entry. Without a window the entry
 * is the plain count `ctx 5.5k`; a session with no occupancy data yet renders
 * nothing. The snapshot takes `tokenUsage`, `contextPressure`, and
 * `contextBreakdown` at one cursor; this producer never scans an Agent or
 * Session event log.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextBreakdownProjection, ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionFactsService } from './session-facts.ts'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { SHED, shedNode } from './status-shed.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-context'

/** Services required before the context entry can register. */
export const inject = ['mayflyStatus', 'mayflySessionFacts', 'sessionProjections']

/** One native snapshot cut for the context entry. */
const CONTEXT_KEYS = ['tokenUsage', 'contextPressure', 'contextBreakdown'] as const
const CONTEXT_KEY_SET: ReadonlySet<string> = new Set(CONTEXT_KEYS)

/** The native projections the compact row reads; composition is kept for one cursor cut. */
interface ContextValues {
  readonly usage?: TokenUsageProjection | undefined
  readonly pressure?: ContextPressureProjection | undefined
  /** Heuristic system/tools/message composition from the same cut; not the occupancy total. */
  readonly breakdown?: ContextBreakdownProjection | undefined
}

/**
 * The context occupancy of one step: the disjoint input-side token counts.
 * Re-exported so the `./status-context` subpath keeps its public surface.
 * @param usage - the step's token accounting.
 * @returns occupied context tokens.
 */
export function contextTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Read the native context projections for one exact Session at one cursor. */
function readContext(ctx: Context, session: Session): ContextValues {
  const { values } = ctx.sessionProjections.snapshot(session, CONTEXT_KEYS)
  return { usage: values.tokenUsage, pressure: values.contextPressure, breakdown: values.contextBreakdown }
}


/**
 * One decimal, trailing `.0` trimmed: 1 → `1`, 1.5 → `1.5`, 2.04 → `2`.
 * @param value - the value to format.
 * @returns the trimmed one-decimal representation.
 */
function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

/**
 * Compact 1024-base token formatting: the plain integer below 1024, `x.yk`
 * (rounded at 100k) at or above it, `x.yM` at or above 1 MiB. Context
 * windows are powers of two, so the binary base keeps the abbreviations
 * exact — 262144 → `256k`, 1048576 → `1M`. Non-finite or negative input
 * formats as `0`.
 * @param tokens - the token count.
 * @returns the formatted count.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0'
  if (tokens >= 1024 * 1024) return `${trimDecimal(tokens / (1024 * 1024))}M`
  if (tokens >= 1024) {
    const k = tokens / 1024
    return `${k >= 100 ? String(Math.round(k)) : trimDecimal(k)}k`
  }
  return String(tokens)
}

/**
 * The occupancy share of a context window, in whole percents: rounded up so
 * partial use never reads as empty, clamped to [0, 100], and a non-zero
 * share always at least 1. A non-finite or non-positive window — or a
 * non-positive occupancy — yields 0.
 * @param used - the occupied tokens.
 * @param max - the context window.
 * @returns the share in percent.
 */
export function contextPercent(used: number, max: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(max) || used <= 0 || max <= 0) return 0
  return Math.min(100, Math.max(1, Math.ceil((used / max) * 100)))
}

/**
 * The cache-read share of the occupied context, in whole percents: rounded
 * down so only a fully cached prompt reads 100, clamped to [0, 100]. A
 * non-finite or non-positive occupancy — or a non-finite or negative cache
 * read — yields 0.
 * @param cacheRead - the cache-read tokens.
 * @param used - the occupied tokens.
 * @returns the share in percent.
 */
export function cachePercent(cacheRead: number, used: number): number {
  if (!Number.isFinite(cacheRead) || !Number.isFinite(used) || cacheRead <= 0 || used <= 0) return 0
  return Math.min(100, Math.floor((cacheRead / used) * 100))
}

/** The context bar's cells, and the cache bar's (a hit rate needs less room than the limit it sits beside). */
const CONTEXT_CELLS = 10
const CACHE_CELLS = 5

/**
 * The context bar's tone: the limit is the thing to watch, so it warns from 70% and turns to danger from 90%.
 * @param percent - the occupancy share in percent.
 * @returns the filled part's tone.
 */
function contextTone(percent: number): 'primary' | 'warning' | 'danger' {
  return percent >= 90 ? 'danger' : percent >= 70 ? 'warning' : 'primary'
}

/**
 * The cache bar's tone, the other way round: a low hit rate means a costlier and slower prompt, so it is danger under 30%,
 * warning under 60%, and success from 60%.
 * @param percent - the cache-read share in percent.
 * @returns the filled part's tone.
 */
function cacheTone(percent: number): 'success' | 'warning' | 'danger' {
  return percent < 30 ? 'danger' : percent < 60 ? 'warning' : 'success'
}

/**
 * Normalize an advertised context window: only a positive finite number is
 * a window, anything else (undefined included) means "not advertised" and
 * the entry degrades.
 * @param contextWindow - the advertised window, if any.
 * @returns the usable window, or undefined when not advertised.
 */
function normalizeWindow(contextWindow: number | undefined): number | undefined {
  return contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined
}

/**
 * Register the context entry over the exact selected Agent's native projections.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  let values: ContextValues = {}
  const read = (): ContextValues => {
    const session = factsService?.currentAgent?.session
    return session === undefined ? {} : readContext(ctx, session)
  }
  const node = (): MayflyStatusNode | null => {
    const pressure = values.pressure
    const used = pressure?.projectedTokens ?? pressure?.pressureTokens
    if (used === undefined || used <= 0) return null
    const max = normalizeWindow(pressure?.contextWindow)
    // Without an advertised window there is no share to draw: the plain count, shed whole when the row is crowded.
    if (max === undefined) return shedNode({ kind: 'text', content: `ctx ${formatTokens(used)}` }, [{ rank: SHED.context, node: null }])
    const percent = contextPercent(used, max)
    const context: MayflyStatusNode = {
      kind: 'progress', label: 'ctx', value: percent, max: 100, style: 'cells', width: CONTEXT_CELLS, tone: contextTone(percent), showCount: false, showPercent: true,
    }
    const usage = values.usage
    const promptTokens = usage === undefined ? 0 : usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    if (usage === undefined || promptTokens <= 0) {
      return shedNode(context, [{ rank: SHED.bar, node: { kind: 'text', content: `ctx ${String(percent)}%` } }, { rank: SHED.context, node: null }])
    }
    const cacheRead = usage.cacheReadTokens
    const cache: MayflyStatusNode = {
      kind: 'progress', label: 'cache', value: cachePercent(cacheRead, promptTokens), max: 100, style: 'cells', width: CACHE_CELLS, tone: cacheTone(cachePercent(cacheRead, promptTokens)), showCount: false, showPercent: true,
    }
    // The cache bar goes first when the row is crowded, then the context bar becomes its percentage, then the readout.
    return shedNode({ kind: 'stack', direction: 'row', gap: 2, children: [{ node: cache }, { node: context }] }, [
      { rank: SHED.cache, node: context },
      { rank: SHED.bar, node: { kind: 'text', content: `ctx ${String(percent)}%` } },
      { rank: SHED.context, node: null },
    ])
  }
  values = read()
  const initial = node()
  const status = ctx.mayflyStatus.register({ id: 'mayfly.status.context', priority: 6, band: 'right', overflow: 'hide' }, initial)
  let published = JSON.stringify(initial)
  const refresh = (): void => {
    values = read()
    const next = node()
    const signature = JSON.stringify(next)
    if (signature === published) return
    published = signature
    status.set(next)
  }
  const offAgent = factsService?.subscribeAgent(() => refresh())
  // Only the exact selected Session's context keys re-read the projections;
  // the change feed replaces per-event order assumptions.
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (session !== factsService?.currentAgent?.session) return
    if (!CONTEXT_KEY_SET.has(key)) return
    refresh()
  })
  ctx.effect(() => () => {
    offAgent?.()
    offProjection()
  })
}
