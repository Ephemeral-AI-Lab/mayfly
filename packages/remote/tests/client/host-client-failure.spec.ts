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
  it.each(['connection', 'sessions', 'workspaces'] as const)('rejects and cleans up when %s is absent', async missing => {
    mocks.installConnection.mockImplementation((ctx: Context) => {
      if (missing !== 'connection') ctx.provide('connection', {})
    })
    mocks.loadClientPlugins.mockResolvedValue({
      remotes: empty(),
      fileUpload: empty(),
      sessions: missing === 'sessions' ? empty() : { inject: [], apply: (ctx: Context) => { ctx.provide('sessions', {}) } },
      workspaces: missing === 'workspaces' ? empty() : { inject: [], apply: (ctx: Context) => { ctx.provide('workspaces', {}) } },
    })
    await expect(createHostClient({ key: HostKey('local'), startupUrl: 'http://example.test/?token=secret' }))
      .rejects.toThrow('did not provide its object layer')
  })
})
