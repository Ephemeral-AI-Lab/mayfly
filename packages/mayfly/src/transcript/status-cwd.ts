/**
 * `mayfly-status-cwd` plugin: enhancement footer entry showing the session's
 * working directory, home-shortened and abbreviated to its last three
 * segments on deep paths (the kimi `shortenCwd` port) in the `muted` tier at
 * priority 7, shed to its last segment when the row is crowded. The directory
 * comes from the native `workingDirectory` projection, with the Session
 * header's original project as the fallback before a change is committed, and
 * `process.cwd()` without a session. An empty path renders '' and occupies
 * nothing.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-cwd
 */

import { buildCwdStatusNode, shortenCwd } from './status-cwd-model.ts'
import { homedir } from 'node:os'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { SessionFactsService } from './session-facts.ts'
import { sessionDirectory } from '../internal/session-directory.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-cwd'

/** Services required before the cwd entry can register. */
export const inject = ['mayflyStatus', 'mayflySessionFacts', 'sessionProjections']

/**
 * Register the cwd entry. Recomputes on current-Agent changes and on the
 * native `workingDirectory` projection; a redraw is requested only when the
 * rendered text actually changed.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const facts = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  let agent: Agent | null = facts?.currentAgent ?? null
  const directory = (): string => agent === null ? process.cwd() : sessionDirectory(ctx, agent.session)
  let text = shortenCwd(directory(), homedir())
  const node = (): MayflyStatusNode | null => buildCwdStatusNode(text)
  const status = ctx.mayflyStatus.register({ id: 'mayfly.status.cwd', priority: 7, overflow: 'truncate' }, node())

  const refresh = (): void => {
    const next = shortenCwd(directory(), homedir())
    if (next === text) return
    text = next
    status.set(node())
  }
  const offAgent = facts?.subscribeAgent((next) => {
    agent = next
    refresh()
  })
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'workingDirectory' && session === agent?.session) refresh()
  })
  ctx.effect(() => () => {
    offAgent?.()
    offProjection()
  })
}

export { shortenCwd, buildCwdStatusNode } from './status-cwd-model.ts'
