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

import { buildContextStatusNode, type ContextStatusValues } from './status-context-model.ts'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionFactsService } from './session-facts.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-context'

/** Services required before the context entry can register. */
export const inject = ['mayflyStatus', 'mayflySessionFacts', 'sessionProjections']

/** One native snapshot cut for the context entry. */
const CONTEXT_KEYS = ['tokenUsage', 'contextPressure', 'contextBreakdown'] as const
const CONTEXT_KEY_SET: ReadonlySet<string> = new Set(CONTEXT_KEYS)

/** Read the native context projections for one exact Session at one cursor. */
function readContext(ctx: Context, session: Session): ContextStatusValues {
  const { values } = ctx.sessionProjections.snapshot(session, CONTEXT_KEYS)
  return { usage: values.tokenUsage, pressure: values.contextPressure, breakdown: values.contextBreakdown }
}

/**
 * Register the context entry over the exact selected Agent's native projections.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  let values: ContextStatusValues = {}
  const read = (): ContextStatusValues => {
    const session = factsService?.currentAgent?.session
    return session === undefined ? {} : readContext(ctx, session)
  }
  const node = (): MayflyStatusNode | null => buildContextStatusNode(values)
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

export { contextTokens, formatTokens, contextPercent, cachePercent, buildContextStatusNode, type ContextStatusValues } from './status-context-model.ts'
