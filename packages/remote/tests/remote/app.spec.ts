import { describe, expect, it, vi } from 'vitest'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import { RemoteApp, type RemoteAppView } from '../../src/remote/app.ts'
import type { RemoteNotice } from '../../src/remote/notice.ts'
import type { RemoteAppPanels } from '../../src/remote/interactions/plain-panels.ts'
import type { RemoteConversationModelSource } from '../../src/transcript/remote-model.ts'

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
    connection: {} as never,
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
    expect(test.status.set).not.toHaveBeenCalledWith(expect.stringContaining('Too late'))
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
    expect(test.status.set).not.toHaveBeenCalledWith('retired rejection')
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
    expect(test.status.set).toHaveBeenLastCalledWith('plain rejection')
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
    expect(status.set).toHaveBeenCalledWith('Unknown command: /not-a-command')
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
    expect(status.set).toHaveBeenCalledWith('denied')
    await app.cancel()
    expect(status.set).toHaveBeenCalledWith('busy')

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
    expect(browser.open).toHaveBeenCalledWith(fixture.client, expect.objectContaining({ sessionId: fixture.sessionId }), expect.any(Function))

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
    await expect(app.execute('/attach')).rejects.toThrow('Usage: /attach <host-url>')
  })

  it('reports unavailable browsing in incomplete compositions and fences callbacks after reconnect or selection change', async () => {
    const fixture = clientFixture(HostKey('http://127.0.0.1:3080/'))
    const { conversation, status, panels, browser } = appFixture()
    const incomplete = new RemoteApp(conversation, status, panels, () => fixture.client)
    await incomplete.execute('/sessions')
    expect(status.set).toHaveBeenCalledWith('Session browsing is unavailable in this composition')
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
    expect(status.set).not.toHaveBeenCalledWith(expect.stringContaining('Unknown command'))
    fixture.session.command.mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'offline' } } as never)
    await app.execute('/model')
    expect(status.set).toHaveBeenCalledWith('offline')
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
    await vi.waitFor(() => { expect(status.set).toHaveBeenCalledWith('missing Session') })
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
    expect(browser.open).toHaveBeenCalledWith(fixture.client, expect.objectContaining({ sessionId: SessionId('other-session') }), expect.any(Function))
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
    await expect(pending).rejects.toThrow('superseded')
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
    expect(status.set).toHaveBeenLastCalledWith('starting a new session')
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

  it('routes rename and fork writes to the exact selected Session, validates boundaries, and retains the source on fork failure', async () => {
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
    expect(status.set).toHaveBeenLastCalledWith('renamed session to Revised title')
    rename.mockResolvedValueOnce({ ok: false, error: { message: 'rename denied' } } as never)
    await app.execute('/rename Denied')
    expect(status.set).toHaveBeenLastCalledWith('rename denied')
    for (const argument of ['-1', 'bad', '1.5', '9007199254740992']) {
      await expect(app.execute(`/fork ${argument}`)).rejects.toThrow('Usage: /fork [atSeq]')
    }
    fork.mockRejectedValueOnce(new Error('fork-unavailable'))
    await app.execute('/fork')
    expect(status.set).toHaveBeenLastCalledWith(expect.stringContaining('Nothing to fork yet'))
    expect(app.registry.current?.sessionId).toBe('shared-session')
    fork.mockRejectedValueOnce('native fork denied')
    await app.execute('/fork 0')
    expect(status.set).toHaveBeenLastCalledWith('native fork denied')
    await app.execute('/fork 12')
    expect(fork).toHaveBeenLastCalledWith({ sessionId: 'shared-session', atSeq: 12 })
    expect(app.registry.current?.sessionId).toBe('forked')
    expect(status.set).toHaveBeenCalledWith('Forked into forked')
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
    expect(status.set).toHaveBeenLastCalledWith('Analyzing the codebase to write AGENTS.md')
    fixture.session.prompt.mockResolvedValueOnce({ ok: false, error: { message: 'init refused' } } as never)
    await app.execute('/init')
    expect(status.set).toHaveBeenLastCalledWith('init refused')
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
    expect(test.client.sessions.create).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalled()
    off()
    expect(current()).toBe(false)
    await choose(1)
    expect(test.fork).toHaveBeenCalledOnce()
  })

  it('preserves explicit sequence support and reports invalid, empty, busy and failed branches', async () => {
    const test = rewindFixture()
    await expect(test.app.execute('/rewind')).rejects.toThrow('no active session')
    await test.app.attach('http://one.test/')
    await test.app.selectOrCreate('shared-session')
    await expect(test.app.execute('/rewind invalid')).rejects.toThrow('Usage: /rewind [seq]')
    test.session.getSnapshot.mockReturnValueOnce({ running: true })
    await test.app.execute('/rewind')
    expect(test.status.set).toHaveBeenCalledWith('cannot rewind while the agent is running')
    test.events.mockResolvedValueOnce({ ok: true, value: { records: [], hasMore: false } })
    await test.app.execute('/rewind')
    expect(test.status.set).toHaveBeenCalledWith('no user turns to rewind')
    test.fork.mockRejectedValueOnce(new Error('fork-unavailable'))
    await test.app.execute('/rewind 0')
    expect(test.status.set).toHaveBeenCalledWith(expect.stringContaining('Nothing to fork yet'))
    await test.app.execute('/rewind')
    const choose = vi.mocked(test.panels.showRewind!).mock.calls[0]![1]
    test.session.getSnapshot.mockReturnValueOnce({ running: true })
    await choose(1)
    expect(test.fork).toHaveBeenCalledTimes(1)
    await test.app.execute('/rewind 1')
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
    const branching = test.app.execute('/rewind 1')
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
    const pending = test.app.execute('/rewind 1')
    test.app.clearSession()
    native.reject(new Error('retired fork rejection'))
    await pending
    expect(test.status.set).not.toHaveBeenCalledWith('retired fork rejection')
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
    expect(test.status.set).toHaveBeenCalledWith('no user turns to rewind')
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
    expect(test.status.set).not.toHaveBeenCalledWith('no user turns to rewind')
    expect(test.app.registry.current).toBeUndefined()
  })
})
