/**
 * The cross-session index behind `/stats` History and Models. Harness owns every log; the command Fiber keeps one small
 * digest per stored session, memoised by the persistence revision, so a reopened panel rereads only sessions that
 * changed. One listing per refresh, the newest sessions first up to a cap, and a pool of four cold reads that fences
 * storage replacement, abort and unload the way `/sessions` titles do.
 *
 * @module @ephemeral-ai/mayfly/interaction/stats-index
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { readColdSessionLog } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session'
import { foldDigest, type SessionDigest } from './digest.ts'

/** Sessions read per refresh, newest first; older ones are counted but not read. */
export const INDEX_SESSION_LIMIT = 300
const READ_CONCURRENCY = 4

/** What the command Fiber keeps across panel opens. */
export interface StatsIndex {
  active: boolean
  identity: symbol | undefined
  /** The last listing, newest first, for the workspace scope it was made for. */
  listed: readonly SessionPersistenceSnapshot[] | undefined
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
  const index: StatsIndex = { active: true, identity: undefined, listed: undefined, digests: new Map() }
  ctx.effect(() => () => { index.active = false; index.listed = undefined; index.digests.clear() })
  return index
}

/** The digests of the listed sessions that have been read, newest first. */
export function readDigests(index: StatsIndex, cwd: string | undefined): readonly SessionDigest[] {
  const result: SessionDigest[] = []
  for (const snapshot of index.listed ?? []) {
    if (cwd !== undefined && snapshot.header.cwd !== cwd) continue
    const digest = index.digests.get(snapshot.header.id)?.digest
    if (digest !== undefined && digest !== null) result.push(digest)
  }
  return result
}

/**
 * List the stored sessions once and read the ones whose digest is missing or stale.
 * @param ctx - the command's context.
 * @param index - the retained index.
 * @param cwd - the workspace to count, or undefined for every workspace.
 * @param signal - aborts the refresh (overlay closed, scope changed, unload).
 * @param onProgress - called as reads settle; the caller coalesces the repaint.
 * @returns when every read has settled or the refresh was retired.
 */
export async function refreshStatsIndex(ctx: Context, index: StatsIndex, cwd: string | undefined, signal: AbortSignal, onProgress: (progress: IndexProgress) => void): Promise<void> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return
  if (index.identity !== persistence.identity) { index.identity = persistence.identity; index.listed = undefined; index.digests.clear() }
  const identity = persistence.identity
  const sessions = ctx.get('sessions')
  const retired = (): boolean => signal.aborted || !index.active || index.identity !== identity || ctx.get('sessionPersistence')?.identity !== identity
  const stored = await persistence.list({ signal })
  if (retired()) return
  const matching = stored.filter(snapshot => cwd === undefined || snapshot.header.cwd === cwd).sort((a, b) => b.header.createdAt - a.header.createdAt)
  const wanted = matching.slice(0, INDEX_SESSION_LIMIT)
  const skipped = matching.length - wanted.length
  index.listed = wanted
  for (const id of index.digests.keys()) if (!stored.some(snapshot => snapshot.header.id === id)) index.digests.delete(id)
  // A live session is read from its own events every time; a stored one only when its revision moved.
  const pending = wanted.filter(snapshot => sessions?.get(snapshot.header.id) !== undefined || snapshot.revision === undefined || index.digests.get(snapshot.header.id)?.revision !== String(snapshot.revision))
  let done = wanted.length - pending.length
  let failed = 0
  onProgress({ done, total: wanted.length, skipped, failed })
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (let next = cursor++; next < pending.length; next = cursor++) {
      const snapshot = pending[next]!
      try {
        const attached = sessions?.get(snapshot.header.id)
        const events = attached !== undefined ? attached.snapshotEvents() : (await readColdSessionLog(persistence, snapshot.header.id, signal)).events
        if (retired()) return
        const digest = foldDigest(snapshot.header.id, snapshot.header.cwd, events) ?? null
        // The listing revision precedes this read, so a concurrent append is reread at the next refresh, never reused.
        if (snapshot.revision !== undefined && attached === undefined) index.digests.set(snapshot.header.id, { revision: String(snapshot.revision), digest })
        else index.digests.set(snapshot.header.id, { revision: '', digest })
      } catch (error) {
        if (retired()) return
        failed += 1
        ctx.logger.warn(`stats: could not read session ${snapshot.header.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      done += 1
      onProgress({ done, total: wanted.length, skipped, failed })
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, pending.length) }, worker))
}
