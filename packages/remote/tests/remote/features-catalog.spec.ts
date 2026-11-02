import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MayflyUiActionEvent, MayflyUiEventContext, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient, SessionRef } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import type { RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { mountCatalogFeature } from '../../src/remote/features/catalog.ts'
import { unavailableCapability } from '../../src/remote/features/capabilities.ts'
import { remoteMcpConfigNode, remoteMcpServerItems } from '../../src/remote/panels/catalog.ts'
import type { MayflyMcpCatalog, MayflyMcpServer } from '@ephemeral-ai/mayfly-host/types'

describe('unknown MCP transport state', () => {
  it('keeps unavailable live state distinct from an empty connected server', () => {
    const unknown = mcpServer({ status: 'unknown', connection: 'disconnected', registeredCount: 1, toolsVisible: [toolSchema('cached-tool')] }) as unknown as MayflyMcpServer
    const empty = mcpServer({ entryId: 'empty', serverName: 'empty', status: 'no-tools', connection: 'connected' }) as unknown as MayflyMcpServer
    const t = (text: string) => text
    const rows = remoteMcpServerItems({ servers: [empty, unknown], orphanCount: 0, sessionLive: true } as MayflyMcpCatalog, t, t)
    expect(rows.map(row => row.id)).toEqual(['entry-alpha', 'empty'])
    expect(rows[0]!.cells![0]!.spans[0]).toEqual({ text: 'unknown', tone: 'muted' })
    const strings = nodesOf(remoteMcpConfigNode(unknown, t, t)).filter(node => node.kind === 'text').map(node => node.content)
    expect(strings).toContain('Live tool availability is unknown while the server is not connected')
    expect(strings).not.toContain('No tools registered; connection state is unavailable')
  })
})

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
}))

vi.mock('../../src/remote/panels/browser.ts', () => ({
  openRemoteBrowser: mocks.open,
}))

/** One server schema the Host would publish for a session. */
function toolSchema(name: string, description = 'Does a thing.'): unknown {
  return { name, description, parameters: { type: 'object' } }
}

/** One MCP server as the Host's wire shape declares it, with nullable config resolved. */
function mcpServer(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    entryId: 'entry-alpha',
    serverName: 'alpha',
    status: 'synced',
    registeredCount: 0,
    toolsVisible: [],
    config: { transport: null, endpoint: null },
    ...overrides,
  }
}

/** One construction-frozen MCP catalog as the Host returns it. */
function mcpCatalog(servers: readonly unknown[], orphanCount = 0): unknown {
  return { servers, orphanCount, sessionLive: true }
}

/** One construction-frozen tool catalog as the Host returns it. */
function toolCatalog(names: readonly string[]): unknown {
  return { tools: names.map(name => toolSchema(name)) }
}

/** Every node of one panel view, flattened for shape-independent assertions. */
function nodesOf(node: unknown, found: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const child of node) nodesOf(child, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  const record = node as Record<string, unknown>
  if (typeof record.kind === 'string') found.push(record)
  for (const value of Object.values(record)) nodesOf(value, found)
  return found
}

/** The list node with one control id, which carries the mapped rows and its empty state. */
function listOf(view: MayflyUiNode, id: string): Record<string, unknown> {
  const list = nodesOf(view).find(node => node.kind === 'list' && node.id === id)
  expect(list).toBeDefined()
  return list!
}

/** The labels of one list node's rows, in painted order. */
function labelsOf(view: MayflyUiNode, id = 'servers'): readonly string[] {
  return (listOf(view, id).items as ReadonlyArray<{ readonly label: string }>).map(item => item.label)
}

/** The explicit empty-state title of one list node, absent when the list declares none. */
function emptyTitleOf(view: MayflyUiNode, id: string): unknown {
  return (listOf(view, id).empty as Record<string, unknown> | undefined)?.title
}

/** Every danger-tone text painted into a panel, which carries a failed read or a missing capability. */
function errorTextsOf(view: MayflyUiNode): readonly string[] {
  return nodesOf(view)
    .filter(node => node.kind === 'text' && node.tone === 'danger')
    .map(node => String(node.content))
}

/** The muted explanatory texts of a panel, where the orphan count is painted. */
function mutedTextsOf(view: MayflyUiNode): readonly string[] {
  return nodesOf(view)
    .filter(node => node.kind === 'text' && node.tone === 'muted')
    .map(node => String(node.content))
}

function fixture(options: {
  readonly features?: readonly string[]
  readonly mcp?: unknown
  readonly tools?: unknown
} = {}) {
  const ref: SessionRef = { host: HostKey('local'), sessionId: SessionId('session-1') }
  const capabilities = vi.fn(async () => ({
    ok: true,
    value: { protocolVersion: 1, hostVersion: '0.1.4', requiredDshVersion: '0.1.0', features: options.features ?? ['mcpCatalog', 'toolCatalog'] },
  }))
  const mcpCatalogRead = vi.fn(async () => ({ ok: true, value: options.mcp ?? mcpCatalog([]) }))
  const toolCatalogRead = vi.fn(async () => ({ ok: true, value: options.tools ?? toolCatalog([]) }))
  const client = {
    key: HostKey('local'),
    state: { getSnapshot: () => ({ generation: 1 }), subscribe: vi.fn(() => () => {}) },
    remote: {
      $on: vi.fn(() => () => {}),
      mayflyHost: { capabilities, mcpCatalog: mcpCatalogRead, toolCatalog: toolCatalogRead },
    },
  } as unknown as HostClient
  let selection: RemoteFeatureSelection = { ref, client, binding: {} as RemoteFeatureSelection['binding'] }
  const topology: Array<() => void> = []
  const hosts = {
    current: vi.fn((): RemoteFeatureSelection | undefined => selection),
    list: vi.fn((): readonly HostClient[] => [client]),
    subscribe: vi.fn((listener: () => void) => {
      topology.push(listener)
      return () => {}
    }),
  }
  const locale = {
    register: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    translate: vi.fn((_namespace: string, key: string) => key),
  }
  const effect = vi.fn((fn: () => unknown) => {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  })
  const ctx = {
    effect,
    inject: vi.fn((_dependencies: readonly string[], callback: (scope: unknown) => void) => {
      callback({ mayflyLocale: locale, effect })
    }),
    get: vi.fn((name: string) => (name === 'mayflyLocale' ? locale : undefined)),
    mayflyLocale: locale,
  }
  const commands: Array<{ readonly name: string, readonly execute: (rawInput: string, signal: AbortSignal) => Promise<void> }> = []
  const disposers = [vi.fn(), vi.fn()]
  const register = vi.fn((command: { readonly name: string, readonly execute: (rawInput: string, signal: AbortSignal) => Promise<void> }) => {
    commands.push(command)
    return disposers[commands.length - 1]!
  })
  const context = {
    ctx,
    hosts,
    commands: { register },
    t: vi.fn((key: string) => key),
    subscribeLocale: vi.fn(() => () => {}),
  } as unknown as RemoteFeatureContext
  return {
    context,
    hosts,
    locale,
    client,
    ref,
    capabilities,
    mcpCatalogRead,
    toolCatalogRead,
    commands,
    disposers,
    register,
    /** Fire every topology listener, as a Host attach/detach or re-selection would. */
    reselect: (): void => {
      selection = { ref, client, binding: {} as RemoteFeatureSelection['binding'] }
      for (const listener of [...topology]) listener()
    },
  }
}

/** The browser options of the n-th opened panel. */
function browserOf(index = 0): RemoteBrowserOptions {
  return mocks.open.mock.calls[index]![1] as RemoteBrowserOptions
}

const signal = new AbortController().signal

/** Wait until one refresh finished: the feature repaints its open panel last. */
async function settled(panel: { readonly refresh: () => void }): Promise<void> {
  await vi.waitFor(() => { expect(panel.refresh).toHaveBeenCalled() })
}

/** Ask an open catalog panel to refresh, as its hidden refresh action does. */
async function refreshPanel(browser: RemoteBrowserOptions): Promise<void> {
  await browser.action!(
    { kind: 'activate', actionId: 'refresh' } as MayflyUiActionEvent,
    { signal } as unknown as MayflyUiEventContext,
  )
}

beforeEach(() => {
  mocks.open.mockReset()
  mocks.open.mockReturnValue({ closed: false, refresh: vi.fn(), close: vi.fn() })
})

describe('mountCatalogFeature commands', () => {
  it('registers exactly /mcp and /tools, refuses arguments, and unregisters both on teardown', async () => {
    const { context, register, commands, disposers } = fixture()
    const panel = { closed: false, refresh: vi.fn(), close: vi.fn() }
    mocks.open.mockReturnValue(panel)
    const dispose = mountCatalogFeature(context)

    expect(register).toHaveBeenCalledTimes(2)
    expect(commands.map(command => command.name)).toEqual(['mcp', 'tools'])
    await expect(commands[0]!.execute(' alpha', signal)).rejects.toThrow('Usage: /mcp')
    await expect(commands[1]!.execute(' now', signal)).rejects.toThrow('Usage: /tools')
    expect(mocks.open).not.toHaveBeenCalled()

    await commands[0]!.execute('', signal)
    const browser = browserOf()
    expect(browser.id).toBe('remote.mcp')
    expect(browser.scope).toEqual({ kind: 'session', sessionId: SessionId('session-1') })

    dispose()
    expect(panel.close).toHaveBeenCalledOnce()
    for (const unregister of disposers) expect(unregister).toHaveBeenCalledOnce()
  })
})

describe('mountCatalogFeature MCP catalog', () => {
  it('maps the Host wire catalog to rows in status order and keeps an absent connection absent', async () => {
    const servers = [
      mcpServer({ entryId: 'entry-beta', serverName: 'beta', status: 'synced', connection: 'connected', registeredCount: 3 }),
      mcpServer({ entryId: 'entry-alpha', serverName: 'alpha', status: 'no-tools' }),
      mcpServer({ entryId: 'entry-zeta', serverName: 'zeta', status: 'restricted', connection: 'disconnected' }),
    ]
    const { context, commands } = fixture({ mcp: mcpCatalog(servers) })
    const dispose = mountCatalogFeature(context)

    await commands[0]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(labelsOf(browserOf().view())).toHaveLength(3) })

    const view = browserOf().view()
    expect(labelsOf(view)).toEqual(['alpha', 'zeta', 'beta'])
    const items = listOf(view, 'servers').items as ReadonlyArray<{ readonly cells: readonly unknown[] }>
    // alpha carries no connection phase, so its row has two cells; a fabricated
    // empty third cell would paint an unexplained gap.
    expect(items.map(item => item.cells.length)).toEqual([2, 3, 3])
    expect(errorTextsOf(view)).toEqual([])
    dispose()
  })

  it('paints an explicit empty state for an empty catalog instead of a bare list', async () => {
    const { context, commands, mcpCatalogRead } = fixture({ mcp: mcpCatalog([], 0) })
    const panel = { closed: false, refresh: vi.fn(), close: vi.fn() }
    mocks.open.mockReturnValue(panel)
    const dispose = mountCatalogFeature(context)

    await commands[0]!.execute('', signal)
    await settled(panel)
    expect(mcpCatalogRead).toHaveBeenCalled()

    const view = browserOf().view()
    expect(labelsOf(view)).toEqual([])
    expect(emptyTitleOf(view, 'servers')).toBe('No MCP servers are declared')
    expect(mutedTextsOf(view).some(text => text.includes('have no declared server'))).toBe(false)
    dispose()
  })

  it('paints the orphan-tool line only when the Host counts orphans', async () => {
    const { context, commands } = fixture({ mcp: mcpCatalog([mcpServer()], 2) })
    const dispose = mountCatalogFeature(context)

    await commands[0]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(labelsOf(browserOf().view())).toHaveLength(1) })

    expect(mutedTextsOf(browserOf().view()).some(text => text.includes('have no declared server'))).toBe(true)
    dispose()
  })

  it('paints a failed capability probe as an error with no rows, never as a throw', async () => {
    const { context, commands, capabilities, mcpCatalogRead, toolCatalogRead } = fixture()
    vi.mocked(capabilities).mockResolvedValue({ ok: false, error: { code: 'mayflyHost/capability-unavailable', message: 'Host does not compose Mayfly' } } as never)
    const dispose = mountCatalogFeature(context)

    await commands[0]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(errorTextsOf(browserOf().view())).toEqual(['Host does not compose Mayfly']) })

    const view = browserOf().view()
    expect(labelsOf(view)).toEqual([])
    expect(emptyTitleOf(view, 'servers')).toBe('No MCP servers are declared')
    // An unreachable capability probe proves nothing about the feature set, so
    // no catalog read is sent on a guess.
    expect(mcpCatalogRead).not.toHaveBeenCalled()
    expect(toolCatalogRead).not.toHaveBeenCalled()
    dispose()
  })

  it('reports an unadvertised capability with actionable copy and never sends its read', async () => {
    const { context, commands, mcpCatalogRead, toolCatalogRead } = fixture({ features: ['toolCatalog'], tools: toolCatalog(['read_file']) })
    const dispose = mountCatalogFeature(context)

    await commands[0]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(errorTextsOf(browserOf().view())).toEqual([unavailableCapability('mcpCatalog')]) })

    expect(mcpCatalogRead).not.toHaveBeenCalled()

    await commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(errorTextsOf(browserOf(1).view())).toEqual([]) })
    expect(labelsOf(browserOf(1).view(), 'tools')).toEqual(['read_file'])
    expect(toolCatalogRead).toHaveBeenCalled()
    dispose()
  })

  it('surfaces a failed catalog read as a panel notice while the other catalog still renders', async () => {
    const { context, commands, mcpCatalogRead, toolCatalogRead } = fixture({ tools: toolCatalog(['read_file']) })
    vi.mocked(mcpCatalogRead).mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'catalog exploded' } } as never)
    const dispose = mountCatalogFeature(context)

    await commands[0]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(errorTextsOf(browserOf().view())).toEqual(['catalog exploded']) })
    expect(labelsOf(browserOf().view())).toEqual([])

    await commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledTimes(2) })
    expect(toolCatalogRead.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(errorTextsOf(browserOf(1).view())).toEqual([])
    expect(labelsOf(browserOf(1).view(), 'tools')).toEqual(['read_file'])
    dispose()
  })

  it('paints the tool catalog empty state with its own copy when the session sees no tools', async () => {
    const { context, commands, toolCatalogRead } = fixture({ tools: toolCatalog([]) })
    const dispose = mountCatalogFeature(context)

    await commands[1]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    expect(toolCatalogRead.mock.calls.length).toBeGreaterThanOrEqual(1)

    const view = browserOf().view()
    expect(labelsOf(view, 'tools')).toEqual([])
    expect(emptyTitleOf(view, 'tools')).toBe('No tools visible to this session')
    dispose()
  })
})

describe('mountCatalogFeature probe ownership', () => {
  it('probes capabilities once per open and never re-probes for a re-render', async () => {
    const { context, commands, capabilities } = fixture({ mcp: mcpCatalog([mcpServer()]) })
    const panel = { closed: false, refresh: vi.fn(), close: vi.fn() }
    mocks.open.mockReturnValue(panel)
    const dispose = mountCatalogFeature(context)

    // The mount follows the committed selection once; opening the panel is a
    // second explicit read of the same generation.
    expect(capabilities).toHaveBeenCalledOnce()
    await commands[0]!.execute('', signal)
    await vi.waitFor(() => { expect(capabilities).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(labelsOf(browserOf().view())).toHaveLength(1) })

    const browser = browserOf()
    for (let paint = 0; paint < 3; paint += 1) browser.view()
    panel.refresh()
    // Re-painting a panel is a read of published facts, not another Host probe.
    expect(capabilities).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('discards a catalog answer that lands after the selection generation changed', async () => {
    let release!: (result: unknown) => void
    const stale = new Promise(resolve => { release = resolve })
    const { context, commands, capabilities, mcpCatalogRead, reselect } = fixture({ mcp: mcpCatalog([mcpServer({ entryId: 'old', serverName: 'old-server' })]) })
    const dispose = mountCatalogFeature(context)

    await commands[0]!.execute('', signal)
    await vi.waitFor(() => { expect(mocks.open).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(labelsOf(browserOf().view())).toEqual(['old-server']) })
    const browser = browserOf()

    // One refresh is in flight when the Host topology replaces the generation.
    capabilities.mockImplementationOnce(async () => await stale as never)
    const refresh = refreshPanel(browser)
    await vi.waitFor(() => { expect(capabilities).toHaveBeenCalledTimes(3) })

    mcpCatalogRead.mockResolvedValue({ ok: true, value: mcpCatalog([mcpServer({ entryId: 'new', serverName: 'new-server' })]) })
    reselect()
    await vi.waitFor(() => { expect(labelsOf(browser.view())).toEqual(['new-server']) })

    // The old generation's late answer must not overwrite the new catalog.
    release({ ok: true, value: { features: ['mcpCatalog', 'toolCatalog'] } })
    await refresh
    await Promise.resolve()
    await Promise.resolve()
    expect(labelsOf(browser.view())).toEqual(['new-server'])
    dispose()
  })
})
