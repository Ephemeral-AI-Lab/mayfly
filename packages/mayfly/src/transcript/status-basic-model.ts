/**
 * Renderer-neutral baseline model footer row. The producer reads the native
 * `modelSelection` projection — `next`, else `lastUsed` — so a committed
 * `/model` or `/effort` pick flips the row immediately, before any request
 * fires. Only the request header and the Agent options remain as fallbacks;
 * the default model service supplies the row before a Session exists. The
 * renderer owns styling and width handling. A source carrying an explicit
 * reasoning effort appends ` <Effort>` (the id capitalized,
 * `deepseek/step-5-preview Max`); the provider default leaves the bare
 * `provider/model`. The provider, model, and effort stay paired per source — a
 * `/model` switch that drops the effort clears the suffix rather than
 * inheriting the previous request's level.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-basic-model
 */

import type { Context } from '@deepseek-ai/cordis'
// Empty type imports carry the `sessionProjections` Context merge this
// module's inject resolves.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '../app/index.ts'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionFactsService } from './session-facts.ts'
import { SHED, shedNode } from './status-shed.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-basic-model'
/** Services required before the baseline model can register. */
export const inject = ['mayflyStatus', 'mayflySessionFacts', 'sessionProjections']

/** The displayed triple: the provider, the model, and the source-paired effort id. */
interface RowSelection {
  readonly provider?: string
  readonly model: string
  readonly effort?: string
}

/**
 * Read the session's projected selection in force: the pending pick, else the
 * selection the latest request used.
 * @param ctx - plugin context.
 * @param session - the current Agent's session, if any.
 * @returns the projected selection, or `undefined` before any selection.
 */
function projectedSelection(ctx: Context, session: Session | undefined): RowSelection | undefined {
  if (session === undefined) return undefined
  const projected = ctx.sessionProjections.snapshot(session, ['modelSelection']).values.modelSelection as ModelSelectionProjection | undefined
  const selected = projected?.next ?? projected?.lastUsed
  if (selected === undefined || selected === null) return undefined
  return { provider: selected.provider, model: selected.model, ...selected.reasoningEffort === undefined ? {} : { effort: String(selected.reasoningEffort) } }
}

/** Capitalize the effort id's head: `max` → `Max`, `x-high` → `X-high`. */
function capitalizeEffort(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/** Register the baseline model row. */
export function apply(ctx: Context): void {
  const factsService = ctx.get('mayflySessionFacts') as SessionFactsService
  let agent = factsService.currentAgent
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
       never inherits the stale header level. */
    const header = agent?.session.requestHeader()?.config
    const selection: RowSelection | undefined = projectedSelection(ctx, agent?.session)
      ?? (header === undefined
        ? undefined
        : { provider: header.provider, model: header.model, ...(header.reasoningEffort === undefined ? {} : { effort: String(header.reasoningEffort) }) })
      ?? (agent?.options.model === undefined
        ? undefined
        : { ...agent.options.provider === undefined ? {} : { provider: agent.options.provider }, model: agent.options.model, ...(agent.options.reasoningEffort === undefined ? {} : { effort: String(agent.options.reasoningEffort) }) })
      /* no session yet: the default the first session takes (`/model` and `/effort` set it) */
      ?? (agent !== null ? undefined : defaultSelection())
    model = selection?.model ?? (agent === null ? '' : 'no model')
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
    /* Projection and Agent notifications both land here; the row only
       republishes when its rendered text actually changed. */
    if (text === published) return
    published = text
    status.set(node())
  }
  const offAgent = factsService.subscribeAgent(next => { agent = next; refresh() })
  const offProjection = ctx.sessionProjections.onChanged((session, key) => {
    if (key === 'modelSelection' && session === agent?.session) refresh()
  })
  ctx.effect(() => () => offAgent())
  ctx.effect(() => () => offProjection())
  ctx.effect(() => ctx.on('mayfly/default-model-changed', refresh))
}
