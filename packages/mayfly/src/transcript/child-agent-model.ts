/**
 * Projection-backed child-agent presentation helpers. Child session event
 * reduction belongs to `mayflyConversationFacts`; this module only correlates
 * readonly child snapshots with parent transcript tool entries. A spawn call
 * names its child through the native activation result
 * `{ kind: 'activation', subagentId }`; rendered tool prose is never parsed.
 *
 * @module @ephemeral-ai/mayfly/transcript/child-agent-model
 */

import type { AgentMemberLive } from './agent-presentation.ts'
import type { ChildSessionFacts, SessionFactsService } from './session-facts.ts'
import type { TranscriptToolItem } from './types.ts'

/** One canonical activation result, as the native delegation tool returns it. */
export interface ActivationResult {
  readonly kind: 'activation'
  readonly subagentId: string
}

/**
 * Parse the canonical activation result from a tool result's text. Anything
 * that is not that JSON object — including the model-facing delegation prose
 * a native renderer emits — yields `undefined`; the caller then correlates
 * through the native catalog, never the prose.
 * @param text - the durable tool result text.
 * @returns the activation value, when the text is its canonical JSON.
 */
export function parseActivationResult(text: string | undefined): ActivationResult | undefined {
  if (text === undefined || text === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as { readonly kind?: unknown, readonly subagentId?: unknown }
  return row.kind === 'activation' && typeof row.subagentId === 'string' && row.subagentId !== ''
    ? { kind: 'activation', subagentId: row.subagentId }
    : undefined
}

/**
 * The child session id a spawn result names, through the canonical activation
 * JSON only.
 * @param item - the parent transcript tool item.
 * @returns the child id, or undefined when the result is not activation JSON.
 */
export function childIdOfResult(item: TranscriptToolItem): string | undefined {
  if (item.result === undefined) return undefined
  return parseActivationResult(item.result.text)?.subagentId
}

/** Convert renderer-neutral child facts to the existing agent-card view. */
export function childLiveSnapshot(child: ChildSessionFacts): AgentMemberLive {
  return {
    phase: child.phase,
    ...(child.endedAt === undefined ? {} : { endedAt: child.endedAt }),
    ...(child.tokens > 0 ? { tokens: child.tokens } : {}),
    toolCount: child.toolCount,
    ...(child.liveChars === undefined ? {} : { liveChars: child.liveChars }),
    ...(child.activity === undefined ? {} : { activity: child.activity }),
    ...(child.model === undefined ? {} : { model: child.model }),
    ...(child.effort === undefined ? {} : { effort: child.effort }),
  }
}

/** Subscribe the current parent session's agent card to projection-backed children. */
export function trackChildAgentModels(
  facts: SessionFactsService,
  changed: () => void,
): { snapshot(member: TranscriptToolItem): AgentMemberLive | undefined; dispose(): void } {
  /* Members resolve through one per-publication map: the activation JSON is
     read once per member and each children refresh pays O(children) once. */
  let byId = new Map<string, AgentMemberLive>()
  const resolved = new WeakMap<TranscriptToolItem, string | undefined>()
  const childIdOf = (member: TranscriptToolItem): string | undefined => {
    if (resolved.has(member)) return resolved.get(member)
    const id = childIdOfResult(member)
    resolved.set(member, id)
    return id
  }
  const dispose = facts.subscribeChildren(next => {
    const ids = new Map<string, AgentMemberLive>()
    for (const child of next) if (!ids.has(child.id)) ids.set(child.id, childLiveSnapshot(child))
    byId = ids
    changed()
  })
  return {
    snapshot(member) {
      const id = childIdOf(member)
      return id === undefined ? undefined : byId.get(id)
    },
    dispose,
  }
}
