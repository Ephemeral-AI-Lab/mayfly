/** Read-only MCP server inspection over native catalogs and one shared panel.
 * @module @ephemeral-ai/mayfly/interaction/mcp-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { type MayflyOverlayHandle, type MayflySubmission, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiEventContext, type MayflyUiNode, type MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { collectMcpServers, type McpCatalog } from './mcp-servers.ts'
import { listMcpResources, readMcpResource } from './mcp-resources.ts'
import { listPanel, serverPage, toolPanel, resourcePanel, resourceBodyPanel } from './catalog-model.ts'
export { serverItems, serverConfigNode, mcpServerNode } from './catalog-model.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-mcp-command'
export const inject = ['commands', 'tools', 'mayflyCurrentAgent', 'mayflyOverlays']
const SERVER_TABS = ['tools', 'config', 'resources'] as const
type ServerTab = typeof SERVER_TABS[number]
type Page = 'list' | 'server' | 'tool' | 'resource' | 'body'
const describe = (error: unknown) => error instanceof Error ? error.message : String(error)
interface ResourceState {
  readonly templates: boolean
  items: Record<string, unknown>[]
  cursor: string | undefined
  loading: boolean
  loaded: boolean
  error: string | undefined
}
interface ViewState {
  page: Page
  serverId: string
  tab: ServerTab
  toolName: string | undefined
  resource: ResourceState | undefined
  resourceIndex: number | undefined
  bodyText: string | undefined
  bodyLabel: string | undefined
}
const emptyState = (): ViewState => ({ page: 'list', serverId: '', tab: 'tools', toolName: undefined, resource: undefined, resourceIndex: undefined, bodyText: undefined, bodyLabel: undefined })

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
      let handle: MayflyOverlayHandle | undefined
      let available = true
      let generation = 0
      let resourceGeneration = 0
      const state = emptyState()
      const selectedServer = () => catalog.servers.find(item => item.entryId === state.serverId)
      const render = (): MayflyUiNode => {
        if (state.page === 'list') return listPanel(catalog, available, t)
        // Accepted transitions select real rows; refresh resets vanished rows
        // before publishing, and resource reads fence their original page.
        const server = selectedServer()!
        if (state.page === 'tool') {
          const schema = server.toolsVisible.find(item => item.name === state.toolName)!
          return toolPanel(server, schema, t)
        }
        if (state.page === 'resource') {
          return resourcePanel(server, state.resource!, state.resourceIndex!, t)
        }
        if (state.page === 'body') return resourceBodyPanel(server, state, t)
        return serverPage(server, state.tab, state.resource, t)
      }
      const publish = (): void => { if (handle?.closed === false) handle.set(render()) }
      const refresh = async (): Promise<void> => {
        const revision = ++generation
        let latest: McpCatalog
        try { latest = await collectMcpServers(ctx, agent) } catch (error) {
          if (current() && handle?.closed === false && generation === revision) { available = false; publish() }
          throw error
        }
        if (!current() || handle?.closed !== false || generation !== revision) return
        catalog = latest
        available = true
        if (state.page !== 'list') {
          const server = selectedServer()
          if (server === undefined) { state.page = 'list'; state.resource = undefined; state.resourceIndex = undefined; state.toolName = undefined }
          else if (state.page === 'tool' && !server.toolsVisible.some(item => item.name === state.toolName)) { state.page = 'server'; state.tab = 'tools'; state.toolName = undefined }
        }
        publish()
      }
      const loadResources = async (more: boolean): Promise<void> => {
        const resource = state.resource
        const server = selectedServer()
        if (resource === undefined || server === undefined || resource.loading || more && resource.cursor === undefined) return
        resource.loading = true
        const revision = ++resourceGeneration
        publish()
        try {
          const next = await listMcpResources(ctx, agent, server.serverName, resource.templates, signal, more ? resource.cursor : undefined)
          if (!current() || handle?.closed !== false || revision !== resourceGeneration || state.resource !== resource) return
          resource.items = more ? [...resource.items, ...next.items] : [...next.items]
          resource.cursor = next.cursor
          resource.loaded = true
          resource.error = undefined
        } catch (error) {
          if (current() && handle?.closed === false && revision === resourceGeneration && state.resource === resource) resource.error = describe(error)
        } finally {
          if (current() && handle?.closed === false && revision === resourceGeneration && state.resource === resource) { resource.loading = false; publish() }
        }
      }
      const openResources = (templates: boolean): void => {
        const server = selectedServer()
        if (server === undefined) return
        state.page = 'server'
        state.tab = 'resources'
        state.toolName = undefined
        if (state.resource?.templates === templates && (state.resource.loaded || state.resource.loading)) { publish(); return }
        state.resource = { templates, items: [], cursor: undefined, loading: false, loaded: false, error: undefined }
        state.resourceIndex = undefined
        ++resourceGeneration
        publish()
        void loadResources(false)
      }
      const readResource = async (submission: MayflySubmission | undefined, taskSignal: AbortSignal): Promise<MayflyUiActionReply> => {
        const resource = state.resource
        const server = selectedServer()
        const index = state.resourceIndex
        const item = resource === undefined || index === undefined ? undefined : resource.items[index]
        if (resource === undefined || server === undefined || item === undefined) return { kind: 'failed', message: t('The MCP server is no longer available') }
        const active = () => current() && !taskSignal.aborted && handle?.closed === false && state.resource === resource && state.resourceIndex === index && state.page === 'resource'
        const submitted = submission?.forms[0]?.fields.find(field => field.id === 'uri')?.value
        const uri = typeof submitted === 'string' && submitted.trim() !== '' ? submitted : String(item.uri ?? item.uriTemplate ?? '')
        if (uri.trim() === '') return { kind: 'failed', message: 'Enter a resource URI' }
        try {
          const text = await readMcpResource(ctx, agent, server.serverName, uri, AbortSignal.any([signal, taskSignal]))
          if (!active()) return { kind: 'cancelled' }
          state.bodyText = text
          state.bodyLabel = String(item.name ?? uri)
          state.page = 'body'
          publish()
          return { kind: 'completed' }
        } catch (error) { return active() ? { kind: 'failed', message: describe(error) } : { kind: 'cancelled' } }
      }
      const back = (): MayflyUiActionReply => {
        if (state.page === 'body') { state.page = 'resource'; publish(); return { kind: 'completed', dismiss: false } }
        if (state.page === 'resource') { state.page = 'server'; state.tab = 'resources'; state.resourceIndex = undefined; publish(); return { kind: 'completed', dismiss: false } }
        if (state.page === 'tool') { state.page = 'server'; state.tab = 'tools'; state.toolName = undefined; publish(); return { kind: 'completed', dismiss: false } }
        if (state.page === 'server') { state.page = 'list'; state.resource = undefined; state.resourceIndex = undefined; state.toolName = undefined; publish(); return { kind: 'completed', dismiss: false } }
        return { kind: 'completed' }
      }
      const observe = (event: MayflyUiObservationEvent): void => {
        if (event.kind !== 'tab-change' || event.controlId !== 'server-pages' || state.page !== 'server') return
        const tab = SERVER_TABS.find(item => item === event.tabId)
        if (tab === undefined) return
        if (tab === 'resources') { openResources(state.resource?.templates ?? false); return }
        state.tab = tab
        publish()
      }
      const action = async (event: MayflyUiActionEvent, context: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
        if (context.signal.aborted || !current()) return { kind: 'cancelled', dismiss: true }
        if (event.kind === 'dismiss') return back()
        if (event.kind === 'activate') {
          if (event.actionId === 'refresh') {
            try { await refresh(); return { kind: 'completed' } } catch (error) { return { kind: 'failed', message: describe(error) } }
          }
          if (event.actionId === 'resources') { openResources(false); return { kind: 'completed' } }
          if (event.actionId === 'templates') { openResources(true); return { kind: 'completed' } }
          if (event.actionId === 'more') { await loadResources(true); return { kind: 'completed' } }
          if (event.actionId === 'read') return readResource(event.inputs, context.signal)
          return { kind: 'completed' }
        }
        if (event.kind === 'selection-accept' && event.controlId === 'servers') {
          try { await refresh() } catch (error) { return { kind: 'failed', message: describe(error) } }
          const server = catalog.servers.find(item => item.entryId === event.selectedIds[0])
          if (server === undefined) return { kind: 'failed', message: t('The MCP server is no longer available') }
          state.page = 'server'
          state.serverId = server.entryId
          state.tab = 'tools'
          state.toolName = undefined
          state.resource = undefined
          state.resourceIndex = undefined
          publish()
          return { kind: 'completed' }
        }
        if (event.kind === 'selection-accept' && event.controlId === 'tools') {
          const server = selectedServer()
          if (server === undefined) return { kind: 'failed', message: t('The MCP server is no longer available') }
          const schema = server.toolsVisible.find(item => item.name === event.selectedIds[0])
          if (schema === undefined) return { kind: 'failed', message: t('The tool is no longer available') }
          state.page = 'tool'
          state.toolName = schema.name
          publish()
          return { kind: 'completed' }
        }
        if (event.kind === 'selection-accept' && event.controlId === 'resources') {
          const index = Number(event.selectedIds[0])
          if (state.resource === undefined || !Number.isInteger(index) || state.resource.items[index] === undefined) return { kind: 'cancelled' }
          state.page = 'resource'
          state.resourceIndex = index
          publish()
          return { kind: 'completed' }
        }
        return { kind: 'completed' }
      }
      let cleanup = (): void => {}
      handle = openUiOverlay(ctx, {
        id: 'mayfly.mcp', presentation: 'editor', capturing: true, dismissal: 'discard',
        scope: { kind: 'session', sessionId: agent.id },
        onEvent: { observe, action },
      }, render(), { reopen: 'focus', signal, onClosed: () => cleanup() })!
      if (handle.closed) return { kind: 'success' }
      let scheduled = false
      const schedule = (): void => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => { scheduled = false; if (current() && handle?.closed === false) void refresh().catch(() => {}) })
      }
      const offTools = ctx.on('tools/change', schedule)
      const offLocale = observeInteractionLocale(ctx, publish)
      const offAgent = ctx.mayflyCurrentAgent.subscribe(agentNow => { if (agentNow !== agent) handle?.close() })
      cleanup = () => { offTools(); offLocale(); offAgent() }
      await refresh()
      return { kind: 'success' }
    } catch (error) { return current() ? { kind: 'error', text: describe(error) } : { kind: 'success' } }
  } })
}
