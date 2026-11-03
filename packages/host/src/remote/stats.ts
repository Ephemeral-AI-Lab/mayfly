/** Passive native statistics reads with revision caching and caller-owned leases. @module */
import { symbols, type Context } from '@deepseek-ai/cordis'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { RemoteError, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { MayflyHostSessionRequest } from '../types.ts'
import type { MayflyStatsDigest, MayflyStatsHistory, MayflyStatsHistoryRequest, MayflyStatsSession } from './stats-contract.ts'
import { ChangeQueue } from './queue.ts'
import { frozen } from './json.ts'
import { requiredDshVersion } from './version.ts'
import { statsDigest } from './stats-digest.ts'

const identity = (source: object | undefined): object | undefined => source === undefined ? undefined : Reflect.get(source, symbols.original) as object | undefined ?? source
const LIMIT = 300
const CONCURRENCY = 4

/** Observe one Session without activating an Agent or retaining its native objects. */
export async function statsSession(ctx: Context, request: MayflyHostSessionRequest, signal: AbortSignal): Promise<MayflyStatsSession> {
  signal.throwIfAborted()
  const source = ctx.sessionQuery
  using observation = await source.observeSession(request.sessionId, { signal, projectionMode: 'none' })
  signal.throwIfAborted()
  if (identity(source) !== identity(ctx.get('sessionQuery'))) throw new RemoteError('mayflyHost/session-stale', 'Statistics source changed during the read', { sessionId: request.sessionId })
  return frozen({ harnessVersion: requiredDshVersion, status: ctx.agents.get(request.sessionId)?.status ?? 'idle', createdAt: observation.header.createdAt, cwd: observation.header.cwd, digest: statsDigest(String(request.sessionId), observation.header.cwd, observation.events) })
}

/** One Host service's small digest cache; each request owns its listing and progress. */
export class StatsHistory {
  private source: object | undefined
  private readonly memo = new Map<string, { readonly revision: string, readonly digest: MayflyStatsDigest | undefined }>()

  constructor(private readonly ctx: Context) {
    ctx.effect(() => () => { this.memo.clear(); this.source = undefined })
  }

  /** Complete replacement frames during a bounded four-reader native corpus scan. */
  async *read(request: MayflyStatsHistoryRequest, signal: AbortSignal): RemoteStream<MayflyStatsHistory> {
    signal.throwIfAborted()
    const local = new AbortController()
    const retire = AbortSignal.any([signal, local.signal])
    const source: SessionQueryEngine = this.ctx.sessionQuery
    const mine = identity(source)
    if (mine !== this.source) { this.source = mine; this.memo.clear() }
    const assertCurrent = (): void => {
      retire.throwIfAborted()
      if (this.source !== mine || identity(this.ctx.get('sessionQuery')) !== mine) throw new RemoteError('mayflyHost/session-stale', 'Statistics source changed during the read', { sessionId: request.sessionId })
    }
    const queue = new ChangeQueue<MayflyStatsHistory>(retire)
    const scan = async (): Promise<void> => {
      const current = await statsSession(this.ctx, request, retire)
      assertCurrent()
      const records = await source.listSessions(retire)
      assertCurrent()
      const matching = records.filter(row => request.allWorkspaces || row.header.cwd === current.cwd).sort((a, b) => b.header.createdAt - a.header.createdAt)
      const wanted = matching.slice(0, LIMIT)
      const digests = new Map<string, MayflyStatsDigest>()
      for (const record of wanted) {
        const cached = this.memo.get(String(record.header.id))?.digest
        if (cached !== undefined) digests.set(String(record.header.id), cached)
      }
      for (const id of this.memo.keys()) if (!records.some(row => String(row.header.id) === id)) this.memo.delete(id)
      let done = 0
      let failed = 0
      let cursor = 0
      const publish = (running: boolean): void => {
        queue.push(frozen({ running, done, failed, total: wanted.length, skipped: matching.length - wanted.length, digests: wanted.flatMap(row => { const value = digests.get(String(row.header.id)); return value === undefined ? [] : [value] }) }))
      }
      publish(true)
      const worker = async (): Promise<void> => {
        for (let next = cursor++; next < wanted.length; next = cursor++) {
          const record = wanted[next]!
          const id = String(record.header.id)
          try {
            using observation = await source.observeSession(record.header.id, { signal: retire, projectionMode: 'none' })
            assertCurrent()
            const revision = observation.revision === undefined ? '' : String(observation.revision)
            let value = this.memo.get(id)
            if (revision === '' || value?.revision !== revision) {
              value = { revision, digest: statsDigest(id, observation.header.cwd, observation.events) }
              this.memo.set(id, value)
            }
            if (value!.digest === undefined) digests.delete(id)
            else digests.set(id, value!.digest)
          } catch {
            assertCurrent()
            failed += 1
          }
          done += 1
          publish(true)
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, worker))
      assertCurrent()
      publish(false)
    }
    void scan().then(() => { queue.finish() }, error => { queue.fail(error) })
    try { for await (const frame of queue) yield frame }
    finally { local.abort(); queue.finish() }
  }
}
