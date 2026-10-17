/**
 * One terminal-side read of a Session's effective directory.
 *
 * The Harness `workingDirectory` projection follows `working-directory/change`
 * and is the directory every current filesystem operation should use.
 * `Session.header.cwd` remains the original project identity for workspace
 * membership, archive grouping, and permission roots, so it is only a fallback
 * for hosts that compose no working-directory service.
 *
 * @module @ephemeral-ai/mayfly/internal/session-directory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Read one Session's current directory, falling back to its original project. */
export function sessionDirectory(ctx: Context, session: Session): string {
  const projections = ctx.get('sessionProjections') as Context['sessionProjections'] | undefined
  return projections?.snapshot(session, ['workingDirectory']).values.workingDirectory
    ?? session.header.cwd
    ?? process.cwd()
}

/** Read the displayed Agent's current directory. */
export function agentDirectory(ctx: Context, agent: Agent): string {
  return sessionDirectory(ctx, agent.session)
}
