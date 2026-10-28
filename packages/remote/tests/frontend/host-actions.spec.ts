import { describe, expect, it, vi } from 'vitest'
import type {
  ISessions, SessionBinding, SessionFace, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { HostKey, type HostClient, type SessionRef } from '../../src/client/types.ts'
import { HostActions, type HostPromptInput } from '../../src/frontend/host-actions.ts'
import { HostNotAttachedError, HostRegistry } from '../../src/frontend/host-registry.ts'

function sessionId(value: string): SessionId {
  return value as SessionId
}

function sessionRef(host: HostKey): SessionRef {
  return { host, sessionId: sessionId('shared') }
}

function promptInput(text = 'hello'): HostPromptInput {
  return {
    content: [{ type: 'text', text }],
    mode: 'queue',
    text,
    attachments: [],
  }
}

function makeSession(id: SessionId): {
  readonly session: SessionFace
  readonly requestId: SessionRequestId
  readonly abandon: ReturnType<typeof vi.fn>
} {
  const requestId = `request-${id}` as SessionRequestId
  const abandon = vi.fn()
  const session = Object.assign({} as SessionFace, {
    sessionId: id,
    beginSubmission: vi.fn(() => ({ requestId, abandon })),
    prompt: vi.fn(async () => ({ ok: true, value: { accepted: true } })),
    cancel: vi.fn(async () => ({ ok: true, value: { accepted: true } })),
    rename: vi.fn(async (title: string) => ({ ok: true, value: { title, seq: 4 } })),
    command: vi.fn(async () => ({ ok: true, value: { matched: true } })),
    loadOlder: vi.fn(async () => {}),
    loadThrough: vi.fn(async () => {}),
  })
  return { session, requestId, abandon }
}

function makeActionHost(key: HostKey, session: SessionFace): {
  readonly client: HostClient
  readonly references: SessionReference[]
  readonly retain: ReturnType<typeof vi.fn>
  readonly create: ReturnType<typeof vi.fn>
  readonly list: ISessions['list']
  readonly detach: ReturnType<typeof vi.fn>
} {
  const references: SessionReference[] = []
  const retain = vi.fn((
    target: Parameters<ISessions['retain']>[0],
    _options: Parameters<ISessions['retain']>[1],
  ): SessionReference => {
    const id = typeof target === 'string' ? target : target.childSessionId
    const binding = { sessionId: id, session } as SessionBinding
    const reference: SessionReference = {
      sessionId: id,
      binding,
      ready: Promise.resolve(binding),
      release: vi.fn(),
      [Symbol.dispose]: () => { reference.release() },
    }
    references.push(reference)
    return reference
  })
  const using: ISessions['using'] = async (target, options, operation) => {
    const reference = retain(target, options)
    try {
      await reference.ready
      return await operation(reference)
    } finally {
      reference.release()
    }
  }
  const create = vi.fn(async () => session.sessionId)
  const list: ISessions['list'] = {
    getSnapshot: () => ({
      ids: [session.sessionId], byId: {}, phase: 'ready', projectionsBySession: {},
    }),
    subscribe: () => () => {},
  }
  const detach = vi.fn(async () => {})
  const sessions = Object.assign({} as ISessions, { retain, using, create, list })
  return {
    client: {
      key,
      connection: {} as HostClient['connection'],
      remote: {
        commands: { list: vi.fn(async () => ({ ok: true as const, value: [{ name: 'compact', description: 'Compact history' }] })) },
        session: {
          modelCatalog: vi.fn(async () => ({
            ok: true as const,
            value: { default: { model: 'deepseek-chat', provider: 'deepseek' } },
          })),
        },
      } as HostClient['remote'],
      sessions,
      workspaces: {} as HostClient['workspaces'],
      detach,
    },
    references,
    retain,
    create,
    list,
    detach,
  }
}

describe('HostActions', () => {
  it('routes equal SessionIds through their owning Hosts with stable request identities', async () => {
    const hostA = HostKey('actions-a')
    const hostB = HostKey('actions-b')
    const a = makeActionHost(hostA, makeSession(sessionId('shared')).session)
    const b = makeActionHost(hostB, makeSession(sessionId('shared')).session)
    const clients = new Map([[hostA, a.client], [hostB, b.client]])
    const registry = new HostRegistry(key => clients.get(key)!)
    const actions = new HostActions(registry)
    await Promise.all([registry.attach(hostA), registry.attach(hostB)])
    const onRetire = vi.fn()
    const input = { ...promptInput(), onRetire }

    await actions.prompt(sessionRef(hostA), input)
    await actions.prompt(sessionRef(hostB), input)

    const sessionA = a.references[0]!.binding.session
    const sessionB = b.references[0]!.binding.session
    const requestA = vi.mocked(sessionA.beginSubmission).mock.results[0]!.value.requestId
    const requestB = vi.mocked(sessionB.beginSubmission).mock.results[0]!.value.requestId
    expect(sessionA.prompt).toHaveBeenCalledOnce()
    expect(sessionB.prompt).toHaveBeenCalledOnce()
    expect(sessionA.prompt).toHaveBeenCalledWith(input.content, 'queue', undefined, requestA)
    expect(sessionB.prompt).toHaveBeenCalledWith(input.content, 'queue', undefined, requestB)
    expect(sessionA.beginSubmission).toHaveBeenCalledWith({
      mode: 'queue', text: 'hello', attachments: [], onRetire,
    })
    expect(a.references[0]!.release).toHaveBeenCalledOnce()
    expect(b.references[0]!.release).toHaveBeenCalledOnce()
  })

  it('does not replay or Agent-cancel a transport-aborted submission', async () => {
    const host = HostKey('abort')
    const fixture = makeSession(sessionId('shared'))
    const client = makeActionHost(host, fixture.session)
    const registry = new HostRegistry(() => client.client)
    const actions = new HostActions(registry)
    await registry.attach(host)
    const abort = new Error('transport aborted')
    const controller = new AbortController()
    controller.abort(abort)
    const input = { ...promptInput(), signal: controller.signal }
    vi.mocked(fixture.session.prompt).mockRejectedValue(abort)

    await expect(actions.prompt(sessionRef(host), input)).rejects.toBe(abort)

    expect(fixture.session.beginSubmission).toHaveBeenCalledOnce()
    expect(fixture.session.prompt).toHaveBeenCalledOnce()
    expect(fixture.session.prompt).toHaveBeenCalledWith(
      input.content, 'queue', controller.signal, fixture.requestId,
    )
    expect(fixture.abandon).toHaveBeenCalledOnce()
    expect(fixture.session.cancel).not.toHaveBeenCalled()
    expect(client.references[0]!.release).toHaveBeenCalledOnce()
  })

  it('provides official navigation, references, and typed Session actions', async () => {
    const host = HostKey('typed')
    const fixture = makeSession(sessionId('shared'))
    const client = makeActionHost(host, fixture.session)
    const registry = new HostRegistry(() => client.client)
    const actions = new HostActions(registry)
    expect(actions.current).toBeUndefined()
    expect(actions.currentReference).toBeUndefined()
    await registry.attach(host)

    expect(actions.sessionList(host)).toBe(client.list)
    await expect(actions.create(host, { cwd: '/work' })).resolves.toEqual(sessionRef(host))
    expect(client.create).toHaveBeenCalledOnce()
    expect(client.create).toHaveBeenCalledWith({ cwd: '/work' })
    const retained = actions.retain(sessionRef(host))
    expect(retained.binding.session).toBe(fixture.session)
    expect(retained.release).not.toHaveBeenCalled()
    retained.release()

    await actions.select(sessionRef(host))
    expect(actions.current).toEqual(sessionRef(host))
    expect(actions.currentReference?.binding.session).toBe(fixture.session)
    const selectedReference = actions.currentReference!

    await actions.cancel(sessionRef(host))
    await actions.rename(sessionRef(host), 'renamed')
    await actions.command(sessionRef(host), '/status')
    await expect(actions.listCommands(sessionRef(host))).resolves.toEqual([{ name: 'compact', description: 'Compact history' }])
    vi.mocked(client.client.remote.commands.list).mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'catalog failed' } } as never)
    await expect(actions.listCommands(sessionRef(host))).rejects.toThrow('catalog failed')
    await expect(actions.defaultModel(host)).resolves.toEqual({ model: 'deepseek-chat', provider: 'deepseek' })
    vi.mocked(client.client.remote.session.modelCatalog).mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'models unavailable' } } as never)
    await expect(actions.defaultModel(host)).rejects.toThrow('models unavailable')
    await actions.loadOlder(sessionRef(host))
    await actions.loadThrough(sessionRef(host), 3 as SessionSeq)

    expect(fixture.session.cancel).toHaveBeenCalledOnce()
    expect(fixture.session.rename).toHaveBeenCalledWith('renamed')
    expect(fixture.session.command).toHaveBeenCalledWith('/status')
    expect(fixture.session.loadOlder).toHaveBeenCalledOnce()
    expect(fixture.session.loadThrough).toHaveBeenCalledWith(3)
    expect(selectedReference.release).not.toHaveBeenCalled()
    await registry.detach(host)
    expect(selectedReference.release).toHaveBeenCalledOnce()
    expect(client.detach).toHaveBeenCalledOnce()
  })

  it('fails missing-Host routing before touching Session state and never replays create', async () => {
    const host = HostKey('missing')
    const registry = new HostRegistry(() => { throw new Error('Unexpected attach') })
    const actions = new HostActions(registry)

    expect(() => actions.sessionList(host)).toThrow(HostNotAttachedError)
    expect(() => actions.retain(sessionRef(host))).toThrow(HostNotAttachedError)
    expect(() => actions.create(host)).toThrow(HostNotAttachedError)
    expect(() => actions.prompt(sessionRef(host), promptInput())).toThrow(HostNotAttachedError)
    await expect(actions.select(sessionRef(host))).rejects.toBeInstanceOf(HostNotAttachedError)

    const fixture = makeSession(sessionId('shared'))
    const client = makeActionHost(host, fixture.session)
    const attached = new HostRegistry(() => client.client)
    const attachedActions = new HostActions(attached)
    await attached.attach(host)
    const failure = new Error('create failed')
    client.create.mockRejectedValue(failure)
    await expect(attachedActions.create(host)).rejects.toBe(failure)
    expect(client.create).toHaveBeenCalledOnce()
  })
})
