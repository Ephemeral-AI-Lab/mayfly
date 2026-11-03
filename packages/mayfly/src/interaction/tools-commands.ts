/** Live native tool catalogs and schema documents through ordinary shared UI.
 * One editor panel holds the list and the selected tool's schema.
 * @module @ephemeral-ai/mayfly/interaction/tools-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { ui, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-tools-command'
export const inject = ['commands', 'tools', 'mayflyCurrentAgent', 'mayflyOverlays']

export { firstSentence, toolItems, toolDetailBody, toolDetailNode } from './catalog-model.ts'
import { sortedSchemas, detailActions, toolDetailNode, toolsBrowserNode, type ToolSchemaFacts } from './catalog-model.ts'

/** The parent consumer Fiber owns this read-only exact-Agent child view. */
export async function openToolDetail(ctx: Context, agent: Agent, options: { readonly id: string, readonly name: string, readonly signal: AbortSignal }): Promise<boolean> {
  const tools = ctx.get('tools')
  const registry = ctx.get('mayflyOverlays')
  if (tools === undefined || registry === undefined || options.signal.aborted) return false
  const t = interactionTranslator(ctx)
  const read = () => tools.schemas(agent).find(schema => schema.name === options.name)
  const initial = read()
  if (initial === undefined) return false
  let handle: MayflyOverlayHandle | undefined
  let node = toolDetailNode(initial, t)
  const refresh = () => {
    if (handle?.closed !== false) return
    let next: MayflyUiNode
    try {
      const schema = read()
      if (schema === undefined) { handle.close(); return }
      next = toolDetailNode(schema, t)
    } catch {
      next = ui.surface({ title: options.name, chrome: 'overlay', child: ui.stack.column([ui.text(t('Tool catalog unavailable'), { tone: 'danger' }), detailActions(t)]) })
    }
    if (!isDeepStrictEqual(node, next)) { node = next; handle.set(node) }
  }
  let scheduled = false
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; refresh() })
  }
  handle = await openAgentOverlay(ctx, agent, { id: options.id, presentation: 'editor', capturing: true }, node, owner => {
    owner.on('tools/change', schedule)
    owner.effect(() => observeInteractionLocale(owner, refresh))
    return event => { if (event.kind === 'activate' && event.actionId === 'refresh') refresh(); return { kind: 'completed' } }
  }, { signal: options.signal, reopen: 'replace' })
  refresh()
  return handle?.closed === false
}

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const tools = ctx.tools
  const t = interactionTranslator(ctx)
  ctx.commands.register({ name: 'tools', description: t('List the tools visible to the current session'), handler: async invocation => {
    const agent = invocation.agent
    const signal = AbortSignal.any([lifetime.signal, invocation.signal])
    if (signal.aborted) return { kind: 'success' }
    if (ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'error', text: t('no session is live yet') }
    if (ctx.mayflyOverlays.focus('mayfly.tools')) return { kind: 'success' }
    let focused: string | undefined
    let detailMode = false
    let available = true
    const snapshot = (): readonly ToolSchemaFacts[] => {
      try {
        available = true
        return sortedSchemas(tools.schemas(agent))
      } catch {
        available = false
        return []
      }
    }
    const view = (): MayflyUiNode => toolsBrowserNode(snapshot(), focused, detailMode, available, t)
    let handle: MayflyOverlayHandle | undefined
    const refresh = (): void => {
      const schemas = snapshot()
      if (focused === undefined || !schemas.some(schema => schema.name === focused)) focused = schemas[0]?.name
      if (detailMode && focused === undefined) detailMode = false
      if (handle?.closed === false) handle.set(view())
    }
    let scheduled = false
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; refresh() })
    }
    handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.tools', presentation: 'editor', capturing: true }, view(), owner => {
      owner.on('tools/change', schedule)
      owner.effect(() => observeInteractionLocale(owner, refresh))
      return async event => {
        if (event.kind === 'dismiss') {
          if (detailMode) {
            detailMode = false
            if (handle?.closed === false) handle.set(view())
            return { kind: 'completed', dismiss: false }
          }
          return { kind: 'completed' }
        }
        if (event.kind === 'selection-accept' && (event.controlId === 'tools' || event.controlId === 'tools-narrow')) {
          const name = event.selectedIds[0]
          if (name === undefined) return { kind: 'cancelled' }
          const schema = snapshot().find(schema => schema.name === name)
          if (schema === undefined) return { kind: 'failed', message: t('The tool is no longer available') }
          focused = name
          if (event.controlId === 'tools-narrow') detailMode = true
          if (handle?.closed === false) handle.set(view())
          return { kind: 'completed' }
        }
        if (event.kind === 'activate' && event.actionId === 'refresh') {
          refresh()
          return { kind: 'completed' }
        }
        return { kind: 'completed' }
      }
    }, { signal, reopen: 'focus' })
    refresh()
    return { kind: 'success' }
  } })
}
