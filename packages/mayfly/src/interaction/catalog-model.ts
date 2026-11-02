/** Readonly rc.2 tool and MCP catalog presentation shared by native and Remote owners.
 * @module @ephemeral-ai/mayfly/interaction/catalog-model
 */
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { browser, panel, ui, type MayflyActionItem, type MayflyField, type MayflyListItem, type MayflyTone, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'

/** Readonly public MCP server facts; native owners retain their service objects. */
export interface McpServerFacts {
  readonly entryId: string
  readonly serverName: string
  readonly status: 'no-tools' | 'restricted' | 'synced' | 'unknown'
  readonly registeredCount: number
  readonly toolsVisible: readonly ToolSchema[]
}
/** One whole MCP catalog supplied by its exact Session owner. */
export interface McpCatalogFacts {
  readonly servers: readonly McpServerFacts[]
  readonly orphanCount: number
}
/** A textual summary, independent of terminal geometry. */
export function firstSentence(description: string): string {
  const line = description.split(/\r?\n/u).map(line => line.trim()).find(line => line.length > 0) ?? ''
  const end = /(?<=[.!?])\s|(?<=[。！？])(?=.)/u.exec(line)
  return end === null ? line : line.slice(0, end.index)
}

export function sortedSchemas(schemas: readonly ToolSchema[]): readonly ToolSchema[] {
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

export const detailActions = (t: MayflyTranslate) => ui.actions({ id: 'tool-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] })

/** Preserve the full description and JSON Schema; core alone wraps their text. */
export function toolDetailNode(schema: ToolSchema, t: MayflyTranslate): MayflyUiNode {
  return ui.surface({ title: schema.name, chrome: 'overlay', padding: 1, child: ui.stack.column([toolDetailBody(schema, t), detailActions(t)]) })
}


/** One list page for the tool browser. */
function toolList(id: string, items: readonly MayflyListItem[], t: MayflyTranslate): MayflyUiNode {
  return ui.list({
    id, role: 'browse', filterable: true, filterMode: 'slash', marker: 'selection', acceptVerb: 'open', selectedIds: [], items,
    empty: ui.empty({ title: t('No tools visible to this session') }),
  })
}


const STATUS_ORDER: readonly McpServerFacts['status'][] = ['unknown', 'no-tools', 'restricted', 'synced']
const STATUS_TONE: Readonly<Record<McpServerFacts['status'], MayflyTone>> = { unknown: 'muted', synced: 'success', restricted: 'warning', 'no-tools': 'warning' }
const SERVER_TABS = ['tools', 'config', 'resources'] as const
export type ServerTab = typeof SERVER_TABS[number]
export function serverItems(catalog: McpCatalogFacts, t: MayflyTranslate): readonly MayflyListItem[] {
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

export function serverConfigNode(server: McpServerFacts, t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([
    ui.divider({ label: t('Status') }),
    ui.fields([
      field(t('Status'), t(server.status), STATUS_TONE[server.status]),
      field(t('Registered tools'), String(server.registeredCount)),
      field(t('Visible tools'), String(server.toolsVisible.length)),
    ]),
    ...server.status === 'no-tools' ? [ui.text(t('No tools registered; connection state is unavailable'), { tone: 'muted' })] : [],
    ...server.status === 'restricted' ? [ui.text(t('Tools are registered but restricted for this Agent'), { tone: 'muted' })] : [],
    ...server.status === 'unknown' ? [ui.text(t('Live tool availability is unknown while the server is not connected'), { tone: 'muted' })] : [],
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
export interface ResourceState {
  readonly templates: boolean
  readonly items: readonly Record<string, unknown>[]
  readonly cursor: string | undefined
  readonly loading: boolean
  readonly loaded: boolean
  readonly error: string | undefined
}

export function listPanel(catalog: McpCatalogFacts, available: boolean, t: MayflyTranslate): MayflyUiNode {
  return panel({ title: t('MCP servers'), escapeLabel: 'close', body: ui.stack.column([
    ...available ? [] : [ui.text(t('MCP catalog unavailable; showing the last snapshot'), { tone: 'danger' })],
    ui.list({ id: 'servers', role: 'browse', selectedIds: [], filterable: true, filterMode: 'slash', items: serverItems(catalog, t), empty: ui.empty({ title: t('No MCP servers are declared') }) }),
    ...catalog.orphanCount === 0 ? [] : [ui.text(t('{count} registered MCP tools have no declared server', { count: catalog.orphanCount }), { tone: 'muted' })],
    ui.actions({ id: 'mcp-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
  ]) })
}

export function serverPage(server: McpServerFacts, tab: ServerTab, resources: ResourceState | undefined, t: MayflyTranslate): MayflyUiNode {
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

export function toolPanel(server: McpServerFacts, schema: ToolSchema, t: MayflyTranslate): MayflyUiNode {
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

export function resourcePanel(server: McpServerFacts, resource: ResourceState, index: number, t: MayflyTranslate): MayflyUiNode {
  const item = resource.items[index]!
  const initial = String(item.uri ?? item.uriTemplate ?? '')
  return panel({ title: String(item.name ?? initial), subtitle: server.serverName, escapeLabel: 'back', body: ui.stack.column([
    ...typeof item.description === 'string' && item.description !== '' ? [ui.text(item.description, { tone: 'muted', overflow: 'wrap' })] : [],
    ui.form({ id: 'resource-uri', enterSubmits: 'read', fields: [{ kind: 'input', id: 'uri', label: t('Resource URI'), value: initial }] }),
    ui.actions({ id: 'resource-actions', items: [{ id: 'read', label: t('Read'), hintLabel: t('read'), hidden: true, read: [{ pagePath: [], formId: 'resource-uri' }] }] }),
  ]) })
}

export function resourceBodyPanel(server: McpServerFacts, state: { readonly bodyText?: string | undefined, readonly bodyLabel?: string | undefined }, t: MayflyTranslate): MayflyUiNode {
  const text = state.bodyText ?? ''
  return panel({ title: state.bodyLabel ?? t('Resources'), subtitle: server.serverName, escapeLabel: 'back', body: ui.stack.column([ui.child(ui.scroll(ui.text(text === '' ? t('(no output)') : text, { overflow: 'wrap' }), { id: 'resource-body', scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })]) })
}

/** The server page with its Tools, Configuration, and Resources tabs, as its own panel. */
export function mcpServerNode(server: McpServerFacts, t: MayflyTranslate): MayflyUiNode {
  return serverPage(server, 'tools', undefined, t)
}


/** The rows of one resource or template page: the name, with the URI as the row's description. */
export function resourceItems(items: readonly Record<string, unknown>[]): readonly MayflyListItem[] {
  return items.map((item, index) => ({
    id: String(index),
    label: String(item.name ?? item.uri ?? item.uriTemplate ?? index),
    detail: String(item.description ?? item.uri ?? item.uriTemplate ?? ''),
    searchText: [item.name, item.uri, item.uriTemplate, item.description].filter(value => typeof value === 'string').join(' '),
  }))
}

/** The immutable responsive tool browser, parameterized by the owner's current facts. */
export function toolsBrowserNode(schemas: readonly ToolSchema[], focused: string | undefined, detailMode: boolean, available: boolean, t: MayflyTranslate): MayflyUiNode {
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
