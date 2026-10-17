/**
 * Renderer-neutral baseline model footer row. The producer prefers the live
 * model-selection projection — a committed `/model` or `/effort` pick flips
 * the row immediately, before any request fires — then falls back to the
 * current app session snapshot and official conversation facts; the renderer
 * owns styling and width handling. A source carrying an explicit reasoning
 * effort appends ` <Effort>` (the id capitalized, `deepseek/step-5-preview Max`);
 * the provider default leaves the bare `provider/model`. The provider, model,
 * and effort stay paired per source — a `/model` switch that drops the effort
 * clears the suffix rather than inheriting the previous request's level.
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
import type { ConversationFacts } from '../conversation/types.ts'
import type { SessionFactsService } from './session-facts.ts'
import { SHED, shedNode } from './status-shed.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-basic-model'
/** Services required before the baseline model can register. */
export const inject = ['mayflyStatus', 'mayflySessionFacts', 'sessionProjections']

/** The wired model-selection view shape the status row reads, when projected. */
interface ProjectedModelSelection {
  readonly next?: { readonly provider: string, readonly model: string, readonly reasoningEffort?: string } | null
}

/** The displayed triple: the provider, the model, and the source-paired effort id. */
interface RowSelection {
  readonly provider?: string
  readonly model: string
  readonly effort?: string
}

/**
 * Read the session's projected next selection, if the projection carries one.
 * @param value - the projected `modelSelection` view value.
 * @returns the projected selection, or `undefined` before any selection.
 */
function projectedSelection(value: unknown): RowSelection | undefined {
  const projected = value as ProjectedModelSelection | undefined
  const next = projected?.next
  if (next === undefined || next === null) return undefined
  return { provider: next.provider, model: next.model, ...next.reasoningEffort === undefined ? {} : { effort: next.reasoningEffort } }
}

/**
 * Read the session's projected next selection, if the projection carries one.
 * @param ctx - plugin context.
 * @param session - the current Agent's session, if any.
 * @returns the projected selection, or `undefined` before any selection.
 */
function projectedNext(ctx: Context, session: Session | undefined): RowSelection | undefined {
  if (session === undefined) return undefined
  return projectedSelection(ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection)
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
  /** The session whose projected selection is cached, and that selection; refreshed on attach and change only. */
  let projectedFor: Session | undefined
  let projected: RowSelection | undefined
  let text = ''
  let provider = ''
  let model = ''
  let effort = ''
  const defaultSelection = (): RowSelection | undefined => {
    const saved = ctx.get('agentDefaultModel')?.currentSelection()
    return saved === undefined ? undefined : { provider: saved.provider, model: saved.model, ...(saved.reasoningEffort === undefined ? {} : { effort: String(saved.reasoningEffort) }) }
  }
  const derive = (): void => {
    /* The model/effort pair comes from one source only: a projected pick
       that leaves the effort undefined restores the provider default, it
       never inherits the stale facts or header level. */
    const header = agent?.session.requestHeader()?.config
    const session = agent?.session
    // The snapshot validates through the projection's zod view. Read it once per attached session (and on the change
    // feed below), not on every facts delta.
    if (session !== projectedFor) {
      projectedFor = session
      projected = projectedNext(ctx, session)
    }
    const selection: RowSelection | undefined = projected
      ?? (facts.model === undefined
        ? undefined
        : { ...facts.provider === undefined ? {} : { provider: facts.provider }, model: facts.model, ...(facts.reasoningEffort === undefined ? {} : { effort: facts.reasoningEffort }) })
      ?? (header === undefined
        ? undefined
        : { provider: header.provider, model: header.model, ...(header.reasoningEffort === undefined ? {} : { effort: String(header.reasoningEffort) }) })
      ?? (agent?.options.model === undefined
        ? undefined
        : { ...agent.options.provider === undefined ? {} : { provider: agent.options.provider }, model: agent.options.model, ...(agent.options.reasoningEffort === undefined ? {} : { effort: String(agent.options.reasoningEffort) }) })
      /* no session yet: the default the first session takes (`/model` and `/effort` set it) */
      ?? (agent !== null ? undefined : defaultSelection())
    model = selection?.model ?? (selection === undefined ? facts.provider ?? (agent === null ? '' : 'no model') : '')
    provider = selection?.provider ?? ''
    effort = selection?.effort === undefined ? '' : capitalizeEffort(selection.effort)
    const named = provider === '' || selection === undefined ? model : `${provider}/${model}`
    text = effort === '' || model === '' ? named : `${named} ${effort}`
  }
  derive()
  /** The full `provider/model Effort`, then without the provider, without the thinking level, and last not at all. */
  const node = (): MayflyStatusNode | null => {
    if (text === '') return null
    const plain = (content: string): MayflyStatusNode => ({ kind: 'text', content, tone: 'default' })
    const withEffort = effort === '' ? model : `${model} ${effort}`
    return shedNode(plain(text), [
      ...provider === '' ? [] : [{ rank: SHED.provider, node: plain(withEffort) }],
      ...effort === '' ? [] : [{ rank: SHED.effort, node: plain(model) }],
      { rank: SHED.model, node: null },
    ])
  }
  const status = ctx.mayflyStatus.register({ id: 'mayfly.status.basic', priority: 0, overflow: 'truncate' }, node())
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
  const offProjection = ctx.sessionProjections.onChanged((session, key, value) => {
    if (key !== 'modelSelection' || session !== agent?.session) return
    // The change feed already carries the parsed view: cache it and refresh without another snapshot.
    projectedFor = session
    projected = projectedSelection(value)
    refresh()
  })
  ctx.effect(() => () => offFacts())
  ctx.effect(() => () => offAgent())
  ctx.effect(() => () => offProjection())
  ctx.effect(() => ctx.on('mayfly/default-model-changed', refresh))
}
