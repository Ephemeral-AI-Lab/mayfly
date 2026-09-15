/** Restore the exact selected Agent's transient output through native baselines.
 * @module @ephemeral-ai/mayfly/frontend/assistant-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '../app/current-agent.ts'
import type {} from '../conversation/live-stream.ts'
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'

export const name = 'mayfly-assistant-stream-recovery'
export const inject = ['mayflyLiveAssistantStream', 'mayflyCurrentAgent', 'agents', 'sessionController']

/** Share one recovery lease across views displaying the same exact Agent. */
export function watchAssistantStream(ctx: Context, agent: Agent): () => void {
  const stream = ctx.get('mayflyLiveAssistantStream')
  const agents = ctx.get('agents') as { get(id: Agent['id']): Agent | undefined } | undefined
  const controller = ctx.get('sessionController') as SessionController | undefined
  if (stream === undefined || agents === undefined || controller === undefined) return () => {}
  return stream.watch(agent, {
    current: () => agents.get(agent.id) === agent,
    open: signal => controller.follow({
      address: { kind: 'session', sessionId: agent.session.id },
      assistantStream: true,
    }, signal),
  })
}

/** Keep transport recovery independent of terminal and theme availability. */
export function apply(ctx: Context): void {
  let selected: Agent | null = null
  let release: () => void = () => {}
  const off = ctx.mayflyCurrentAgent.subscribe(agent => {
    if (agent === selected) return
    release()
    selected = agent
    release = agent === null ? () => {} : watchAssistantStream(ctx, agent)
  })
  ctx.effect(() => () => { off(); release() })
}
