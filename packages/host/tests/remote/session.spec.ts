/**
 * Decision tests for the exact-Agent resolution contract every mayflyHost
 * method builds on: identity, refusal codes, and the directory fallback.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { requireExactAgent, resolveExactAgent, sessionDirectory } from '../../src/remote/session.ts'
import type { Context } from '@deepseek-ai/cordis'

/** The narrow registry face the resolution reads, as a plain stub. */
interface RegistryFixture {
  readonly ctx: Context
  readonly agents: { get(id: string): unknown }
  readonly sessions: { get(id: string): unknown }
  readonly sessionController: { resolveAgent(id: string): Promise<unknown> }
}

/** One live Agent/Session pair registered under `id`. */
function fixture(id = 'session-1', overrides: Partial<{
  readonly agent: object
  readonly session: object
  readonly origin: string
  /** False registers only the Session: no live Agent answers for this id. */
  readonly live: boolean
  readonly resolveAgent: (id: string) => Promise<unknown>
}> = {}): RegistryFixture {
  const session = {
    id,
    header: { origin: overrides.origin ?? 'user', cwd: '/host/work' },
    ...(overrides.session ?? {}),
  }
  const agent = { id, session, ...(overrides.agent ?? {}) }
  const agents = { get: (key: string): unknown => key === id && overrides.live !== false ? agent : undefined }
  const sessions = { get: (key: string): unknown => key === id ? session : undefined }
  const sessionController = { resolveAgent: overrides.resolveAgent ?? (async () => { throw new Error('unexpected resolve') }) }
  const ctx = { agents, sessions, sessionController } as unknown as Context
  return { ctx, agents, sessions, sessionController }
}

describe('requireExactAgent', () => {
  it('accepts the exact registered Agent and Session objects', () => {
    const { ctx } = fixture()
    const agent = (ctx.agents as { get(key: string): unknown }).get('session-1')
    expect(requireExactAgent(ctx, SessionId('session-1'), agent as never)).toBe(agent)
  })

  it('refuses a same-id Agent that is not the registered object', () => {
    const { ctx } = fixture()
    const impostor = { id: 'session-1', session: (ctx.sessions as { get(key: string): unknown }).get('session-1') }
    // The refusal names the session, and its code is the stale-session one.
    expect(() => requireExactAgent(ctx, SessionId('session-1'), impostor as never))
      .toThrow(expect.objectContaining({ code: 'mayflyHost/session-stale' }) as never)
  })

  it('refuses an Agent whose session was replaced under the same id', () => {
    const { ctx } = fixture()
    const live = (ctx.agents as { get(key: string): unknown }).get('session-1') as { session: object }
    const replaced = { ...live, session: { id: 'session-1', header: {} } }
    expect(() => requireExactAgent(ctx, SessionId('session-1'), replaced as never)).toThrow()
  })
})

describe('resolveExactAgent', () => {
  it('returns the live Agent without consulting the controller', async () => {
    const { ctx, sessionController } = fixture()
    const agent = await resolveExactAgent(ctx, SessionId('session-1'), new AbortController().signal)
    expect(agent.id).toBe('session-1')
    expect(sessionController.resolveAgent).toBeTypeOf('function')
  })

  it('refuses a live child session with no Agent rather than resurrecting it', async () => {
    const { ctx } = fixture('child-1', { origin: 'subagent', live: false })
    await expect(resolveExactAgent(ctx, SessionId('child-1'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/agent-unavailable' })
  })

  it('resolves through the controller for an ordinary stored session and re-checks identity', async () => {
    // No live agent, no subagent origin: the stored session resolves late.
    const stored = fixture('stored-1', { live: false,
      resolveAgent: async () => {
        const session = { id: 'stored-1', header: { origin: 'user', cwd: '/late' } }
        const agent = { id: 'stored-1', session }
        // Register it so the exact check passes on the way out.
        ;(stored.ctx.agents as { get(k: string): unknown }).get = (key: string): unknown => key === 'stored-1' ? agent : undefined
        ;(stored.ctx.sessions as { get(k: string): unknown }).get = (key: string): unknown => key === 'stored-1' ? session : undefined
        return { agent }
      },
    })
    const agent = await resolveExactAgent(stored.ctx, SessionId('stored-1'), new AbortController().signal)
    expect(agent.id).toBe('stored-1')
  })

  it('propagates the controller error verbatim instead of wrapping it', async () => {
    const { ctx } = fixture('gone-1', { live: false,
      resolveAgent: async (): Promise<never> => ({ error: new RemoteError('session/not-found', 'no such session', { sessionId: 'gone-1' as never }) }) as never,
    })
    await expect(resolveExactAgent(ctx, SessionId('gone-1'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('normalizes a detached child ownership refusal without activating it', async () => {
    const { ctx } = fixture('detached-child', { live: false,
      resolveAgent: async () => ({ error: new RemoteError('session/agent-busy', 'owned by subagent routing', { reason: 'use subagent delivery for this child session' }) }),
    })
    await expect(resolveExactAgent(ctx, SessionId('detached-child'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/agent-unavailable' })
  })

  it('preserves other agent-busy failures', async () => {
    const { ctx } = fixture('busy', { live: false,
      resolveAgent: async () => ({ error: new RemoteError('session/agent-busy', 'busy', { reason: 'another operation' }) }),
    })
    await expect(resolveExactAgent(ctx, SessionId('busy'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/agent-busy' })
  })

  it('discards a resolution completed after caller cancellation', async () => {
    const controller = new AbortController()
    const { ctx } = fixture('late', { live: false, resolveAgent: async () => {
      controller.abort(new Error('cancelled resolution'))
      return { error: new RemoteError('session/not-found', 'missing', { sessionId: SessionId('late') }) }
    } })
    await expect(resolveExactAgent(ctx, SessionId('late'), controller.signal)).rejects.toThrow('cancelled resolution')
  })

  it('refuses to start on an already-aborted signal', async () => {
    const { ctx } = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(resolveExactAgent(ctx, SessionId('session-1'), controller.signal)).rejects.toThrow()
  })
})

describe('sessionDirectory', () => {
  it('prefers the live working-directory projection over the header cwd', () => {
    const { ctx } = fixture()
    const projections = { snapshot: (_session: object, keys: readonly string[]) => ({ values: keys.includes('workingDirectory') ? { workingDirectory: '/live/dir' } : {} }) }
    const session = (ctx.sessions as { get(key: string): unknown }).get('session-1')
    expect(sessionDirectory({ ...ctx, sessionProjections: projections } as unknown as Context, session as never)).toBe('/live/dir')
  })

  it('falls back to the header cwd when no projection is published', () => {
    const { ctx } = fixture()
    const projections = { snapshot: () => ({ values: {} }) }
    const session = (ctx.sessions as { get(key: string): unknown }).get('session-1')
    expect(sessionDirectory({ ...ctx, sessionProjections: projections } as unknown as Context, session as never)).toBe('/host/work')
  })

  it('refuses with a named code when neither source answers', () => {
    const { ctx } = fixture()
    const projections = { snapshot: () => ({ values: {} }) }
    const session = { id: 'session-1', header: {} }
    expect(() => sessionDirectory({ ...ctx, sessionProjections: projections } as unknown as Context, session as never))
      .toThrow(expect.objectContaining({ code: 'mayflyHost/session-directory-unavailable' }) as never)
  })
})
