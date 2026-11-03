/**
 * Decision tests for the service hub, driven through the built artifact.
 *
 * The hub's `@Remote` decorators do not survive vitest's oxc transform (a
 * minimal decorated class reproduces the failure), and the tsconfig flag
 * vite's own diagnostics suggest has no effect on this pipeline. The built
 * `lib/` is what the Remote package actually consumes - AGENTS.md says so -
 * so this spec imports it there. Rebuild before judging it.
 * @module
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MayflyHostService } from '../../lib/index.js'

/** Real contexts created by the harness; a fresh one per test holds no leak. */
const contexts: Context[] = []

afterEach((): void => {
  // Cordis 4 exposes no public dispose on a bare context; each test's context
  // owns its own registrations and is dropped with the test.
  contexts.length = 0
})

/** A real Cordis context with mock services provided; the Service base needs its registry. */
function harness(overrides: Partial<{ readonly cwd: string }> = {}): {
  ctx: Context
  service: InstanceType<typeof MayflyHostService>
  projections: { snapshot(): { values: Record<string, unknown> } }
} {
  const ctx = new Context()
  contexts.push(ctx)
  const session = { id: 'session-1', header: { origin: 'user', cwd: overrides.cwd ?? '/work' } }
  const agent = { id: 'session-1', session }
  const projections = { snapshot: (): { values: Record<string, unknown> } => ({ values: { workingDirectory: overrides.cwd } }) }
  ctx.provide('agents', { get: (): unknown => agent })
  ctx.provide('sessions', { get: (): unknown => session })
  ctx.provide('sessionProjections', projections)
  ctx.provide('sessionController', { resolveAgent: async (): Promise<never> => { throw new Error('unexpected') } })
  const service = new MayflyHostService(ctx)
  return { ctx, service, projections }
}

describe('MayflyHostService (built artifact)', () => {
  it('declares the injected native services', () => {
    expect(MayflyHostService.inject).toContain('agents')
    expect(MayflyHostService.inject).toContain('llm')
    expect(MayflyHostService.inject).toContain('sessionProjections')
  })

  it('answers capabilities with the protocol and package versions', () => {
    const capabilities = harness().service.capabilities()
    expect(capabilities.protocolVersion).toBe(1)
    expect(capabilities.hostVersion).toMatch(/^\d+\.\d+\.\d+/u)
    // Without the optional native MCP face, transport health is not advertised.
    expect(capabilities.features).not.toContain('mcpTransportHealth')
    expect(capabilities.features).toContain('mayflyConversation')
  })

  it('answers a Git probe null on a detached head and keeps the cache keyed', async () => {
    const { service } = harness({ cwd: '/work' })
    expect(await service.gitStatus({ sessionId: 'session-1' as never }, new AbortController().signal)).toBeNull()
    expect(await service.gitStatus({ sessionId: 'session-1' as never }, new AbortController().signal)).toBeNull()
  })

  it('refuses a Git answer whose directory moved during the probe', async () => {
    const { service, projections } = harness({ cwd: '/work' })
    // The directory must move across the probe, not merely differ: the entry
    // resolution and the post-answer check read the same projection.
    let reads = 0
    projections.snapshot = (): { values: Record<string, unknown> } => {
      reads += 1
      return { values: { workingDirectory: reads === 1 ? '/work' : '/moved' } }
    }
    await expect(service.gitStatus({ sessionId: 'session-1' as never }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
  })

  it('aborts an in-flight method through the composed lifetime signal', async () => {
    const { service } = harness()
    const controller = new AbortController()
    const pending = service.gitStatus({ sessionId: 'session-1' as never }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('forwards the provider filter and refuses an unregistered provider', async () => {
    const { ctx, service } = harness()
    ctx.provide('llm', {
      listProviders: (): readonly { id: string, name: string }[] => [{ id: 'p', name: 'P' }],
      listModels: async (): Promise<readonly { id: string, name: string }[]> => [{ id: 'm', name: 'M' }],
      resolveModelInfo: async (): Promise<undefined> => undefined,
    })
    await expect(service.modelCatalogDetails({ provider: 'ghost' } as never, new AbortController().signal))
      .rejects.toThrow('provider "ghost" is not registered')
    const healthy = await service.modelCatalogDetails({ provider: undefined } as never, new AbortController().signal)
    expect(healthy.items).toEqual([{ provider: 'p', id: 'm', name: 'M', providerLabel: 'P' }])
  })
})
