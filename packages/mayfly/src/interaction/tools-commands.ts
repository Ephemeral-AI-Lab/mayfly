/** Live native tool catalogs and schema documents through ordinary shared UI.
 * One editor panel holds the list and the selected tool's schema.
 * @module @ephemeral-ai/mayfly/interaction/tools-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import { browser, panel, ui, type MayflyActionItem, type MayflyListItem, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-tools-command'
export const inject = ['commands', 'tools', 'mayflyCurrentAgent', 'mayflyOverlays']

/** A textual summary, independent of terminal geometry. */
export function firstSentence(description: string): string {
  const line = description.split(/\r?\n/u).map(line => line.trim()).find(line => line.length > 0) ?? ''
  const end = /(?<=[.!?])\s|(?<=[。！？])(?=.)/u.exec(line)
  return end === null ? line : line.slice(0, end.index)
}

function sortedSchemas(schemas: readonly ToolSchema[]): readonly ToolSchema[] {
  return schemas.toSorted((left, right) => left.name.localeCompare(right.name))
}

export function toolItems(schemas: readonly ToolSchema[]): readonly MayflyListItem[] {
  return sortedSchemas(schemas).map(schema => ({ id: schema.name, label: schema.name, detail: firstSentence(schema.description) }))
}

/** The schema body without a surface, shared by the browser and the standalone detail view. */
export function toolDetailBody(schema: ToolSchema, t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([ui.child(ui.scroll(ui.stack.column([
    ui.fields([{ label: t('Name'), value: [{ text: schema.name }] }]),
    ui.divider({ label: t('Description') }),
    schema.description.length === 0 ? ui.text(t('(no description)'), { tone: 'muted' }) : ui.markdown(schema.description),
    ui.divider({ label: t('Parameters') }),
    schema.parameters === undefined ? ui.text(t('(no parameters)'), { tone: 'muted' }) : ui.code(JSON.stringify(schema.parameters, null, 2), { language: 'json' }),
  ]), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })])
}

const detailActions = (t: MayflyTranslate) => ui.actions({ id: 'tool-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] })

/** Preserve the full description and JSON Schema; core alone wraps their text. */
export function toolDetailNode(schema: ToolSchema, t: MayflyTranslate): MayflyUiNode {
  return ui.surface({ title: schema.name, chrome: 'overlay', padding: 1, child: ui.stack.column([toolDetailBody(schema, t), detailActions(t)]) })
}

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

/** One list page for the tool browser. */
function toolList(id: string, items: readonly MayflyListItem[], t: MayflyTranslate): MayflyUiNode {
  return ui.list({
    id, role: 'browse', filterable: true, filterMode: 'slash', marker: 'selection', acceptVerb: 'open', selectedIds: [], items,
    empty: ui.empty({ title: t('No tools visible to this session') }),
  })
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
    const snapshot = (): readonly ToolSchema[] => {
      try {
        available = true
        return sortedSchemas(tools.schemas(agent))
      } catch {
        available = false
        return []
      }
    }
    const view = (): MayflyUiNode => {
      const schemas = snapshot()
      const items = schemas.map(schema => ({ id: schema.name, label: schema.name, detail: firstSentence(schema.description) }))
      const selected = schemas.find(schema => schema.name === focused) ?? schemas[0]
      const detailOpen = detailMode && selected !== undefined
      const actions: MayflyActionItem[] = [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }]
      return panel({
        title: detailOpen && selected !== undefined ? selected.name : t('Tools'),
        escapeLabel: detailOpen ? 'back' : 'close',
        body: ui.stack.column([
          ...available ? [] : [ui.text(t('Tool catalog unavailable'), { tone: 'danger' })],
          browser({
            list: toolList('tools', items, t),
            listNarrow: toolList('tools-narrow', items, t),
            detail: selected === undefined ? ui.text(t('No tools visible to this session'), { tone: 'muted' }) : toolDetailBody(selected, t),
            narrow: detailOpen ? 'detail' : 'list',
          }),
          ui.actions({ id: 'catalog-actions', items: actions }),
        ]),
      })
    }
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
