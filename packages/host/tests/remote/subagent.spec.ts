/**
 * Decision tests for the subagent drain: mode guards, descendant liveness,
 * exact-parent ownership, and the closed refusal vocabulary.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { subagentDrain } from '../../src/remote/subagent.ts'

/** One catalog entry as the drain reads it. */
interface Child {
  readonly kind: 'child'
  readonly id: string
  readonly parentId: string
  readonly mode: 'continuable' | 'terminal' | 'external'
}

/** A harness whose parent Agent is registered and whose catalog answers once. */
function harness(overrides: Partial<{
  readonly children: readonly Child[]
  readonly liveIds: readonly string[]
  readonly drainError?: unknown
}> = {}) {
  const parentSession = { id: 'parent-1', header: { origin: 'user' } }
  const parent: Agent = { id: 'parent-1', session: parentSession } as unknown as Agent
  const drain = vi.fn(async (): Promise<void> => {
    if (overrides.drainError !== undefined) throw overrides.drainError
  })
  const agents = new Map<string, Agent>([['parent-1', parent]])
  for (const id of overrides.liveIds ?? []) agents.set(id, { id } as unknown as Agent)
  const ctx = {
    // The registry is a mutable map the test can swap under a live call.
    agents: { get: (id: string): Agent | undefined => agents.get(id) },
    sessions: { get: (id: string): unknown => id === 'parent-1' ? parentSession : undefined },
    sessionController: { resolveAgent: async (): Promise<never> => { throw new Error('unexpected') } },
    subagents: {
      listDescendants: vi.fn(async (): Promise<readonly Child[]> => overrides.children ?? []),
      drainChildren: drain,
    },
  } as unknown as Context
  return { ctx, drain, listDescendants: (ctx as unknown as { subagents: { listDescendants: ReturnType<typeof vi.fn> } }).subagents.listDescendants }
}

/** A drain request naming the parent and the child. */
function request(childSessionId: string): { childSessionId: string, parentSessionId: string } {
  return { childSessionId, parentSessionId: 'parent-1' }
}

describe('subagentDrain', () => {
  it('drains a live continuable child through its exact parent', async () => {
    const { ctx, drain } = harness({
      children: [{ kind: 'child', id: 'child-1', parentId: 'parent-1', mode: 'continuable' }],
      liveIds: ['child-1'],
    })
    await subagentDrain(ctx, request('child-1'), new AbortController().signal)
    expect(drain).toHaveBeenCalledOnce()
  })

  it('refuses an unknown child before any drain', async () => {
    const { ctx, drain } = harness({ children: [] })
    await expect(subagentDrain(ctx, request('ghost'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/subagent-drain-unavailable', details: { reason: 'unknown subagent' } })
    expect(drain).not.toHaveBeenCalled()
  })

  it('refuses external and non-continuable children with the mode named', async () => {
    const { ctx } = harness({
      children: [{ kind: 'child', id: 'ext-1', parentId: 'parent-1', mode: 'external' }],
    })
    await expect(subagentDrain(ctx, request('ext-1'), new AbortController().signal))
      .rejects.toMatchObject({ details: { reason: 'external children have no local Agent to stop' } })
    const terminal = harness({
      children: [{ kind: 'child', id: 'term-1', parentId: 'parent-1', mode: 'terminal' }],
    })
    await expect(subagentDrain(terminal.ctx, request('term-1'), new AbortController().signal))
      .rejects.toMatchObject({ details: { reason: 'child is not continuable' } })
  })

  it('refuses while any descendant of the child is still live', async () => {
    const { ctx, drain } = harness({
      children: [
        { kind: 'child', id: 'child-1', parentId: 'parent-1', mode: 'continuable' },
        { kind: 'child', id: 'grand-1', parentId: 'child-1', mode: 'continuable' },
      ],
      liveIds: ['child-1', 'grand-1'],
    })
    await expect(subagentDrain(ctx, request('child-1'), new AbortController().signal))
      .rejects.toMatchObject({ details: { reason: 'stop its live descendants first' } })
    expect(drain).not.toHaveBeenCalled()
  })

  it('refuses a child that is not live even with no descendants', async () => {
    const { ctx, drain } = harness({
      children: [{ kind: 'child', id: 'child-1', parentId: 'parent-1', mode: 'continuable' }],
    })
    await expect(subagentDrain(ctx, request('child-1'), new AbortController().signal))
      .rejects.toMatchObject({ details: { reason: 'child is not live' } })
    expect(drain).not.toHaveBeenCalled()
  })

  it('maps an UNAUTHORIZED drain to the exact-parent code and rethrows the rest', async () => {
    const unauthorized = harness({
      children: [{ kind: 'child', id: 'child-1', parentId: 'parent-1', mode: 'continuable' }],
      liveIds: ['child-1'],
      drainError: Object.assign(new Error('nope'), { code: 'UNAUTHORIZED' }),
    })
    await expect(subagentDrain(unauthorized.ctx, request('child-1'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/subagent-drain-unauthorized' })
    const other = harness({
      children: [{ kind: 'child', id: 'child-1', parentId: 'parent-1', mode: 'continuable' }],
      liveIds: ['child-1'],
      drainError: new Error('internal'),
    })
    await expect(subagentDrain(other.ctx, request('child-1'), new AbortController().signal))
      .rejects.toThrow('internal')
  })

  it('re-checks the parent identity between the catalog read and the drain', async () => {
    const { ctx, drain, listDescendants } = harness({
      children: [{ kind: 'child', id: 'child-1', parentId: 'parent-1', mode: 'continuable' }],
      liveIds: ['child-1'],
    })
    // The catalog read hands back the child; the parent registry then swaps.
    const mutableCtx = ctx as unknown as { agents: { get: (id: string): Agent | undefined } }
    listDescendants.mockImplementation(async (): Promise<readonly Child[]> => {
      const replaced = new Map<string, Agent>([['parent-1', { id: 'parent-1', session: { id: 'parent-1', header: {} } } as unknown as Agent]])
      Object.defineProperty(mutableCtx, 'agents', { value: { get: (id: string): Agent | undefined => replaced.get(id) } })
      return [{ kind: 'child', id: 'child-1', parentId: 'parent-1', mode: 'continuable' }]
    })
    await expect(subagentDrain(ctx, request('child-1'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    expect(drain).not.toHaveBeenCalled()
    void SessionId
  })
})
