/** Batch tool presentation through the exact Agent's native presenter definitions. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import type { ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ConversationJson } from '../conversation/types.ts'
import type { MayflyPresentToolsRequest, MayflyPresentToolsResponse, MayflyToolCallView, MayflyToolPresentation, MayflyToolPresentationInput } from '../types.ts'
import { frozen, jsonSnapshot } from './json.ts'
import { requireExactAgent, resolveExactAgent } from './session.ts'

/** Parse raw model arguments without letting malformed JSON reach a presenter. */
export function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function callView(agent: Agent, entry: MayflyToolPresentationInput, args: unknown): MayflyToolCallView | undefined {
  try {
    const view = agent.ctx.tools.get(entry.name, agent)?.presentCall?.(args)
    if (view?.card !== 'generic') return jsonSnapshot(view)
    const { rawInput, ...rest } = view
    if (rawInput === undefined) return jsonSnapshot(rest)
    const input = jsonSnapshot(rawInput as ConversationJson)
    return input === undefined ? undefined : jsonSnapshot({ ...rest, rawInput: input })
  } catch {
    return undefined
  }
}

function resultView(agent: Agent, entry: MayflyToolPresentationInput, args: unknown): ToolResultView | undefined {
  if (entry.result === undefined) return undefined
  try {
    const result: ToolResult = {
      content: [...structuredClone(entry.result.content)],
      isError: entry.result.isError,
      ...entry.result.meta === undefined ? {} : { meta: structuredClone(entry.result.meta) },
    }
    return jsonSnapshot(agent.ctx.tools.get(entry.name, agent)?.presentResult?.(args, result))
  } catch {
    return undefined
  }
}

/** Resolve one entry; a bad tool or presenter degrades only the affected view. */
export function presentTool(agent: Agent, entry: MayflyToolPresentationInput): MayflyToolPresentation {
  const args = parseToolArguments(entry.arguments)
  const call = callView(agent, entry, args)
  const result = resultView(agent, entry, args)
  return frozen({
    updatedSeq: entry.updatedSeq,
    ...call === undefined ? {} : { call },
    ...result === undefined ? {} : { result },
  })
}

/** Resolve changed entries in order, deduplicating exact-Agent activation by Session. */
export async function presentTools(ctx: Context, request: MayflyPresentToolsRequest, signal: AbortSignal): Promise<MayflyPresentToolsResponse> {
  signal.throwIfAborted()
  const agents = new Map<SessionId, Agent>()
  const unavailable = new Set<SessionId>()
  const seen = new Set<string>()
  for (const entry of request.entries) {
    signal.throwIfAborted()
    const entryKey = JSON.stringify([String(entry.sessionId), entry.callId])
    if (seen.has(entryKey)) {
      throw new RemoteError('gateway/bad-request', `duplicate tool presentation entry "${String(entry.sessionId)}/${entry.callId}"`, {})
    }
    seen.add(entryKey)
  }
  const presentations = Object.create(null) as Record<string, Record<string, MayflyToolPresentation>>
  for (const entry of request.entries) {
    signal.throwIfAborted()
    const sessionKey = String(entry.sessionId)
    let agent = agents.get(entry.sessionId)
    if (agent === undefined && !unavailable.has(entry.sessionId)) {
      try {
        agent = await resolveExactAgent(ctx, entry.sessionId, signal)
        agents.set(entry.sessionId, agent)
      } catch (error) {
        if (!(error instanceof RemoteError) || error.code !== 'mayflyHost/agent-unavailable') throw error
        // Historical child Sessions remain browsable without resurrecting an
        // Agent. Their durable input/result renders through the generic card.
        unavailable.add(entry.sessionId)
      }
    }
    const session = presentations[sessionKey] ??= Object.create(null) as Record<string, MayflyToolPresentation>
    session[entry.callId] = agent === undefined ? frozen({ updatedSeq: entry.updatedSeq }) : presentTool(agent, entry)
  }
  signal.throwIfAborted()
  for (const [sessionId, agent] of agents) requireExactAgent(ctx, sessionId, agent)
  return frozen({ presentations })
}
