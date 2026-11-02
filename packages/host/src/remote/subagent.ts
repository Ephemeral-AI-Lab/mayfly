/** Exact direct-parent subagent drain with native catalog and liveness guards. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { MayflySubagentDrainRequest } from '../types.ts'
import { requireExactAgent, resolveExactAgent } from './session.ts'

type ChildEntry = Extract<SubagentDescendantListEntry, { readonly kind: 'child' }>

function liveDescendantCount(entries: readonly SubagentDescendantListEntry[], rootId: string, isLive: (entry: ChildEntry) => boolean): number {
  const byId = new Map(entries.map(entry => [String(entry.id), entry]))
  let count = 0
  for (const entry of entries) {
    if (entry.kind !== 'child' || !isLive(entry) || String(entry.id) === rootId) continue
    let parentId = String(entry.parentId)
    const seen = new Set<string>()
    while (!seen.has(parentId)) {
      if (parentId === rootId) {
        count += 1
        break
      }
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (parent === undefined) break
      parentId = String(parent.parentId)
    }
  }
  return count
}

function unavailable(childId: string, reason: string): RemoteError<'mayflyHost/subagent-drain-unavailable'> {
  return new RemoteError('mayflyHost/subagent-drain-unavailable', `subagent "${childId}" cannot be drained: ${reason}`, { childId, reason })
}

/** Re-read the native catalog and drain the selected child only through its exact direct parent. */
export async function subagentDrain(ctx: Context, request: MayflySubagentDrainRequest, signal: AbortSignal): Promise<void> {
  const childId = String(request.childSessionId)
  const parent = await resolveExactAgent(ctx, request.parentSessionId, signal)
  const entries = await ctx.subagents.listDescendants(request.parentSessionId, signal)
  signal.throwIfAborted()
  requireExactAgent(ctx, request.parentSessionId, parent)
  const current = entries.find(candidate => candidate.kind === 'child' && String(candidate.id) === childId)
  if (current?.kind !== 'child') throw unavailable(childId, 'unknown subagent')
  if (current.mode === 'external') throw unavailable(childId, 'external children have no local Agent to stop')
  if (current.mode !== 'continuable') throw unavailable(childId, 'child is not continuable')
  if (liveDescendantCount(entries, childId, entry => ctx.agents.get(entry.id) !== undefined) > 0) {
    throw unavailable(childId, 'stop its live descendants first')
  }
  if (ctx.agents.get(request.childSessionId) === undefined) throw unavailable(childId, 'child is not live')
  try {
    await ctx.subagents.drainChildren(parent, [request.childSessionId])
    signal.throwIfAborted()
    requireExactAgent(ctx, request.parentSessionId, parent)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'UNAUTHORIZED') {
      throw new RemoteError('mayflyHost/subagent-drain-unauthorized', `subagent "${childId}" no longer belongs to the exact direct parent`, { childId })
    }
    throw error
  }
}
