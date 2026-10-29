/**
 * Construction-frozen MCP and tool catalog presentations with narrow-layout behavior.
 * @module @ephemeral-ai/mayfly/remote/panels/catalog
 */

import type { MayflyMcpCatalog, MayflyMcpServer, MayflyMcpStatus, MayflyToolCatalog, MayflyToolSchema } from '@ephemeral-ai/mayfly-host/types'
import { browser, panel, ui, type MayflyActionItem, type MayflyField, type MayflyListItem, type MayflyTone, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { RemoteMcpResourceItem } from '../features/mcp-resources.ts'

/** Return the first non-empty sentence of a tool description. */
export function remoteFirstSentence(description: string): string {
  const line = description.split(/\r?\n/u).map(line => line.trim()).find(line => line.length > 0) ?? ''
  const end = /(?<=[.!?])\s|(?<=[。！？])(?=.)/u.exec(line)
  return end === null ? line : line.slice(0, end.index)
}

const MCP_STATUS_ORDER: readonly MayflyMcpStatus[] = ['no-tools', 'restricted', 'synced']
const MCP_STATUS_TONE: Readonly<Record<MayflyMcpStatus, MayflyTone>> = { synced: 'success', restricted: 'warning', 'no-tools': 'warning' }
const MCP_CONNECTION_TONE: Readonly<Record<'connecting' | 'connected' | 'reconnecting' | 'disconnected', MayflyTone>> = { connected: 'success', connecting: 'default', reconnecting: 'warning', disconnected: 'danger' }

/** Build MCP server rows ordered by visibility status and name. */
export function remoteMcpServerItems(catalog: MayflyMcpCatalog, t: MayflyTranslate, tr: MayflyTranslate): readonly MayflyListItem[] {
  return catalog.servers.toSorted((left, right) => MCP_STATUS_ORDER.indexOf(left.status) - MCP_STATUS_ORDER.indexOf(right.status) || left.serverName.localeCompare(right.serverName)).map(server => ({
    id: server.entryId,
    label: server.serverName,
    cells: [
      { spans: [{ text: t(server.status), tone: MCP_STATUS_TONE[server.status] }], min: 10, shed: 2 },
      ...server.connection === undefined ? [] : [{ spans: [{ text: tr(server.connection), tone: MCP_CONNECTION_TONE[server.connection] }], min: 9, shed: 3 }],
      { spans: [{ text: t('{visible}/{registered} tools', { visible: server.toolsVisible.length, registered: server.registeredCount }) }], align: 'right', min: 12, shed: 1 },
    ],
    searchText: server.serverName,
  }))
}

function field(label: string, text: string, tone: MayflyTone = 'default'): MayflyField {
  return { label, value: [{ text, tone }] }
}

/** Build the non-secret MCP status and connection fields. */
export function remoteMcpConfigNode(server: MayflyMcpServer, t: MayflyTranslate, tr: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([
    ui.divider({ label: t('Status') }),
    ui.fields([
      field(t('Status'), t(server.status), MCP_STATUS_TONE[server.status]),
      field(t('Registered tools'), String(server.registeredCount)),
      field(t('Visible tools'), String(server.toolsVisible.length)),
    ]),
    ...server.status === 'no-tools' && server.connection === undefined ? [ui.text(t('No tools registered; connection state is unavailable'), { tone: 'muted' })] : [],
    ...server.status === 'no-tools' && server.connection === 'disconnected' ? [ui.text(tr('Configured server is not connected; no tools are registered'), { tone: 'muted' })] : [],
    ...server.status === 'restricted' ? [ui.text(t('Tools are registered but restricted for this Agent'), { tone: 'muted' })] : [],
    ui.divider({ label: t('Connection') }),
    ui.fields([
      field(t('Connection'), server.connection === undefined ? tr('(connection unknown)') : tr(server.connection), server.connection === undefined ? 'muted' : MCP_CONNECTION_TONE[server.connection]),
      field(t('Transport'), server.config.transport ?? t('(not resolved)')),
      field(t('Endpoint'), server.config.endpoint ?? t('(not resolved)')),
    ]),
  ])
}

/** Build the MCP server list with orphan counts and explicit refresh. */
export function remoteMcpListNode(catalog: MayflyMcpCatalog | undefined, error: string | undefined, t: MayflyTranslate, tr: MayflyTranslate): MayflyUiNode {
  return panel({
    title: t('MCP servers'),
    escapeLabel: 'close',
    body: ui.stack.column([
      ...error === undefined ? [] : [ui.text(error, { tone: 'danger', overflow: 'wrap' })],
      ui.list({
        id: 'servers', role: 'browse', selectedIds: [], filterable: true, filterMode: 'slash',
        items: catalog === undefined ? [] : remoteMcpServerItems(catalog, t, tr),
        empty: ui.empty({ title: t('No MCP servers are declared') }),
      }),
      ...catalog === undefined || catalog.orphanCount === 0 ? [] : [ui.text(t('{count} registered MCP tools have no declared server', { count: catalog.orphanCount }), { tone: 'muted' })],
      ui.actions({ id: 'mcp-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}

/** MCP server tabs supported by the current Host contract. */
export type RemoteMcpServerTab = 'tools' | 'config' | 'resources'

/** Resources-tab state owned by the catalog feature: gate, paging, and one open body. */
export interface RemoteMcpResourcesState {
  /** Whether the Host advertises the `mcpResources` capability. */
  readonly enabled: boolean
  /** Precise `unavailableCapability` copy shown while `enabled` is false. */
  readonly unavailable: string
  readonly kind: 'resources' | 'templates'
  readonly items: readonly RemoteMcpResourceItem[]
  /** The server-owned continuation cursor of the loaded pages. */
  readonly cursor: string | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly detail?: { readonly uri: string, readonly text: string } | undefined
  readonly reading: boolean
}

function resourceRow(item: RemoteMcpResourceItem): MayflyListItem {
  const label = item.name ?? item.uri
  const detail = item.description ?? item.mimeType
  return { id: item.uri, label, ...detail === undefined ? {} : { detail }, searchText: item.uri }
}

/** Build the paged Resources tab: kind switch, cursor paging, and one read body. */
export function remoteMcpResourcesNode(state: RemoteMcpResourcesState, t: MayflyTranslate, tr: MayflyTranslate): MayflyUiNode {
  if (!state.enabled) return ui.empty({ title: t('MCP resources unavailable'), description: state.unavailable })
  if (state.detail !== undefined) {
    return ui.scroll(ui.stack.column([
      ui.fields([{ label: t('Name'), value: [{ text: state.detail.uri }] }]),
      ...state.reading ? [ui.text(tr('Reading…'), { tone: 'muted' })] : [],
      ui.code(state.detail.text === '' ? t('(no description)') : state.detail.text),
    ]), { id: 'resource-document', scrollbar: true })
  }
  return ui.stack.column([
    ui.tabs({ id: 'resource-kind', activeId: state.kind, items: [
      { id: 'resources', label: t('Resources'), ...state.kind === 'resources' ? { count: state.items.length } : {} },
      { id: 'templates', label: tr('Templates'), ...state.kind === 'templates' ? { count: state.items.length } : {} },
    ] }),
    ...state.error === undefined ? [] : [ui.text(state.error, { tone: 'danger', overflow: 'wrap' })],
    ui.list({
      id: 'resource-items',
      role: 'browse',
      filterable: true,
      filterMode: 'slash',
      marker: 'selection',
      acceptVerb: 'open',
      selectedIds: [],
      items: state.items.map(resourceRow),
      empty: ui.empty({ title: tr(state.kind === 'resources' ? 'No resources' : 'No resource templates'), ...state.loading ? { description: tr('Loading…') } : {} }),
    }),
    ...state.loading && state.items.length > 0 ? [ui.text(tr('Loading…'), { tone: 'muted' })] : [],
    ui.actions({ id: 'resource-actions', items: [
      { id: 'more', label: tr('Load more'), disabled: state.cursor === undefined, ...state.cursor === undefined ? { disabledReason: tr('End of catalog') } : {}, busy: state.loading },
    ] }),
  ])
}

/** Build one MCP server's Tools, Configuration, and paged Resources tabs. */
export function remoteMcpServerNode(server: MayflyMcpServer, tab: RemoteMcpServerTab, resources: RemoteMcpResourcesState, t: MayflyTranslate, tr: MayflyTranslate): MayflyUiNode {
  const prefix = `mcp__${server.serverName}__`
  const tools = server.toolsVisible.map(schema => ({ id: schema.name, label: schema.name.slice(prefix.length), detail: remoteFirstSentence(schema.description) }))
  return panel({
    title: server.serverName,
    escapeLabel: 'back',
    body: ui.stack.column([
      ui.tabs({ id: 'server-pages', activeId: tab, items: [
        { id: 'tools', label: t('Tools'), count: server.toolsVisible.length },
        { id: 'config', label: t('Configuration') },
        { id: 'resources', label: t('Resources') },
      ] }),
      ui.child(ui.list({ id: 'tools', role: 'browse', filterable: true, filterMode: 'slash', selectedIds: [], items: tools, empty: ui.empty({ title: t(server.registeredCount > 0 ? 'No tools visible to this session' : 'No tools registered') }) }), { tab: { controlId: 'server-pages', itemId: 'tools' }, grow: 1, minSize: 1 }),
      ui.child(ui.scroll(remoteMcpConfigNode(server, t, tr), { scrollbar: true }), { tab: { controlId: 'server-pages', itemId: 'config' }, grow: 1, minSize: 1 }),
      ui.child(remoteMcpResourcesNode(resources, t, tr), { tab: { controlId: 'server-pages', itemId: 'resources' }, grow: 1, minSize: 1 }),
      ui.actions({ id: 'server-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}

/** Build a full MCP tool description and JSON Schema page. */
export function remoteMcpToolNode(server: MayflyMcpServer, schema: MayflyToolSchema, t: MayflyTranslate): MayflyUiNode {
  return panel({
    title: schema.name,
    subtitle: server.serverName,
    escapeLabel: 'back',
    body: ui.stack.column([
      ui.child(ui.scroll(ui.stack.column([
        ui.fields([{ label: t('Name'), value: [{ text: schema.name }] }]),
        ui.divider({ label: t('Description') }),
        schema.description.length === 0 ? ui.text(t('(no description)'), { tone: 'muted' }) : ui.markdown(schema.description),
        ui.divider({ label: t('Parameters') }),
        ui.code(JSON.stringify(schema.parameters, null, 2), { language: 'json' }),
      ]), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
      ui.actions({ id: 'tool-actions', items: [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}

function toolDetailBody(schema: MayflyToolSchema, t: MayflyTranslate): MayflyUiNode {
  return ui.stack.column([ui.child(ui.scroll(ui.stack.column([
    ui.fields([{ label: t('Name'), value: [{ text: schema.name }] }]),
    ui.divider({ label: t('Description') }),
    schema.description.length === 0 ? ui.text(t('(no description)'), { tone: 'muted' }) : ui.markdown(schema.description),
    ui.divider({ label: t('Parameters') }),
    ui.code(JSON.stringify(schema.parameters, null, 2), { language: 'json' }),
  ]), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 })])
}

function toolList(id: string, schemas: readonly MayflyToolSchema[], t: MayflyTranslate): MayflyUiNode {
  return ui.list({
    id,
    role: 'browse',
    filterable: true,
    filterMode: 'slash',
    marker: 'selection',
    acceptVerb: 'open',
    selectedIds: [],
    items: schemas.map(schema => ({ id: schema.name, label: schema.name, detail: remoteFirstSentence(schema.description) })),
    empty: ui.empty({ title: t('No tools visible to this session') }),
  })
}

/** Build the responsive global tool browser with list/detail narrow-mode switching. */
export function remoteToolsNode(
  catalog: MayflyToolCatalog | undefined,
  focused: string | undefined,
  detailMode: boolean,
  error: string | undefined,
  t: MayflyTranslate,
): MayflyUiNode {
  const schemas = catalog?.tools ?? []
  const selected = schemas.find(schema => schema.name === focused) ?? schemas[0]
  const detailOpen = detailMode && selected !== undefined
  const actions: MayflyActionItem[] = [{ id: 'refresh', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }]
  return panel({
    title: detailOpen && selected !== undefined ? selected.name : t('Tools'),
    escapeLabel: detailOpen ? 'back' : 'close',
    body: ui.stack.column([
      ...error === undefined ? [] : [ui.text(error, { tone: 'danger', overflow: 'wrap' })],
      browser({
        list: toolList('tools', schemas, t),
        listNarrow: toolList('tools-narrow', schemas, t),
        detail: selected === undefined ? ui.text(t('No tools visible to this session'), { tone: 'muted' }) : toolDetailBody(selected, t),
        narrow: detailOpen ? 'detail' : 'list',
      }),
      ui.actions({ id: 'catalog-actions', items: actions }),
    ]),
  })
}
