/**
 * Construction-frozen Host MCP/tool catalogs, responsive browsers, and refresh ownership.
 * @module @ephemeral-ai/mayfly/remote/features/catalog
 */

import type { MayflyMcpCatalog, MayflyMcpServer, MayflyToolCatalog, MayflyToolSchema } from '@ephemeral-ai/mayfly-host/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MayflyTranslate, MayflyUiActionEvent, MayflyUiActionReply, MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import {
  remoteMcpListNode,
  remoteMcpServerNode,
  remoteMcpToolNode,
  remoteToolsNode,
  type RemoteMcpResourcesState,
  type RemoteMcpServerTab,
} from '../panels/catalog.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { unavailableCapability } from './capabilities.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'
import { remoteErrorMessage } from './official.ts'
import { loadRemoteMcpResources, readRemoteMcpResource, type RemoteMcpResourceItem } from './mcp-resources.ts'

type McpPage = 'list' | 'server' | 'tool'

/** Transport-health and Resources-tab copy owned by this lane; the shared `remote-catalog` namespace stays with the locale lane. */
const zh: Readonly<Record<string, string>> = {
  'connected': '已连接',
  'connecting': '连接中',
  'reconnecting': '重连中',
  'disconnected': '已断开',
  '(connection unknown)': '（连接状态未知）',
  'Configured server is not connected; no tools are registered': '已配置的服务器未连接；未注册工具',
  'Templates': '模板',
  'Load more': '加载更多',
  'End of catalog': '已到末尾',
  'Loading…': '正在加载…',
  'Reading…': '正在读取…',
  'No resources': '没有资源',
  'No resource templates': '没有资源模板',
  'The resource is no longer available': '资源已不可用',
}

class RemoteCatalogController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly tr: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly hostListeners = new Map<HostClient, () => void>()
  private readonly offTopology: () => void
  private mcp: MayflyMcpCatalog | undefined
  private tools: MayflyToolCatalog | undefined
  private mcpError: string | undefined
  private toolsError: string | undefined
  private features: readonly string[] | undefined
  private ticket = 0
  private operationLifetime = new AbortController()
  private mcpPanel: RemoteBrowserPanel | undefined
  private toolsPanel: RemoteBrowserPanel | undefined
  private mcpPage: McpPage = 'list'
  private serverId: string | undefined
  private serverTab: RemoteMcpServerTab = 'tools'
  private mcpToolName: string | undefined
  private focusedTool: string | undefined
  private toolDetailMode = false
  private resourceKind: 'resources' | 'templates' = 'resources'
  private resourceItems: readonly RemoteMcpResourceItem[] = []
  private resourceCursor: string | undefined
  private resourceLoaded = false
  private resourceLoading = false
  private resourceError: string | undefined
  private resourceDetail: { readonly uri: string, readonly text: string } | undefined
  private resourceReading = false
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-catalog').translate
    this.tr = memoizedLocaleTranslator(options.ctx, 'remote-mcp-resources').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.offTopology = options.hosts.subscribe(this.reconcileHosts)
    options.ctx.effect(() => options.ctx.mayflyLocale.register('remote-mcp-resources', {
      en: Object.freeze(Object.fromEntries(Object.keys(zh).map(key => [key, key]))),
      zh,
    }))
    this.reconcileHosts()
    this.lifecycle.start()
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.ticket += 1
    this.lifecycle.dispose()
    this.operationLifetime.abort()
    this.offTopology()
    for (const dispose of this.hostListeners.values()) dispose()
    this.hostListeners.clear()
    this.mcpPanel?.close()
    this.toolsPanel?.close()
  }

  private readonly reconcileHosts = (): void => {
    if (this.disposed) return
    const attached = new Set(this.options.hosts.list())
    for (const [client, dispose] of this.hostListeners) {
      if (attached.has(client)) continue
      dispose()
      this.hostListeners.delete(client)
    }
    for (const client of attached) {
      if (this.hostListeners.has(client)) continue
      this.hostListeners.set(client, client.remote.$on('agent-preset/selected', (sessionId: SessionId) => {
        const current = this.options.hosts.current()
        if (current?.client === client && current.ref.sessionId === sessionId) void this.refresh(this.lifecycle.currentGeneration())
      }))
    }
  }

  private readonly attach = (generation: number): void => {
    this.ticket += 1
    this.operationLifetime.abort()
    this.operationLifetime = new AbortController()
    this.mcp = undefined
    this.tools = undefined
    this.mcpError = undefined
    this.toolsError = undefined
    this.features = undefined
    this.mcpPanel?.close()
    this.toolsPanel?.close()
    this.mcpPanel = undefined
    this.toolsPanel = undefined
    this.mcpPage = 'list'
    this.serverId = undefined
    this.serverTab = 'tools'
    this.mcpToolName = undefined
    this.focusedTool = undefined
    this.toolDetailMode = false
    this.resetResourceState()
    if (this.lifecycle.selection(generation) !== undefined) void this.refresh(generation)
  }

  private async refresh(generation: number): Promise<void> {
    const current = this.lifecycle.selection(generation)
    if (current === undefined) return
    const ticket = ++this.ticket
    const signal = this.operationLifetime.signal
    try {
      const capabilities = await current.client.remote.mayflyHost.capabilities()
      if (signal.aborted || !this.lifecycle.owns(generation) || ticket !== this.ticket) return
      this.features = capabilities.ok ? [...capabilities.value.features] : undefined
      const [mcp, tools] = await Promise.all([
        capabilities.ok && capabilities.value.features.includes('mcpCatalog')
          ? current.client.remote.mayflyHost.mcpCatalog({ sessionId: current.ref.sessionId }, signal)
          : Promise.resolve(undefined),
        capabilities.ok && capabilities.value.features.includes('toolCatalog')
          ? current.client.remote.mayflyHost.toolCatalog({ sessionId: current.ref.sessionId }, signal)
          : Promise.resolve(undefined),
      ])
      if (!this.lifecycle.owns(generation) || ticket !== this.ticket) return
      if (!capabilities.ok) {
        this.mcpError = capabilities.error.message
        this.toolsError = capabilities.error.message
        this.mcp = undefined
        this.tools = undefined
      } else {
        if (mcp === undefined) {
          this.mcp = undefined
          this.mcpError = unavailableCapability('mcpCatalog')
        } else if (mcp.ok) {
          this.mcp = mcp.value
          this.mcpError = undefined
        } else {
          this.mcp = undefined
          this.mcpError = mcp.error.message
        }
        if (tools === undefined) {
          this.tools = undefined
          this.toolsError = unavailableCapability('toolCatalog')
        } else if (tools.ok) {
          this.tools = tools.value
          this.toolsError = undefined
        } else {
          this.tools = undefined
          this.toolsError = tools.error.message
        }
      }
    } catch (error) {
      if (!this.lifecycle.owns(generation) || ticket !== this.ticket || signal.aborted) return
      const message = remoteErrorMessage(error)
      this.mcpError = message
      this.toolsError = message
    }
    this.mcpPanel?.refresh()
    this.toolsPanel?.refresh()
  }

  private selectedServer(): MayflyMcpServer | undefined {
    return this.mcp?.servers.find(server => server.entryId === this.serverId)
  }

  /** Clear every Resources-tab fact without touching the shared operation fence. */
  private resetResourceState(): void {
    this.resourceKind = 'resources'
    this.resourceItems = []
    this.resourceCursor = undefined
    this.resourceLoaded = false
    this.resourceLoading = false
    this.resourceError = undefined
    this.resourceDetail = undefined
    this.resourceReading = false
  }

  private resourcesEnabled(): boolean {
    return this.features?.includes('mcpResources') === true
  }

  private resourcesState(): RemoteMcpResourcesState {
    return {
      enabled: this.resourcesEnabled(),
      unavailable: this.features === undefined ? this.tr('Loading…') : unavailableCapability('mcpResources'),
      kind: this.resourceKind,
      items: this.resourceItems,
      cursor: this.resourceCursor,
      loading: this.resourceLoading,
      error: this.resourceError,
      ...this.resourceDetail === undefined ? {} : { detail: this.resourceDetail },
      reading: this.resourceReading,
    }
  }

  /** Load the first page of the current kind, replacing whatever was listed. */
  private async reloadResources(): Promise<void> {
    this.resourceItems = []
    this.resourceCursor = undefined
    this.resourceLoaded = false
    this.resourceError = undefined
    this.resourceDetail = undefined
    await this.loadResources()
  }

  /** Load one page through the Host adapter with the controller's operation fence. */
  private async loadResources(): Promise<void> {
    const generation = this.lifecycle.currentGeneration()
    const current = this.lifecycle.selection(generation)
    const server = this.selectedServer()
    if (current === undefined || server === undefined || !this.resourcesEnabled()) return
    if (this.resourceLoaded && this.resourceCursor === undefined) return
    const ticket = ++this.ticket
    const signal = this.operationLifetime.signal
    this.resourceLoading = true
    this.resourceError = undefined
    this.mcpPanel?.refresh()
    try {
      const cursor = this.resourceLoaded ? this.resourceCursor : undefined
      const page = await loadRemoteMcpResources(current.client, current.ref.sessionId, {
        serverName: server.serverName,
        templates: this.resourceKind === 'templates',
        ...cursor === undefined ? {} : { cursor },
      }, signal)
      if (signal.aborted || !this.lifecycle.owns(generation) || ticket !== this.ticket) return
      this.resourceItems = this.resourceLoaded ? [...this.resourceItems, ...page.items] : page.items
      this.resourceCursor = page.nextCursor
      this.resourceLoaded = true
    } catch (error) {
      if (signal.aborted || !this.lifecycle.owns(generation) || ticket !== this.ticket) return
      this.resourceError = remoteErrorMessage(error)
    } finally {
      if (ticket === this.ticket) this.resourceLoading = false
      this.mcpPanel?.refresh()
    }
  }

  /** Read one listed resource body into the Resources tab's detail view. */
  private async readResource(uri: string): Promise<void> {
    const generation = this.lifecycle.currentGeneration()
    const current = this.lifecycle.selection(generation)
    const server = this.selectedServer()
    if (current === undefined || server === undefined || !this.resourcesEnabled()) return
    const ticket = ++this.ticket
    const signal = this.operationLifetime.signal
    this.resourceDetail = { uri, text: '' }
    this.resourceReading = true
    this.mcpPanel?.refresh()
    try {
      const body = await readRemoteMcpResource(current.client, current.ref.sessionId, server.serverName, uri, signal)
      if (signal.aborted || !this.lifecycle.owns(generation) || ticket !== this.ticket) return
      this.resourceDetail = { uri, text: body.text }
    } catch (error) {
      if (signal.aborted || !this.lifecycle.owns(generation) || ticket !== this.ticket) return
      this.resourceError = remoteErrorMessage(error)
      this.resourceDetail = undefined
    } finally {
      if (ticket === this.ticket) this.resourceReading = false
      this.mcpPanel?.refresh()
    }
  }

  private mcpView(): ReturnType<typeof remoteMcpListNode> {
    const server = this.selectedServer()
    if (this.mcpPage !== 'list' && server !== undefined) {
      if (this.mcpPage === 'tool') {
        const schema = server.toolsVisible.find(candidate => candidate.name === this.mcpToolName)
        if (schema !== undefined) return remoteMcpToolNode(server, schema, this.t)
      }
      return remoteMcpServerNode(server, this.serverTab, this.resourcesState(), this.t, this.tr)
    }
    this.mcpPage = 'list'
    return remoteMcpListNode(this.mcp, this.mcpError, this.t, this.tr)
  }

  private openMcp(): void {
    const current = this.options.hosts.current()
    if (current === undefined) return
    this.mcpPanel?.close()
    this.mcpPanel = openRemoteBrowser(this.options, {
      id: 'remote.mcp',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref),
      view: () => this.mcpView(),
      observe: event => this.observeMcp(event),
      action: event => this.mcpAction(event),
      back: () => {
        if (this.mcpPage === 'tool') {
          this.mcpPage = 'server'
          this.mcpToolName = undefined
        } else if (this.mcpPage === 'server') {
          if (this.serverTab === 'resources' && this.resourceDetail !== undefined) {
            this.resourceDetail = undefined
            this.resourceReading = false
          } else if (this.serverTab === 'resources') {
            this.resetResourceState()
            this.mcpPage = 'list'
            this.serverId = undefined
            this.serverTab = 'tools'
          } else {
            this.mcpPage = 'list'
            this.serverId = undefined
            this.serverTab = 'tools'
          }
        } else return false
        this.mcpPanel?.refresh()
        return true
      },
      onClosed: () => { this.mcpPanel = undefined },
    })
    void this.refresh(this.lifecycle.currentGeneration())
  }

  private observeMcp(event: MayflyUiObservationEvent): void {
    if (event.kind !== 'tab-change') return
    if (event.controlId === 'server-pages' && this.mcpPage === 'server') {
      if (event.tabId !== 'tools' && event.tabId !== 'config' && event.tabId !== 'resources') return
      this.serverTab = event.tabId
      if (event.tabId === 'resources' && !this.resourceLoaded && !this.resourceLoading) void this.loadResources()
      this.mcpPanel?.refresh()
      return
    }
    if (event.controlId === 'resource-kind' && this.mcpPage === 'server' && this.serverTab === 'resources') {
      if (event.tabId !== 'resources' && event.tabId !== 'templates') return
      if (event.tabId === this.resourceKind) return
      this.resourceKind = event.tabId
      void this.reloadResources()
    }
  }

  private async mcpAction(event: MayflyUiActionEvent): Promise<MayflyUiActionReply> {
    if (event.kind === 'activate' && event.actionId === 'refresh') {
      await this.refresh(this.lifecycle.currentGeneration())
      if (this.mcpPage === 'server' && this.serverTab === 'resources' && this.resourcesEnabled()) await this.reloadResources()
      return { kind: 'completed' }
    }
    if (event.kind === 'activate' && event.actionId === 'more' && this.mcpPage === 'server' && this.serverTab === 'resources') {
      await this.loadResources()
      return { kind: 'completed' }
    }
    if (event.kind === 'selection-accept' && event.controlId === 'servers') {
      await this.refresh(this.lifecycle.currentGeneration())
      const id = event.selectedIds[0]
      const server = this.mcp?.servers.find(candidate => candidate.entryId === id)
      if (server === undefined) return { kind: 'failed', message: this.t('The MCP server is no longer available') }
      this.serverId = server.entryId
      this.mcpPage = 'server'
      this.serverTab = 'tools'
      this.mcpToolName = undefined
      this.resetResourceState()
      this.mcpPanel?.refresh()
      return { kind: 'completed' }
    }
    if (event.kind === 'selection-accept' && event.controlId === 'tools' && this.mcpPanel !== undefined) {
      const server = this.selectedServer()
      const schema = server?.toolsVisible.find(candidate => candidate.name === event.selectedIds[0])
      if (server === undefined || schema === undefined) return { kind: 'failed', message: this.t('The tool is no longer available') }
      this.mcpToolName = schema.name
      this.mcpPage = 'tool'
      this.mcpPanel.refresh()
      return { kind: 'completed' }
    }
    if (event.kind === 'selection-accept' && event.controlId === 'resource-items' && this.mcpPage === 'server' && this.serverTab === 'resources') {
      const uri = event.selectedIds[0]
      const listed = this.resourceItems.find(item => item.uri === uri)
      if (listed === undefined) return { kind: 'failed', message: this.tr('The resource is no longer available') }
      await this.readResource(listed.uri)
      return { kind: 'completed' }
    }
    return { kind: 'completed' }
  }

  private openTools(): void {
    const current = this.options.hosts.current()
    if (current === undefined) return
    this.toolsPanel?.close()
    this.toolsPanel = openRemoteBrowser(this.options, {
      id: 'remote.tools',
      scope: { kind: 'session', sessionId: current.ref.sessionId },
      isCurrent: () => isRemoteFeatureSelection(this.options.hosts.current(), current.client, current.ref),
      view: () => remoteToolsNode(this.tools, this.focusedTool, this.toolDetailMode, this.toolsError, this.t),
      action: event => this.toolsAction(event),
      back: () => {
        if (!this.toolDetailMode) return false
        this.toolDetailMode = false
        this.toolsPanel?.refresh()
        return true
      },
      onClosed: () => { this.toolsPanel = undefined },
    })
    void this.refresh(this.lifecycle.currentGeneration())
  }

  private async toolsAction(event: MayflyUiActionEvent): Promise<MayflyUiActionReply> {
    if (event.kind === 'activate' && event.actionId === 'refresh') {
      await this.refresh(this.lifecycle.currentGeneration())
      return { kind: 'completed' }
    }
    if (event.kind !== 'selection-accept' || (event.controlId !== 'tools' && event.controlId !== 'tools-narrow')) return { kind: 'completed' }
    const name = event.selectedIds[0]
    if (!this.tools?.tools.some((schema: MayflyToolSchema) => schema.name === name)) return { kind: 'failed', message: this.t('The tool is no longer available') }
    this.focusedTool = name
    if (event.controlId === 'tools-narrow') this.toolDetailMode = true
    this.toolsPanel?.refresh()
    return { kind: 'completed' }
  }

  readonly executeMcp = async (rawInput: string): Promise<void> => {
    if (rawInput.trim() !== '') throw new Error('Usage: /mcp')
    this.openMcp()
  }

  readonly executeTools = async (rawInput: string): Promise<void> => {
    if (rawInput.trim() !== '') throw new Error('Usage: /tools')
    this.openTools()
  }
}

/** Mount one refresh owner for both construction-frozen Host catalogs. */
export function mountCatalogFeature(options: RemoteFeatureContext): () => void {
  const controller = new RemoteCatalogController(options)
  const unregisterMcp = options.commands.register({
    name: 'mcp',
    description: 'List the MCP servers the host connects to',
    execute: controller.executeMcp,
  })
  const unregisterTools = options.commands.register({
    name: 'tools',
    description: 'List the tools visible to the current session',
    execute: controller.executeTools,
  })
  return () => {
    unregisterTools()
    unregisterMcp()
    controller.dispose()
  }
}
