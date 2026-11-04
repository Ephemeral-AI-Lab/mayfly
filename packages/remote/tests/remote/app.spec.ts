import { describe, expect, it, vi } from 'vitest'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, HostTransportError, type HostClient, type HostConnectionState } from '../../src/client/types.ts'
import { RemoteApp, type RemoteAppView } from '../../src/remote/app.ts'
import type { RemoteNotice } from '../../src/remote/notice.ts'
import type { RemoteAppPanels } from '../../src/remote/interactions/plain-panels.ts'
import type { RemoteConversationModelSource } from '../../src/transcript/remote-model.ts'
import { mergeRemoteFeatureCommandSources, RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import { flush, submissionFixture } from './editor-feature-fixture.ts'
import type { EditorFeatureSession } from '../../src/remote/editor/types.ts'

vi.mock('../../src/frontend/btw.ts', () => ({
  RemoteBtwService: class {
    readonly ask = vi.fn()
    readonly close = vi.fn()
  },
}))
const defaultAttachHostClient = vi.hoisted(() => vi.fn())
vi.mock('../../src/remote/host-composition.ts', () => ({ attachMayflyHostClient: defaultAttachHostClient }))

function clientFixture(key: HostKey) {
  const sessionId = SessionId('shared-session')
  const eventSource = {
    getSnapshot: () => ({ entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }),
    subscribe: () => () => {},
  } satisfies SessionBinding['eventSource']
  const requestId = 'request-1' as SessionRequestId
  const projectionValues = new Map<string, unknown>()
  const sessionListeners = new Set<() => void>()
  const session = {
    beginSubmission: vi.fn(() => ({ requestId, abandon: vi.fn() })),
    prompt: vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } })),
    cancel: vi.fn(async () => ({ ok: true as const, value: { accepted: true as const } })),
    command: vi.fn(async () => ({ ok: true as const, value: { matched: false } })),
    getSnapshot: vi.fn(() => ({ running: false })),
    subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
    projections: { faceOf: (key: string) => ({ getSnapshot: () => projectionValues.get(key), subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } } }) },
  }
  const binding = { sessionId, eventSource, session, ctx: {} as never } as unknown as SessionBinding
  const reference: SessionReference = {
    sessionId,
    binding,
    ready: Promise.resolve(binding),
    release: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  }
  const summary = { id: sessionId, displayTitle: 'Shared Session', cwd: '/workspace' }
  const listSnapshot = vi.fn(() => ({
    ids: [sessionId],
    byId: { [sessionId]: summary },
    phase: 'ready' as const,
    projectionsBySession: {},
  }))
  const client: HostClient = {
    key,
    connection: { generation: { getSnapshot: () => ({ id: 1 }), subscribe: () => () => {} } } as never,
    remote: {
      commands: { list: vi.fn(async () => ({ ok: true as const, value: [{ name: 'compact', description: 'Compact history' }] })) },
      session: {
        modelCatalog: vi.fn(async () => ({
          ok: true as const,
          value: { default: { model: 'deepseek-chat', provider: 'deepseek' } },
        })),
      },
      pluginManager: { listBundles: vi.fn(async () => ({ ok: true as const, value: [{ name: '@deepseek-ai/dsh-base', version: '0.2.2-alpha.2' }] })) },
    } as never,
    fileUpload: {} as never,
    origin: 'http://127.0.0.1:3080',
    state: { getSnapshot: () => ({ status: 'connected', generation: 1 }), subscribe: () => () => {} } as never,
    workspaces: {} as never,
    sessions: {
      refresh: vi.fn(async () => {}),
      create: vi.fn(async () => sessionId),
      retain: vi.fn(() => reference),
      using: vi.fn(async (_id, _options, operation) => operation(reference)),
      list: { getSnapshot: listSnapshot, subscribe: () => () => {} },
    } as never,
    detach: vi.fn(async () => {}),
  }
  return { client, session, reference, sessionId, listSnapshot, projectionValues, sessionListeners }
}

function appFixture() {
  const conversation = {
    attach: vi.fn(),
    setDefaultModel: vi.fn(),
    setModelCatalog: vi.fn(),
    presentation: vi.fn(() => ({ cwd: '/workspace', contextTokens: 0, active: false, phase: 'idle' })),
  } as unknown as RemoteConversationModelSource
  const status = { set: vi.fn() } as RemoteNotice
  const panels: RemoteAppPanels = {
    showHelp: vi.fn(),
    showStatus: vi.fn(),
    showContext: vi.fn(),
    showVersion: vi.fn(),
    showChangelog: vi.fn(),
    showRewind: vi.fn(),
    showRename: vi.fn(),
  }
  return { conversation, status, panels, browser: { open: vi.fn() } }
}


describe('RemoteApp native command admission', () => {
  it('waits for the connected generation and its replacement catalog refresh before resuming a known Session', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    const obsolete = Promise.withResolvers<void>()
    const replacement = Promise.withResolvers<void>()
    let activeRefresh = obsolete.promise
    let connected = false
    let catalogReady = false
    const listeners = new Set<() => void>()
    Object.assign(f.client.connection, { generation: {
      getSnapshot: () => connected ? { id: 1 } : undefined,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    } })
    vi.mocked(f.client.sessions.refresh).mockImplementation(() => activeRefresh)
    f.listSnapshot.mockImplementation(() => ({ ids: catalogReady ? [f.sessionId] : [], byId: catalogReady ? { [f.sessionId]: { id: f.sessionId, displayTitle: 'Shared Session', cwd: '/workspace' } } : {}, phase: catalogReady ? 'ready' : 'pending', projectionsBySession: {} }) as never)
    vi.mocked(f.client.sessions.retain).mockImplementation(() => {
      if (!catalogReady) throw new Error(`sessions.retain: unknown session ${f.sessionId}`)
      return f.reference
    })
    // The official Client may have a bootstrap HTTP list pull before its
    // initial connection generation invalidates and replaces that pull.
    void f.client.sessions.refresh()
    let settled = false
    let failure: unknown
    const pending = app.attach('http://one.test/').then(() => app.selectOrCreate(f.sessionId)).catch(error => { failure = error }).finally(() => { settled = true })
    await flush()
    activeRefresh = replacement.promise
    void f.client.sessions.refresh()
    connected = true
    for (const listener of listeners) listener()
    obsolete.resolve()
    await flush()
    expect(settled).toBe(false)
    expect(f.client.sessions.retain).not.toHaveBeenCalled()
    catalogReady = true
    replacement.resolve()
    await pending
    expect(failure).toBeUndefined()
    expect(f.client.sessions.retain).toHaveBeenCalledOnce()
    expect(app.registry.current?.sessionId).toBe(f.sessionId)
    expect(listeners.size).toBe(0)
    app.dispose()
  })

  it.each(['caller', 'dispose', 'detach', 'new-attach'] as const)('retires a pending connection wait and its observers on %s', async retirement => {
    const first = clientFixture(HostKey('http://one.test/'))
    const second = clientFixture(HostKey('http://two.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, key => key === first.client.key ? first.client : second.client)
    const generationListeners = new Set<() => void>()
    const stateListeners = new Set<() => void>()
    Object.assign(first.client.connection, { generation: { getSnapshot: () => undefined, subscribe: (listener: () => void) => { generationListeners.add(listener); return () => { generationListeners.delete(listener) } } } })
    first.client.state.subscribe = listener => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } }
    const caller = new AbortController()
    const pending = app.attach('http://one.test/', undefined, caller.signal)
    await vi.waitFor(() => { expect(generationListeners.size).toBe(1) })
    const late = [...generationListeners, ...stateListeners]
    if (retirement === 'caller') caller.abort()
    if (retirement === 'dispose') app.dispose()
    if (retirement === 'detach') await app.execute('/detach')
    if (retirement === 'new-attach') await app.attach('http://two.test/')
    await pending
    for (const listener of late) listener()
    expect(generationListeners.size + stateListeners.size).toBe(0)
    expect(first.client.sessions.refresh).not.toHaveBeenCalled()
    expect(first.client.remote.session.modelCatalog).not.toHaveBeenCalled()
    expect(first.client.sessions.retain).not.toHaveBeenCalled()
    app.dispose()
  })

  it.each(['authentication-required', 'failed', 'detached'] as const)('reports terminal %s during connection startup and releases every observer', async status => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    let state: HostConnectionState = { status: 'connecting', generation: 0 }
    const listeners = new Set<() => void>()
    Object.assign(f.client.connection, { generation: { getSnapshot: () => undefined, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } })
    Object.assign(f.client.state, { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } })
    const pending = app.attach('http://one.test/')
    const rejected = expect(pending).rejects.toThrow(status === 'detached' ? 'Host Client is detached' : 'connection refused')
    await vi.waitFor(() => { expect(listeners.size).toBe(1) })
    state = status === 'detached' ? { status, generation: 0 } : { status, generation: 0, error: new HostTransportError('unavailable', 'connection refused') }
    for (const listener of listeners) listener()
    await rejected
    expect(listeners.size).toBe(0)
    expect(f.client.sessions.refresh).not.toHaveBeenCalled()
    app.dispose()
  })

  it('discards a terminal startup failure after the app retires in the same callback turn', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    let state: HostConnectionState = { status: 'connecting', generation: 0 }
    const listeners = new Set<() => void>()
    Object.assign(f.client.connection, { generation: { getSnapshot: () => undefined, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } } })
    Object.assign(f.client.state, { getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } })
    const pending = app.attach('http://one.test/')
    await vi.waitFor(() => { expect(listeners.size).toBe(1) })
    state = { status: 'failed', generation: 0, error: new HostTransportError('unavailable', 'retired startup failure') }
    for (const listener of listeners) listener()
    app.dispose()
    await expect(pending).resolves.toBe(f.client)
    expect(listeners.size).toBe(0)
    expect(test.status.set).not.toHaveBeenCalled()
    expect(f.client.sessions.refresh).not.toHaveBeenCalled()
  })

  it('preserves an existing attachment on immediate abort and a newer Host selection during cancelled discovery', async () => {
    const one = clientFixture(HostKey('http://one.test/'))
    const two = clientFixture(HostKey('http://two.test/'))
    const test = appFixture()
    let view: RemoteAppView | undefined
    const app = new RemoteApp(test.conversation, test.status, test.panels, key => key === one.client.key ? one.client : two.client, '/workspace', undefined, () => view)
    await app.attach('http://two.test/')
    const immediate = new AbortController()
    const reused = app.execute('/attach http://two.test/', immediate.signal)
    immediate.abort()
    await reused
    expect(two.client.detach).not.toHaveBeenCalled()
    const gate = Promise.withResolvers<unknown>()
    vi.mocked(one.client.remote.session.modelCatalog).mockReturnValueOnce(gate.promise as never)
    const caller = new AbortController()
    const pending = app.execute('/attach http://one.test/', caller.signal)
    await vi.waitFor(() => { expect(one.client.remote.session.modelCatalog).toHaveBeenCalled() })
    view = { ref: { host: two.client.key, sessionId: two.sessionId }, binding: two.reference.binding, access: 'interactive', presentation: test.conversation.presentation() }
    await app.selectOrCreate('shared-session')
    caller.abort()
    gate.resolve({ ok: true, value: { default: { provider: 'late', model: 'late' } } })
    await pending
    expect(one.client.detach).toHaveBeenCalledOnce()
    expect(two.client.detach).not.toHaveBeenCalled()
    expect(app.registry.current?.host).toBe(two.client.key)
    app.dispose()
  })

  it('keeps current native failures visible across creation, prompt, command and attach', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    vi.mocked(f.client.sessions.create).mockRejectedValueOnce(new Error('create refused'))
    await expect(app.selectOrCreate()).rejects.toThrow('create refused')
    await app.selectOrCreate('shared-session')
    f.session.prompt.mockRejectedValueOnce(new Error('prompt refused'))
    await expect(app.execute('hello')).rejects.toThrow('prompt refused')
    f.session.command.mockRejectedValueOnce(new Error('command refused'))
    await expect(app.execute('/native')).rejects.toThrow('command refused')
    vi.mocked(f.client.remote.session.modelCatalog).mockRejectedValueOnce(new Error('attach refused'))
    await expect(app.execute('/attach http://one.test/')).rejects.toThrow('attach refused')
    app.dispose()
  })

  it('contains superseded fork selection but reports actual native opening failures', async () => {
    for (const error of [new Error('native open refused'), 'plain open refused', Object.assign(new Error('retired selection'), { name: 'HostOperationSupersededError' }), new Error('Session selection was superseded')]) {
      const f = clientFixture(HostKey('http://one.test/'))
      const test = appFixture()
      Object.assign(f.client.sessions, { fork: vi.fn(async () => SessionId('child')) })
      const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
      await app.attach('http://one.test/')
      await app.selectOrCreate('shared-session')
      vi.spyOn(app.actions, 'select').mockRejectedValueOnce(error)
      const pending = app.execute('/fork')
      if (error instanceof Error && (error.name === 'HostOperationSupersededError' || error.message.includes('superseded'))) await expect(pending).resolves.toEqual({ exit: false })
      else await expect(pending).rejects.toBe(error)
      expect(app.registry.current?.sessionId).toBe('shared-session')
      app.dispose()
    }
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    Object.assign(f.client.sessions, { fork: vi.fn(async () => SessionId('child')) })
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    const ready = Promise.withResolvers<SessionBinding>()
    const retained = { ...f.reference, ready: ready.promise, release: vi.fn() }
    vi.mocked(f.client.sessions.retain).mockReturnValueOnce(retained)
    const caller = new AbortController()
    const pending = app.execute('/fork', caller.signal)
    await vi.waitFor(() => { expect(f.client.sessions.retain).toHaveBeenCalledTimes(2) })
    caller.abort()
    ready.resolve(retained.binding)
    await pending
    expect(retained.release).toHaveBeenCalledOnce()
    expect(app.registry.current?.sessionId).toBe('shared-session')
    app.dispose()
  })

  it('fences both detached-Client outcomes and never reports them after caller retirement', async () => {
    for (const retired of ['current', 'abort', 'dispose', 'reattach'] as const) for (const fails of [false, true]) {
      const f = clientFixture(HostKey('http://one.test/'))
      const test = appFixture()
      const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
      await app.attach('http://one.test/')
      const gate = Promise.withResolvers<void>()
      vi.mocked(f.client.detach).mockReturnValueOnce(gate.promise)
      const caller = new AbortController()
      const pending = app.execute('/detach', caller.signal)
      const settlement = retired === 'current' && fails ? expect(pending).rejects.toThrow('detach refused') : expect(pending).resolves.toEqual({ exit: false })
      if (retired === 'abort') caller.abort()
      if (retired === 'dispose') app.dispose()
      if (retired === 'reattach') await app.registry.attach(f.client.key)
      if (fails) gate.reject(new Error('detach refused'))
      else gate.resolve()
      await settlement
      if (retired !== 'current') expect(test.status.set).not.toHaveBeenCalledWith(`Detached ${f.client.key}`)
      app.dispose()
    }
  })

  it('fences cancelled discovery panels and closes Context through its exact source subscription', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    for (const fails of [false, true]) {
      const commands = Promise.withResolvers<unknown>()
      vi.mocked(f.client.remote.commands.list).mockReturnValueOnce(commands.promise as never)
      const caller = new AbortController()
      const pending = app.execute('/help', caller.signal)
      await vi.waitFor(() => { expect(f.client.remote.commands.list).toHaveBeenCalled() })
      caller.abort()
      if (fails) commands.reject(new Error('retired discovery'))
      else commands.resolve({ ok: true, value: [] })
      await pending
      expect(test.panels.showHelp).not.toHaveBeenCalled()
    }
    await app.execute('/version')
    vi.mocked(test.panels.showVersion).mockClear()
    for (const fails of [false, true]) {
      const inventory = Promise.withResolvers<unknown>()
      vi.mocked(f.client.remote.pluginManager.listBundles).mockReturnValueOnce(inventory.promise as never)
      const caller = new AbortController()
      const pending = app.execute('/version', caller.signal)
      caller.abort()
      if (fails) inventory.reject(new Error('retired inventory'))
      else inventory.resolve({ ok: true, value: [] })
      await pending
      expect(test.panels.showVersion).not.toHaveBeenCalled()
    }
    const caller = new AbortController()
    await app.execute('/context', caller.signal)
    const source = vi.mocked(test.panels.showContext).mock.calls[0]![0]
    const listener = vi.fn()
    const off = source.subscribe(listener)
    caller.abort()
    expect(listener).toHaveBeenCalledOnce()
    expect(source.read()).toBeUndefined()
    off()
    await expect(app.ensureSession('/workspace', caller.signal)).rejects.toThrow()
    await expect(app.selectOrCreate('shared-session', '/workspace', caller.signal)).rejects.toThrow()
    app.dispose()
  })

  it('retires a cancelled Session browser callback before selection', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const browser = { open: vi.fn() }
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client, '/workspace', browser)
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    const abort = new AbortController()
    await app.execute('/sessions', abort.signal)
    expect(browser.open).toHaveBeenCalledWith(f.client, app.registry.current, expect.any(Function), abort.signal)
    const choose = browser.open.mock.calls[0]![2] as (id: string) => void
    abort.abort()
    choose('never selected')
    expect(f.client.sessions.retain).toHaveBeenCalledOnce()
    app.dispose()
  })

  it('releases only a newly attached cancelled Client and fences late default-model discovery', async () => {
    for (const existing of [false, true]) {
      const f = clientFixture(HostKey('http://one.test/'))
      const test = appFixture()
      const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
      if (existing) await app.attach('http://one.test/')
      vi.mocked(test.conversation.setDefaultModel).mockClear()
      const gate = Promise.withResolvers<unknown>()
      vi.mocked(f.client.remote.session.modelCatalog).mockReturnValueOnce(gate.promise as never)
      const abort = new AbortController()
      const pending = app.execute('/attach http://one.test/', abort.signal)
      await vi.waitFor(() => { expect(f.client.remote.session.modelCatalog).toHaveBeenCalledTimes(existing ? 2 : 1) })
      abort.abort()
      gate.resolve({ ok: true, value: { default: { provider: 'late', model: 'late' } } })
      await pending
      expect(test.conversation.setDefaultModel).not.toHaveBeenCalled()
      if (existing) expect(f.client.detach).not.toHaveBeenCalled()
      else expect(f.client.detach).toHaveBeenCalledOnce()
      app.dispose()
    }
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const attached = Promise.withResolvers<HostClient>()
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => attached.promise)
    const abort = new AbortController()
    const pending = app.execute('/attach http://one.test/', abort.signal)
    abort.abort()
    attached.resolve(f.client)
    await pending
    expect(f.client.detach).toHaveBeenCalledOnce()
    await expect(app.attach('http://one.test/', undefined, abort.signal)).rejects.toThrow()
    app.dispose()
  })

  it('validates presets before clearing and consumes a valid preset only on the next creation', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const list = vi.fn(async () => ({ ok: true, value: { presets: [{ id: 'builder' }, { id: 'broken', broken: 'invalid' }] } }))
    Object.assign(f.client.remote, { agentPresets: { list } })
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    for (const preset of ['absent', 'broken']) {
      await expect(app.execute(`/new ${preset}`)).rejects.toThrow(`unknown agent preset ${preset}`)
      expect(app.registry.current?.sessionId).toBe(f.sessionId)
    }
    list.mockResolvedValueOnce({ ok: false, error: { message: 'roster denied' } } as never)
    await expect(app.execute('/new builder')).rejects.toThrow('roster denied')
    list.mockRejectedValueOnce(new Error('roster failed'))
    await expect(app.execute('/new builder')).rejects.toThrow('roster failed')
    await app.execute('/clear builder')
    expect(app.registry.current).toBeUndefined()
    expect(f.client.sessions.create).not.toHaveBeenCalled()
    await expect(app.execute('/new absent')).rejects.toThrow('unknown agent preset')
    await app.ensureSession()
    expect(f.client.sessions.create).toHaveBeenLastCalledWith({ cwd: process.cwd(), agentPreset: 'builder' })
    await app.execute('/new')
    await app.ensureSession()
    expect(f.client.sessions.create).toHaveBeenLastCalledWith({ cwd: process.cwd() })
    app.dispose()
    const unattached = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await expect(unattached.execute('/new builder')).rejects.toThrow('Attach a Host')
    unattached.dispose()
  })

  it.each(['abort', 'selection', 'connection', 'binding', 'view', 'access', 'newer', 'dispose'] as const)('retires both preset read outcomes after %s without clearing the source', async reason => {
    for (const fails of [false, true]) {
      const f = clientFixture(HostKey('http://one.test/'))
      const test = appFixture()
      let generation = 1
      Object.assign(f.client.state, { getSnapshot: () => ({ status: 'connected', generation }) })
      let view: RemoteAppView | undefined
      const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client, '/workspace', undefined, () => view)
      await app.attach('http://one.test/')
      await app.selectOrCreate('shared-session')
      view = { ref: app.registry.current!, binding: f.reference.binding, access: 'interactive', presentation: test.conversation.presentation() }
      const gate = Promise.withResolvers<unknown>()
      Object.assign(f.client.remote, { agentPresets: { list: vi.fn(() => gate.promise) } })
      const abort = new AbortController()
      const pending = app.execute('/new builder', abort.signal)
      if (reason === 'abort') abort.abort()
      if (reason === 'selection') app.clearSession()
      if (reason === 'connection') generation += 1
      if (reason === 'binding') view = { ...view, binding: { ...f.reference.binding } }
      if (reason === 'view') view = { ...view, ref: { ...view.ref, sessionId: SessionId('other') } }
      if (reason === 'access') view = { ...view, access: 'readonly' }
      if (reason === 'newer') await app.execute('/new')
      if (reason === 'dispose') app.dispose()
      const clearCount = vi.mocked(test.conversation.attach).mock.calls.length
      if (fails) gate.reject(new Error('retired roster failure'))
      else gate.resolve({ ok: true, value: { presets: [{ id: 'builder' }] } })
      await pending
      expect(vi.mocked(test.conversation.attach).mock.calls.length).toBe(clearCount)
      expect(test.status.set).not.toHaveBeenCalledWith('retired roster failure')
      expect(f.client.sessions.create).not.toHaveBeenCalled()
      app.dispose()
    }
  })

  it.each(['abort', 'connection', 'binding', 'dispose'] as const)('releases a pending native selection after %s before committing it', async reason => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    let generation = 1
    Object.assign(f.client.state, { getSnapshot: () => ({ status: 'connected', generation }) })
    let view: RemoteAppView | undefined
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client, '/workspace', undefined, () => view)
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    view = { ref: app.registry.current!, binding: f.reference.binding, access: 'interactive', presentation: test.conversation.presentation() }
    const ready = Promise.withResolvers<SessionBinding>()
    const reference = { ...f.reference, ready: ready.promise, release: vi.fn() }
    vi.mocked(f.client.sessions.retain).mockReturnValueOnce(reference)
    const abort = new AbortController()
    const pending = app.selectOrCreate('new-selection', '/workspace', abort.signal)
    const rejected = expect(pending).rejects.toThrow('superseded')
    await vi.waitFor(() => { expect(f.client.sessions.retain).toHaveBeenCalledTimes(2) })
    if (reason === 'abort') abort.abort()
    if (reason === 'connection') generation += 1
    if (reason === 'binding') view = { ...view, binding: { ...f.reference.binding } }
    if (reason === 'dispose') app.dispose()
    ready.resolve(reference.binding)
    await rejected
    expect(reference.release).toHaveBeenCalledOnce()
    if (reason !== 'dispose') expect(app.registry.current?.sessionId).toBe('shared-session')
    expect(f.session.cancel).not.toHaveBeenCalled()
    app.dispose()
  })

  it.each(['abort', 'connection'] as const)('keeps a sent creation Host-owned after %s and fences both outcomes', async reason => {
    for (const fails of [false, true]) {
      const f = clientFixture(HostKey('http://one.test/'))
      const test = appFixture()
      let generation = 1
      Object.assign(f.client.state, { getSnapshot: () => ({ status: 'connected', generation }) })
      const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
      await app.attach('http://one.test/')
      const gate = Promise.withResolvers<SessionId>()
      vi.mocked(f.client.sessions.create).mockReturnValueOnce(gate.promise)
      const abort = new AbortController()
      const pending = app.selectOrCreate(undefined, '/workspace', abort.signal)
      const rejected = expect(pending).rejects.toThrow('superseded')
      if (reason === 'abort') abort.abort()
      else generation += 1
      if (fails) gate.reject(new Error('late create rejection'))
      else gate.resolve(SessionId('created'))
      await rejected
      expect(app.registry.current).toBeUndefined()
      expect(f.client.sessions.retain).not.toHaveBeenCalled()
      expect(f.session.cancel).not.toHaveBeenCalled()
      app.dispose()
    }
  })

  it('refuses busy fork/init before any Host mutation and guards init again after preparation and reference acquisition', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const fork = vi.fn(async () => SessionId('child'))
    Object.assign(f.client.sessions, { fork })
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    f.session.getSnapshot.mockReturnValueOnce({ running: true })
    await app.execute('/fork')
    expect(fork).not.toHaveBeenCalled()
    expect(test.status.set).toHaveBeenLastCalledWith('cannot fork while the agent is running', 'error')
    f.session.getSnapshot.mockReturnValueOnce({ running: true })
    await app.execute('/init')
    expect(test.status.set).toHaveBeenLastCalledWith('cannot run /init while the agent is running', 'error')
    vi.spyOn(app, 'preparePrompt').mockImplementationOnce(async () => { f.session.getSnapshot.mockReturnValueOnce({ running: true }) })
    await app.execute('/init')
    expect(f.session.prompt).not.toHaveBeenCalled()
    vi.mocked(f.client.sessions.using).mockImplementationOnce(async (_id, _options, run) => {
      f.session.getSnapshot.mockReturnValueOnce({ running: true })
      return run(f.reference)
    })
    await expect(app.execute('/init')).rejects.toThrow('cannot run /init while the agent is running')
    expect(f.session.prompt).not.toHaveBeenCalled()
    app.dispose()
  })

  it.each(['abort', 'selection', 'connection', 'binding', 'dispose'] as const)('keeps late fork success/failure at its original Host after %s', async reason => {
    for (const fails of [false, true]) {
      const f = clientFixture(HostKey('http://one.test/'))
      const test = appFixture()
      let generation = 1
      Object.assign(f.client.state, { getSnapshot: () => ({ status: 'connected', generation }) })
      let view: RemoteAppView | undefined
      const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client, '/workspace', undefined, () => view)
      await app.attach('http://one.test/')
      await app.selectOrCreate('shared-session')
      view = { ref: app.registry.current!, binding: f.reference.binding, access: 'interactive', presentation: test.conversation.presentation() }
      const gate = Promise.withResolvers<SessionId>()
      const fork = vi.fn(() => gate.promise)
      Object.assign(f.client.sessions, { fork })
      const abort = new AbortController()
      const pending = app.execute('/fork', abort.signal)
      if (reason === 'abort') abort.abort()
      if (reason === 'selection') app.clearSession()
      if (reason === 'connection') generation += 1
      if (reason === 'binding') view = { ...view, binding: { ...f.reference.binding } }
      if (reason === 'dispose') app.dispose()
      if (fails) gate.reject(new Error('retired fork refusal'))
      else gate.resolve(SessionId('retired-child'))
      await pending
      expect(f.client.sessions.retain).toHaveBeenCalledOnce()
      expect(test.status.set).not.toHaveBeenCalledWith('retired fork refusal', 'error')
      expect(fork).toHaveBeenCalledOnce()
      expect(f.session.cancel).not.toHaveBeenCalled()
      app.dispose()
    }
  })

  it.each(['init', 'prompt', 'command'] as const)('fences cancelled %s at native reference acquisition and after its sent result', async kind => {
    for (const stage of ['prepare', 'acquire', 'result'] as const) for (const outcome of ['success', 'refusal', 'rejection'] as const) {
      if (kind === 'command' && stage === 'prepare') continue
      const f = clientFixture(HostKey('http://one.test/'))
      const test = appFixture()
      const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
      await app.attach('http://one.test/')
      await app.selectOrCreate('shared-session')
      const abort = new AbortController()
      const gate = Promise.withResolvers<unknown>()
      if (stage === 'prepare') vi.spyOn(app, 'preparePrompt').mockImplementationOnce(() => gate.promise as Promise<void>)
      if (stage === 'acquire') vi.mocked(f.client.sessions.using).mockImplementationOnce(async (_id, _options, run) => { await gate.promise; return run(f.reference) })
      if (stage === 'result') (kind === 'command' ? f.session.command : f.session.prompt).mockReturnValueOnce(gate.promise as never)
      const pending = app.execute(kind === 'init' ? '/init' : kind === 'command' ? '/native' : 'hello', abort.signal)
      if (stage === 'prepare') await vi.waitFor(() => { expect(app.preparePrompt).toHaveBeenCalled() })
      else if (stage === 'acquire') await vi.waitFor(() => { expect(f.client.sessions.using).toHaveBeenCalled() })
      else await vi.waitFor(() => { expect(kind === 'command' ? f.session.command : f.session.prompt).toHaveBeenCalled() })
      abort.abort()
      if (outcome === 'rejection') gate.reject(new Error('retired native rejection'))
      else gate.resolve(stage !== 'result' ? undefined : outcome === 'success'
        ? { ok: true, value: kind === 'command' ? { matched: true } : { accepted: true } }
        : { ok: false, error: { message: 'retired native refusal' } })
      await pending
      if (stage !== 'result') {
        expect(f.session.prompt).not.toHaveBeenCalled()
        expect(f.session.command).not.toHaveBeenCalled()
      }
      expect(test.status.set).not.toHaveBeenCalled()
      expect(f.session.cancel).not.toHaveBeenCalled()
      app.dispose()
    }
  })
})

describe('RemoteApp title editor and lifetime', () => {
  it('fences a cancelled title owner before writes and removes its abort subscription', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    const abort = new AbortController()
    await app.execute('/rename', abort.signal)
    const [, save, current, subscribe] = vi.mocked(test.panels.showRename).mock.calls[0]!
    const listener = vi.fn()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    const off = subscribe(listener)
    abort.abort()
    expect(listener).toHaveBeenCalledOnce()
    expect(current()).toBe(false)
    await save('Never admitted')
    expect(f.client.sessions.using).not.toHaveBeenCalled()
    off()
    expect(remove).toHaveBeenCalledWith('abort', listener)
    await expect(app.execute('/rename', abort.signal)).rejects.toThrow()
    app.dispose()
  })
  it('rechecks ownership after native reference acquisition before admitting the rename write', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const rename = vi.fn(async () => ({ ok: true as const, value: { title: 'never admitted' } }))
    Object.assign(f.session, { rename })
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    const ready = Promise.withResolvers<void>()
    vi.mocked(f.client.sessions.using).mockImplementationOnce(async (_id, _options, operation) => {
      await ready.promise
      return operation(f.reference)
    })
    const pending = app.execute('/rename Too late')
    app.dispose()
    ready.resolve()
    await pending
    expect(rename).not.toHaveBeenCalled()
    expect(test.status.set).not.toHaveBeenCalledWith(expect.stringContaining('Too late'), 'info')
    expect(f.session.cancel).not.toHaveBeenCalled()
  })

  it('releases a title owner without a displayed-view observer and retires feedback queued after a refusal', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    await app.execute('/rename')
    const [, , , subscribe] = vi.mocked(test.panels.showRename).mock.calls[0]!
    subscribe(() => {})()
    vi.spyOn(app.actions, 'rename').mockImplementationOnce(() => {
      const rejected = Promise.reject(new Error('retired rejection'))
      void rejected.catch(() => { queueMicrotask(() => { app.dispose() }) })
      return rejected
    })
    await app.execute('/rename Changed')
    expect(test.status.set).not.toHaveBeenCalledWith('retired rejection', 'error')
  })
  it('prefills the exact displayed title, trims through the form owner, and retires its observers', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const rename = vi.fn(async (title: string) => ({ ok: true as const, value: { title } }))
    Object.assign(f.session, { rename })
    f.projectionValues.set('title', 'Current native title')
    const listeners = new Set<() => void>()
    const offDisplayed = vi.fn()
    let view: RemoteAppView | undefined
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client, '/workspace', undefined, () => view, undefined,
      callback => { listeners.add(callback); return () => { listeners.delete(callback); offDisplayed() } })
    await app.attach('http://one.test/')
    await app.selectOrCreate('shared-session')
    await app.execute('/rename')
    const [title, save, current, subscribe] = vi.mocked(test.panels.showRename).mock.calls[0]!
    expect(title).toBe('Current native title')
    expect(current()).toBe(true)
    const listener = vi.fn()
    const off = subscribe(listener)
    for (const changed of listeners) changed()
    expect(listener).toHaveBeenCalledOnce()
    await save('Edited title')
    expect(rename).toHaveBeenCalledWith('Edited title')
    expect(test.status.set).not.toHaveBeenCalled()
    rename.mockResolvedValueOnce({ ok: false, error: { message: 'native refused' } } as never)
    await expect(save('Refused')).rejects.toThrow('native refused')
    off()
    expect(offDisplayed).toHaveBeenCalledOnce()
    view = { ref: app.registry.current!, binding: f.reference.binding, access: 'readonly', presentation: test.conversation.presentation() }
    expect(current()).toBe(false)
    await expect(app.execute('/rename')).rejects.toThrow('read-only')
    view = { ref: view.ref, presentation: view.presentation, access: 'interactive' }
    await expect(app.execute('/rename')).rejects.toThrow('no native Client binding')
    app.dispose(); app.dispose()
    await expect(app.execute('/rename')).rejects.toThrow('disposed')
    await expect(app.selectOrCreate()).rejects.toThrow('disposed')
    await expect(app.ensureSession()).rejects.toThrow('disposed')
    await expect(app.preparePrompt(f.reference.binding as never)).rejects.toThrow('disposed')
    await expect(app.attach('http://one.test/')).rejects.toThrow('disposed')
    expect(f.session.cancel).not.toHaveBeenCalled()
  })

  it.each(['selection', 'binding', 'host', 'connection', 'readonly', 'dispose', 'abort'] as const)('fences both title outcomes after %s retirement', async change => {
    for (const fails of [false, true]) {
      const f = clientFixture(HostKey('http://one.test/'))
      const other = clientFixture(HostKey('http://two.test/'))
      const test = appFixture()
      let generation = 1
      Object.assign(f.client.state, { getSnapshot: () => ({ status: 'connected', generation }) })
      let view: RemoteAppView = { ref: { host: f.client.key, sessionId: f.sessionId }, binding: f.reference.binding, access: 'interactive', presentation: test.conversation.presentation() }
      const app = new RemoteApp(test.conversation, test.status, test.panels, key => key === f.client.key ? f.client : other.client, '/workspace', undefined, () => view)
      await app.attach('http://one.test/')
      const result = Promise.withResolvers<{ ok: true, value: { title: string } }>()
      const rename = vi.fn(() => result.promise)
      Object.assign(f.session, { rename })
      const abort = new AbortController()
      await app.execute('/rename', abort.signal)
      const [, save, current] = vi.mocked(test.panels.showRename).mock.calls[0]!
      const pending = save('Accepted at original Host')
      if (change === 'selection') view = { ...view, ref: { ...view.ref, sessionId: SessionId('different') } }
      if (change === 'abort') abort.abort()
      if (change === 'binding') view = { ...view, binding: { ...f.reference.binding } }
      if (change === 'host') { await app.attach('http://two.test/'); view = { ...view, ref: { ...view.ref, host: other.client.key } } }
      if (change === 'connection') generation += 1
      if (change === 'readonly') view = { ...view, access: 'readonly' }
      if (change === 'dispose') app.dispose()
      expect(current()).toBe(false)
      if (fails) result.reject(new Error('retired failure'))
      else result.resolve({ ok: true, value: { title: 'Normalized accepted title' } })
      await pending
      await save('Never sent')
      expect(rename).toHaveBeenCalledOnce()
      expect(test.status.set).not.toHaveBeenCalled()
    }
  })

  it('suppresses retired direct-rename feedback and reports current thrown values', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const rename = vi.fn(async () => { throw 'plain rejection' })
    Object.assign(f.session, { rename })
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    await app.selectOrCreate()
    await app.execute('/rename Failed')
    expect(test.status.set).toHaveBeenLastCalledWith('plain rejection', 'error')
    const pendingTitle = Promise.withResolvers<never>()
    rename.mockReturnValueOnce(pendingTitle.promise)
    const pending = app.execute('/rename Late')
    app.dispose()
    pendingTitle.reject(new Error('late failure'))
    await pending
    expect(test.status.set).toHaveBeenCalledOnce()
  })

  it('releases pending selection/creation and late attachment resources without cancelling Host work', async () => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    const ready = Promise.withResolvers<SessionBinding>()
    Object.assign(f.reference, { ready: ready.promise })
    const selecting = app.selectOrCreate('shared-session')
    await Promise.resolve()
    app.dispose()
    ready.resolve(f.reference.binding)
    await expect(selecting).rejects.toThrow('superseded')
    expect(f.reference.release).toHaveBeenCalled()
    expect(app.registry.current).toBeUndefined()
    const creatingApp = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await creatingApp.attach('http://one.test/')
    const created = Promise.withResolvers<SessionId>()
    vi.mocked(f.client.sessions.create).mockReturnValueOnce(created.promise)
    const creating = creatingApp.ensureSession()
    creatingApp.dispose()
    created.resolve(f.sessionId)
    await expect(creating).rejects.toThrow('superseded')
    expect(creatingApp.registry.current).toBeUndefined()
    const attached = Promise.withResolvers<HostClient>()
    const attachingApp = new RemoteApp(test.conversation, test.status, test.panels, () => attached.promise)
    const attaching = attachingApp.attach('http://one.test/')
    attachingApp.dispose()
    attached.resolve(f.client)
    await expect(attaching).rejects.toThrow('disposed')
    expect(attachingApp.registry.list()).toEqual([])
    expect(f.client.detach).toHaveBeenCalled()
    expect(f.session.cancel).not.toHaveBeenCalled()
  })
})

describe('RemoteApp', () => {
  it('addresses the active Host while sessionless, preserves exact selection, and falls back after detach', async () => {
    const first = clientFixture(HostKey('http://one.test/'))
    const second = clientFixture(HostKey('http://two.test/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, key => key === first.client.key ? first.client : second.client)
    expect(app.activeClient).toBeUndefined()
    await app.attach('http://one.test/')
    await app.selectOrCreate()
    await app.attach('http://two.test/')
    expect(app.activeClient).toBe(first.client)
    app.clearSession()
    expect(app.activeClient).toBe(second.client)
    await app.execute('/detach')
    expect(second.client.detach).toHaveBeenCalledOnce()
    expect(first.client.detach).not.toHaveBeenCalled()
    expect(app.activeClient).toBe(first.client)
  })

  it('does not let a late attach steal the active sessionless Host', async () => {
    const first = clientFixture(HostKey('http://one.test/'))
    const second = clientFixture(HostKey('http://two.test/'))
    let resolve!: (client: HostClient) => void
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, key => key === first.client.key
      ? new Promise(done => { resolve = done }) : second.client)
    const pending = app.attach('http://one.test/')
    await app.attach('http://two.test/')
    resolve(first.client)
    await pending
    expect(app.activeClient).toBe(second.client)
    await app.ensureSession('/workspace')
    expect(second.client.sessions.create).toHaveBeenCalledWith({ cwd: '/workspace' })
    expect(first.client.sessions.create).not.toHaveBeenCalled()
  })

  it('stays sessionless until the first prompt and clears the view without stopping Host work', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    expect(app.registry.current).toBeUndefined()
    expect(fixture.client.sessions.create).not.toHaveBeenCalled()
    await app.execute('/help')
    expect(panels.showHelp).toHaveBeenCalled()
    expect(fixture.client.sessions.create).not.toHaveBeenCalled()

    await Promise.all([app.execute('first'), app.execute('second')])
    expect(fixture.client.sessions.create).toHaveBeenCalledOnce()
    expect(fixture.session.prompt).toHaveBeenCalledTimes(2)
    await app.execute('/new')
    expect(app.registry.current).toBeUndefined()
    expect(conversation.attach).toHaveBeenLastCalledWith(null)
    expect(fixture.reference.release).toHaveBeenCalledOnce()
    expect(fixture.session.cancel).not.toHaveBeenCalled()
    expect(fixture.client.detach).not.toHaveBeenCalled()
    await app.execute('/clear')
    expect(fixture.client.sessions.create).toHaveBeenCalledOnce()
  })

  it('does not select or prompt a Session created after the user returned to the start view', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    let resolve!: (id: SessionId) => void
    vi.mocked(fixture.client.sessions.create).mockReturnValue(new Promise(done => { resolve = done }) as never)
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    const pending = app.execute('first')
    await app.execute('/clear')
    resolve(fixture.sessionId)
    await expect(pending).rejects.toThrow('Session selection was superseded')
    expect(app.registry.current).toBeUndefined()
    expect(fixture.session.prompt).not.toHaveBeenCalled()
    expect(fixture.client.sessions.retain).not.toHaveBeenCalled()
  })

  it.each(['complete-first', 'complete-last'] as const)('isolates sessionless creation, prompts and startup intent across Hosts: %s', async order => {
    const first = clientFixture(HostKey('http://one.test/'))
    const second = clientFixture(HostKey('http://two.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, key => key === first.client.key ? first.client : second.client)
    const created = Promise.withResolvers<SessionId>()
    vi.mocked(first.client.sessions.create).mockReturnValueOnce(created.promise)
    Object.assign(first.client.remote, { agentPresets: { list: async () => ({ ok: true, value: { presets: [{ id: 'builder' }] } }) } })
    await app.attach('http://one.test/')
    await app.execute('/new builder')
    app.startupPlan.set(true)
    const pending = app.execute('first')
    const retired = expect(pending).rejects.toThrow('superseded')
    await app.attach('http://two.test/')
    expect(app.startupPlan.pending()).toBe(false)
    if (order === 'complete-first') {
      created.resolve(first.sessionId)
      await retired
    }
    await app.execute('second')
    if (order === 'complete-last') created.resolve(first.sessionId)
    await retired
    expect(first.client.sessions.create).toHaveBeenCalledExactlyOnceWith({ cwd: process.cwd(), agentPreset: 'builder' })
    expect(first.client.sessions.retain).not.toHaveBeenCalled()
    expect(first.session.command).not.toHaveBeenCalled()
    expect(first.session.prompt).not.toHaveBeenCalled()
    expect(first.session.cancel).not.toHaveBeenCalled()
    expect(second.client.sessions.create).toHaveBeenCalledExactlyOnceWith({ cwd: process.cwd() })
    expect(second.session.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'second' }], 'queue', undefined, 'request-1')
    expect(second.session.command).not.toHaveBeenCalled()
    expect(app.registry.current?.host).toBe(second.client.key)
    app.dispose()
  })

  it.each(['reconnect', 'detach'] as const)('replaces pending initial creation after %s without admitting its prompt', async change => {
    const f = clientFixture(HostKey('http://one.test/'))
    const test = appFixture()
    let generation = 1
    f.client.state.getSnapshot = () => ({ status: 'connected', generation })
    const app = new RemoteApp(test.conversation, test.status, test.panels, () => f.client)
    await app.attach('http://one.test/')
    const created = Promise.withResolvers<SessionId>()
    vi.mocked(f.client.sessions.create).mockReturnValueOnce(created.promise)
    const pending = app.execute('retired')
    const retired = expect(pending).rejects.toThrow('superseded')
    if (change === 'reconnect') generation += 1
    else {
      await app.execute('/detach')
      await app.attach('http://one.test/')
    }
    await app.execute('current')
    created.resolve(f.sessionId)
    await retired
    expect(f.client.sessions.create).toHaveBeenCalledTimes(2)
    expect(f.session.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'current' }], 'queue', undefined, 'request-1')
    expect(f.session.cancel).not.toHaveBeenCalled()
    app.dispose()
  })

  it('fences a pending editor attachment submission and its startup intent before admitting a new Host prompt', async () => {
    const first = clientFixture(HostKey('http://one.test/'))
    const second = clientFixture(HostKey('http://two.test/'))
    const test = appFixture()
    const app = new RemoteApp(test.conversation, test.status, test.panels, key => key === first.client.key ? first.client : second.client)
    const created = Promise.withResolvers<SessionId>()
    vi.mocked(first.client.sessions.create).mockReturnValueOnce(created.promise)
    Object.assign(first.client.remote, { agentPresets: { list: async () => ({ ok: true, value: { presets: [{ id: 'builder' }] } }) } })
    await app.attach('http://one.test/')
    await app.execute('/new builder')
    app.startupPlan.set(true)
    const formerSelection: EditorFeatureSession = {
      client: first.client, session: first.reference.binding.session,
      ref: { host: first.client.key, sessionId: first.sessionId }, generation: 1,
    }
    const editor = submissionFixture(formerSelection, async () => {
      const ref = await app.ensureSession()
      const client = app.registry.get(ref.host)!
      const selected: EditorFeatureSession = { client, session: app.registry.currentReference!.binding.session, ref, generation: 1 }
      editor.select(selected)
      return selected
    }, (selected, signal, intent) => app.preparePrompt(selected.ref, signal, intent))
    // A receipt may remain in the draft after /new; it retains its original
    // exact native owner even while first-Session acquisition is pending.
    const marker = editor.file()
    editor.select(undefined)
    editor.enter(`first ${marker}`)
    expect(first.client.sessions.create).toHaveBeenCalledOnce()
    await app.attach('http://two.test/')
    editor.enter('second')
    await flush()
    expect(second.session.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'second' }], 'queue', expect.any(AbortSignal), 'request-1')
    created.resolve(first.sessionId)
    await flush()
    expect(first.client.sessions.retain).not.toHaveBeenCalled()
    expect(first.session.command).not.toHaveBeenCalled()
    expect(first.session.prompt).not.toHaveBeenCalled()
    expect(first.session.beginSubmission).not.toHaveBeenCalled()
    expect(second.session.command).not.toHaveBeenCalled()
    expect(second.client.sessions.create).toHaveBeenCalledExactlyOnceWith({ cwd: process.cwd() })
    expect(app.startupPlan.pending()).toBe(false)
    expect(app.registry.current?.host).toBe(second.client.key)
    expect(editor.attachments.capture(marker).content).toEqual([{ type: 'file', receiptId: 'receipt-1' }])
    app.dispose()
  })

  it.each(['', 'mount/'])('shares one Host Client, connection generation and displayed lease for root and connect paths under %s', async mount => {
    const { conversation, status, panels } = appFixture()
    const f = clientFixture(HostKey(`https://same.test/${mount}`))
    const attach = vi.fn(() => f.client)
    const app = new RemoteApp(conversation, status, panels, attach)
    await app.attach(`https://same.test/${mount}?token=first`)
    await app.selectOrCreate(undefined, '/workspace')
    const generation = f.client.state.getSnapshot().generation
    const binding = app.registry.currentReference?.binding
    for (const path of [`${mount}connect`, `${mount}connect/`, mount.replace(/\/$/u, '')]) {
      await app.attach(`https://same.test/${path}?token=changed&query=other#fragment`)
      expect(app.activeClient).toBe(f.client)
      expect(app.registry.currentReference?.binding).toBe(binding)
      expect(f.client.state.getSnapshot().generation).toBe(generation)
    }
    expect(app.registry.list()).toEqual([f.client])
    expect(attach).toHaveBeenCalledOnce()
    expect(f.client.sessions.retain).toHaveBeenCalledOnce()
    expect(f.reference.release).not.toHaveBeenCalled()
    app.dispose()
  })

  it('separates schemes and reverse-proxy mount paths without putting credentials in Host keys', async () => {
    const { conversation, status, panels } = appFixture()
    const attach = vi.fn(async (key: HostKey) => clientFixture(key).client)
    const app = new RemoteApp(conversation, status, panels, attach)
    await app.attach('http://same.test:3080/one/?token=secret')
    await app.attach('http://same.test:3080/two?token=other')
    await app.attach('https://same.test:3080/one/#token=third')
    await app.attach('http://same.test:3080/one?token=changed')
    expect(app.registry.list().map(client => client.key)).toEqual([
      'http://same.test:3080/one/', 'http://same.test:3080/two/', 'https://same.test:3080/one/',
    ])
    expect(attach).toHaveBeenCalledTimes(3)
  })

  it('routes create, select, and prompt through the selected Host', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    expect(conversation.setDefaultModel).toHaveBeenCalledWith({ model: 'deepseek-chat', provider: 'deepseek' })
    await app.selectOrCreate(undefined, '/workspace')
    expect(fixture.client.sessions.create).toHaveBeenCalledWith({ cwd: '/workspace' })
    expect(conversation.attach).toHaveBeenCalledWith(fixture.reference.binding, {
      ref: expect.objectContaining({ sessionId: fixture.sessionId }),
      cwd: '/workspace',
    })

    await app.execute('hello')
    expect(fixture.session.prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: 'hello' }],
      'queue',
      undefined,
      'request-1',
    )
    await app.cancel()
    expect(fixture.session.cancel).toHaveBeenCalledOnce()
    expect(status.set).not.toHaveBeenCalledWith('cancel failed')
  })

  it('keeps identical SessionIds isolated by Host and detaches only the selected Host', async () => {
    const first = clientFixture(HostKey('http://one.test:3080/'))
    const second = clientFixture(HostKey('http://two.test:3081/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, key => key === HostKey('http://one.test:3080/') ? first.client : second.client)
    await app.attach('http://one.test:3080/?token=a')
    await app.selectOrCreate()
    await app.attach('http://two.test:3081/?token=b')
    await app.selectOrCreate()

    await app.execute('second')
    expect(second.session.prompt).toHaveBeenCalledOnce()
    expect(first.session.prompt).not.toHaveBeenCalled()
    await app.execute('/detach')
    expect(second.client.detach).toHaveBeenCalledOnce()
    expect(first.client.detach).not.toHaveBeenCalled()
  })

  it('reports attached Hosts and routes unknown commands to the selected Host Session', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    await app.execute('/host')
    expect(status.set).toHaveBeenCalledWith('http://127.0.0.1:3080/')
    await app.selectOrCreate()
    await app.execute('/not-a-command')
    expect(fixture.session.command).toHaveBeenCalledWith('/not-a-command')
    expect(status.set).toHaveBeenCalledWith('unknown command: /not-a-command', 'error')
    expect(fixture.session.prompt).not.toHaveBeenCalled()
  })

  it('supports new, resume, and attach commands with their actual Host routes', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    await app.execute('/new')
    expect(fixture.client.sessions.create).not.toHaveBeenCalled()
    await app.execute('/resume shared-session')
    expect(fixture.client.sessions.create).not.toHaveBeenCalled()
    await app.execute('/attach http://127.0.0.1:3080/?token=secret')
    expect(fixture.client.sessions.refresh).toHaveBeenCalledTimes(2)
    await app.execute('/host')
    expect(status.set).toHaveBeenCalledWith('http://127.0.0.1:3080/ *')
  })

  it('rejects actions without an attached Host or selected Session and handles empty detach', async () => {
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels)
    await expect(app.selectOrCreate()).rejects.toThrow('Attach a Host before selecting a Session')
    await expect(app.execute('/quit')).resolves.toEqual({ exit: true })
    await expect(app.execute('hello')).rejects.toThrow('Attach a Host before selecting a Session')
    await app.execute('/host')
    expect(status.set).toHaveBeenCalledWith('No attached Hosts')
    await app.execute('/detach')
    expect(conversation.attach).not.toHaveBeenCalled()
    await app.cancel()
  })

  it('surfaces prompt and cancellation failures and a missing Client binding', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    fixture.session.prompt.mockResolvedValue({ ok: false, error: { code: 'denied', message: 'denied' } } as never)
    fixture.session.cancel.mockResolvedValue({ ok: false, error: { code: 'busy', message: 'busy' } } as never)
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    await app.selectOrCreate()
    await app.execute('hello')
    expect(status.set).toHaveBeenCalledWith('denied', 'error')
    await app.cancel()
    expect(status.set).toHaveBeenCalledWith('busy', 'error')

    fixture.client.sessions.retain = vi.fn(() => ({ ...fixture.reference, binding: undefined }) as never)
    await expect(app.selectOrCreate('other-session')).rejects.toThrow('Selected Session has no Client binding')
  })

  it('uses the configured Host identity with the default composition attach', async () => {
    const fixture = clientFixture(HostKey('stable-host'))
    defaultAttachHostClient.mockResolvedValue(fixture.client)
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels)
    await app.attach('http://127.0.0.1:3080/?token=secret', 'stable-host')
    expect(defaultAttachHostClient).toHaveBeenCalledWith(HostKey('stable-host'), 'http://127.0.0.1:3080/?token=secret')
  })

  it('rejects an unregistered endpoint and derives default HTTP and HTTPS ports', async () => {
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels)
    await expect(app.registry.attach(HostKey('missing'))).rejects.toThrow('No endpoint registered for Host "missing"')
    const http = clientFixture(HostKey('http://host/'))
    const https = clientFixture(HostKey('https://host/'))
    defaultAttachHostClient.mockClear()
    defaultAttachHostClient
      .mockResolvedValueOnce(http.client)
      .mockResolvedValueOnce(https.client)
    await app.attach('http://host/')
    await app.attach('https://host/')
    expect(defaultAttachHostClient).toHaveBeenNthCalledWith(1, HostKey('http://host/'), 'http://host/')
    expect(defaultAttachHostClient).toHaveBeenNthCalledWith(2, HostKey('https://host/'), 'https://host/')
  })

  it('does not clear activeHost when detaching a different Host', async () => {
    const first = clientFixture(HostKey('http://one.test:3080/'))
    const second = clientFixture(HostKey('http://two.test:3081/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, key => key === HostKey('http://one.test:3080/') ? first.client : second.client)
    await app.attach('http://one.test:3080/?token=a')
    await app.selectOrCreate()
    await app.attach('http://two.test:3081/?token=b')
    await app.execute('/detach')
    expect(first.client.detach).toHaveBeenCalledOnce()
    await app.execute('/new')
    expect(first.client.sessions.create).toHaveBeenCalledOnce()
    expect(second.client.sessions.create).not.toHaveBeenCalled()
  })

  it('shows live Host commands, Session facts, version, and the official Session catalog', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels, browser } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client, '/workspace', browser)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    await app.selectOrCreate()

    await app.execute('/help')
    expect(fixture.client.remote.commands.list).toHaveBeenCalledWith(fixture.sessionId)
    expect(panels.showHelp).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ name: 'quit' }),
      expect.objectContaining({ name: 'compact', description: 'Compact history' }),
    ]))
    await app.execute('/host-status')
    expect(panels.showStatus).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace' }))
    await app.execute('/version')
    expect(panels.showVersion).toHaveBeenCalledOnce()
    await app.execute('/changelog')
    expect(panels.showChangelog).toHaveBeenCalledOnce()
    expect(fixture.session.command).not.toHaveBeenCalled()
    await app.execute('/sessions')
    expect(browser.open).toHaveBeenCalledWith(fixture.client, expect.objectContaining({ sessionId: fixture.sessionId }), expect.any(Function), undefined)

    const select = vi.mocked(browser.open).mock.calls[0]![2]
    select('shared-session')
    await vi.waitFor(() => {
      expect(conversation.attach).toHaveBeenCalledWith(fixture.reference.binding, expect.objectContaining({ cwd: '/workspace' }))
    })
  })

  it('supports frontend aliases and validates attach input', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    await expect(app.execute('/q')).resolves.toEqual({ exit: true })
    await expect(app.execute('/exit')).resolves.toEqual({ exit: true })
    await app.execute('/clear')
    expect(fixture.client.sessions.create).not.toHaveBeenCalled()
    // rc.2's reportCommand maps a successful command's text to info.
    expect(status.set).toHaveBeenLastCalledWith('starting a new session', 'info')
    await app.execute('/resume shared-session')
    expect(status.set).toHaveBeenLastCalledWith('resuming session shared-session', 'info')
    await expect(app.execute('/attach')).rejects.toThrow('Usage: /attach <host-url>')
  })

  it('reports unavailable browsing in incomplete compositions and fences callbacks after reconnect or selection change', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels, browser } = appFixture()
    const incomplete = new RemoteApp(conversation, status, panels, () => fixture.client)
    await incomplete.execute('/sessions')
    expect(status.set).toHaveBeenCalledWith('Session browsing is unavailable in this composition', 'error')
    let generation = 1
    fixture.client.state.getSnapshot = () => ({ status: 'connected', generation })
    const app = new RemoteApp(conversation, status, panels, () => fixture.client, '/workspace', browser)
    await app.attach('http://127.0.0.1:3080/')
    await app.execute('/sessions')
    const staleConnection = browser.open.mock.calls[0]![2] as (id: string) => void
    generation += 1
    staleConnection('shared-session')
    expect(fixture.client.sessions.retain).not.toHaveBeenCalled()
    await app.execute('/sessions')
    const staleSelection = browser.open.mock.calls[1]![2] as (id: string) => void
    await app.selectOrCreate()
    const calls = vi.mocked(fixture.client.sessions.retain).mock.calls.length
    staleSelection('other-session')
    expect(fixture.client.sessions.retain).toHaveBeenCalledTimes(calls)
  })

  it('keeps successful Host commands quiet and surfaces command transport failures', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    await app.selectOrCreate()
    fixture.session.command.mockResolvedValueOnce({ ok: true, value: { matched: true } })
    await app.execute('/compact')
    expect(status.set).not.toHaveBeenCalled()
    fixture.session.command.mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'offline' } } as never)
    await app.execute('/model')
    expect(status.set).toHaveBeenCalledWith('offline', 'error')
  })

  it('reports asynchronous Session selection failures from the catalog panel', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels, browser } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client, '/workspace', browser)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    await app.selectOrCreate()
    fixture.client.sessions.retain = vi.fn()
      .mockImplementationOnce(() => { throw new Error('missing Session') })
      .mockImplementationOnce(() => { throw 'missing Session' })
    await app.execute('/sessions')
    const select = vi.mocked(browser.open).mock.calls[0]![2]
    select('missing')
    await vi.waitFor(() => { expect(status.set).toHaveBeenCalledWith('missing Session', 'error') })
    select('missing')
    await vi.waitFor(() => { expect(status.set).toHaveBeenCalledTimes(2) })
  })

  it('falls back when catalog cwd and rows are absent', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    fixture.listSnapshot.mockReturnValue({ ids: [SessionId('missing')], byId: {}, phase: 'ready', projectionsBySession: {} })
    const { conversation, status, panels, browser } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client, '/workspace', browser)
    await app.attach('http://127.0.0.1:3080/?token=secret')
    await app.selectOrCreate(undefined, '/new-workspace')
    expect(conversation.attach).toHaveBeenCalledWith(fixture.reference.binding, expect.objectContaining({ cwd: '/new-workspace' }))
    await app.selectOrCreate('other-session')
    expect(conversation.attach).toHaveBeenCalledWith(fixture.reference.binding, expect.objectContaining({ cwd: '' }))
    await app.execute('/sessions')
    expect(browser.open).toHaveBeenCalledWith(fixture.client, expect.objectContaining({ sessionId: SessionId('other-session') }), expect.any(Function), undefined)
  })

  it('ignores stale default-model responses and clears the fallback on detach', async () => {
    const first = clientFixture(HostKey('http://one.test:3080/'))
    const second = clientFixture(HostKey('http://two.test:3081/'))
    let settleFirst!: (value: unknown) => void
    first.client.remote.session.modelCatalog = vi.fn(() => new Promise(resolve => { settleFirst = resolve })) as never
    second.client.remote.session.modelCatalog = vi.fn(async () => ({
      ok: true as const,
      value: { default: { model: 'new-model', provider: 'new-provider' } },
    })) as never
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, key => key === HostKey('http://one.test:3080/') ? first.client : second.client)
    const attaching = app.attach('http://one.test:3080/?token=a')
    await vi.waitFor(() => { expect(first.client.remote.session.modelCatalog).toHaveBeenCalledOnce() })
    await app.attach('http://two.test:3081/?token=b')
    settleFirst({ ok: true, value: { default: { model: 'old-model', provider: 'old-provider' } } })
    await attaching
    expect(conversation.setDefaultModel).toHaveBeenCalledWith({ model: 'new-model', provider: 'new-provider' })
    expect(conversation.setDefaultModel).not.toHaveBeenCalledWith({ model: 'old-model', provider: 'old-provider' })
    expect(conversation.setModelCatalog).toHaveBeenCalledWith(second.client.key, expect.objectContaining({ default: { model: 'new-model', provider: 'new-provider' } }))
    expect(conversation.setModelCatalog).not.toHaveBeenCalledWith(first.client.key, expect.anything())
    await app.execute('/detach')
    expect(conversation.setDefaultModel).toHaveBeenCalledWith(undefined)
    expect(conversation.setModelCatalog).toHaveBeenCalledWith(second.client.key, undefined)
  })

  it('fences native model metadata across a physical reconnection or a detached Client', async () => {
    for (const invalidate of ['reconnect', 'detach'] as const) {
      const fixture = clientFixture(HostKey('http://host/'))
      let generation = 1
      fixture.client.state.getSnapshot = () => ({ status: 'connected', generation })
      let settle!: (value: unknown) => void
      fixture.client.remote.session.modelCatalog = vi.fn(() => new Promise(resolve => { settle = resolve })) as never
      const { conversation, status, panels } = appFixture()
      const app = new RemoteApp(conversation, status, panels, () => fixture.client)
      const attaching = app.attach('http://host/')
      await vi.waitFor(() => { expect(fixture.client.remote.session.modelCatalog).toHaveBeenCalledOnce() })
      if (invalidate === 'reconnect') generation += 1
      else await app.registry.detach(fixture.client.key)
      settle({ ok: true, value: { default: { provider: 'old', model: 'old' }, groups: [] } })
      await attaching
      expect(conversation.setModelCatalog).not.toHaveBeenCalled()
      expect(conversation.setDefaultModel).not.toHaveBeenCalled()
    }
  })

  it('rejects current metadata failures and ignores failures delivered after another Host became active', async () => {
    const fixture = clientFixture(HostKey('http://current/'))
    const failure = { code: 'unavailable', message: 'Catalog unavailable' }
    fixture.client.remote.session.modelCatalog = vi.fn(async () => ({ ok: false, error: failure })) as never
    const current = appFixture()
    const app = new RemoteApp(current.conversation, current.status, current.panels, () => fixture.client)
    await expect(app.attach('http://current/')).rejects.toEqual(failure)
    expect(current.conversation.setModelCatalog).not.toHaveBeenCalled()
    fixture.client.remote.session.modelCatalog = vi.fn(async () => { throw new Error('Transport failed') }) as never
    await expect(app.attach('http://current/')).rejects.toThrow('Transport failed')

    const first = clientFixture(HostKey('http://first/'))
    const second = clientFixture(HostKey('http://second/'))
    let reject!: (error: Error) => void
    first.client.remote.session.modelCatalog = vi.fn(() => new Promise((_, fail) => { reject = fail })) as never
    const stale = appFixture()
    const switching = new RemoteApp(stale.conversation, stale.status, stale.panels, key => key === first.client.key ? first.client : second.client)
    const attaching = switching.attach('http://first/')
    await vi.waitFor(() => { expect(first.client.remote.session.modelCatalog).toHaveBeenCalledOnce() })
    await switching.attach('http://second/')
    reject(new Error('Late transport failure'))
    await expect(attaching).resolves.toBe(first.client)
    expect(stale.conversation.setModelCatalog).not.toHaveBeenCalledWith(first.client.key, expect.anything())
  })

  it('uses the mounted feature directory without creating or querying a Session at startup', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const theme = { name: 'theme', description: 'Switch the color theme', scope: 'sessionless' as const, aliases: ['color'], execute: vi.fn() }
    const features = vi.fn(() => [theme, { name: 'save', description: 'Save', execute: vi.fn() }])
    const app = new RemoteApp(conversation, status, panels, () => fixture.client, '/workspace', undefined, undefined, features)
    await app.attach('http://host/')
    await app.execute('/help')
    const commands = vi.mocked(panels.showHelp).mock.calls[0]![0]
    expect(commands).toContainEqual({ name: 'theme', description: 'Switch the color theme', aliases: ['color'] })
    expect(commands.map(command => command.name)).not.toContain('save')
    expect(fixture.client.remote.commands.list).not.toHaveBeenCalled()
    expect(fixture.client.sessions.create).not.toHaveBeenCalled()
    expect(fixture.client.sessions.retain).not.toHaveBeenCalled()
    features.mockReturnValue([])
    await app.execute('/help')
    expect(vi.mocked(panels.showHelp).mock.calls[1]![0].map(command => command.name)).not.toContain('theme')
  })

  it('hides the native ZIP export in actual help while retaining local save and live native commands', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const features = new RemoteFeatureCommandRegistry(), later = new RemoteFeatureCommandRegistry()
    const off = features.register({ name: 'export', description: 'Hidden local export', hidden: true, execute: vi.fn() })
    features.register({ name: 'save', description: 'Save the current session as a Markdown file', input: { hint: '[full] [<path>]' }, execute: vi.fn() })
    features.register({ name: 'plan', description: 'Next Session plan', scope: 'sessionless', execute: vi.fn() })
    later.register({ name: 'export', description: 'Later export owner', execute: vi.fn() })
    const source = mergeRemoteFeatureCommandSources(features, later)
    const native = [
      { name: 'export', description: 'Download this Session log as a ZIP archive' },
      { name: 'plan', description: 'Plan the current Session', input: { hint: '[off|message]', attachments: true } },
      { name: 'compact', description: 'Compact history', input: { hint: '[instructions]' } },
    ]
    fixture.client.remote.commands.list = vi.fn(async () => ({ ok: true, value: native })) as never
    const app = new RemoteApp(conversation, status, panels, () => fixture.client, '/workspace', undefined, undefined, () => source.list(true))
    await app.attach('http://host/')
    await app.selectOrCreate()
    await app.execute('/help')
    const commands = vi.mocked(panels.showHelp).mock.calls[0]![0]
    expect(fixture.client.remote.commands.list).toHaveBeenCalledExactlyOnceWith(fixture.sessionId)
    expect(commands.some(command => command.name === 'export')).toBe(false)
    expect(commands.find(command => command.name === 'save')).toMatchObject({ input: { hint: '[full] [<path>]' } })
    expect(commands.find(command => command.name === 'plan')).toEqual(native[1])
    expect(commands.find(command => command.name === 'compact')).toEqual(native[2])
    off()
    await app.execute('/help')
    expect(vi.mocked(panels.showHelp).mock.calls[1]![0].find(command => command.name === 'export')).toMatchObject({ description: 'Later export owner' })
    later.clear()
    await app.execute('/help')
    expect(vi.mocked(panels.showHelp).mock.calls[2]![0].find(command => command.name === 'export')).toEqual(native[0])
    app.dispose()
  })

  it('fences help reads after reconnect and suppresses retired catalog failures', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    let generation = 1
    fixture.client.state.getSnapshot = () => ({ status: 'connected', generation })
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    await app.selectOrCreate()
    let settle!: (value: unknown) => void
    fixture.client.remote.commands.list = vi.fn(() => new Promise(resolve => { settle = resolve })) as never
    const pending = app.execute('/help')
    await vi.waitFor(() => { expect(settle).toBeTypeOf('function') })
    generation += 1
    settle({ ok: true, value: [{ name: 'retired', description: 'retired' }] })
    await pending
    expect(panels.showHelp).not.toHaveBeenCalled()
    let reject!: (error: unknown) => void
    fixture.client.remote.commands.list = vi.fn(() => new Promise((_resolve, fail) => { reject = fail })) as never
    const failed = app.execute('/help')
    await vi.waitFor(() => { expect(reject).toBeTypeOf('function') })
    app.clearSession()
    reject(new Error('old connection error'))
    await expect(failed).resolves.toEqual({ exit: false })
    expect(panels.showHelp).not.toHaveBeenCalled()
  })

  it('shares one first-prompt plan admission and sends no prompt before the native write succeeds', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    const changed = vi.fn()
    app.subscribeTopology(changed)
    expect(app.startupPlan.pending()).toBe(false)
    app.startupPlan.set(true)
    app.startupPlan.set(true)
    expect(changed).toHaveBeenCalledOnce()
    let settle!: (value: unknown) => void
    fixture.session.command.mockImplementation(() => new Promise(resolve => { settle = resolve }) as never)
    const first = app.execute('first')
    await vi.waitFor(() => { expect(fixture.session.command).toHaveBeenCalledWith('/plan') })
    expect(app.registry.current).toBeDefined()
    expect(conversation.attach).toHaveBeenCalledWith(fixture.reference.binding, expect.anything())
    const second = app.execute('second')
    expect(fixture.session.prompt).not.toHaveBeenCalled()
    settle({ ok: true, value: { matched: true } })
    await Promise.all([first, second])
    expect(fixture.session.command).toHaveBeenCalledOnce()
    expect(fixture.session.prompt).toHaveBeenCalledTimes(2)
    expect(app.startupPlan.pending()).toBe(false)
  })

  it('consumes explicit plan-off once, while existing selection and /new discard pending mode', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    fixture.session.command.mockResolvedValue({ ok: true, value: { matched: true } })
    app.startupPlan.set(false)
    await app.execute('first')
    expect(fixture.session.command).toHaveBeenCalledWith('/plan off')
    app.startupPlan.set(true)
    await app.selectOrCreate('persisted')
    expect(app.startupPlan.pending()).toBe(false)
    await app.execute('existing')
    expect(fixture.session.command).toHaveBeenCalledOnce()
    await app.execute('/new')
    app.startupPlan.set(true)
    await app.execute('/new')
    expect(app.startupPlan.pending()).toBe(false)
    await app.execute('default')
    expect(fixture.session.command).toHaveBeenCalledOnce()
  })

  it('preserves failed plan admission without retries or silent subsequent prompts', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    app.startupPlan.set(true)
    fixture.session.command.mockResolvedValue({ ok: false, error: { message: 'mode denied' } } as never)
    await expect(app.execute('first')).rejects.toThrow('mode denied')
    await expect(app.execute('second')).rejects.toThrow('mode denied')
    expect(fixture.session.command).toHaveBeenCalledOnce()
    expect(fixture.session.prompt).not.toHaveBeenCalled()
    await app.execute('/new')
    app.startupPlan.set(true)
    fixture.session.command.mockResolvedValue({ ok: true, value: { matched: false } })
    await expect(app.execute('/init')).rejects.toThrow('does not provide the plan command')
    expect(fixture.session.prompt).not.toHaveBeenCalled()
  })

  it.each([true, false])('lets an explicit first plan command supersede the unstarted startup plan selection %s once', async active => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    app.startupPlan.set(active)
    const ref = await app.ensureSession()
    await app.preparePrompt(ref, new AbortController().signal, 'plan')
    await app.preparePrompt(ref)
    expect(app.startupPlan.pending()).toBe(false)
    expect(fixture.session.command).not.toHaveBeenCalled()
    expect(fixture.session.prompt).not.toHaveBeenCalled()
  })

  it('awaits an already admitted startup plan write when an explicit plan command arrives concurrently', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    app.startupPlan.set(true)
    const ref = await app.ensureSession()
    let finish!: (value: { ok: true, value: { matched: true } }) => void
    fixture.session.command.mockImplementation(() => new Promise(resolve => { finish = resolve }) as never)
    const initial = app.preparePrompt(ref)
    const explicit = app.preparePrompt(ref, undefined, 'plan')
    expect(fixture.session.command).toHaveBeenCalledExactlyOnceWith('/plan')
    finish({ ok: true, value: { matched: true } })
    await Promise.all([initial, explicit])
    expect(fixture.session.command).toHaveBeenCalledOnce()
  })

  it('rejects plan admission after selection retirement, reconnect or aborted preparation', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    let generation = 1
    fixture.client.state.getSnapshot = () => ({ status: 'connected', generation })
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    app.startupPlan.set(true)
    const ref = await app.ensureSession()
    const aborted = new AbortController()
    aborted.abort()
    await expect(app.preparePrompt(ref, aborted.signal)).rejects.toThrow()
    expect(fixture.session.command).not.toHaveBeenCalled()
    generation += 1
    await expect(app.preparePrompt(ref)).rejects.toThrow('superseded')
    app.clearSession()
    await expect(app.preparePrompt(ref)).rejects.toThrow('superseded')
    app.startupPlan.set(true)
    let settle!: (value: unknown) => void
    fixture.session.command.mockImplementation(() => new Promise(resolve => { settle = resolve }) as never)
    const pending = app.execute('old')
    await vi.waitFor(() => { expect(settle).toBeTypeOf('function') })
    app.clearSession()
    settle({ ok: true, value: { matched: true } })
    await expect(pending).resolves.toEqual({ exit: false })
    expect(fixture.session.prompt).not.toHaveBeenCalled()
  })

  it('keeps native /status routing and advertises local diagnostics under /host-status', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    await app.selectOrCreate()
    fixture.session.command.mockResolvedValue({ ok: true, value: { matched: true } })
    await app.execute('/status')
    expect(fixture.session.command).toHaveBeenCalledWith('/status')
    expect(panels.showStatus).not.toHaveBeenCalled()
    await app.execute('/host-status')
    expect(panels.showStatus).toHaveBeenCalledOnce()
    await app.execute('/new')
    expect(app.registry.current).toBeUndefined()
    expect(status.set).toHaveBeenLastCalledWith('starting a new session', 'info')
  })

  it('reads Harness version from actual Host bundle inventory without creating a Session', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    await app.execute('/version')
    expect(fixture.client.remote.pluginManager.listBundles).toHaveBeenCalledOnce()
    expect(panels.showVersion).toHaveBeenCalledWith('0.2.2-alpha.2')
    expect(fixture.client.sessions.create).not.toHaveBeenCalled()
    expect(fixture.client.sessions.retain).not.toHaveBeenCalled()
    vi.mocked(fixture.client.remote.pluginManager.listBundles).mockResolvedValue({ ok: true, value: [] })
    await app.execute('/version')
    expect(panels.showVersion).toHaveBeenLastCalledWith(undefined)
  })

  it('fences native version inventory after reconnect and preserves current read failures', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    let generation = 1
    fixture.client.state.getSnapshot = () => ({ status: 'connected', generation })
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    await app.execute('/version')
    vi.mocked(panels.showVersion).mockClear()
    let settle!: (value: unknown) => void
    fixture.client.remote.pluginManager.listBundles = vi.fn(() => new Promise(resolve => { settle = resolve })) as never
    const pending = app.execute('/version')
    generation += 1
    settle({ ok: true, value: [{ name: '@deepseek-ai/dsh-base', version: 'retired' }] })
    await pending
    expect(panels.showVersion).not.toHaveBeenCalled()
    fixture.client.remote.pluginManager.listBundles = vi.fn(async () => ({ ok: false, error: { message: 'Host inventory denied' } })) as never
    await expect(app.execute('/version')).rejects.toThrow('Host inventory denied')
  })

  it('warms the exact Host version without delaying attach and consumes that read only once', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    let settle!: (value: unknown) => void
    fixture.client.remote.pluginManager.listBundles = vi.fn(() => new Promise(resolve => { settle = resolve })) as never
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    expect(panels.showVersion).not.toHaveBeenCalled()
    const pending = app.execute('/version')
    expect(fixture.client.remote.pluginManager.listBundles).toHaveBeenCalledOnce()
    settle({ ok: true, value: [{ name: '@deepseek-ai/dsh-base', version: 'native-version' }] })
    await pending
    expect(panels.showVersion).toHaveBeenLastCalledWith('native-version')
    fixture.client.remote.pluginManager.listBundles = vi.fn(async () => ({ ok: true, value: [] })) as never
    await app.execute('/version')
    expect(panels.showVersion).toHaveBeenLastCalledWith(undefined)
  })

  it('retries a failed startup inventory and never fails attaching because optional metadata is unavailable', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    vi.mocked(fixture.client.remote.pluginManager.listBundles).mockRejectedValueOnce(new Error('offline metadata'))
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    await app.execute('/version')
    expect(fixture.client.remote.pluginManager.listBundles).toHaveBeenCalledTimes(2)
    expect(panels.showVersion).toHaveBeenLastCalledWith('0.2.2-alpha.2')
  })

  it('invalidates a warmed version on reconnect and fences late startup failure against the new read', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    let generation = 1
    fixture.client.state.getSnapshot = () => ({ status: 'connected', generation })
    let reject!: (reason: Error) => void
    fixture.client.remote.pluginManager.listBundles = vi.fn(() => new Promise((_resolve, fail) => { reject = fail })) as never
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    generation += 1
    fixture.client.remote.pluginManager.listBundles = vi.fn(async () => ({ ok: true, value: [{ name: '@deepseek-ai/dsh-base', version: 'new-generation' }] })) as never
    reject(new Error('old startup failure'))
    await app.execute('/version')
    expect(panels.showVersion).toHaveBeenLastCalledWith('new-generation')
  })

  it('ignores a rejected version read after reconnect and can show a sessionless panel without any Host', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    let generation = 1
    fixture.client.state.getSnapshot = () => ({ status: 'connected', generation })
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.execute('/version')
    expect(panels.showVersion).toHaveBeenLastCalledWith(undefined)
    await app.attach('http://host/')
    await app.execute('/version')
    vi.mocked(panels.showVersion).mockClear()
    let reject!: (reason: Error) => void
    fixture.client.remote.pluginManager.listBundles = vi.fn(() => new Promise((_resolve, fail) => { reject = fail })) as never
    const pending = app.execute('/version')
    generation += 1
    reject(new Error('retired transport'))
    await pending
    expect(panels.showVersion).not.toHaveBeenCalled()
  })

  it('provides a live exact-binding context source and retires it on primary selection change', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    await app.selectOrCreate()
    fixture.projectionValues.set('contextPressure', { projectedTokens: 1024, contextWindow: 2048 })
    await app.execute('/context')
    const source = vi.mocked(panels.showContext).mock.calls[0]![0]
    expect(source.read()).toMatchObject({ usage: { context: { used: 1024, window: 2048 } } })
    const listener = vi.fn()
    const off = source.subscribe(listener)
    for (const changed of fixture.sessionListeners) changed()
    expect(listener).toHaveBeenCalled()
    app.clearSession()
    expect(source.read()).toBeUndefined()
    off()
    expect(fixture.sessionListeners.size).toBe(0)
  })

  it('routes rename and fork to the exact Session, ignores fork arguments, and retains the source on failure', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const rename = vi.fn(async (title: string) => ({ ok: true as const, value: { title } }))
    Object.assign(fixture.session, { rename })
    const fork = vi.fn(async () => SessionId('forked'))
    Object.assign(fixture.client.sessions, { fork })
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    await app.selectOrCreate('shared-session')
    await app.execute('/rename')
    expect(panels.showRename).toHaveBeenCalledWith('', expect.any(Function), expect.any(Function), expect.any(Function))
    await app.execute('/rename Revised title')
    expect(rename).toHaveBeenCalledWith('Revised title')
    expect(status.set).toHaveBeenLastCalledWith('renamed session to Revised title', 'info')
    rename.mockResolvedValueOnce({ ok: false, error: { message: 'rename denied' } } as never)
    await app.execute('/rename Denied')
    expect(status.set).toHaveBeenLastCalledWith('rename denied', 'error')
    for (const argument of ['-1', 'bad', '1.5', '9007199254740992']) {
      fork.mockRejectedValueOnce('native fork denied')
      await app.execute(`/fork ${argument}`)
      expect(fork).toHaveBeenLastCalledWith({ sessionId: 'shared-session' })
      expect(status.set).toHaveBeenLastCalledWith('native fork denied', 'error')
    }
    fork.mockRejectedValueOnce(new Error('fork-unavailable'))
    await app.execute('/fork')
    expect(status.set).toHaveBeenLastCalledWith(expect.stringContaining('Nothing to fork yet'), 'error')
    expect(app.registry.current?.sessionId).toBe('shared-session')
    fork.mockRejectedValueOnce('native fork denied')
    await app.execute('/fork 0')
    expect(status.set).toHaveBeenLastCalledWith('native fork denied', 'error')
    await app.execute('/fork 12')
    expect(fork).toHaveBeenLastCalledWith({ sessionId: 'shared-session' })
    expect(app.registry.current?.sessionId).toBe('forked')
    expect(status.set).toHaveBeenCalledWith('forking the current session', 'info')
    await app.execute('/fork')
    expect(fork).toHaveBeenLastCalledWith({ sessionId: 'forked' })
  })

  it('submits the shared init instruction only after Session admission and reports native admission failures', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    await app.execute('/init')
    expect(fixture.client.sessions.create).toHaveBeenCalledOnce()
    expect(fixture.session.prompt).toHaveBeenLastCalledWith([expect.objectContaining({ type: 'text', text: expect.stringContaining('AGENTS.md') })], 'queue', undefined, 'request-1')
    expect(status.set).toHaveBeenLastCalledWith('analyzing the codebase to write AGENTS.md', 'info')
    fixture.session.prompt.mockResolvedValueOnce({ ok: false, error: { message: 'init refused' } } as never)
    await app.execute('/init')
    expect(status.set).toHaveBeenLastCalledWith('init refused', 'error')
  })

  it('uses displayed writable bindings and refuses readonly views before prompt, command, and cancellation admission', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    let view: RemoteAppView = {
      ref: { host: fixture.client.key, sessionId: fixture.sessionId }, binding: fixture.reference.binding,
      access: 'interactive', presentation: conversation.presentation(),
    }
    const offDisplayed = vi.fn()
    const subscribe = vi.fn(() => offDisplayed)
    const app = new RemoteApp(conversation, status, panels, () => fixture.client, '/workspace', undefined, () => view, undefined, subscribe)
    await app.attach('http://host/')
    expect(await app.ensureSession()).toBe(view.ref)
    await app.preparePrompt(view.ref)
    fixture.projectionValues.set('contextPressure', { projectedTokens: 17, contextWindow: 100 })
    await app.execute('/context')
    const source = vi.mocked(panels.showContext).mock.calls[0]![0]
    expect(source.read()).toMatchObject({ usage: { context: { used: 17, window: 100 } } })
    const off = source.subscribe(vi.fn())
    off()
    expect(offDisplayed).toHaveBeenCalledOnce()
    await app.execute('/host-status')
    expect(panels.showStatus).toHaveBeenLastCalledWith(view.presentation)
    view = { ref: view.ref, access: view.access, presentation: view.presentation }
    expect(source.read()).toBeUndefined()
    await expect(app.execute('/context')).rejects.toThrow('no native Client binding')
    view = { ...view, access: 'readonly' }
    await expect(app.ensureSession()).rejects.toThrow('read-only')
    await expect(app.preparePrompt(view.ref)).rejects.toThrow('read-only')
    await expect(app.execute('/compact')).rejects.toThrow('read-only')
    await app.cancel()
    expect(fixture.session.cancel).not.toHaveBeenCalled()
    expect(fixture.client.sessions.create).not.toHaveBeenCalled()
  })

  it('propagates an active help failure while suppressing a failed catalog selection after it was retired', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels, browser } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client, '/workspace', browser)
    await app.attach('http://host/')
    await app.selectOrCreate()
    fixture.client.remote.commands.list = vi.fn(async () => { throw new Error('live help failure') }) as never
    await expect(app.execute('/help')).rejects.toThrow('live help failure')
    const pending = Promise.withResolvers<SessionBinding>()
    fixture.client.sessions.retain = vi.fn(() => ({ ...fixture.reference, ready: pending.promise })) as never
    await app.execute('/sessions')
    const choose = browser.open.mock.lastCall![2] as (id: string) => void
    choose('missing')
    await vi.waitFor(() => { expect(fixture.client.sessions.retain).toHaveBeenCalledOnce() })
    app.clearSession()
    pending.reject(new Error('retired selection failure'))
    await new Promise(resolve => setImmediate(resolve))
    expect(status.set).not.toHaveBeenCalledWith('retired selection failure')
  })

  it('rejects a plan preparation retired between native confirmation and prompt admission', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    app.startupPlan.set(true)
    const ref = await app.ensureSession()
    const native = Promise.withResolvers<Awaited<ReturnType<typeof fixture.session.command>>>()
    fixture.session.command.mockReturnValueOnce(native.promise)
    const pending = app.preparePrompt(ref)
    native.resolve({ ok: true, value: { matched: true } })
    queueMicrotask(() => { app.clearSession() })
    await expect(pending).rejects.toThrow('superseded')
    expect(fixture.session.prompt).not.toHaveBeenCalled()
  })

  it('fences a Session selection cleared immediately after its native binding commits', async () => {
    const fixture = clientFixture(HostKey('http://host/'))
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels, () => fixture.client)
    await app.attach('http://host/')
    const pending = app.selectOrCreate('other-session')
    queueMicrotask(() => { queueMicrotask(() => { app.clearSession() }) })
    await expect(pending).rejects.toThrow('superseded')
    expect(app.registry.current).toBeUndefined()
    expect(conversation.attach).not.toHaveBeenCalledWith(fixture.reference.binding, expect.anything())
  })

  it('refuses Session commands from an empty start view', async () => {
    const { conversation, status, panels } = appFixture()
    const app = new RemoteApp(conversation, status, panels)
    await expect(app.execute('/compact')).rejects.toThrow('Select or create a Session before prompting')
  })
})


describe('RemoteApp rewind', () => {
  function rewindFixture() {
    const host = clientFixture(HostKey('http://one.test/'))
    const fixture = appFixture()
    const events = vi.fn(async () => ({ ok: true as const, value: { records: [
      { type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
      { type: 'event', event: { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier prompt' }] } } },
      { type: 'event', event: { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'Earlier answer' }] } } } },
    ], hasMore: false } }))
    Object.assign(host.client.remote.session, { events })
    const fork = vi.fn(async () => SessionId('child'))
    Object.assign(host.client.sessions, { fork })
    const showPrimary = vi.fn()
    const app = new RemoteApp(fixture.conversation, fixture.status, fixture.panels, () => host.client, '/workspace', undefined, undefined, undefined, undefined, showPrimary)
    return { ...fixture, ...host, app, events, fork, showPrimary }
  }


  it('retires passive history and picker acceptance with the original caller', async () => {
    for (const fails of [false, true]) {
      const test = rewindFixture()
      await test.app.attach('http://one.test/')
      await test.app.selectOrCreate('shared-session')
      const gate = Promise.withResolvers<unknown>()
      test.events.mockReturnValueOnce(gate.promise as never)
      const caller = new AbortController()
      const pending = test.app.execute('/rewind', caller.signal)
      caller.abort()
      expect(vi.mocked(test.client.remote.session.events).mock.calls[0]![1]?.aborted).toBe(true)
      if (fails) gate.reject(new Error('retired history'))
      else gate.resolve({ ok: true, value: { records: [], hasMore: false } })
      await pending
      expect(test.panels.showRewind).not.toHaveBeenCalled()
      const live = new AbortController()
      await test.app.execute('/rewind', live.signal)
      const [, choose, current, subscribe] = vi.mocked(test.panels.showRewind!).mock.calls[0]!
      const listener = vi.fn()
      const off = subscribe(listener)
      live.abort()
      expect(current()).toBe(false)
      expect(listener).toHaveBeenCalledOnce()
      await choose(1)
      expect(test.fork).not.toHaveBeenCalled()
      off()
      test.app.dispose()
    }
  })

  it('reads passive native history and opens the reference picker; acceptance forks exact primary and keeps source', async () => {
    const test = rewindFixture()
    await test.app.attach('http://one.test/')
    await test.app.selectOrCreate('shared-session')
    await test.app.execute('/rewind')
    expect(test.showPrimary).toHaveBeenCalledOnce()
    expect(test.events).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'shared-session' } }, expect.any(AbortSignal))
    const [candidates, choose, current, subscribe] = vi.mocked(test.panels.showRewind!).mock.calls[0]!
    expect(candidates).toEqual([{ turn: 1, boundarySeq: 1, prompt: 'Earlier prompt', response: 'Earlier answer', discarded: 2 }])
    expect(current()).toBe(true)
    const listener = vi.fn()
    const off = subscribe(listener)
    await choose(1)
    expect(test.fork).toHaveBeenCalledWith({ sessionId: 'shared-session', atSeq: 1 })
    expect(test.app.registry.current?.sessionId).toBe('child')
    expect(test.status.set).not.toHaveBeenCalled()
    expect(test.client.sessions.create).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalled()
    off()
    expect(current()).toBe(false)
    await choose(1)
    expect(test.fork).toHaveBeenCalledOnce()
  })

  it('ignores command arguments and reports empty, busy and failed picker branches', async () => {
    const test = rewindFixture()
    await expect(test.app.execute('/rewind')).rejects.toThrow('no active session')
    await test.app.attach('http://one.test/')
    await test.app.selectOrCreate('shared-session')
    for (const argument of ['invalid', '0', '-1', '1.5']) {
      await test.app.execute(`/rewind ${argument}`)
      expect(test.fork).not.toHaveBeenCalled()
    }
    expect(test.panels.showRewind).toHaveBeenCalledTimes(4)
    vi.mocked(test.panels.showRewind!).mockClear()
    test.session.getSnapshot.mockReturnValueOnce({ running: true })
    await test.app.execute('/rewind')
    expect(test.status.set).toHaveBeenCalledWith('cannot rewind while the agent is running', 'error')
    test.events.mockResolvedValueOnce({ ok: true, value: { records: [], hasMore: false } })
    await test.app.execute('/rewind')
    expect(test.status.set).toHaveBeenCalledWith('no user turns to rewind', 'info')
    test.fork.mockRejectedValueOnce(new Error('fork-unavailable'))
    await test.app.execute('/rewind 0')
    const choose = vi.mocked(test.panels.showRewind!).mock.calls[0]![1]
    await choose(1)
    expect(test.status.set).toHaveBeenCalledWith(expect.stringContaining('Nothing to fork yet'), 'error')
    test.session.getSnapshot.mockReturnValueOnce({ running: true })
    await choose(1)
    expect(test.fork).toHaveBeenCalledTimes(1)
    await choose(1)
    expect(test.app.registry.current?.sessionId).toBe('child')
  })

  it('fences history and branch results after clear, connection replacement, and read failure', async () => {
    const test = rewindFixture()
    await test.app.attach('http://one.test/')
    await test.app.selectOrCreate('shared-session')
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof test.events>>>()
    test.events.mockReturnValueOnce(pending.promise)
    const opening = test.app.execute('/rewind')
    test.app.clearSession()
    pending.resolve({ ok: true, value: { records: [], hasMore: false } })
    await opening
    expect(test.panels.showRewind).not.toHaveBeenCalled()
    await test.app.selectOrCreate('shared-session')
    test.events.mockRejectedValueOnce(new Error('read failed'))
    await expect(test.app.execute('/rewind')).rejects.toThrow('read failed')
    const lateFailure = Promise.withResolvers<Awaited<ReturnType<typeof test.events>>>()
    test.events.mockReturnValueOnce(lateFailure.promise)
    const stale = test.app.execute('/rewind')
    test.app.clearSession()
    lateFailure.reject(new Error('late failed'))
    await stale
    await test.app.selectOrCreate('shared-session')
    const fork = Promise.withResolvers<SessionId>()
    test.fork.mockReturnValueOnce(fork.promise)
    await test.app.execute('/rewind 1')
    const branching = vi.mocked(test.panels.showRewind!).mock.lastCall![1](1)
    test.app.clearSession()
    fork.resolve(SessionId('late-child'))
    await branching
    expect(test.app.registry.current).toBeUndefined()
  })

  it('suppresses a fork rejection received after the rewind owner retired', async () => {
    const test = rewindFixture()
    await test.app.attach('http://one.test/')
    await test.app.selectOrCreate('shared-session')
    const native = Promise.withResolvers<SessionId>()
    test.fork.mockReturnValueOnce(native.promise)
    await test.app.execute('/rewind 1')
    const pending = vi.mocked(test.panels.showRewind!).mock.lastCall![1](1)
    test.app.clearSession()
    native.reject(new Error('retired fork rejection'))
    await pending
    expect(test.status.set).not.toHaveBeenCalledWith('retired fork rejection', 'error')
    expect(test.app.registry.current).toBeUndefined()
  })

  it('keeps a pending native history read alive across unrelated topology presentation updates', async () => {
    const test = rewindFixture()
    await test.app.attach('http://one.test/')
    await test.app.selectOrCreate('shared-session')
    const native = Promise.withResolvers<Awaited<ReturnType<typeof test.events>>>()
    test.events.mockReturnValueOnce(native.promise)
    const pending = test.app.execute('/rewind')
    const signal = (test.events.mock.lastCall as unknown as readonly [unknown, AbortSignal])[1]
    test.app.startupPlan.set(true)
    expect(signal.aborted).toBe(false)
    native.resolve({ ok: true, value: { records: [], hasMore: false } })
    await pending
    expect(test.status.set).toHaveBeenCalledWith('no user turns to rewind', 'info')
  })

  it('retires a rewind after history settles but before its caller resumes', async () => {
    const test = rewindFixture()
    await test.app.attach('http://one.test/')
    await test.app.selectOrCreate('shared-session')
    const native = Promise.withResolvers<Awaited<ReturnType<typeof test.events>>>()
    test.events.mockReturnValueOnce(native.promise)
    const pending = test.app.execute('/rewind')
    expect(test.events).toHaveBeenCalledOnce()
    native.resolve({ ok: true, value: { records: [], hasMore: false } })
    // The native result unwrap and history collection each resume once. Selection can retire in
    // the following microtask, after collection's cancellation check and before the app resumes.
    await Promise.resolve()
    await Promise.resolve()
    test.app.clearSession()
    await pending
    expect(test.panels.showRewind).not.toHaveBeenCalled()
    expect(test.status.set).not.toHaveBeenCalledWith('no user turns to rewind', 'info')
    expect(test.app.registry.current).toBeUndefined()
  })
})
