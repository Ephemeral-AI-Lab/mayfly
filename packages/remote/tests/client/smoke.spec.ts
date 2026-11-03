/** The exported headless consumer exercises list/create/open and always detaches. */
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {
  ISessions,
  SessionReference,
  SessionRetainOptions,
  SessionTarget,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createHostClient } from '../../src/client/host-client.ts'
import { smokeHostClient } from '../../src/client/smoke.ts'
import { HostKey, type HostClient } from '../../src/client/types.ts'

vi.mock('../../src/client/host-client.ts', () => ({ createHostClient: vi.fn() }))

function fixture() {
  const id = SessionId('smoke-session')
  const using = vi.fn()
  const sessions = {
    refresh: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(id),
    list: {
      getSnapshot: vi.fn()
        .mockReturnValueOnce({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
        .mockReturnValueOnce({ ids: [id], byId: {}, phase: 'ready', projectionsBySession: {} }),
      subscribe: vi.fn(() => () => {}),
    },
    using: async <T>(
      target: SessionTarget,
      options: SessionRetainOptions,
      operation: (reference: SessionReference) => T | Promise<T>,
    ): Promise<T> => {
      using(target, options, operation)
      const sessionId = typeof target === 'string' ? target : target.childSessionId
      return operation({ binding: { sessionId } } as SessionReference)
    },
    retain: vi.fn(),
    retainInfo: vi.fn(),
    searchResultLimit: 100,
    subagentAddress: vi.fn(),
    refreshProjections: vi.fn(),
    search: vi.fn(),
    fork: vi.fn(),
    scope: vi.fn(),
    scopeOf: vi.fn(),
    sessionOf: vi.fn(),
    binding: vi.fn(),
  } satisfies ISessions
  const client = {
    key: HostKey('local'),
    sessions,
    connection: {} as ConnectionHandle,
    remote: {} as HostClient['remote'],
    fileUpload: {} as HostClient['fileUpload'],
    origin: 'http://127.0.0.1:3080',
    state: {
      getSnapshot: () => ({ status: 'connected', generation: 0 }),
      subscribe: () => () => {},
    } satisfies HostClient['state'],
    workspaces: {} as IWorkspaces,
    detach: vi.fn().mockResolvedValue(undefined),
  } satisfies HostClient
  vi.mocked(createHostClient).mockResolvedValue(client)
  return { client, sessions, id, using }
}

describe('smokeHostClient', () => {
  it('returns serializable list/create/open evidence and detaches', async () => {
    const { client, sessions, id, using } = fixture()
    const result = await smokeHostClient({ key: HostKey('local'), startupUrl: 'http://host/?token=secret', cwd: '/work' })
    expect(result).toEqual({
      listedBefore: 0,
      created: { host: client.key, sessionId: id },
      opened: { host: client.key, sessionId: id },
      listedAfter: 1,
    })
    expect(sessions.create).toHaveBeenCalledWith({ cwd: '/work' })
    expect(sessions.refresh).toHaveBeenCalledTimes(2)
    expect(using).toHaveBeenCalledWith(id, { source: 'controllerOperation' }, expect.any(Function))
    expect(client.detach).toHaveBeenCalledOnce()
  })

  it('omits an unspecified cwd and detaches after a failed create', async () => {
    const { client, sessions } = fixture()
    sessions.create.mockRejectedValueOnce(new Error('create failed'))
    await expect(smokeHostClient({ key: HostKey('local'), startupUrl: 'http://host/?token=secret' }))
      .rejects.toThrow('create failed')
    expect(sessions.create).toHaveBeenCalledWith()
    expect(client.detach).toHaveBeenCalledOnce()
  })
})
