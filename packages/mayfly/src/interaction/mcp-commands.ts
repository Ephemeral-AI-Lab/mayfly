/** Read-only MCP server inspection over native catalogs and one shared panel.
 * @module @ephemeral-ai/mayfly/interaction/mcp-commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import { panel, ui, type MayflyField, type MayflyListItem, type MayflyOverlayHandle, type MayflySubmission, type MayflyTone, type MayflyUiActionEvent, type MayflyUiActionReply, type MayflyUiEventContext, type MayflyUiNode, type MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { collectMcpServers, type McpCatalog, type McpServerView, type McpStatus } from './mcp-servers.ts'
import { listMcpResources, readMcpResource, resourceItems } from './mcp-resources.ts'
import { firstSentence } from './tools-commands.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { interactionTranslator, mountInteractionLocale, observeInteractionLocale } from './locale.ts'

export const name = 'mayfly-mcp-command'
export const inject = ['commands', 'tools', 'mayflyCurrentAgent', 'mayflyOverlays']
const STATUS_ORDER: readonly McpStatus[] = ['no-tools', 'restricted', 'synced']
const STATUS_TONE: Readonly<Record<McpStatus, MayflyTone>> = { synced: 'success', restricted: 'warning', 'no-tools': 'warning' }
const SERVER_TABS = ['tools', 'config', 'resources'] as const
type ServerTab = typeof SERVER_TABS[number]
type Page = 'list' | 'server' | 'tool' | 'resource' | 'body'
const describe = (error: unknown) => error instanceof Error ? error.message : String(error)

export function serverItems(catalog: McpCatalog, t: MayflyTranslate): readonly MayflyListItem[] {
  return catalog.servers.toSorted((left, right) => STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status) || left.serverName.localeCompare(right.serverName)).map(server => ({
    id: server.entryId, label: server.serverName,
    cells: [
      { spans: [{ text: t(server.status), tone: STATUS_TONE[server.status] }], min: 10, shed: 2 },
      { spans: [{ text: t('{visible}/{registered} tools', { visible: server.toolsVisible.length, registered: server.registeredCount }) }], align: 'right', min: 12, shed: 1 },
    ],
    searchText: server.serverName,
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
    /* No native service reports an MCP client's transport, endpoint, or
       health. Label the fields unresolved instead of showing a fabricated
       connection or reading a loader entry. */
    ui.divider({ label: t('Connection') }),
    ui.fields([
      field(t('Transport'), t('(not resolved)')),
      field(t('Endpoint'), t('(not resolved)')),
    ]),
  ])
}

/** The per-server page state: the active tab and, once read, the resource catalog. */
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

function listPanel(catalog: McpCatalog, available: boolean, t: MayflyTranslate): MayflyUiNode {
  return panel({ title: t('MCP servers'), escapeLabel: 'close', body: ui.stack.column([
    ...available ? [] : [ui.text(t('MCP catalog unavailable; showing the last snapshot'), { tone: 'danger' })],
    ui.list({ id: 'servers', role: 'browse', selectedIds: [], filterable: true, filterMode: 'slash', items: serverItems(catalog, t), empty: ui.empty({ title: t('No MCP servers are declared') }) }),
    ...catalog.orphanCount === 0 ? [] : [ui.text(t('{count} registered MCP tools have no declared server', { count: catalog.orphanCount }), { tone: 'muted' })],
    ui.actions({ id: 'mcp-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
  ]) })
}

function serverPage(server: McpServerView, tab: ServerTab, resources: ResourceState | undefined, t: MayflyTranslate): MayflyUiNode {
  const prefix = `mcp__${server.serverName}__`
  const tools = server.toolsVisible.map(schema => ({ id: schema.name, label: schema.name.slice(prefix.length), detail: firstSentence(schema.description) }))
  const toolPage = ui.list({ id: 'tools', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: [], items: tools, empty: ui.empty({ title: t(server.registeredCount > 0 ? 'No tools visible to this session' : 'No tools registered') }) })
  const configPage = ui.scroll(serverConfigNode(server, t), { scrollbar: true })
  let resourcesPage: MayflyUiNode
  if (resources === undefined || resources.loading && resources.items.length === 0) {
    resourcesPage = ui.loader({})
  } else if (resources.error !== undefined) {
    resourcesPage = ui.text(resources.error, { tone: 'danger', overflow: 'wrap' })
  } else {
    resourcesPage = ui.stack.column([
      ui.text(resources.templates ? t('Templates') : t('Resources'), { tone: 'muted' }),
      ui.list({ id: 'resources', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: [], items: resourceItems(resources.items), empty: ui.empty({ title: 'No resources' }) }),
      ...resources.loading ? [ui.loader({})] : [],
    ])
  }
  return panel({ title: server.serverName, escapeLabel: 'back', body: ui.stack.column([
    ui.tabs({ id: 'server-pages', activeId: tab, items: [
      { id: 'tools', label: t('Tools'), count: server.toolsVisible.length },
      { id: 'config', label: t('Configuration') },
      { id: 'resources', label: t('Resources') },
    ] }),
    ui.child(toolPage, { tab: { controlId: 'server-pages', itemId: 'tools' }, grow: 1, minSize: 1 }),
    ui.child(configPage, { tab: { controlId: 'server-pages', itemId: 'config' }, grow: 1, minSize: 1 }),
    ui.child(resourcesPage, { tab: { controlId: 'server-pages', itemId: 'resources' }, grow: 1, minSize: 1 }),
    ui.actions({ id: 'server-actions', items: [
      { id: 'resources', label: t('Resources'), hintLabel: t('resources'), key: 'v', hidden: true },
      { id: 'templates', label: t('Templates'), hintLabel: t('templates'), key: 't', hidden: true },
      ...tab === 'resources' && resources?.cursor !== undefined && !resources.loading ? [{ id: 'more', label: t('More'), hintLabel: t('more'), key: 'm', hidden: true }] : [],
      { id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true },
    ] }),
  ]) })
}

function toolPanel(server: McpServerView, schema: ToolSchema, t: MayflyTranslate): MayflyUiNode {
  return panel({ title: schema.name, subtitle: server.serverName, escapeLabel: 'back', body: ui.stack.column([
    ui.child(ui.scroll(ui.stack.column([
      ui.fields([{ label: t('Name'), value: [{ text: schema.name }] }]),
      ui.divider({ label: t('Description') }),
      schema.description.length === 0 ? ui.text(t('(no description)'), { tone: 'muted' }) : ui.markdown(schema.description),
      ui.divider({ label: t('Parameters') }),
      schema.parameters === undefined ? ui.text(t('(no parameters)'), { tone: 'muted' }) : ui.code(JSON.stringify(schema.parameters, null, 2), { language: 'json' }),
    ]), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
    ui.actions({ id: 'tool-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
  ]) })
}

function resourcePanel(server: McpServerView, resource: ResourceState, index: number, t: MayflyTranslate): MayflyUiNode {
  const item = resource.items[index]!
  const initial = String(item.uri ?? item.uriTemplate ?? '')
  return panel({ title: String(item.name ?? initial), subtitle: server.serverName, escapeLabel: 'back', body: ui.stack.column([
    ...typeof item.description === 'string' && item.description !== '' ? [ui.text(item.description, { tone: 'muted', overflow: 'wrap' })] : [],
    ui.form({ id: 'resource-uri', enterSubmits: 'read', fields: [{ kind: 'input', id: 'uri', label: t('Resource URI'), value: initial }] }),
    ui.actions({ id: 'resource-actions', items: [{ id: 'read', label: t('Read'), hintLabel: t('read'), hidden: true, read: [{ pagePath: [], formId: 'resource-uri' }] }] }),
  ]) })
}

function resourceBodyPanel(server: McpServerView, state: ViewState, t: MayflyTranslate): MayflyUiNode {
  const text = state.bodyText ?? ''
  return panel({ title: state.bodyLabel ?? t('Resources'), subtitle: server.serverName, escapeLabel: 'back', body: ui.stack.column([ui.child(ui.scroll(ui.text(text === '' ? t('(no output)') : text, { overflow: 'wrap' }), { id: 'resource-body', scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })]) })
}

/** The server page with its Tools, Configuration, and Resources tabs, as its own panel. */
export function mcpServerNode(server: McpServerView, t: MayflyTranslate): MayflyUiNode {
  return serverPage(server, 'tools', undefined, t)
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
      let handle: MayflyOverlayHandle | undefined
      let available = true
      let generation = 0
      let resourceGeneration = 0
      const state = emptyState()
      const selectedServer = () => catalog.servers.find(item => item.entryId === state.serverId)
      const render = (): MayflyUiNode => {
        if (state.page === 'list') return listPanel(catalog, available, t)
        const server = selectedServer()
        if (server === undefined) return listPanel(catalog, available, t)
        if (state.page === 'tool') {
          const schema = server.toolsVisible.find(item => item.name === state.toolName)
          return schema === undefined ? serverPage(server, 'tools', state.resource, t) : toolPanel(server, schema, t)
        }
        if (state.page === 'resource') {
          return state.resource === undefined || state.resourceIndex === undefined || state.resource.items[state.resourceIndex] === undefined
            ? serverPage(server, 'resources', state.resource, t)
            : resourcePanel(server, state.resource, state.resourceIndex, t)
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
          else if (state.page === 'body' && state.resource === undefined) state.page = 'server'
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
      const readResource = async (submission: MayflySubmission | undefined): Promise<MayflyUiActionReply> => {
        const resource = state.resource
        const server = selectedServer()
        const index = state.resourceIndex
        const item = resource === undefined || index === undefined ? undefined : resource.items[index]
        if (resource === undefined || server === undefined || item === undefined) return { kind: 'failed', message: t('The MCP server is no longer available') }
        const submitted = submission?.forms[0]?.fields.find(field => field.id === 'uri')?.value
        const uri = typeof submitted === 'string' && submitted.trim() !== '' ? submitted : String(item.uri ?? item.uriTemplate ?? '')
        if (uri.trim() === '') return { kind: 'failed', message: 'Enter a resource URI' }
        try {
          const text = await readMcpResource(ctx, agent, server.serverName, uri, signal)
          if (!current() || handle?.closed !== false) return { kind: 'cancelled' }
          state.bodyText = text
          state.bodyLabel = String(item.name ?? uri)
          state.page = 'body'
          publish()
          return { kind: 'completed' }
        } catch (error) { return { kind: 'failed', message: describe(error) } }
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
          if (event.actionId === 'read') return readResource(event.inputs)
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
      }, render(), { reopen: 'focus', signal, onClosed: () => cleanup() })
      if (handle === undefined) return { kind: 'success' }
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
