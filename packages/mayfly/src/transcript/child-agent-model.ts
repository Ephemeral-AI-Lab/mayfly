/**
 * Projection-backed child-agent presentation helpers. Child session event
 * reduction belongs to `mayflyConversationFacts`; this module only correlates
 * readonly child snapshots with parent transcript tool entries.
 *
 * @module @ephemeral-ai/mayfly/transcript/child-agent-model
 */

import type { AgentMemberLive } from './agent-group.ts'
import type { ChildSessionFacts, SessionFactsService } from './session-facts.ts'
import type { TranscriptToolItem } from './types.ts'

/** The child session id carried by a spawn-class acknowledgement. */
export function childIdOfResult(item: TranscriptToolItem): string | undefined {
  if (item.result === undefined) return undefined
  return /started subagent ([a-f0-9-]{8,})/.exec(item.result.fullText ?? item.result.text)?.[1]
}

/** Whether a parent call correlates with one projected child snapshot. */
export function correlateChild(child: ChildSessionFacts, member: TranscriptToolItem): boolean {
  const id = childIdOfResult(member)
  if (id !== undefined) return id === child.id
  const args = member.parsedArguments
  const prompt = typeof args === 'object' && args !== null
    ? (args as Record<string, unknown>)['prompt']
    : undefined
  return child.promptText !== undefined && prompt === child.promptText
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
  /* Member lookups resolve through per-publication maps instead of scanning
     every child per member: the child-id regex and prompt read run once per
     member item, and each children refresh pays O(children) once. */
  let byId = new Map<string, AgentMemberLive>()
  let byPrompt = new Map<string, AgentMemberLive>()
  const resolved = new WeakMap<TranscriptToolItem, string | undefined>()
  const promptCache = new WeakMap<TranscriptToolItem, string | undefined>()
  const childIdOf = (member: TranscriptToolItem): string | undefined => {
    if (resolved.has(member)) return resolved.get(member)
    const id = childIdOfResult(member)
    resolved.set(member, id)
    return id
  }
  const promptOf = (member: TranscriptToolItem): string | undefined => {
    if (promptCache.has(member)) return promptCache.get(member)
    const args = member.parsedArguments
    const prompt = typeof args === 'object' && args !== null
      ? (args as Record<string, unknown>)['prompt']
      : undefined
    const value = typeof prompt === 'string' ? prompt : undefined
    promptCache.set(member, value)
    return value
  }
  const dispose = facts.subscribeChildren(next => {
    const ids = new Map<string, AgentMemberLive>()
    const prompts = new Map<string, AgentMemberLive>()
    for (const child of next) {
      const live = childLiveSnapshot(child)
      if (!ids.has(child.id)) ids.set(child.id, live)
      if (child.promptText !== undefined && !prompts.has(child.promptText)) prompts.set(child.promptText, live)
    }
    byId = ids
    byPrompt = prompts
    changed()
  })
  return {
    snapshot(member) {
      const id = childIdOf(member)
      if (id !== undefined) return byId.get(id)
      const prompt = promptOf(member)
      return prompt === undefined ? undefined : byPrompt.get(prompt)
    },
    dispose,
  }
}
