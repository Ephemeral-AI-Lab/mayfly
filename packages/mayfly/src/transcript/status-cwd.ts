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

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { SessionFactsService } from './session-facts.ts'
import { SHED, shedNode } from './status-shed.ts'
import { sessionDirectory } from '../internal/session-directory.ts'
import { displayPath, homeRelative } from '../internal/paths.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-cwd'

/** Services required before the cwd entry can register. */
export const inject = ['mayflyStatus', 'mayflySessionFacts', 'sessionProjections']

/** How many trailing path segments a deep cwd keeps. */
const MAX_CWD_SEGMENTS = 3

/**
 * Abbreviate a working directory for the footer: `~` for the home directory
 * itself, `~` + the rest under home, and once more than
 * {@link MAX_CWD_SEGMENTS} segments remain, everything above the last three
 * collapses to a leading `…`.
 * @param path - the working directory.
 * @param home - the home directory to shorten against.
 * @returns the abbreviated cwd; `path` unchanged when empty or shallow.
 */
export function shortenCwd(path: string, home: string, platform: NodeJS.Platform = process.platform): string {
  if (path === '') return path
  const work = homeRelative(path, home, platform) ?? displayPath(path, platform)

  const segments = work.split('/').filter(segment => segment.length > 0)
  if (segments.length <= MAX_CWD_SEGMENTS) return work
  return `…/${segments.slice(-MAX_CWD_SEGMENTS).join('/')}`
}

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
  /** The directory gives up its depth when the row is crowded: only its last segment stays. */
  const node = (): MayflyStatusNode | null => {
    if (text === '') return null
    const leaf = text.split('/').filter(segment => segment.length > 0 && segment !== '…' && segment !== '~').at(-1)
    return shedNode({ kind: 'text', content: text, tone: 'muted' }, leaf === undefined || leaf === text ? [] : [{ rank: SHED.cwd, node: { kind: 'text', content: leaf, tone: 'muted' } }])
  }
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
