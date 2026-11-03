/**
 * The cross-session index behind `/stats` History and Models. Harness owns every log; the command Fiber keeps one small
 * digest per stored session through the native Session Query observation, memoised by its durable revision, so a
 * reopened panel refolds only sessions that changed. One listing per refresh, the newest sessions first up to a cap,
 * and a pool of four observations that fences service replacement, abort, and unload the way `/sessions` listings do.
 *
 * @module @ephemeral-ai/mayfly/interaction/stats-index
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionQueryEngine, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { sameService } from '../../internal/service-identity.ts'
import { foldDigest, type SessionDigest } from './digest.ts'

/** Sessions read per refresh, newest first; older ones are counted but not read. */
export const INDEX_SESSION_LIMIT = 300
const READ_CONCURRENCY = 4

/** What the command Fiber keeps across panel opens. */
export interface StatsIndex {
  active: boolean
  /** The query service the listing and digests came from. */
  source: SessionQueryEngine | undefined
  /** The last native listing, newest first, for the workspace scope it was made for. */
  listed: readonly SessionRecord[] | undefined
  readonly digests: Map<string, { readonly revision: string, readonly digest: SessionDigest | null }>
}

/** How far a refresh has come. */
export interface IndexProgress {
  readonly done: number
  readonly total: number
  /** Sessions beyond the cap that were not read. */
  readonly skipped: number
  readonly failed: number
}

/** Create the index; unloading the owning Fiber retires everything it holds. */
export function createStatsIndex(ctx: Context): StatsIndex {
  const index: StatsIndex = { active: true, source: undefined, listed: undefined, digests: new Map() }
  ctx.effect(() => () => { index.active = false; index.listed = undefined; index.digests.clear() })
  return index
}

/** The digests of the listed sessions that have been read, newest first. */
export function readDigests(index: StatsIndex, cwd: string | undefined): readonly SessionDigest[] {
  const result: SessionDigest[] = []
  for (const record of index.listed ?? []) {
    if (cwd !== undefined && record.header.cwd !== cwd) continue
    const digest = index.digests.get(String(record.header.id))?.digest
    if (digest !== undefined && digest !== null) result.push(digest)
  }
  return result
}

/**
 * List the sessions once and read the ones whose digest is missing or stale.
 * @param ctx - the command's context.
 * @param index - the retained index.
 * @param cwd - the workspace to count, or undefined for every workspace.
 * @param signal - aborts the refresh (overlay closed, scope changed, unload).
 * @param onProgress - called as reads settle; the caller coalesces the repaint.
 * @returns when every observation has settled or the refresh was retired.
 */
export async function refreshStatsIndex(ctx: Context, index: StatsIndex, cwd: string | undefined, signal: AbortSignal, onProgress: (progress: IndexProgress) => void): Promise<void> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return
  if (!sameService(index.source, query)) { index.source = query; index.listed = undefined; index.digests.clear() }
  const source = query
  const retired = (): boolean => signal.aborted || !index.active || !sameService(index.source, source) || !sameService(ctx.get('sessionQuery'), source)
  const records = await source.listSessions(signal)
  if (retired()) return
  const matching = records
    .filter(record => cwd === undefined || record.header.cwd === cwd)
    .sort((left, right) => right.header.createdAt - left.header.createdAt)
  const wanted = matching.slice(0, INDEX_SESSION_LIMIT)
  const skipped = matching.length - wanted.length
  index.listed = wanted
  for (const id of index.digests.keys()) if (!records.some(record => String(record.header.id) === id)) index.digests.delete(id)
  let done = 0
  let failed = 0
  onProgress({ done, total: wanted.length, skipped, failed })
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (let next = cursor++; next < wanted.length; next = cursor++) {
      const record = wanted[next]!
      const id = String(record.header.id)
      try {
        using observation = await source.observeSession(record.header.id, { signal, projectionMode: 'none' })
        if (retired()) return
        const revision = observation.revision === undefined ? '' : String(observation.revision)
        // A live session is refolded every refresh; a cold one only when its durable revision moved.
        if (revision === '' || index.digests.get(id)?.revision !== revision) {
          const digest = foldDigest(id, observation.header.cwd, observation.events) ?? null
          index.digests.set(id, { revision, digest })
        }
      } catch (error) {
        if (retired()) return
        failed += 1
        ctx.logger.warn(`stats: could not read session ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      done += 1
      onProgress({ done, total: wanted.length, skipped, failed })
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, wanted.length) }, worker))
}
