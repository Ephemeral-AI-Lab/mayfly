/** Host Remote entry routing and Fiber lifetime with the built decorators. @module */
import { Context, Service } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MayflyHostService } from '../../lib/index.js'
import { mkdtempTracked, registerTempDirCleanup } from '../../../mayfly/tests/core/temp-dir.ts'
import { expectFrozenJson } from './frozen-frame.ts'

registerTempDirCleanup()
const contexts: Context[] = []
const clientRequire = createRequire(new URL('../../../remote/package.json', import.meta.url))
const { TypertRegistry } = await import(pathToFileURL(clientRequire.resolve('@deepseek-ai/dsh-typert-registry')).href)
const { TypertGatewayService } = await import(pathToFileURL(clientRequire.resolve('@deepseek-ai/dsh-api-gateway')).href)
type HostService = InstanceType<typeof MayflyHostService>
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

class AgentFilesystem extends Service {
  constructor(ctx: Context, implementation: object) { super(ctx, 'fs'); Object.assign(this, implementation) }
}

async function host() {
  const ctx = new Context()
  contexts.push(ctx)
  const session = { id: SessionId('parent'), header: { origin: 'user', cwd: '/host', createdAt: 10 }, snapshotEvents: () => [] }
  const agent = { id: session.id, session, status: 'idle', ctx }
  const settingsFile = join(mkdtempTracked('mayfly-host-service-'), 'settings.json')
  await writeFile(settingsFile, '{}', 'utf8')
  const services: Record<string, unknown> = {
    profileContext: { dir: dirname(settingsFile) },
    fs: { resolve: async () => ({ targetKey: 'opaque', displayPath: '~/host/report.md' }), stat: async () => ({ type: 'file', size: 6 }), processPath: () => '/host/report.md', readBytes: async () => new TextEncoder().encode('report') },
    sessionQuery: {
      readSession: async () => ({ events: [{ type: 'custom/event', seq: 0, time: 1, data: { text: 'trace fact' } }] }),
      traceEvent: async () => ({ replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [], derivedEventSeqs: [] }),
      observeSession: async () => ({ header: session.header, cursor: 37, events: [], revision: 'one', [Symbol.dispose]: () => {} }),
      listSessions: async () => [],
    },
    agents: { get: (id: string) => id === session.id ? agent : undefined },
    sessions: { get: (id: string) => id === session.id ? session : undefined },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'one' }) },
    authorization: { describe: () => undefined, cancel: vi.fn() },
    credentials: { resolve: async () => undefined },
    llm: { listProviders: () => [] },
    permissionPresets: { defaultPreset: 'safe', resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), catalog: () => ({ options: [], defaultOptions: [], defaultPreset: 'safe' }) },
    shell: { sandboxMode: 'workspace-write' },
    approval: { config: { policy: 'ask' } },
    sessionController: { resolveAgent: async () => { throw new Error('unexpected activation') }, fork: async () => ({ sessionId: SessionId('btw-child') }) },
    sessionProjections: {
      snapshot: () => ({ values: { workingDirectory: '/host', mayflyWorkflow: { sessionId: session.id, runs: [] }, mayflyDeliverables: [{ id: 'delivery', path: 'report.md' }] } }),
      onChanged: () => () => {},
    },
    settings: { writable: true, prepareDocument: async () => settingsFile },
    skills: { snapshot: async () => ({ complete: true, skills: [] }) },
    subagents: { listDescendants: async () => [], drainChildren: async () => {} },
    tools: { schemas: () => [], get: () => undefined, execute: async () => ({ results: [{ result: { isError: false, value: { resources: [], contents: [] } } }] }) },
    workspaceChanges: { summary: () => undefined, diff: async () => undefined },
    workspaceRegistry: { resolveByPath: async () => undefined },
  }
  for (const [key, value] of Object.entries(services)) ctx.provide(key, value)
  const world = ctx.isolate('fs')
  const filesystem = world.plugin({ name: 'host-agent-filesystem', apply(scope: Context) { new AgentFilesystem(scope, services['fs'] as object) } })
  await filesystem
  // The native Agent owns a real child Fiber; it does not inject each service
  // that consumers may later resolve in its execution world.
  await world.plugin({ name: 'host-agent-owner', apply(scope: Context) { agent.ctx = scope } })
  const fiber = ctx.plugin(MayflyHostService)
  await fiber
  const service = ctx.get('mayflyHost') as HostService
  expect(service).toBeInstanceOf(MayflyHostService)
  return { ctx, service, filesystem, unload: () => fiber.dispose() }
}

describe('Host Remote composition', () => {
  it.each([200, 503])('returns an immutable public balance failure for an unusable HTTP %i response', async (status) => {
    const { ctx, service } = await host()
    vi.spyOn(ctx.credentials, 'resolve').mockResolvedValue({ value: 'host-only-key' } as never)
    ctx.settings.describe = (() => []) as typeof ctx.settings.describe
    const json = vi.fn(async () => ({ balance_infos: [{ currency: 'USD', total_balance: 'invalid' }], detail: 'private response details' }))
    const fetch = vi.fn(async () => ({ status, ok: status === 200, json }))
    vi.stubGlobal('fetch', fetch)

    const balance = await service.providerBalance(new AbortController().signal)

    expect(balance).toEqual({ status: 'unavailable', reason: 'network' })
    expectFrozenJson(balance)
    expect(fetch).toHaveBeenCalledOnce()
    expect(json).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
  })

  it('streams a live attributed Workflow replacement through the installed built service', async () => {
    const { ctx, service } = await host()
    const session = ctx.sessions.get(SessionId('parent'))!
    const iterator = service.followWorkflow({ sessionId: session.id }, new AbortController().signal)[Symbol.asyncIterator]()
    await iterator.next()
    ctx.emit('workflow/start', { id: 'foreign', meta: { name: 'foreign' } } as never)
    ctx.emit('session/event', session, { type: 'tool-workflow/run-start', seq: 1, time: 1, data: { runId: 'r', name: 'live' } } as never)
    expect((await iterator.next()).value).toMatchObject({ type: 'replacement', value: { runs: [{ id: 'r' }] } })
    await iterator.return?.()
  })

  it('streams a native no-prompt authorization result through the installed built service', async () => {
    const { ctx } = await host()
    ctx.authorization.describe = (() => ({ key: credentialKey('fixture', 'account'), methods: [{ id: 'browser', label: 'Browser' }], label: 'Fixture', inFlight: false })) as typeof ctx.authorization.describe
    ctx.authorization.begin = (async () => ({ status: 'authorized' })) as typeof ctx.authorization.begin
    const signal = new AbortController().signal
    const receiver = ctx.extend({ invocation: {
      request: { namespace: 'mayflyHost', method: 'authorize', args: { key: 'fixture/account' } },
      service: 'mayflyHost', signal,
      peer: { id: 'fixture-peer' as never, ctx, principal: { kind: 'owner' }, signal, interactions: 'none', dispose: async () => {} },
      uplink: () => ({ async *[Symbol.asyncIterator]() {} }),
    } }).get('mayflyHost') as HostService
    const frames = []
    for await (const frame of receiver.authorize({ key: credentialKey('fixture', 'account') }, signal)) frames.push(frame)
    expect(frames).toMatchObject([{ type: 'started' }, { type: 'settled', status: 'authorized' }])
  })
  it('declares every addressed Session to native Gateway authorization, including root and stopped descendant identities', async () => {
    const { service } = await host()
    const methods = new Map(remoteMethods(service).map(method => [method.method, method]))
    const sessionId = SessionId('authorized-session')
    for (const name of ['btwFork', 'followWorkflow', 'gitStatus', 'mcpCatalog', 'toolCatalog', 'skillCatalog', 'retractTurn', 'workspaceChangesSummary', 'workspaceChangesDiff', 'deliveredFile', 'latestWorkspaceChanges', 'traceCatalog', 'traceDetail', 'statsSession', 'listMcpResources', 'readMcpResource', 'subagentTree', 'permissionCatalogDetails']) {
      const reader = methods.get(name)?.resources?.['session']
      expect(reader, `${name} must declare Session authorization`).toBeTypeOf('function')
      expect(reader?.({ sessionId })).toBe(sessionId)
    }
    const presentations = methods.get('presentTools')?.resources?.['session']
    expect(presentations?.({ entries: [] })).toBeUndefined()
    expect(presentations?.({ entries: [{ sessionId }, { sessionId }, { sessionId: 'second' }] })).toEqual([sessionId, 'second'])
    expect(methods.get('subagentStop')?.resources?.['session']?.({ sessionId, childSessionId: 'child' })).toEqual([sessionId, 'child'])
    expect(methods.get('statsHistory')?.resources?.['session']?.({ sessionId })).toBeUndefined()
    expect(methods.get('permissionCatalogDetails')?.resources?.['session']?.({})).toBeUndefined()
  })

  it('authorizes exact permission reads before observing cold history and requires global access for defaults', async () => {
    const { ctx } = await host()
    new TypertRegistry(ctx)
    ctx.typert.resources.register('session', { field: 'sessionId' })
    const decide = vi.fn(({ resources }: { resources: readonly { kind: string, id?: string }[] }) =>
      resources.every(resource => resource.kind === 'session' && resource.id === 'parent')
        ? { kind: 'allow' } : { kind: 'deny', reason: 'only parent is authorized' })
    ctx.provide('remoteAccess', { decide })
    const gateway = new TypertGatewayService(ctx, {})
    const peer = { id: 'permissions-test', ctx, principal: { kind: 'global' }, signal: new AbortController().signal, interactions: 'none', dispose: async () => {} }
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    for (const request of [{ sessionId: 'forbidden-cold-child' }, {}]) {
      await expect(gateway.invoke({ namespace: 'mayflyHost', method: 'permissionCatalogDetails', args: { request }, peer }))
        .rejects.toMatchObject({ code: 'remote-access/denied' })
    }
    expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ resources: [{ kind: 'global' }] }))
    expect(observe).not.toHaveBeenCalled()
    await expect(gateway.invoke({ namespace: 'mayflyHost', method: 'permissionCatalogDetails', args: { request: { sessionId: 'parent' } }, peer }))
      .resolves.toMatchObject({ yolo: false })
    expect(observe).toHaveBeenCalledExactlyOnceWith('parent', expect.objectContaining({ projectionMode: 'none' }))
    expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ resources: [{ kind: 'session', id: 'parent' }] }))
  })

  it('retires an in-flight passive permission observation on service unload', async () => {
    const { ctx, service, unload } = await host()
    const observation = Promise.withResolvers<Awaited<ReturnType<Context['sessionQuery']['observeSession']>>>()
    const dispose = vi.fn()
    let received: AbortSignal | undefined
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (_id, options) => { received = options?.signal; return observation.promise })
    const pending = service.permissionCatalogDetails({ sessionId: SessionId('parent') }, new AbortController().signal)
    await unload()
    expect(received?.aborted).toBe(true)
    observation.resolve({ events: [], [Symbol.dispose]: dispose } as never)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it.each([false, true])('requires global Gateway access before any history read, allWorkspaces=%s', async allWorkspaces => {
    const { ctx } = await host()
    new TypertRegistry(ctx)
    // Native sessionController registers a default resolver. The corpus method
    // must override it even though its request carries the selected Session.
    ctx.typert.resources.register('session', { field: 'sessionId' })
    const decide = vi.fn(({ resources }: { resources: readonly { kind: string, id?: string }[] }) =>
      resources.every(resource => resource.kind === 'session' && resource.id === 'parent')
        ? { kind: 'allow' } : { kind: 'deny', reason: 'only parent is authorized' })
    ctx.provide('remoteAccess', { decide })
    const gateway = new TypertGatewayService(ctx, {})
    const controller = new AbortController()
    const peer = { id: 'history-test', ctx, principal: { kind: 'global' }, signal: controller.signal, interactions: 'none', dispose: async () => {} }
    const observe = vi.spyOn(ctx.sessionQuery, 'observeSession')
    const list = vi.spyOn(ctx.sessionQuery, 'listSessions')
    await expect(gateway.stream({ namespace: 'mayflyHost', method: 'statsHistory', args: { request: { sessionId: 'parent', allWorkspaces } }, peer }))
      .rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'mayflyHost/statsHistory', resources: [{ kind: 'global' }] }))
    expect(list).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    await expect(gateway.invoke({ namespace: 'mayflyHost', method: 'statsSession', args: { request: { sessionId: 'parent' } }, peer }))
      .resolves.toMatchObject({ createdAt: 10 })
    expect(decide).toHaveBeenLastCalledWith(expect.objectContaining({ resources: [{ kind: 'session', id: 'parent' }] }))
    decide.mockReturnValue({ kind: 'allow' })
    const records = [
      { header: { id: 'parent', cwd: '/host', createdAt: 10 } },
      { header: { id: 'forbidden-sibling', cwd: '/host', createdAt: 20 } },
      { header: { id: 'other-workspace', cwd: '/other', createdAt: 30 } },
    ]
    list.mockResolvedValue(records as never)
    observe.mockImplementation(async id => ({
      header: records.find(record => record.header.id === id)!.header,
      events: [{ type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }],
      revision: 'cold-one', [Symbol.dispose]: () => {},
    }) as never)
    const frames = []
    for await (const frame of await gateway.stream({ namespace: 'mayflyHost', method: 'statsHistory', args: { request: { sessionId: 'parent', allWorkspaces } }, peer })) frames.push(frame)
    expect(frames.at(-1)).toMatchObject({ running: false, total: allWorkspaces ? 3 : 2, digests: allWorkspaces
      ? [{ id: 'other-workspace' }, { id: 'forbidden-sibling' }, { id: 'parent' }]
      : [{ id: 'forbidden-sibling' }, { id: 'parent' }] })
    expect(list).toHaveBeenCalledOnce()
  })

  it('routes every capability through the service installed by Cordis', async () => {
    const { service } = await host()
    const signal = new AbortController().signal
    const request = { sessionId: SessionId('parent') }
    expect(service.capabilities().features).toContain('presentTools')
    expect(service.capabilities().features).toEqual(expect.arrayContaining(['subagentTree', 'subagentStop']))
    expect(service.capabilities().features).not.toContain('subagentDrain')
    await expect(service.btwFork(request, signal)).resolves.toEqual({ sessionId: SessionId('btw-child'), historyFloorSeq: 37 })
    await expect(service.presentTools({ entries: [{ ...request, callId: 'one', updatedSeq: 1, name: 'missing', arguments: '{}' }] }, signal))
      .resolves.toMatchObject({ presentations: { parent: { one: { updatedSeq: 1 } } } })
    await expect(service.mcpCatalog(request, signal)).resolves.toMatchObject({ servers: [], sessionLive: true })
    await expect(service.toolCatalog(request, signal)).resolves.toEqual({ tools: [] })
    await expect(service.skillCatalog(request, signal)).resolves.toEqual({ skills: [], complete: true })
    await expect(service.retractTurn({ ...request, messageId: 'missing' }, signal)).resolves.toBe(false)
    await expect(service.modelCatalogDetails({}, signal)).resolves.toEqual({ items: [] })
    await expect(service.defaultModel({ operation: 'read' }, signal)).resolves.toEqual({ provider: 'fixture', model: 'one' })
    await expect(service.permissionCatalogDetails({}, signal)).resolves.toMatchObject({ options: [], yolo: false })
    await expect(service.providerBalance(signal)).resolves.toEqual({ status: 'unavailable', reason: 'no-key' })
    const document = await service.readSettingsDocument(signal)
    await expect(service.writeSettingsDocument({ content: '{"ok":true}', expectedRevision: document.revision }, signal)).resolves.toMatchObject({ content: '{"ok":true}' })
    await expect(service.subagentTree(request, signal)).resolves.toEqual([])
    await expect(service.subagentStop({ sessionId: request.sessionId, childSessionId: SessionId('missing') }, signal)).rejects.toMatchObject({ code: 'mayflyHost/subagent-stop-unavailable' })
    await expect(service.deliveredFile({ ...request, deliveryId: 'delivery', preview: true }, signal)).resolves.toEqual({ path: '/host/report.md', displayPath: '~/host/report.md', fileType: 'file', size: 6, preview: 'report' })
    expect(service.latestWorkspaceChanges(request, signal)).toBeNull()
    await expect(service.traceCatalog(request, signal)).resolves.toMatchObject([{ eventSeqs: [0] }])
    await expect(service.traceDetail({ ...request, seq: 0, eventSeqs: [0] }, signal)).resolves.toMatchObject({ rawEvents: [{ seq: 0 }], relation: { replacementChain: [] } })
    await expect(service.statsSession(request, signal)).resolves.toMatchObject({ createdAt: 10, cwd: '/host', status: 'idle' })
    const frames = []
    for await (const frame of service.statsHistory({ ...request, allWorkspaces: false }, signal)) frames.push(frame)
    expect(frames.at(-1)).toMatchObject({ running: false, total: 0, done: 0 })
    expect(service.workspaceChangesSummary({ ...request, seq: 1 }, signal)).toBeNull()
    await expect(service.workspaceChangesDiff({ ...request, seq: 1, index: 0 }, signal)).resolves.toBeNull()
    await expect(service.workspacePath({ path: '/missing' }, signal)).resolves.toBeNull()
    await expect(service.listMcpResources({ ...request, server: 'docs', kind: 'resources' }, signal)).resolves.toEqual({ items: [] })
    await expect(service.readMcpResource({ ...request, server: 'docs', uri: 'docs://one' }, signal)).resolves.toEqual({ text: '' })
    const workflow = service.followWorkflow(request, signal)[Symbol.asyncIterator]()
    expect(await workflow.next()).toEqual({ done: false, value: { type: 'baseline', value: { sessionId: request.sessionId, runs: [] } } })
    await workflow.return?.()
    service.cancelAuthorization({ key: credentialKey('fixture', 'account') }, signal)
    const authorization = service.authorize({ key: credentialKey('fixture', 'account') }, signal)[Symbol.asyncIterator]()
    await expect(authorization.next()).rejects.toMatchObject({ code: 'mayflyHost/authorization-unavailable' })
  })

  it('resolves Files in the exact Agent world even when that native ownership Fiber does not inject fs', async () => {
    const { ctx, service, filesystem } = await host()
    const agent = ctx.agents.get(SessionId('parent'))!
    expect(() => agent.ctx.fs).toThrow('cannot get property "fs" without inject')
    const hostRead = vi.spyOn(ctx.fs, 'resolve').mockRejectedValue(new Error('the root Host filesystem must stay unused'))
    const signal = new AbortController().signal
    await expect(service.deliveredFile({ sessionId: agent.id, deliveryId: 'delivery', preview: true }, signal)).resolves.toMatchObject({ preview: 'report' })
    expect(hostRead).not.toHaveBeenCalled()
    const completed = Promise.withResolvers<Awaited<ReturnType<Context['fs']['resolve']>>>()
    const agentRead = vi.spyOn(agent.ctx.get('fs')!, 'resolve').mockReturnValue(completed.promise)
    const pending = service.deliveredFile({ sessionId: agent.id, deliveryId: 'delivery' }, signal)
    await vi.waitFor(() => { expect(agentRead).toHaveBeenCalledOnce() })
    await filesystem.dispose()
    completed.resolve({ targetKey: 'unloaded-world' as never, displayPath: '/late' })
    await expect(pending).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    await expect(service.deliveredFile({ sessionId: agent.id, deliveryId: 'delivery' }, signal)).rejects.toMatchObject({ code: 'mayflyHost/delivery-unavailable' })
  })

  it('aborts in-flight work when its actual Cordis Fiber unloads and permits a fresh service', async () => {
    const { ctx, service, unload } = await host()
    let finish!: (value: Awaited<ReturnType<Context['skills']['snapshot']>>) => void
    let receivedSignal: AbortSignal | undefined
    ctx.skills.snapshot = (async (options: { signal?: AbortSignal }) => {
      receivedSignal = options.signal
      return new Promise(resolve => { finish = resolve })
    }) as typeof ctx.skills.snapshot
    const pending = service.skillCatalog({ sessionId: SessionId('parent') }, new AbortController().signal)
    await vi.waitFor(() => { expect(receivedSignal).toBeDefined() })
    await unload()
    expect(receivedSignal?.aborted).toBe(true)
    finish({ skills: [], complete: true })
    await expect(pending).rejects.toThrow()
    const replacement = ctx.plugin(MayflyHostService)
    await replacement
    expect(ctx.get('mayflyHost')).not.toBe(service)
    expect((ctx.get('mayflyHost') as HostService).capabilities().protocolVersion).toBe(1)
    await replacement.dispose()
  })

  it('retires an in-flight BTW native write on service unload without cancelling the Host-owned child', async () => {
    const { ctx, service, unload } = await host()
    const child = Promise.withResolvers<Awaited<ReturnType<Context['sessionController']['fork']>>>()
    const native = vi.spyOn(ctx.sessionController, 'fork').mockReturnValue(child.promise)
    const pending = service.btwFork({ sessionId: SessionId('parent') }, new AbortController().signal)
    const retired = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => { expect(native).toHaveBeenCalledWith({ sessionId: 'parent', atSeq: 37 }) })
    await unload()
    child.resolve({ sessionId: SessionId('btw-child') })
    await retired
    expect(native).toHaveBeenCalledOnce()
  })

  it('retires passive native tree discovery when the actual service Fiber unloads', async () => {
    const { ctx, service, unload } = await host()
    const listed = Promise.withResolvers<Awaited<ReturnType<Context['subagents']['listDescendants']>>>()
    let received: AbortSignal | undefined
    vi.spyOn(ctx.subagents, 'listDescendants').mockImplementation((_sessionId, signal) => { received = signal; return listed.promise })
    const pending = service.subagentTree({ sessionId: SessionId('parent') }, new AbortController().signal)
    const retired = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => { expect(received).toBeDefined() })
    await unload()
    expect(received?.aborted).toBe(true)
    listed.resolve([])
    await retired
  })

  it('waits for sent native descendant teardown but retires its reply on actual service Fiber unload', async () => {
    const { ctx, service, unload } = await host()
    const parent = ctx.agents.get(SessionId('parent'))!
    // This composition fixture supplies structural native owners; spreading a
    // typed Session/Agent does not preserve their private class members.
    const childSession = { ...parent.session, id: SessionId('leaf') } as typeof parent.session
    const child = { ...parent, id: childSession.id, session: childSession } as typeof parent
    vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === child.id ? child : id === parent.id ? parent : undefined)
    vi.spyOn(ctx.sessions, 'get').mockImplementation(id => id === child.id ? childSession : id === parent.id ? parent.session : undefined)
    vi.spyOn(ctx.subagents, 'listDescendants').mockResolvedValue([{ kind: 'child', id: child.id, parentId: parent.id, depth: 1, mode: 'continuable', label: 'leaf', activity: 'inactive', hasChildren: false }])
    const drained = Promise.withResolvers<void>()
    const native = vi.spyOn(ctx.subagents, 'drainChildren').mockReturnValue(drained.promise)
    const pending = service.subagentStop({ sessionId: parent.id, childSessionId: child.id }, new AbortController().signal)
    const retired = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => { expect(native).toHaveBeenCalledWith(parent, [child.id]) })
    await unload()
    drained.resolve()
    await retired
    expect(native).toHaveBeenCalledOnce()
  })
})

it('routes the native latest workspace event and aborts delivered-file reads on service Fiber unload', async () => {
  const { ctx, service, unload } = await host()
  const sessionId = SessionId('parent')
  const session = ctx.sessions.get(sessionId)!
  vi.spyOn(session, 'snapshotEvents').mockReturnValue([{ seq: 8, type: 'workspace/changes', time: 1, data: { turn: 3 } }, { seq: 9, type: 'turn/end', time: 2, data: { turn: 3, reason: { kind: 'completed' } } }] as never)
  const summary = { turn: 3, cwd: '/host', files: [], total: 0, added: 0, deleted: 0 }
  const nativeSummary = vi.spyOn(ctx.workspaceChanges, 'summary').mockReturnValue(summary)
  expect(service.latestWorkspaceChanges({ sessionId }, new AbortController().signal)).toEqual({ seq: 8, summary })
  expect(nativeSummary).toHaveBeenCalledWith(sessionId, 8)
  const resolved = Promise.withResolvers<Awaited<ReturnType<Context['fs']['resolve']>>>()
  let received: AbortSignal | undefined
  vi.spyOn(ctx.agents.get(sessionId)!.ctx.get('fs')!, 'resolve').mockImplementation(async (_path, options) => { received = options!.signal; return resolved.promise })
  const pending = service.deliveredFile({ sessionId, deliveryId: 'delivery' }, new AbortController().signal)
  await vi.waitFor(() => { expect(received).toBeDefined() })
  await unload()
  expect(received?.aborted).toBe(true)
  resolved.resolve({ targetKey: 'opaque' as never, displayPath: '/late' })
  await expect(pending).rejects.toThrow()
  expect(() => service.latestWorkspaceChanges({ sessionId }, new AbortController().signal)).toThrow()
})
