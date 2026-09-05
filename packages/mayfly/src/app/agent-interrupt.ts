/**
 * Interrupt the selected Agent and every running continuable descendant
 * without tearing down their retained Activations or queued inbox work.
 *
 * @module @ephemeral-ai/mayfly/app/agent-interrupt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MayflyAgentViewSnapshot } from './current-agent.ts'

/** Outcome of one synchronous tree-wide interrupt request. */
export interface AgentTreeInterruptResult {
  readonly requested: boolean
  readonly failures: readonly string[]
}

/** Options that differ between ordinary interruption and safe retraction. */
export interface AgentTreeInterruptOptions {
  readonly keepInbox?: boolean
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve descendants through the same live parent-session lineage Harness authorizes. */
function liveDescendants(ctx: Context, ancestor: Agent): readonly Agent[] {
  const candidates = ctx.agents.list()
  const byId = new Map(candidates.map(candidate => [String(candidate.id), candidate]))
  return candidates.filter(candidate => {
    if (candidate === ancestor) return false
    let parentId = candidate.session.header.parentSession
    const seen = new Set<string>()
    while (parentId !== undefined && !seen.has(String(parentId))) {
      if (String(parentId) === String(ancestor.id)) return true
      seen.add(String(parentId))
      parentId = byId.get(String(parentId))?.session.header.parentSession
    }
    return false
  })
}

/**
 * Interrupt the selected Agent plus every running descendant. Descendants use
 * the native exact-ancestor authority so continuable children stay resumable.
 */
export function interruptAgentTree(
  ctx: Context,
  agent: Agent,
  view: MayflyAgentViewSnapshot,
  options: AgentTreeInterruptOptions = {},
): AgentTreeInterruptResult {
  const descendants = liveDescendants(ctx, agent).filter(candidate => candidate.status === 'running')
  const selfRunning = agent.status === 'running'
  if (!selfRunning && descendants.length === 0) return { requested: false, failures: [] }

  const failures: string[] = []
  if (selfRunning) {
    try {
      if (view.displayed === 'auxiliary'
        && view.auxiliary?.kind === 'subagent'
        && view.auxiliary.mode === 'continuable'
        && view.auxiliary.sessionId === String(agent.id)) {
        ctx.subagents.interruptByParent(
          SessionId(view.auxiliary.sessionId),
          SessionId(view.auxiliary.parentSessionId),
          'continuable',
        )
      } else if (options.keepInbox === true) {
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      } else {
        agent.cancel({ kind: 'user' })
      }
    } catch (error) {
      failures.push(`current Agent: ${describe(error)}`)
    }
  }

  for (const descendant of descendants) {
    try {
      ctx.subagents.interrupt(descendant.id, { kind: 'ancestor', agent })
    } catch (error) {
      failures.push(`subagent ${String(descendant.id)}: ${describe(error)}`)
    }
  }
  return { requested: true, failures }
}
