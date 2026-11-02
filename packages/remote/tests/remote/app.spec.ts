import { describe, expect, it, vi } from 'vitest'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import { RemoteApp } from '../../src/remote/app.ts'
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
    presentation: vi.fn(() => ({ cwd: '/workspace', contextTokens: 0, active: false, phase: 'idle' })),
  } as unknown as RemoteConversationModelSource
  const status = { set: vi.fn() } as RemoteNotice
  const panels: RemoteAppPanels = {
    showHelp: vi.fn(),
    showStatus: vi.fn(),
    showContext: vi.fn(),
    showVersion: vi.fn(),
  }
  return { conversation, status, panels, browser: { open: vi.fn() } }
}

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
    await app.execute('/detach')
    expect(conversation.setDefaultModel).toHaveBeenCalledWith(undefined)
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
})
