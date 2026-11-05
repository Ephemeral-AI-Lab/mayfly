/** Host catalogs and MCP resources through actual native adapters and exact browser lifetimes. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '../../src/core.ts'
import type { MayflyUiActionEvent, MayflyUiEventContext, MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import type { MayflyMcpCatalog, MayflyMcpServer, MayflyToolCatalog } from '@ephemeral-ai/mayfly-host/types'
import { mountCatalogFeature } from '../../src/app/features/catalog.ts'
import { remoteMcpResourceItem } from '../../src/app/features/mcp-resources.ts'
import type { RemoteBrowserOptions } from '../../src/app/panels/browser.ts'
import { firstSentence as remoteFirstSentence, mcpListNode, mcpServerPageNode, mcpToolNode, mcpResourceNode, mcpResourceBodyNode, toolsBrowserNode, type McpResourceFacts } from '../../src/command-panels.ts'
import { taskFixture, tick, translate, activated, good, bad } from './task-feature-fixture.ts'

const browser = vi.hoisted(() => vi.fn())
vi.mock('../../src/app/panels/browser.ts', () => ({ openRemoteBrowser: browser }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.restoreAllMocks(); browser.mockReset() })
const schema = (name = 'mcp__alpha__read', description = 'Read native data. More details.') => ({ name, description, parameters: { type: 'object', properties: { path: { type: 'string' } } } })
const server = (extra: Partial<MayflyMcpServer> = {}): MayflyMcpServer => ({ entryId: 'alpha-entry', serverName: 'alpha', status: 'synced', connection: 'connected', registeredCount: 1, toolsVisible: [schema()], config: { transport: 'stdio', endpoint: null }, ...extra })
const choose = (controlId: string, id?: string): MayflyUiActionEvent => ({ kind: 'selection-accept', controlId, selectedIds: id === undefined ? [] : [id], pagePath: [] })
const tab = (controlId: string, tabId: string): MayflyUiObservationEvent => ({ kind: 'tab-change', controlId, tabId, pagePath: [] })
const eventContext = (): MayflyUiEventContext => ({ surfaceId: 'catalog', source: [], signal: new AbortController().signal, revision: 1, operationId: 'read', report: vi.fn() })

async function fixture(selected = true, enabled = ['mcpCatalog', 'toolCatalog', 'mcpResources']) {
  const f = await taskFixture(selected)
  const features = [...enabled]
  const catalogs: { mcp: MayflyMcpCatalog, tools: MayflyToolCatalog } = { mcp: { servers: [server()], orphanCount: 0, sessionLive: true }, tools: { tools: [schema('shell'), schema('read', '')] } }
  const capabilities = vi.fn(async (): Promise<unknown> => good({ protocolVersion: 1, hostVersion: '0.1.4', requiredDshVersion: '0.1.0', features }))
  const mcp = vi.fn(async (..._args: unknown[]): Promise<unknown> => good(catalogs.mcp))
  const tools = vi.fn(async (..._args: unknown[]): Promise<unknown> => good(catalogs.tools))
  const list = vi.fn(async (..._args: unknown[]): Promise<unknown> => good({ items: [{ uri: 'file://resource', name: 'Native resource', description: 'Resource description', mimeType: 'text/plain' }], cursor: undefined }))
  const read = vi.fn(async (..._args: unknown[]): Promise<unknown> => good({ uri: 'file://resource', text: 'Native body' }))
  Object.assign(f.client.remote, { mayflyHost: { capabilities, mcpCatalog: mcp, toolCatalog: tools, listMcpResources: list, readMcpResource: read } })
  const panels: Array<{ options: RemoteBrowserOptions, refresh: ReturnType<typeof vi.fn<() => void>>, close: ReturnType<typeof vi.fn<() => void>> }> = []
  browser.mockImplementation((_base, options: RemoteBrowserOptions) => { let closed = false; const result = { options, refresh: vi.fn(), close: vi.fn(() => { if (closed) return; closed = true; options.signal?.removeEventListener('abort', result.close); options.onClosed?.() }), get closed() { return closed } }; options.signal?.addEventListener('abort', result.close, { once: true }); panels.push(result); return result })
  const registered = vi.spyOn(f.options.commands, 'register')
  const stop = mountCatalogFeature(f.options)
  cleanups.push(async () => { stop(); await f.dispose() })
  await tick()
  const act = async (event: MayflyUiActionEvent, signal = new AbortController().signal) => await panels.at(-1)!.options.action!(event, { ...eventContext(), signal })
  const observe = async (event: MayflyUiObservationEvent) => { panels.at(-1)!.options.observe!(event); await tick() }
  const open = async (name = 'mcp', signal = new AbortController().signal) => { panels.at(-1)?.close(); await f.run(name, '', signal); await tick(); return panels.at(-1)! }
  const text = () => JSON.stringify(panels.at(-1)!.options.view())
  const resourceTab = async () => { await open(); await act(choose('servers', 'alpha-entry')); await observe(tab('server-pages', 'resources')) }
  return { ...f, features, catalogs, capabilities, mcp, tools, list, read, panels, stop, act, observe, open, text, resourceTab, invoke: (name: string, signal: AbortSignal) => registered.mock.calls.find(([command]) => command.name === name)![0].execute('', signal) }
}

describe('current Host catalogs', () => {
  it('refuses cancelled or retained unloaded commands, cancels open panels and ignores their retained callbacks', async () => {
    const f = await fixture()
    for (const name of ['mcp', 'tools']) {
      const reads = f.capabilities.mock.calls.length
      const cancelled = new AbortController(); cancelled.abort()
      await f.invoke(name, cancelled.signal)
      expect(f.panels).toHaveLength(name === 'mcp' ? 0 : 1)
      expect(f.capabilities).toHaveBeenCalledTimes(reads)
      const caller = new AbortController()
      const panel = await f.open(name, caller.signal)
      caller.abort()
      expect(panel.close).toHaveBeenCalledOnce()
      expect(panel.options.isCurrent()).toBe(false)
      expect(await panel.options.action!(activated('refresh'), eventContext())).toEqual({ kind: 'cancelled' })
      panel.options.observe?.(tab('server-pages', 'resources'))
    }
    const count = f.capabilities.mock.calls.length
    f.stop()
    await f.invoke('mcp', new AbortController().signal)
    await f.invoke('tools', new AbortController().signal)
    expect(f.capabilities).toHaveBeenCalledTimes(count)
  })

  it('does not read after synchronous renderer close and discards pending capability/catalog responses on caller cancellation', async () => {
    const f = await fixture()
    const original = browser.getMockImplementation()!
    browser.mockImplementationOnce((...args) => { const mounted = original(...args); mounted.close(); return mounted })
    const before = f.capabilities.mock.calls.length
    await f.open()
    expect(f.capabilities).toHaveBeenCalledTimes(before)
    for (const name of ['mcp', 'tools']) for (const kind of ['capabilities', name] as const) for (const failed of [false, true]) {
      const gate = Promise.withResolvers<unknown>()
      f[kind as 'capabilities' | 'mcp' | 'tools'].mockReturnValueOnce(gate.promise)
      const caller = new AbortController()
      const panel = await f.open(name, caller.signal)
      const refreshes = panel.refresh.mock.calls.length
      caller.abort()
      if (failed) gate.reject(new Error('cancelled native discovery'))
      else gate.resolve(good(kind === 'capabilities' ? { features: [] } : kind === 'mcp' ? { servers: [] } : { tools: [] }))
      await tick()
      expect(panel.close).toHaveBeenCalledOnce()
      expect(panel.refresh).toHaveBeenCalledTimes(refreshes)
    }
  })

  it('fences action-specific cancellation before opening server details or refreshing a tool panel', async () => {
    const f = await fixture()
    for (const name of ['mcp', 'tools']) {
      await f.open(name)
      const cancelled = new AbortController(); cancelled.abort()
      expect(await f.act(activated('refresh'), cancelled.signal)).toEqual({ kind: 'cancelled' })
      const gate = Promise.withResolvers<unknown>()
      f.capabilities.mockReturnValueOnce(gate.promise)
      const caller = new AbortController()
      const pending = f.act(name === 'mcp' ? choose('servers', 'alpha-entry') : activated('refresh'), caller.signal)
      caller.abort(); gate.resolve(good({ features: ['mcpCatalog', 'toolCatalog'] }))
      expect(await pending).toEqual({ kind: 'cancelled' })
      expect(f.panels.at(-1)!.options.isCurrent()).toBe(true)
    }
  })

  it('handles absent selections, native events, latest tickets, unavailable capabilities and detach cleanup', async () => {
    const f = await fixture(false)
    await f.open(); await f.open('tools'); expect(f.panels).toEqual([])
    f.select(true); await f.open()
    const panel = f.panels.at(-1)!; expect(panel.options.isCurrent()).toBe(true)
    const calls = f.capabilities.mock.calls.length
    f.event('agent-preset/selected', 'unrelated'); expect(f.capabilities).toHaveBeenCalledTimes(calls)
    f.event('agent-preset/selected', 'session'); await tick(); expect(f.capabilities).toHaveBeenCalledTimes(calls + 1)
    for (const failure of [new Error('catalog failed'), 'catalog failed']) {
      f.capabilities.mockRejectedValueOnce(failure); await f.act(activated('refresh')); expect(f.text()).toContain('MCP catalog unavailable; showing the last snapshot')
    }
    f.capabilities.mockResolvedValueOnce(bad('capabilities refused')); await f.act(activated('refresh')); expect(f.text()).toContain('MCP catalog unavailable; showing the last snapshot')
    f.features.splice(0); await f.act(activated('refresh')); expect(f.text()).toContain('MCP catalog unavailable; showing the last snapshot')
    await f.open('tools'); expect(f.text()).toContain('Tool catalog unavailable')
    f.features.push('mcpCatalog', 'toolCatalog')
    f.tools.mockResolvedValueOnce(bad('tools refused')); await f.act(activated('refresh')); expect(f.text()).toContain('Tool catalog unavailable')
    f.mcp.mockResolvedValueOnce(bad('mcp refused')); await f.open(); expect(f.text()).toContain('MCP catalog unavailable; showing the last snapshot')
    const queued = [...f.topology]
    f.detach(); expect(panel.options.isCurrent()).toBe(false)
    f.stop(); f.stop(); for (const callback of queued) callback()
    expect(f.events.get('agent-preset/selected')?.size).toBe(0)
  })

  it('retires capability and catalog success/failure after newer reads, reconnect, or unload', async () => {
    const f = await fixture(); await f.open()
    for (const kind of ['capabilities', 'mcp'] as const) for (const reject of [false, true]) {
      const pending = Promise.withResolvers<unknown>(); f[kind].mockReturnValueOnce(pending.promise)
      const stale = f.act(activated('refresh')); await tick()
      await f.act(activated('refresh'))
      if (reject) pending.reject('old catalog failure'); else pending.resolve(good(kind === 'capabilities' ? { features: [] } : { servers: [], orphanCount: 0, sessionLive: true }))
      await stale
      expect(f.text()).not.toContain('old catalog failure'); expect(f.text()).toContain('alpha')
    }
    const pending = Promise.withResolvers<unknown>(); f.capabilities.mockReturnValueOnce(pending.promise)
    const stale = f.act(activated('refresh')); f.reconnect(); pending.resolve(good({ features: [] })); await stale
    await f.open(); expect(f.text()).toContain('alpha')
    const read = Promise.withResolvers<unknown>(); f.mcp.mockReturnValueOnce(read.promise)
    const retired = f.act(activated('refresh')); await tick(); f.stop(); read.reject('unloaded failure'); await retired
    expect(f.panels.at(-1)!.close).toHaveBeenCalled()
  })

  it('navigates list/server/tool and responsive tool details without admitting missing rows', async () => {
    const f = await fixture(); const panel = await f.open()
    expect(panel.options.back!()).toBe(false)
    await f.observe(tab('server-pages', 'config'))
    expect(await f.act(choose('servers', 'missing'))).toMatchObject({ kind: 'failed' })
    await f.act(choose('servers', 'alpha-entry'))
    await f.observe({ kind: 'draft-change', pagePath: [], controlId: 'ignored' } as unknown as MayflyUiObservationEvent)
    await f.observe(tab('server-pages', 'unknown')); await f.observe(tab('other', 'config')); await f.observe(tab('server-pages', 'config'))
    expect(f.text()).toContain('(not resolved)')
    expect(await f.act(choose('tools', 'missing'))).toMatchObject({ kind: 'failed' })
    await f.act(choose('tools', 'mcp__alpha__read')); expect(f.text()).toContain('Parameters')
    f.catalogs.mcp = { ...f.catalogs.mcp, servers: [server({ toolsVisible: [] })] }
    await f.act(activated('refresh')); expect(f.text()).toContain('No tools visible to this session')
    expect(panel.options.back!()).toBe(true); expect(panel.options.back!()).toBe(true); expect(panel.options.back!()).toBe(false)
    await f.act(choose('servers', 'alpha-entry')); f.catalogs.mcp = { ...f.catalogs.mcp, servers: [] }
    await f.act(activated('refresh')); expect(f.text()).toContain('MCP servers')
    await f.act(activated('unrelated')); await f.act({ kind: 'dismiss', pagePath: [] })
    const toolsPanel = await f.open('tools')
    expect(toolsPanel.options.isCurrent()).toBe(true)
    expect(toolsPanel.options.back!()).toBe(false)
    expect(await f.act(choose('tools', 'missing'))).toMatchObject({ kind: 'failed' })
    await f.act(choose('other', 'shell')); await f.act(activated('unrelated'))
    await f.act(choose('tools', 'shell')); await f.act(choose('tools-narrow', 'read'))
    expect(f.text()).toContain('Parameters'); expect(toolsPanel.options.back!()).toBe(true)
    toolsPanel.options.onClosed!(); panel.options.onClosed!()
  })

  it('rechecks queued reads and exposes loading while capability reconciliation is pending', async () => {
    const f = await fixture(); await f.resourceTab()
    f.silentlyDeselect()
    const calls = f.capabilities.mock.calls.length
    await f.act(activated('refresh')); expect(f.capabilities).toHaveBeenCalledTimes(calls)
    f.select(true); await f.resourceTab()
    const pending = Promise.withResolvers<unknown>(); f.capabilities.mockReturnValueOnce(pending.promise)
    const refresh = f.act(activated('refresh'))
    pending.resolve(bad('capability discovery refused')); await Promise.resolve()
    expect(f.text()).toContain('loader')
    await refresh
    await f.act(activated('refresh'))
    f.features.splice(f.features.indexOf('mcpResources'), 1)
    await f.act(activated('refresh'))
    const reads = f.read.mock.calls.length
    await f.act(choose('resource-items', 'file://resource'))
    expect(f.read).toHaveBeenCalledTimes(reads)
  })
})

describe('native paged MCP resources', () => {
  it('preserves malformed rows for explicit URI correction and refuses absent or blank read targets', async () => {
    const f = await fixture()
    await f.open()
    expect(await f.act(activated('read'))).toMatchObject({ kind: 'failed' })
    await f.act(activated('resources'))
    f.list.mockResolvedValueOnce(good({ items: [{ name: 'Missing URI' }, { uri: '   ', name: 'Blank URI' }] }))
    await f.act(choose('servers', 'alpha-entry'))
    await f.observe(tab('server-pages', 'resources'))
    await f.act(choose('resources', '0'))
    expect(await f.act(activated('read'))).toMatchObject({ kind: 'failed', message: 'Enter a resource URI' })
    f.panels.at(-1)!.options.back!()
    await f.act(choose('resources', '1'))
    expect(await f.act(activated('read'))).toMatchObject({ kind: 'failed', message: 'Enter a resource URI' })
    expect(f.read).not.toHaveBeenCalled()
    f.silentlyDeselect()
    expect(await f.act(activated('read'))).toMatchObject({ kind: 'failed' })
  })

  it('refocuses existing MCP and tool panels without transferring invocation ownership', async () => {
    const f = await fixture()
    for (const name of ['mcp', 'tools']) {
      const owner = new AbortController()
      const panel = await f.open(name, owner.signal)
      const calls = f.panels.length
      const other = new AbortController()
      await f.run(name, '', other.signal)
      expect(f.panels).toHaveLength(calls)
      other.abort()
      expect(panel.close).not.toHaveBeenCalled()
      owner.abort()
      expect(panel.close).toHaveBeenCalledOnce()
    }
  })

  it('cancels paged, refreshed and selected resource reads without publishing their late content', async () => {
    for (const kind of ['more', 'refresh', 'read'] as const) for (const failed of [false, true]) {
      const f = await fixture()
      f.list.mockResolvedValueOnce(good({ items: [{ uri: 'file://resource' }], cursor: 'next' }))
      await f.resourceTab()
      const gate = Promise.withResolvers<unknown>()
      if (kind === 'read') f.read.mockReturnValueOnce(gate.promise)
      else f.list.mockReturnValueOnce(gate.promise)
      const controller = new AbortController()
      if (kind === 'read') await f.act(choose('resources', '0'))
      const pending = f.act(activated(kind), controller.signal)
      await tick()
      const signal = (kind === 'read' ? f.read : f.list).mock.calls.at(-1)![1] as AbortSignal
      controller.abort()
      expect(signal.aborted).toBe(true)
      if (failed) gate.reject(new Error('cancelled resource failure'))
      else gate.resolve(good(kind === 'read' ? { uri: 'file://resource', text: 'late native secret' } : { items: [{ uri: 'file://late-secret' }] }))
      expect(await pending).toEqual({ kind: 'cancelled' })
      expect(f.text()).not.toContain('late native secret')
      expect(f.text()).not.toContain('late-secret')
      expect(f.text()).not.toContain('cancelled resource failure')
    }
  })

  it('loads pages, templates, exact resource bodies and back navigation with the actual adapter', async () => {
    const f = await fixture()
    f.list.mockResolvedValueOnce(good({ items: [{ uri: 'file://first', name: 'First', mimeType: 'text/plain' }, { uri: '', name: 'invalid' }], cursor: 'next-page' }))
    await f.resourceTab()
    expect(f.list).toHaveBeenCalledWith({ sessionId: 'session', server: 'alpha', kind: 'resources' }, expect.any(AbortSignal))
    expect(f.text()).toContain('First'); expect(f.text()).toContain('invalid')
    f.list.mockResolvedValueOnce(good({ items: [{ uri: 'file://second' }] }))
    await f.act(activated('more'))
    expect(f.list).toHaveBeenLastCalledWith({ sessionId: 'session', server: 'alpha', kind: 'resources', cursor: 'next-page' }, expect.any(AbortSignal))
    expect(f.text()).toContain('First'); expect(f.text()).toContain('file://second')
    const calls = f.list.mock.calls.length; await f.act(activated('more')); expect(f.list).toHaveBeenCalledTimes(calls)
    expect(await f.act(choose('resources', 'missing'))).toEqual({ kind: 'cancelled' })
    const pending = Promise.withResolvers<unknown>(); f.read.mockReturnValueOnce(pending.promise)
    await f.act(choose('resources', '0'))
    expect(f.text()).toContain('Resource URI')
    const reading = f.act(activated('read')); expect(f.text()).toContain('Resource URI')
    pending.resolve(good({ uri: 'file://first', text: 'Exact resource document' })); await reading
    expect(f.read).toHaveBeenLastCalledWith({ sessionId: 'session', server: 'alpha', uri: 'file://first' }, expect.any(AbortSignal))
    expect(f.text()).toContain('Exact resource document')
    expect(f.panels.at(-1)!.options.back!()).toBe(true); expect(f.text()).toContain('Resource URI')
    expect(f.panels.at(-1)!.options.back!()).toBe(true); expect(f.text()).toContain('First')
    await f.observe(tab('resource-kind', 'unknown')); await f.act(activated('resources'))
    f.list.mockResolvedValueOnce(good({ items: [{ uriTemplate: 'template://{name}', description: 'Template description' }] }))
    await f.act(activated('templates')); await tick()
    expect(f.list).toHaveBeenLastCalledWith({ sessionId: 'session', server: 'alpha', kind: 'templates' }, expect.any(AbortSignal))
    expect(f.text()).toContain('Template description')
    expect(f.text()).toContain('template://{name}')
    await f.act(choose('resources', '0'))
    expect(f.text()).toContain('template://{name}')
    await f.act({ ...activated('read'), inputs: { actionId: 'read', draftRevision: 0, source: [], forms: [{ pagePath: [], formId: 'resource-uri', draftRevision: 0, fields: [{ id: 'uri', value: 'template://concrete-name', change: 'set' }] }], selections: [] } })
    expect(f.read).toHaveBeenLastCalledWith({ sessionId: 'session', server: 'alpha', uri: 'template://concrete-name' }, expect.any(AbortSignal))
    f.panels.at(-1)!.options.back!(); f.panels.at(-1)!.options.back!()
    await f.act(activated('resources')); await tick()
    await f.act(activated('refresh')); expect(f.list).toHaveBeenCalled()
    expect(f.panels.at(-1)!.options.back!()).toBe(true); expect(f.panels.at(-1)!.options.back!()).toBe(false)
  })

  it('shows only real capability/read failures and fences overlapping or retired resource work', async () => {
    const f = await fixture(true, ['mcpCatalog', 'toolCatalog'])
    await f.resourceTab(); expect(f.text()).toContain('mcpResources is unavailable'); expect(f.list).not.toHaveBeenCalled()
    f.features.push('mcpResources'); await f.act(activated('refresh'))
    for (const failure of [new Error('resource page failed'), 'resource page failed', bad('page refused')]) {
      if (typeof failure === 'object' && 'ok' in failure) f.list.mockResolvedValueOnce(failure)
      else f.list.mockRejectedValueOnce(failure)
      await f.act(activated('refresh')); expect(f.text()).toContain(typeof failure === 'object' && 'ok' in failure ? 'page refused' : 'resource page failed')
    }
    await f.act(activated('refresh'))
    for (const failure of [new Error('resource read failed'), 'resource read failed', bad('read refused')]) {
      if (typeof failure === 'object' && 'ok' in failure) f.read.mockResolvedValueOnce(failure)
      else f.read.mockRejectedValueOnce(failure)
      await f.act(choose('resources', '0'))
      expect(await f.act(activated('read'))).toMatchObject({ kind: 'failed', message: typeof failure === 'object' && 'ok' in failure ? 'read refused' : 'resource read failed' })
    }
    for (const kind of ['list', 'read'] as const) for (const reject of [false, true]) {
      await f.resourceTab()
      const pending = Promise.withResolvers<unknown>(); f[kind].mockReturnValueOnce(pending.promise)
      if (kind === 'read') await f.act(choose('resources', '0'))
      const retired = f.act(activated(kind === 'list' ? 'refresh' : 'read'))
      await tick(); await f.act(activated('refresh'))
      if (reject) pending.reject('old resource failure'); else pending.resolve(good(kind === 'list' ? { items: [{ uri: 'file://old' }] } : { uri: 'file://old', text: 'OLD BODY' }))
      await retired; expect(f.text()).not.toContain('old resource failure'); expect(f.text()).not.toContain('file://old')
    }
    for (const kind of ['list', 'read'] as const) {
      await f.resourceTab()
      const pending = Promise.withResolvers<unknown>(); f[kind].mockReturnValueOnce(pending.promise)
      if (kind === 'read') await f.act(choose('resources', '0'))
      const retired = f.act(activated(kind === 'list' ? 'refresh' : 'read'))
      await tick(); f.reconnect(); pending.resolve(good(kind === 'list' ? { items: [] } : { text: 'retired' })); await retired
    }
  })
})

describe('catalog safe presentation and native row narrowing', () => {
  it('renders every native MCP state, resource state and narrow tool page within width', async () => {
    const f = await fixture()
    const base: McpResourceFacts = { templates: false, items: [], cursor: undefined, loading: false, loaded: true, error: undefined }
    const states = [undefined, base, { ...base, templates: true, loading: true, error: 'native error' }, { ...base, loading: true, cursor: 'next', items: [{ uri: 'file://a', name: 'Resource', description: 'Description' }, { uriTemplate: 'template://{id}', mimeType: 'text/plain' }, { uri: 'file://c' }] }]
    const servers = [server(), server({ status: 'no-tools', connection: undefined, toolsVisible: [], registeredCount: 0 }), server({ status: 'restricted' }), server({ status: 'unknown' })].map((value, index) => ({ ...value, entryId: `server-${String(index)}` }))
    const nodes = [mcpListNode({ servers: [], orphanCount: 0 }, true, translate), mcpListNode({ servers, orphanCount: 2 }, false, translate), ...servers.flatMap(value => states.map(state => mcpServerPageNode(value, 'resources', state, translate))), mcpToolNode(server(), schema(), translate), mcpToolNode(server(), schema('empty', ''), translate), toolsBrowserNode([], undefined, true, true, translate), toolsBrowserNode([schema(), schema('empty', '')], 'empty', true, false, translate), mcpResourceNode(server(), { ...base, items: [{ uriTemplate: 'template://{id}' }] }, 0, translate), mcpResourceBodyNode(server(), { bodyText: 'Resource 你好 '.repeat(20) }, translate)]
    for (const node of nodes) for (const width of [1, 8, 20, 40, 80, 120]) expect(f.render(node, width).every(row => visibleWidth(row) <= width)).toBe(true)
    expect(remoteFirstSentence('')).toBe(''); expect(remoteFirstSentence('Single sentence')).toBe('Single sentence'); expect(remoteFirstSentence('\n  中文句子。下一句')).toBe('中文句子。')
    expect(remoteMcpResourceItem({ uri: '' })).toEqual({}); expect(remoteMcpResourceItem({ name: 1, description: '', mimeType: true })).toEqual({})
  })
})
