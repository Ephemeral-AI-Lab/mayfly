/**
 * `mayfly-status-cwd` plugin: enhancement footer entry showing the session's
 * working directory, home-shortened and abbreviated to its last three
 * segments on deep paths (the kimi `shortenCwd` port) in the `muted` tier at
 * priority 5. The cwd comes from the app-owned current-session snapshot and
 * falls back to `process.cwd()`. An empty path renders '' and occupies nothing.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-cwd
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type { SessionFactsService } from './session-facts.ts'
import { displayPath, platformPath } from '../internal/paths.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-cwd'

/** Services required before the cwd entry can register. */
export const inject = ['mayflyStatus', 'mayflySessionFacts']

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
  let work = displayPath(path, platform)
  if (home !== '') {
    const paths = platformPath(platform)
    const relative = displayPath(paths.relative(home, path), platform)
    if (relative === '') return '~'
    if (relative !== '..' && !relative.startsWith('../') && !paths.isAbsolute(relative)) work = `~/${relative}`
  }

  const segments = work.split('/').filter(segment => segment.length > 0)
  if (segments.length <= MAX_CWD_SEGMENTS) return work
  return `…/${segments.slice(-MAX_CWD_SEGMENTS).join('/')}`
}

/**
 * Register the cwd entry. Recomputes on current-session snapshot changes; a
 * redraw is requested only when the rendered text actually changed.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  const facts = ctx.get('mayflySessionFacts') as SessionFactsService | undefined
  let text = shortenCwd(facts?.currentAgent?.session.header.cwd ?? process.cwd(), homedir())
  const node = (): MayflyStatusNode | null => text === '' ? null : { kind: 'text', content: text, tone: 'muted' }
  const status = ctx.mayflyStatus.register({ id: 'mayfly.status.cwd', priority: 5 }, node())

  const offAgent = facts?.subscribeAgent((agent) => {
    const next = shortenCwd(agent?.session.header.cwd ?? process.cwd(), homedir())
    if (next === text) return
    text = next
    status.set(node())
  })
  ctx.effect(() => () => offAgent?.())

}
