/** Read-only MCP server inspection over native catalogs and shared UI state.
 * @module @ephemeral-ai/mayfly/interaction/mcp-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import type {} from '@deepseek-ai/dsh-commands'
import { ui, type MayflyField, type MayflyListItem, type MayflyOverlayHandle, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { collectMcpServers, type McpCatalog, type McpServerView, type McpStatus } from './mcp-servers.ts'
import { firstSentence, openToolDetail } from './tools-commands.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-mcp-command'
export const inject = ['commands', 'loader', 'tools', 'mayflyCurrentAgent', 'mayflyOverlays']
const STATUS_ORDER: readonly McpStatus[] = ['failed', 'no-tools', 'restricted', 'starting', 'reloading', 'synced', 'disabled']
const STATUS_TONE: Readonly<Record<McpStatus, MayflyTone>> = { synced: 'success', restricted: 'warning', 'no-tools': 'warning', starting: 'muted', failed: 'danger', reloading: 'muted', disabled: 'muted' }

export function serverItems(catalog: McpCatalog, t: MayflyTranslate): readonly MayflyListItem[] {
  return catalog.servers.toSorted((left, right) => STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status) || left.serverName.localeCompare(right.serverName)).map(server => ({
    id: server.entryId, label: server.serverName, detail: `${server.transport} · ${t(server.status)} · ${t('{visible}/{registered} tools', { visible: server.toolsVisible.length, registered: server.registeredCount })}`,
  }))
}

function field(label: string, text: string, tone: MayflyTone = 'default'): MayflyField { return { label, value: [{ text, tone }] } }

export function serverConfigNode(server: McpServerView, t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([
    ui.divider({ label: t('Status') }),
    ui.fields([
      field(t('Status'), t(server.status), STATUS_TONE[server.status]),
      field(t('Registered tools'), String(server.registeredCount)),
      field(t('Visible tools'), String(server.toolsVisible.length)),
    ]),
    ...server.status === 'no-tools' ? [ui.text(t('No tools registered; connection state is unavailable'), { tone: 'muted' })] : [],
    ...server.status === 'restricted' ? [ui.text(t('Tools are registered but restricted for this Agent'), { tone: 'muted' })] : [],
    ui.divider({ label: t('Connection') }),
    ui.fields([
      field(t('Transport'), server.transport), field(t('Endpoint'), server.endpoint),
      ...server.cwd === undefined ? [] : [field(t('Working directory'), server.cwd)],
      field(t('Environment keys'), server.envKeys.join(', ') || t('(none)')),
      field(t('Header keys'), server.headerKeys.join(', ') || t('(none)')),
    ]),
    ui.divider({ label: t('Policy') }),
    ui.fields([
      ...server.toolCallTimeoutMs === undefined ? [] : [field(t('Tool timeout'), `${server.toolCallTimeoutMs} ms`)],
      ...server.failOnStartupError === undefined ? [] : [field(t('Fail on startup error'), String(server.failOnStartupError))],
      field(t('Reconnect'), server.reconnect === undefined ? t('(not resolved)') : t(server.reconnect.enabled ? 'enabled' : 'disabled')),
      ...server.reconnect === undefined ? [] : [field(t('Backoff'), `${server.reconnect.initialDelayMs} - ${server.reconnect.maxDelayMs} ms`), field(t('Maximum attempts'), String(server.reconnect.maxAttempts))],
    ]),
  ])
}

export function mcpServerNode(server: McpServerView, t: MayflyTranslate): MayflyUiNode {
  const prefix = `mcp__${server.serverName}__`
  return ui.surface({ title: server.serverName, chrome: 'overlay', padding: 1, child: ui.stack.column([
    ui.tabs({ id: 'server-pages', activeId: 'tools', items: [{ id: 'tools', label: t('Tools'), count: server.toolsVisible.length }, { id: 'config', label: t('Configuration') }] }),
    ui.child(ui.list({ id: 'tools', role: 'browse', filterable: true, selectedIds: [], items: server.toolsVisible.map(schema => ({ id: schema.name, label: schema.name.slice(prefix.length), detail: firstSentence(schema.description) })), empty: ui.empty({ title: t(server.registeredCount > 0 ? 'No tools visible to this session' : 'No tools registered') }) }), { tab: { controlId: 'server-pages', itemId: 'tools' } }),
    ui.child(ui.scroll(serverConfigNode(server, t), { scrollbar: true }), { tab: { controlId: 'server-pages', itemId: 'config' }, basis: 0, grow: 1, minSize: 1 }),
    ui.actions({ id: 'server-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'close', label: t('Close'), dismiss: true }] }),
  ]) })
}

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  const t = interactionTranslator(ctx)
  ctx.commands.register({ name: 'mcp', description: t('List the MCP servers the host connects to'), handler: async invocation => {
    const agent = invocation.agent
    const signal = AbortSignal.any([lifetime.signal, invocation.signal])
    const current = () => !signal.aborted && ctx.mayflyCurrentAgent.current() === agent
    if (!current()) return { kind: 'success' }
    if (ctx.mayflyOverlays.focus('mayfly.mcp')) return { kind: 'success' }
    try {
      let catalog = await collectMcpServers(ctx, agent)
      if (!current()) return { kind: 'success' }
      if (ctx.mayflyOverlays.focus('mayfly.mcp')) return { kind: 'success' }
      let root: MayflyOverlayHandle | undefined
      let server: { readonly id: string, readonly handle: MayflyOverlayHandle, name: string, node: MayflyUiNode } | undefined
      let generation = 0
      let available = true
      const view = () => ui.surface({ title: t('MCP servers'), chrome: 'overlay', padding: 1, child: ui.stack.column([
        ...available ? [] : [ui.text(t('MCP catalog unavailable; showing the last snapshot'), { tone: 'danger' })],
        ui.list({ id: 'servers', role: 'browse', selectedIds: [], filterable: true, items: serverItems(catalog, t), empty: ui.empty({ title: t('No MCP servers are declared') }) }),
        ...catalog.orphanCount === 0 ? [] : [ui.text(t('{count} registered MCP tools have no declared server', { count: catalog.orphanCount }), { tone: 'muted' })],
        ui.actions({ id: 'mcp-actions', items: [{ id: 'refresh', label: t('Refresh') }, { id: 'close', label: t('Close'), dismiss: true }] }),
      ]) })
      const publish = () => {
        if (!current() || root?.closed !== false) return
        root.set(view())
        if (server?.handle.closed === false) {
          const latest = catalog.servers.find(item => item.entryId === server!.id)
          if (latest === undefined) { server.handle.close(); server = undefined }
          else {
            if (server.name !== latest.serverName) { ctx.mayflyOverlays.close('mayfly.mcp.tool'); server.name = latest.serverName }
            const next = available ? mcpServerNode(latest, t) : ui.stack.column([ui.text(t('MCP catalog unavailable; showing the last snapshot'), { tone: 'danger' }), mcpServerNode(latest, t)])
            if (!isDeepStrictEqual(next, server.node)) { server.node = next; server.handle.set(next) }
          }
        }
      }
      const refresh = async () => {
        const revision = ++generation
        let latest: McpCatalog
        try { latest = await collectMcpServers(ctx, agent) } catch (error) {
          if (current() && root?.closed === false && generation === revision) { available = false; publish() }
          throw error
        }
        if (!current() || root?.closed !== false || generation !== revision) return
        catalog = latest
        available = true
        publish()
      }
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => { scheduled = false; if (current() && root?.closed === false) void refresh().catch(() => {}) })
      }
      root = await openAgentOverlay(ctx, agent, { id: 'mayfly.mcp', presentation: 'editor', capturing: true }, view(), owner => {
        owner.on('tools/change', schedule)
        owner.effect(() => observeInteractionLocale(owner, publish))
        return async (event, context) => {
          if (event.kind === 'activate' && event.actionId === 'refresh') { await refresh(); return { kind: 'completed' } }
          if (event.kind !== 'selection-accept' || event.controlId !== 'servers') return { kind: 'completed' }
          await refresh()
          if (context.signal.aborted || !current()) return { kind: 'cancelled' }
          const selected = catalog.servers.find(server => server.entryId === event.selectedIds[0])
          if (selected === undefined) return { kind: 'failed', message: t('The MCP server is no longer available') }
          ctx.mayflyOverlays.close('mayfly.mcp.server')
          const handle = await openAgentOverlay(owner, agent, { id: 'mayfly.mcp.server', presentation: 'editor', capturing: true }, mcpServerNode(selected, t), scope => async (event, context) => {
            if (event.kind === 'activate' && event.actionId === 'refresh') { await refresh(); return { kind: 'completed' } }
            if (event.kind !== 'selection-accept' || event.controlId !== 'tools') return { kind: 'completed' }
            await refresh()
            if (context.signal.aborted || !current()) return { kind: 'cancelled' }
            const tool = catalog.servers.find(server => server.entryId === selected.entryId)?.toolsVisible.find(tool => tool.name === event.selectedIds[0])
            return tool !== undefined && await openToolDetail(scope, agent, { id: 'mayfly.mcp.tool', name: tool.name, signal }) ? { kind: 'completed' } : { kind: 'failed', message: t('The tool is no longer available') }
          }, signal)
          if (handle !== undefined) server = { id: selected.entryId, handle, name: selected.serverName, node: mcpServerNode(selected, t) }
          publish()
          return { kind: 'completed' }
        }
      }, signal)
      await refresh()
      return { kind: 'success' }
    } catch (error) { return current() ? { kind: 'error', text: error instanceof Error ? error.message : String(error) } : { kind: 'success' } }
  } })
}
