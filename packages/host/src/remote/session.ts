/** Exact-Agent resolution and Host Session directory reads for Remote providers. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-working-directory'

function stale(sessionId: SessionId): RemoteError<'mayflyHost/session-stale'> {
  return new RemoteError('mayflyHost/session-stale', `session "${sessionId}" changed before the operation completed`, { sessionId })
}

/** Require the same exact live Agent and Session objects, not merely a matching wire id. */
export function requireExactAgent(ctx: Context, sessionId: SessionId, agent: Agent): Agent {
  if (agent.id === sessionId && agent.session.id === sessionId
    && ctx.agents.get(sessionId) === agent && ctx.sessions.get(sessionId) === agent.session) return agent
  throw stale(sessionId)
}

/** Resolve an ordinary Session after authorization; live child Agents use their exact registry entry. */
export async function resolveExactAgent(ctx: Context, sessionId: SessionId, signal: AbortSignal): Promise<Agent> {
  signal.throwIfAborted()
  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return requireExactAgent(ctx, sessionId, live)
  if (ctx.sessions.get(sessionId)?.header.origin === 'subagent') {
    throw new RemoteError('mayflyHost/agent-unavailable', `child session "${sessionId}" has no live Agent`, { sessionId })
  }
  const found = await ctx.sessionController.resolveAgent(sessionId)
  signal.throwIfAborted()
  if ('error' in found) throw found.error
  return requireExactAgent(ctx, sessionId, found.agent)
}

/** Read the effective Host directory without ever falling back to the caller's cwd. */
export function sessionDirectory(ctx: Context, session: Session): string {
  return ctx.sessionProjections.snapshot(session, ['workingDirectory']).values.workingDirectory ?? session.header.cwd ?? (() => {
    throw new RemoteError('mayflyHost/session-directory-unavailable', `session "${session.id}" has no Host working directory`, { sessionId: session.id })
  })()
}
