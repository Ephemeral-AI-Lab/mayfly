/** Exact displayed-Session transcript context from whole native projection snapshots. @module */

import type { SessionListState, SessionProjectionMap } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationAgentCall, ConversationFacts } from '@ephemeral-ai/mayfly-host/types'
import type { TranscriptControllerOptions } from './transcript-model.ts'
import type { SessionRef } from '../client/types.ts'
import type { RemoteSessionFactsSnapshot } from '../hosts/session-facts.ts'
import { partialStrings } from './partial-json.ts'

/** A catalog read from the exact displayed Session's Host and selection. */
export interface RemoteTranscriptCatalog {
  readonly ref: SessionRef
  readonly snapshot: SessionListState
  readonly children?: ReadonlyMap<SessionId, Readonly<Partial<SessionProjectionMap>>>
}

type Context = NonNullable<ReturnType<NonNullable<TranscriptControllerOptions['context']>>>
type Child = NonNullable<Context['children']>['byId'] extends ReadonlyMap<string, infer Value> ? Value : never

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function factsOf(value: unknown): ConversationFacts | undefined {
  const facts = record(value)
  return typeof facts?.['active'] === 'boolean' ? facts as unknown as ConversationFacts : undefined
}

/** Only the displayed parent's authoritative direct-child identities may acquire passive facts. */
export function remoteTranscriptChildIds(facts: RemoteSessionFactsSnapshot, catalog: RemoteTranscriptCatalog | undefined): readonly SessionId[] {
  if (facts.ref === undefined || catalog === undefined || catalog.ref.host !== facts.ref.host || catalog.ref.sessionId !== facts.ref.sessionId) return []
  const children = facts.values['subagentCatalog']
  if (!Array.isArray(children)) return []
  return children.flatMap((value): SessionId[] => {
    const child = record(value)
    const id = child?.['id']
    if (typeof id !== 'string' || id === facts.ref!.sessionId || child!['mode'] === 'external') return []
    const parent = catalog.snapshot.byId[id as SessionId]?.parentId
    return parent === undefined || parent === facts.ref!.sessionId ? [id as SessionId] : []
  })
}

function childState(facts: ConversationFacts | undefined, timing: Record<string, unknown> | undefined, running: boolean): Child | undefined {
  if (facts !== undefined) {
    if (facts.active || facts.runOutcome === undefined) return { state: 'running' }
    return {
      state: 'settled', failed: facts.runOutcome === 'failed',
      ...facts.runStopped === true ? { stopped: true } : {},
      ...facts.endedAt === undefined ? {} : { endedAt: facts.endedAt },
    }
  }
  if (timing?.['active'] !== undefined) return { state: 'running' }
  if (typeof timing?.['lastTurnCompleted'] === 'boolean') return { state: 'settled', failed: !timing['lastTurnCompleted'] }
  return running ? { state: 'running' } : undefined
}

/**
 * Which child each spawn call started. The native catalog has no call id, but it records each child in spawn order under
 * the spawn's description, so the calls claim the catalog's rows of their description in order. Two spawns with one
 * description can swap, and read the same. A call that failed started nothing and claims nothing.
 * @param calls - the parent's spawn calls.
 * @param catalog - the parent's `subagentCatalog` value.
 * @returns the child id by call id.
 */
export function spawnedChildIds(calls: readonly ConversationAgentCall[], catalog: unknown): ReadonlyMap<string, string> {
  const unclaimed = new Map<string, string[]>()
  for (const value of Array.isArray(catalog) ? catalog as readonly unknown[] : []) {
    const child = record(value)
    const id = child?.['id']
    const label = child?.['label']
    if (typeof id !== 'string' || typeof label !== 'string') continue
    unclaimed.set(label, [...unclaimed.get(label) ?? [], id])
  }
  const byCall = new Map<string, string>()
  for (const call of calls) {
    if (call.result?.isError === true) continue
    const id = unclaimed.get(partialStrings(call.arguments).fields['description'] ?? '')?.shift()
    if (id !== undefined) byCall.set(call.callId, id)
  }
  return byCall
}

/** No durable fold, parent fallback, or retained rendering state: each call reads one exact whole snapshot. */
export function remoteTranscriptContext(facts: RemoteSessionFactsSnapshot, catalog?: RemoteTranscriptCatalog): ReturnType<NonNullable<TranscriptControllerOptions['context']>> {
  if (facts.ref === undefined) return undefined
  const parent = factsOf(facts.values['mayflyConversationFacts'])
  const pressure = record(facts.values['contextPressure'])
  const window = pressure?.['contextWindow']
  const projected = pressure?.['projectedTokens']
  const measured = pressure?.['pressureTokens']
  const tokens = typeof projected === 'number' ? projected : typeof measured === 'number' ? measured : undefined
  const byId = new Map<string, Child>()
  const byPrompt = new Map<string, Child>()
  for (const id of remoteTranscriptChildIds(facts, catalog)) {
    const summary = catalog!.snapshot.byId[id]
    const values: Readonly<Record<string, unknown>> = catalog!.children?.get(id) ?? catalog!.snapshot.projectionsBySession[id]?.values ?? summary?.projectionValues ?? {}
    const child = factsOf(values['mayflyConversationFacts'])
    const state = childState(child, record(values['subagentTiming']), summary?.running === true)
    if (state === undefined) continue
    byId.set(id, state)
    if (child?.promptText !== undefined && !byPrompt.has(child.promptText)) byPrompt.set(child.promptText, state)
  }
  return {
    ...Array.isArray(parent?.compactions) ? { marks: parent.compactions } : {},
    ...Array.isArray(parent?.approvals) ? { approvals: parent.approvals } : {},
    ...typeof window === 'number' ? { window } : {},
    ...tokens === undefined ? {} : { tokens },
    children: { byId, byCall: spawnedChildIds(Array.isArray(parent?.agentCalls) ? parent.agentCalls : [], facts.values['subagentCatalog']), byPrompt },
  }
}
