/**
 * Interrupt the selected Agent's current turn and nothing else: its running subagents, jobs, goal, and Activation are
 * untouched, and the messages queued or steering behind the turn are kept, so the Agent's driver starts the next turn
 * with them as soon as the aborted one settles (Harness runs the pending inbox after a cancelled turn that kept it).
 *
 * @module @ephemeral-ai/mayfly/app/agent-interrupt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MayflyConversationView } from './conversation-views.ts'

/** Outcome of one synchronous interrupt request. */
interface AgentInterruptResult {
  readonly requested: boolean
  readonly failures: readonly string[]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether the selected Agent runs a turn: the condition {@link interruptAgent} acts on, without the write. A subagent that
 * runs while the Agent is idle is not a flow of the selected conversation, so `Esc` there behaves as at rest.
 * @param agent - the selected Agent.
 * @returns whether it runs.
 */
export function isAgentRunning(agent: Agent): boolean {
  return agent.status === 'running'
}

/**
 * Interrupt the selected Agent's current turn. A displayed continuable child is interrupted through its parent's
 * authority; every other Agent is cancelled with `keepInbox`, so nothing the user queued or steered is discarded.
 * @param ctx - the app context, for the subagent service.
 * @param agent - the selected Agent.
 * @param displayed - the displayed conversation, to tell a continuable child from the main Agent.
 * @returns whether a turn was running, and what failed.
 */
export function interruptAgent(
  ctx: Context,
  agent: Agent,
  displayed: MayflyConversationView | null,
): AgentInterruptResult {
  if (!isAgentRunning(agent)) return { requested: false, failures: [] }
  try {
    if (displayed?.kind === 'subagent'
      && displayed.mode === 'continuable'
      && displayed.sessionId === String(agent.id)) {
      ctx.subagents.interruptByParent(
        SessionId(displayed.sessionId),
        SessionId(displayed.parentSessionId),
        'continuable',
      )
    } else {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
  } catch (error) {
    return { requested: true, failures: [`current Agent: ${describe(error)}`] }
  }
  return { requested: true, failures: [] }
}
