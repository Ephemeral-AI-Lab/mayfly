/**
 * Renderer-neutral baseline model footer row. The producer reads the current
 * app session snapshot and official conversation facts; the renderer owns
 * styling and width handling.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-basic-model
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '../app/index.ts'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type { ConversationFacts } from '../conversation/index.ts'
import type { SessionFactsService } from './session-facts.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-basic-model'
/** Services required before the baseline model can register. */
export const inject = ['mayflyStatus', 'mayflySessionFacts']

/** Register the baseline model row. */
export function apply(ctx: Context): void {
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService
  let facts: ConversationFacts = factsService.current
  let agent = factsService.currentAgent
  let text = ''
  const derive = (): void => {
    text = facts.model
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
  ctx.effect(() => () => offFacts())
  ctx.effect(() => () => offAgent())
}
