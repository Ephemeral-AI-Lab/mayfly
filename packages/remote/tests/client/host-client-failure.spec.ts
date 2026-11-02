/** Incomplete official assemblies fail loudly and release their local Context. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientPlugin } from '../../src/client/bundle.ts'
import { createHostClient } from '../../src/client/host-client.ts'
import { HostKey } from '../../src/client/types.ts'

const mocks = vi.hoisted(() => ({
  installConnection: vi.fn(),
  loadClientPlugins: vi.fn(),
}))

vi.mock('@deepseek-ai/dsh-client-connection/client', () => ({ installConnection: mocks.installConnection }))
vi.mock('@deepseek-ai/dsh-typert-registry/client', () => ({ inject: [], apply: () => {} }))
vi.mock('@deepseek-ai/dsh-api-gateway/client', () => ({ inject: [], apply: () => {} }))
vi.mock('../../src/client/bundle.ts', () => ({ loadClientPlugins: mocks.loadClientPlugins }))

const empty = (): ClientPlugin => ({ inject: [], apply: () => {} })

describe('createHostClient assembly failures', () => {
  it.each(['connection', 'remote', 'fileUpload', 'sessions', 'workspaces'] as const)('rejects and cleans up when %s is absent', async missing => {
    mocks.installConnection.mockImplementation((ctx: Context) => {
      if (missing !== 'connection') ctx.provide('connection', {})
    })
    mocks.loadClientPlugins.mockResolvedValue({
      remotes: missing === 'remote' ? empty() : { inject: [], apply: (ctx: Context) => { ctx.provide('remote', {}) } },
      fileUpload: missing === 'fileUpload' ? empty() : { inject: [], apply: (ctx: Context) => { ctx.provide('fileUpload', {}) } },
      sessions: missing === 'sessions' ? empty() : { inject: [], apply: (ctx: Context) => { ctx.provide('sessions', {}) } },
      workspaces: missing === 'workspaces' ? empty() : { inject: [], apply: (ctx: Context) => { ctx.provide('workspaces', {}) } },
    })
    const expected = missing === 'connection'
      ? 'did not provide its Connection'
      : 'did not provide its object layer'
    await expect(createHostClient({ key: HostKey('local'), startupUrl: 'http://127.0.0.1:3080/?token=secret' }))
      .rejects.toThrow(expected)
  })

  it('rejects a Host contribution when the official Remote plugin fails to provide its mount', async () => {
    mocks.installConnection.mockImplementation((ctx: Context) => { ctx.provide('connection', {}) })
    mocks.loadClientPlugins.mockResolvedValue({ remotes: empty(), fileUpload: empty(), sessions: empty(), workspaces: empty() })
    await expect(createHostClient({ key: HostKey('local'), startupUrl: 'http://127.0.0.1:3080/?token=secret', mayflyHost: {} as never }))
      .rejects.toThrow('did not provide its Remote mount')
  })
})
