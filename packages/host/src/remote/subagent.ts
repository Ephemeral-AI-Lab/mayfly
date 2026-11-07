/** Native descendant trees, exact live metrics and completed direct-parent stops. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { MayflyHostSessionRequest, MayflySubagentStopBlocked, MayflySubagentStopRequest, MayflySubagentStopValue, MayflySubagentTreeEntry } from '../types.ts'
import { foldAssistantStreamRecords, initialAssistantStream } from '../conversation/stream-accumulator.ts'
import type { WorkflowLiveCatalog } from './workflow.ts'
import { requireExactAgent } from './session.ts'

type ChildEntry = Extract<SubagentDescendantListEntry, { readonly kind: 'child' }>

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function liveDescendantCount(entries: readonly SubagentDescendantListEntry[], rootId: string, isLive: (entry: ChildEntry) => boolean): number {
  const byId = new Map(entries.map(entry => [String(entry.id), entry]))
  let count = 0
  for (const entry of entries) {
    if (entry.kind !== 'child' || !isLive(entry) || String(entry.id) === rootId) continue
    let parentId = String(entry.parentId)
    const seen = new Set<string>()
    while (!seen.has(parentId)) {
      if (parentId === rootId) { count += 1; break }
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (parent === undefined) break
      parentId = String(parent.parentId)
    }
  }
  return count
}

function stopBlocked(ctx: Context, entries: readonly SubagentDescendantListEntry[], entry: ChildEntry): MayflySubagentStopBlocked | undefined {
  if (entry.mode !== 'continuable') return 'not-continuable'
  if (ctx.agents.get(entry.id) === undefined) return 'not-live'
  if (liveDescendantCount(entries, String(entry.id), candidate => ctx.agents.get(candidate.id) !== undefined) > 0) return 'live-descendants'
  if (ctx.agents.get(entry.parentId) === undefined) return 'parent-not-live'
  return undefined
}

function treeFailure(sessionId: MayflyHostSessionRequest['sessionId'], reason: string, message: string): RemoteError<'mayflyHost/subagent-tree-unavailable'> {
  return new RemoteError('mayflyHost/subagent-tree-unavailable', message, { sessionId, reason })
}

/** Capture only native identity; passive discovery never resolves or activates an Agent. */
function treeOwner(ctx: Context, request: MayflyHostSessionRequest, signal: AbortSignal): () => void {
  const agent = ctx.agents.get(request.sessionId)
  const session = ctx.sessions.get(request.sessionId)
  return () => {
    signal.throwIfAborted()
    if (ctx.agents.get(request.sessionId) !== agent || ctx.sessions.get(request.sessionId) !== session) {
      throw new RemoteError('mayflyHost/session-stale', `session "${request.sessionId}" changed before the operation completed`, request)
    }
  }
}

async function liveMetrics(ctx: Context, entry: Exclude<ChildEntry, { readonly mode: 'external' }>, agent: Agent, check: () => void, signal: AbortSignal) {
  const lifetime = new AbortController()
  const combined = AbortSignal.any([signal, lifetime.signal])
  const iterator = ctx.sessionController.follow({ address: { kind: 'subagent', parentSessionId: entry.parentId, childSessionId: entry.id, mode: entry.mode }, assistantStream: true, maxMessages: 1 }, combined)[Symbol.asyncIterator]()
  let onAbort!: () => void
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(combined.reason) }
      combined.addEventListener('abort', onAbort, { once: true })
      if (combined.aborted) onAbort()
    })
    const opening = await Promise.race([iterator.next(), aborted])
    check()
    requireExactAgent(ctx, agent.id, agent)
    if (opening.done || opening.value.type !== 'snapshot' || opening.value.assistantStream === undefined) {
      throw treeFailure(agent.id, 'stream-opening-unavailable', `subagent ${String(agent.id)} assistant stream baseline is unavailable`)
    }
    const active = opening.value.assistantStream.activeAttempt
    const draft = active === undefined ? undefined : foldAssistantStreamRecords(initialAssistantStream(), active.stream as never)
    return {
      ...(draft !== undefined && draft.chars > 0 ? { liveChars: draft.chars } : {}),
      ...(draft?.phase === 'thinking' || draft?.phase === 'composing' ? { streamPhase: draft.phase } : {}),
    }
  } finally {
    combined.removeEventListener('abort', onAbort)
    lifetime.abort()
    if (iterator.return !== undefined) void Promise.resolve().then(() => iterator.return!()).catch(() => {})
  }
}

/** Return the complete native tree, without opening or retaining any cold child. */
export async function subagentTree(ctx: Context, request: MayflyHostSessionRequest, signal: AbortSignal, workflows: Pick<WorkflowLiveCatalog, 'snapshot'>): Promise<readonly MayflySubagentTreeEntry[]> {
  const check = treeOwner(ctx, request, signal)
  check()
  const entries = await ctx.subagents.listDescendants(request.sessionId, signal).catch(error => {
    check()
    throw treeFailure(request.sessionId, 'catalog-unavailable', describe(error))
  })
  check()
  const owners = new Map<ChildEntry['id'], Agent | undefined>()
  const sessions = new Map<ChildEntry['id'], Session | undefined>()
  for (const entry of entries) if (entry.kind === 'child') {
    owners.set(entry.id, ctx.agents.get(entry.id))
    sessions.set(entry.id, ctx.sessions.get(entry.id))
  }
  const current = (): void => {
    check()
    for (const [id, agent] of owners) {
      if (ctx.agents.get(id) !== agent || ctx.sessions.get(id) !== sessions.get(id)) {
        throw new RemoteError('mayflyHost/session-stale', `session "${id}" changed before the operation completed`, { sessionId: id })
      }
    }
  }
  const rows: MayflySubagentTreeEntry[] = []
  for (const entry of entries) {
    if (entry.kind !== 'child') { rows.push(Object.freeze({ ...entry })); continue }
    const agent = entry.mode === 'external' ? undefined : owners.get(entry.id)
    const session = sessions.get(entry.id)
    const parent = ctx.sessions.get(entry.parentId)
    const label = entry.label ?? (parent === undefined ? undefined : workflows.snapshot(ctx, parent).runs.flatMap(run => run.agents).find(member => String(member.childId) === String(entry.id))?.label)
    const metrics = entry.mode === 'external' || agent === undefined ? {} : await liveMetrics(ctx, entry, agent, current, signal).catch(error => {
      current()
      throw treeFailure(request.sessionId, 'stream-opening-unavailable', describe(error))
    })
    current()
    const values = session === undefined ? {} : ctx.sessionProjections.snapshot(session, ['mayflyConversationFacts', 'subagentTiming']).values
    const facts = values.mayflyConversationFacts
    const timing = values.subagentTiming
    const blocked = stopBlocked(ctx, entries, entry)
    const currentTool = facts?.inFlight?.[0]?.name
    rows.push(Object.freeze({
      ...entry,
      ...label === undefined ? {} : { label },
      activity: agent?.status === 'running' ? 'running' : 'inactive',
      live: agent !== undefined,
      ...metrics,
      ...typeof facts?.epochTokens === 'number' ? { tokens: facts.epochTokens } : {},
      ...typeof facts?.epochOutputTokens === 'number' ? { outputTokens: facts.epochOutputTokens } : {},
      ...typeof facts?.epochTokens === 'number' ? { inputTokens: Math.max(0, facts.epochTokens - (facts.epochOutputTokens ?? 0)) } : {},
      ...currentTool === undefined ? {} : { currentTool },
      ...facts?.outputProgress === undefined ? {} : { outputProgress: facts.outputProgress },
      ...typeof facts?.epochToolCount === 'number' ? { toolCount: facts.epochToolCount } : {},
      ...typeof timing?.settledMs === 'number' ? { settledMs: timing.settledMs } : {},
      ...typeof timing?.active?.since === 'number' ? { activeSince: timing.active.since } : {},
      ...blocked === undefined ? {} : { stopBlocked: blocked },
    }))
  }
  current()
  return Object.freeze(rows)
}

function unavailable(childId: string, reason: string, message: string): RemoteError<'mayflyHost/subagent-stop-unavailable'> {
  return new RemoteError('mayflyHost/subagent-stop-unavailable', message, { childId, reason })
}

/** Re-read the authorized root's native tree; wait for teardown through the child's actual direct parent. */
export async function subagentStop(ctx: Context, request: MayflySubagentStopRequest, signal: AbortSignal): Promise<MayflySubagentStopValue> {
  signal.throwIfAborted()
  const childId = String(request.childSessionId)
  const root = ctx.agents.get(request.sessionId)
  if (root === undefined) throw unavailable(childId, 'root-not-live', 'no session is live yet')
  requireExactAgent(ctx, request.sessionId, root)
  const entries = await ctx.subagents.listDescendants(request.sessionId, signal).catch(error => {
    signal.throwIfAborted()
    requireExactAgent(ctx, request.sessionId, root)
    throw unavailable(childId, 'catalog-unavailable', describe(error))
  })
  signal.throwIfAborted()
  requireExactAgent(ctx, request.sessionId, root)
  const current = entries.find(candidate => candidate.kind === 'child' && String(candidate.id) === childId)
  if (current?.kind !== 'child') throw unavailable(childId, 'unknown-subagent', `unknown subagent: ${childId}`)
  if (current.mode === 'external') throw unavailable(childId, 'external', `subagent ${childId} is external; it has no local Agent to stop`)
  if (current.mode !== 'continuable') throw unavailable(childId, 'not-continuable', `subagent ${childId} is not continuable`)
  const count = liveDescendantCount(entries, childId, entry => ctx.agents.get(entry.id) !== undefined)
  if (count > 0) throw unavailable(childId, 'live-descendants', `subagent ${childId} owns ${String(count)} live descendant${count === 1 ? '' : 's'}; stop its live descendants first`)
  if (ctx.agents.get(current.id) === undefined) throw unavailable(childId, 'not-live', `subagent ${childId} is not live; there is no running Agent to stop`)
  const directParent = ctx.agents.get(current.parentId)
  if (directParent === undefined) throw unavailable(childId, 'parent-not-live', `cannot stop subagent ${childId}: its direct parent is not live`)
  requireExactAgent(ctx, current.parentId, directParent)
  try {
    await ctx.subagents.drainChildren(directParent, [current.id])
  } catch (error) {
    signal.throwIfAborted()
    requireExactAgent(ctx, request.sessionId, root)
    requireExactAgent(ctx, current.parentId, directParent)
    if (error instanceof Error && 'code' in error && error.code === 'UNAUTHORIZED') {
      throw new RemoteError('mayflyHost/subagent-stop-unauthorized', `could not stop subagent ${childId}: ${describe(error)}`, { childId })
    }
    throw unavailable(childId, 'stop-failed', `could not stop subagent ${childId}: ${describe(error)}`)
  }
  signal.throwIfAborted()
  requireExactAgent(ctx, request.sessionId, root)
  requireExactAgent(ctx, current.parentId, directParent)
  return Object.freeze({ kind: 'success', text: `stopped subagent ${childId}` })
}
