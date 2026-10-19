/** Native Session Controller catalog snapshots for `/sessions`, the launch
 * screen, and workspace browsing. Harness owns every log and projection; this
 * cache keeps only the summary rows one listing returned.
 * @module @ephemeral-ai/mayfly/interaction/session-list-reads
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionController, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { sameService } from '../internal/service-identity.ts'

/** One native catalog row: the Session Controller summary itself. */
export type SessionListRow = SessionSummary

interface SessionListSelection { readonly cwd?: string | undefined, readonly ids?: ReadonlySet<string> }

/**
 * The listing retained by the owning Fiber. `source` is the controller
 * instance the rows came from; a replaced controller retires them.
 */
export interface SessionListCache {
  active: boolean
  source: SessionController | undefined
  stored: readonly SessionSummary[] | undefined
  /** Newer listings win; a read that lands after one retires its own snapshot. */
  generation: number
}

/**
 * Create the listing cache and retire it with the owning Fiber.
 * @param ctx - the owning command or plugin context.
 * @returns the empty cache.
 */
export function createSessionListCache(ctx: Context): SessionListCache {
  const cache: SessionListCache = { active: true, source: undefined, stored: undefined, generation: 0 }
  ctx.effect(() => () => {
    cache.active = false
    cache.stored = undefined
    cache.generation += 1
  })
  return cache
}

/** Retire a snapshot bound to another controller instance. */
function bindSource(ctx: Context, cache: SessionListCache): void {
  const controller = ctx.get('sessionController')
  if (sameService(cache.source, controller)) return
  cache.source = controller
  cache.stored = undefined
  cache.generation += 1
}

/**
 * Read the complete native catalog once. No persistence, projection cache, or
 * cold-log read is involved.
 * @param ctx - the owning context.
 * @param cache - the retained listing.
 * @param signal - caller cancellation.
 * @returns when the newest listing is retained or a stale read is discarded.
 */
export async function refreshSessionList(ctx: Context, cache: SessionListCache, signal: AbortSignal): Promise<void> {
  bindSource(ctx, cache)
  const controller = cache.source
  if (controller === undefined) return
  const generation = ++cache.generation
  const value = await controller.list({}, signal)
  signal.throwIfAborted()
  if (!cache.active
    || !sameService(cache.source, controller)
    || cache.generation !== generation
    || !sameService(ctx.get('sessionController'), controller)) return
  cache.stored = value.items
}

/**
 * The retained native rows, filtered only for a simpler caller scope.
 * @param ctx - the owning context.
 * @param cache - the retained listing.
 * @param selection - exact cwd, explicit ids, or both.
 * @returns the rows in native activity order.
 */
export function sessionListRows(ctx: Context, cache: SessionListCache, selection?: SessionListSelection): readonly SessionListRow[] {
  bindSource(ctx, cache)
  const rows: SessionListRow[] = []
  for (const summary of cache.stored ?? []) {
    if (selection?.cwd !== undefined && summary.cwd !== selection.cwd) continue
    if (selection?.ids !== undefined && !selection.ids.has(String(summary.sessionId))) continue
    rows.push(summary)
  }
  return rows
}

/**
 * The title hint a native summary carries, trimmed; absent when the listing
 * has no cached title.
 * @param row - one native catalog row.
 * @returns the title, or undefined.
 */
export function sessionListTitle(row: SessionListRow): string | undefined {
  const title = row.projections?.values.title
  if (typeof title !== 'string') return undefined
  const trimmed = title.trim()
  return trimmed === '' ? undefined : trimmed
}
