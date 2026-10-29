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
  type RemoteMcpServerTab,
} from '../panels/catalog.ts'
import { isRemoteFeatureSelection } from '../interactions/selection.ts'
import { unavailableCapability } from './capabilities.ts'
import { RemoteFeatureLifecycle } from './lifecycle.ts'
import { REMOTE_MCP_RESOURCES_GAP } from './mcp-resources.ts'

type McpPage = 'list' | 'server' | 'tool'

class RemoteCatalogController {
  private readonly options: RemoteFeatureContext
  private readonly t: MayflyTranslate
  private readonly lifecycle: RemoteFeatureLifecycle
  private readonly hostListeners = new Map<HostClient, () => void>()
  private readonly offTopology: () => void
  private mcp: MayflyMcpCatalog | undefined
  private tools: MayflyToolCatalog | undefined
  private mcpError: string | undefined
  private toolsError: string | undefined
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
  private disposed = false

  constructor(options: RemoteFeatureContext) {
    this.options = options
    this.t = memoizedLocaleTranslator(options.ctx, 'remote-catalog').translate
    this.lifecycle = new RemoteFeatureLifecycle(options, this.attach)
    this.offTopology = options.hosts.subscribe(this.reconcileHosts)
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
    if (this.disposed) return
    this.ticket += 1
    this.operationLifetime.abort()
    this.operationLifetime = new AbortController()
    this.mcp = undefined
    this.tools = undefined
    this.mcpError = undefined
    this.toolsError = undefined
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
      const message = error instanceof Error ? error.message : String(error)
      this.mcpError = message
      this.toolsError = message
    }
    this.mcpPanel?.refresh()
    this.toolsPanel?.refresh()
  }

  private selectedServer(): MayflyMcpServer | undefined {
    return this.mcp?.servers.find(server => server.entryId === this.serverId)
  }

  private mcpView(): ReturnType<typeof remoteMcpListNode> {
    const server = this.selectedServer()
    if (this.mcpPage !== 'list' && server !== undefined) {
      if (this.mcpPage === 'tool') {
        const schema = server.toolsVisible.find(candidate => candidate.name === this.mcpToolName)
        if (schema !== undefined) return remoteMcpToolNode(server, schema, this.t)
      }
      return remoteMcpServerNode(server, this.serverTab, REMOTE_MCP_RESOURCES_GAP, this.t)
    }
    this.mcpPage = 'list'
    return remoteMcpListNode(this.mcp, this.mcpError, this.t)
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
          this.mcpPage = 'list'
          this.serverId = undefined
          this.serverTab = 'tools'
        } else return false
        this.mcpPanel?.refresh()
        return true
      },
      onClosed: () => { this.mcpPanel = undefined },
    })
    void this.refresh(this.lifecycle.currentGeneration())
  }

  private observeMcp(event: MayflyUiObservationEvent): void {
    if (event.kind !== 'tab-change' || event.controlId !== 'server-pages' || this.mcpPage !== 'server') return
    if (event.tabId !== 'tools' && event.tabId !== 'config' && event.tabId !== 'resources') return
    this.serverTab = event.tabId
    this.mcpPanel?.refresh()
  }

  private async mcpAction(event: MayflyUiActionEvent): Promise<MayflyUiActionReply> {
    if (event.kind === 'activate' && event.actionId === 'refresh') {
      await this.refresh(this.lifecycle.currentGeneration())
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
