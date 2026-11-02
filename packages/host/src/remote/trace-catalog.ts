/** Passive canonical trace observations through native SessionQuery, without Agent activation. @module */
import type { Context } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { buildSessionEventRecords } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { aggregateTraceItems } from './trace-aggregate.ts'
import { frozen, jsonSnapshot } from './json.ts'
import type { MayflyTraceCatalogRequest, MayflyTraceDetail, MayflyTraceDetailRequest, MayflyTraceItem, MayflyTraceRawEvent } from './trace-contract.ts'

/** Read the complete reference timeline from one detached native log observation. */
export async function traceCatalog(ctx: Context, request: MayflyTraceCatalogRequest, signal: AbortSignal): Promise<readonly MayflyTraceItem[]> {
  signal.throwIfAborted()
  const snapshot = await ctx.sessionQuery.readSession(request.sessionId)
  signal.throwIfAborted()
  return frozen(aggregateTraceItems(buildSessionEventRecords(request.sessionId, snapshot.events), snapshot.events))
}

/** Read only the selected immutable raw events plus native event relationships. */
export async function traceDetail(ctx: Context, request: MayflyTraceDetailRequest, signal: AbortSignal): Promise<MayflyTraceDetail> {
  signal.throwIfAborted()
  const snapshot = await ctx.sessionQuery.readSession(request.sessionId)
  signal.throwIfAborted()
  const wanted = new Set(request.eventSeqs)
  const selected = snapshot.events.filter(event => wanted.has(event.seq))
  if (!wanted.has(request.seq) || selected.length !== wanted.size) {
    throw new RemoteError('mayflyHost/session-stale', 'The trace events are no longer available; open the trace again', { sessionId: request.sessionId })
  }
  const rawEvents = jsonSnapshot(selected) as readonly MayflyTraceRawEvent[] | undefined
  if (rawEvents === undefined) {
    throw new RemoteError('mayflyHost/session-stale', 'The trace contains an event that cannot be represented as JSON', { sessionId: request.sessionId })
  }
  const relation = await ctx.sessionQuery.traceEvent({ sessionId: request.sessionId, seq: SessionSeq(request.seq) }, signal)
  signal.throwIfAborted()
  return frozen({
    rawEvents,
    relation: {
      ...relation.replacedBy === undefined ? {} : { replacedBy: relation.replacedBy },
      replacementChain: [...relation.replacementChain],
      replacedEventSeqs: [...relation.replacedEventSeqs],
      sourceEventSeqs: [...relation.sourceEventSeqs],
      derivedEventSeqs: [...relation.derivedEventSeqs],
    },
  })
}
