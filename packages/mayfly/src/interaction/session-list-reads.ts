/** Native catalog snapshots and revision-bound title read memoization for `/sessions`.
 * Keeps only headers and title results; Harness retains all logs and projections.
 * @module @ephemeral-ai/mayfly/interaction/session-list-reads
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionProjectionHints, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { assertSessionHeadersCompatible, readColdSessionLog } from '@deepseek-ai/dsh-session-query'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type {} from '../conversation/types.ts'

const KEYS = ['title', 'sessionListMetadata', 'mayflyConversationFacts', 'tokenUsage', 'sessionStats', 'modelSelection'] as const

export interface SessionListRow {
  readonly header: SessionHeader
  readonly summary: SessionSummary
  readonly revision?: string | undefined
  readonly live: boolean
}

/** Read results retained by the command Fiber, including confirmed absent titles. */
export interface SessionListCache {
  active: boolean
  identity: symbol | undefined
  stored: readonly SessionPersistenceSnapshot[] | undefined
  readonly titles: Map<string, { readonly revision: string, readonly title: string | null }>
}

export function createSessionListCache(ctx: Context): SessionListCache {
  const cache: SessionListCache = { active: true, identity: undefined, stored: undefined, titles: new Map() }
  ctx.effect(() => () => { cache.active = false; cache.stored = undefined; cache.titles.clear() })
  return cache
}

/** Changing the native storage service retires every previous read. */
function bindSources(ctx: Context, cache: SessionListCache): void {
  const identity = ctx.get('sessionPersistence')?.identity
  if (cache.identity === identity) return
  cache.identity = identity
  cache.stored = undefined
  cache.titles.clear()
}

/** One native listing supplies both immutable headers and durable revisions. */
export async function refreshSessionList(ctx: Context, cache: SessionListCache, signal: AbortSignal): Promise<void> {
  bindSources(ctx, cache)
  const identity = cache.identity
  const stored = await ctx.get('sessionPersistence')?.list({ signal }) ?? []
  signal.throwIfAborted()
  if (!cache.active || ctx.get('sessionPersistence')?.identity !== identity) return
  cache.stored = stored
  const revisions = new Map(stored.map(item => [String(item.header.id), item.revision]))
  for (const [id, title] of cache.titles) if (revisions.get(id) !== title.revision) cache.titles.delete(id)
}

/** Join native live state and cold hints without materializing cold logs or transcript views. */
export function sessionListRows(ctx: Context, cache: SessionListCache): readonly SessionListRow[] {
  bindSources(ctx, cache)
  const records = new Map((cache.stored ?? []).map(item => [item.header.id, item]))
  const live = new Map(ctx.sessions.list().map(session => [session.id, session]))
  for (const session of live.values()) {
    const stored = records.get(session.id)
    if (stored !== undefined) assertSessionHeadersCompatible(session.header, stored.header)
  }
  const ids = new Set([...records.keys(), ...live.keys()])
  const rows: SessionListRow[] = []
  const projectionCache = ctx.get('sessionProjectionCache')
  const agents = ctx.agents
  for (const id of ids) {
    const session = live.get(id)
    const stored = records.get(id)
    const header = session?.header ?? stored!.header
    if (session === undefined && header.cwd === undefined) continue
    let projections: SessionSummary['projections']
    try {
      const snapshot = session === undefined
        ? projectionCache?.cachedSnapshot(header, KEYS) ?? projectionCache?.cachedPredecessorTitle(header)
        : ctx.sessionProjections.snapshot(session, KEYS)
      if (snapshot !== undefined) projections = { ...snapshot, kind: session === undefined ? 'cached' : 'sequenced' } as SessionProjectionHints
    } catch (error) {
      ctx.logger.warn(`sessions: listing projections unavailable for ${id}: ${String(error)}`)
    }
    const agent = agents.get(id)
    const metadata = projections?.values.sessionListMetadata
    rows.push({
      header, revision: stored?.revision, live: session !== undefined,
      summary: {
        sessionId: id,
        updatedAt: Math.max(header.createdAt, metadata?.lastPromptAt ?? 0),
        agentAvailable: session !== undefined && agent?.session === session,
        running: session !== undefined && agent?.session === session && agent.status === 'running',
        blank: metadata?.blank ?? (session !== undefined && session.seq === 0),
        ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
        ...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
        ...(header.origin === undefined ? {} : { origin: header.origin }),
        ...(projections === undefined ? {} : { projections }),
      },
    })
  }
  return rows.sort((left, right) => right.summary.updatedAt - left.summary.updatedAt || left.header.id.localeCompare(right.header.id))
}

export function cachedSessionTitle(cache: SessionListCache, row: SessionListRow): string | null | undefined {
  if (row.live) return row.summary.projections?.values.title
  const memo = cache.titles.get(row.header.id)
  return memo?.revision === row.revision ? memo?.title : undefined
}

/** Read only one log through Harness; retain a title, never a prepared Session or transcript. */
export async function readSessionListTitle(ctx: Context, cache: SessionListCache, row: SessionListRow, signal: AbortSignal): Promise<string | null | undefined> {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || !cache.active || cache.identity !== persistence.identity) return undefined
  const identity = persistence.identity
  const log = await readColdSessionLog(persistence, row.header.id, signal)
  signal.throwIfAborted()
  if (!cache.active || cache.identity !== identity || ctx.get('sessionPersistence')?.identity !== identity) return undefined
  const attached = ctx.sessions.get(row.header.id)
  if (attached !== undefined) return foldSessionTitle(attached.snapshotEvents())?.title ?? null
  assertSessionHeadersCompatible(log.header, row.header)
  const title = foldSessionTitle(log.events)?.title ?? null
  // The listing revision precedes this read. A concurrent append changes that
  // revision, causing a conservative reread at the next refresh, never reuse
  // of an older read for a new revision.
  if (row.revision !== undefined) cache.titles.set(row.header.id, { revision: row.revision, title })
  return title
}
