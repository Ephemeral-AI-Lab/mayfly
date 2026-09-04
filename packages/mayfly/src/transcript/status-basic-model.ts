/**
 * Renderer-neutral baseline model footer row. The producer prefers the live
 * model-selection projection — a committed `/model` pick flips the row
 * immediately, before any request fires — then falls back to the current app
 * session snapshot and official conversation facts; the renderer owns
 * styling and width handling.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-basic-model
 */

import type { Context } from '@deepseek-ai/cordis'
// Empty type imports carry the `sessionProjections` Context merge this
// module's inject resolves.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '../app/index.ts'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ConversationFacts } from '../conversation/index.ts'
import type { SessionFactsService } from './session-facts.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-basic-model'
/** Services required before the baseline model can register. */
export const inject = ['mayflyStatus', 'mayflySessionFacts', 'sessionProjections']

/** The wired model-selection view shape the status row reads, when projected. */
interface ProjectedModelSelection {
  readonly next?: { readonly provider: string, readonly model: string } | null
}

/**
 * Read the session's projected next model, if the projection carries one.
 * @param ctx - plugin context.
 * @param session - the current Agent's session, if any.
 * @returns the projected model id, or `undefined` before any selection.
 */
function projectedNext(ctx: Context, session: Session | undefined): string | undefined {
  if (session === undefined) return undefined
  const projected = ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection as ProjectedModelSelection | undefined
  return projected?.next?.model
}

/** Register the baseline model row. */
export function apply(ctx: Context): void {
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService
  let facts: ConversationFacts = factsService.current
  let agent = factsService.currentAgent
  let text = ''
  const derive = (): void => {
    text = projectedNext(ctx, agent?.session)
      ?? facts.model
      ?? agent?.session.requestHeader()?.config.model
      ?? agent?.options.model
      ?? facts.provider
      ?? (agent === null ? '' : 'no model')
  }
  derive()
  const node = (): MayflyStatusNode | null => text === '' ? null : { kind: 'text', content: text, tone: 'default' }
  const status = ctx.mayflyStatus.register({ id: 'mayfly.status.basic', priority: 0 }, node())
  const refresh = (): void => { derive(); status.set(node()) }
  const offFacts = factsService.subscribe(next => { facts = next; refresh() })
  const offAgent = factsService.subscribeAgent(next => { agent = next; refresh() })
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'modelSelection' && session === agent?.session) refresh()
  })
  ctx.effect(() => () => offFacts())
  ctx.effect(() => () => offAgent())
  ctx.effect(() => () => offProjection())
}
