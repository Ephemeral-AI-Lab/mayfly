/**
 * Renderer-neutral baseline model footer row. The producer prefers the live
 * model-selection projection — a committed `/model` or `/effort` pick flips
 * the row immediately, before any request fires — then falls back to the
 * current app session snapshot and official conversation facts; the renderer
 * owns styling and width handling. A source carrying an explicit reasoning
 * effort appends ` <Effort>` (the id capitalized, `step-5-preview Max`);
 * the provider default leaves the bare model id. Model and effort stay
 * paired per source — a `/model` switch that drops the effort clears the
 * suffix rather than inheriting the previous request's level.
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
  readonly next?: { readonly provider: string, readonly model: string, readonly reasoningEffort?: string } | null
}

/** The displayed pair: the model label and its source-paired effort id. */
interface RowSelection {
  readonly model: string
  readonly effort?: string
}

/**
 * Read the session's projected next selection, if the projection carries one.
 * @param ctx - plugin context.
 * @param session - the current Agent's session, if any.
 * @returns the projected selection, or `undefined` before any selection.
 */
function projectedNext(ctx: Context, session: Session | undefined): RowSelection | undefined {
  if (session === undefined) return undefined
  const projected = ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection as ProjectedModelSelection | undefined
  const next = projected?.next
  if (next === undefined || next === null) return undefined
  return next.reasoningEffort === undefined
    ? { model: next.model }
    : { model: next.model, effort: next.reasoningEffort }
}

/** Capitalize the effort id's head: `max` → `Max`, `x-high` → `X-high`. */
function capitalizeEffort(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** Register the baseline model row. */
export function apply(ctx: Context): void {
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService
  let facts: ConversationFacts = factsService.current
  let agent = factsService.currentAgent
  let text = ''
  const derive = (): void => {
    /* The model/effort pair comes from one source only: a projected pick
       that leaves the effort undefined restores the provider default, it
       never inherits the stale facts or header level. */
    const header = agent?.session.requestHeader()?.config
    const selection: RowSelection | undefined = projectedNext(ctx, agent?.session)
      ?? (facts.model === undefined
        ? undefined
        : { model: facts.model, ...(facts.reasoningEffort === undefined ? {} : { effort: facts.reasoningEffort }) })
      ?? (header === undefined
        ? undefined
        : { model: header.model, ...(header.reasoningEffort === undefined ? {} : { effort: String(header.reasoningEffort) }) })
      ?? (agent?.options.model === undefined
        ? undefined
        : { model: agent.options.model, ...(agent.options.reasoningEffort === undefined ? {} : { effort: String(agent.options.reasoningEffort) }) })
    const model = selection?.model ?? facts.provider ?? (agent === null ? '' : 'no model')
    text = model === '' || selection?.effort === undefined
      ? model
      : `${model} ${capitalizeEffort(selection.effort)}`
  }
  derive()
  const node = (): MayflyStatusNode | null => text === '' ? null : { kind: 'text', content: text, tone: 'default' }
  const status = ctx.mayflyStatus.register({ id: 'mayfly.status.basic', priority: 0 }, node())
  let published = text
  const refresh = (): void => {
    derive()
    /* Facts notifications fire per session event; the row only republishes
       when its rendered text actually changed. */
    if (text === published) return
    published = text
    status.set(node())
  }
  const offFacts = factsService.subscribe(next => { facts = next; refresh() })
  const offAgent = factsService.subscribeAgent(next => { agent = next; refresh() })
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'modelSelection' && session === agent?.session) refresh()
  })
  ctx.effect(() => () => offFacts())
  ctx.effect(() => () => offAgent())
  ctx.effect(() => () => offProjection())
}
