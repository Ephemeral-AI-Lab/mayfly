/**
 * Decision tests for the workspace faces: path resolution without activation,
 * snapshot detachment, and the refusal to fabricate a workspace.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { workspaceChangesDiff, workspaceChangesSummary, workspacePath } from '../../src/remote/workspace.ts'

/** A context whose native services answer canned values. */
function ctx(overrides: Partial<{
  readonly summary: unknown
  readonly diff: unknown | Promise<unknown>
  readonly resolve: (path: string) => Promise<{ id: string, path: string, title: string } | undefined>
}> = {}): Context {
  return {
    workspaceChanges: {
      summary: (): unknown => overrides.summary,
      diff: (): unknown => overrides.diff ?? null,
    },
    workspaceRegistry: {
      resolveByPath: overrides.resolve ?? (async (): Promise<undefined> => undefined),
    },
  } as unknown as Context
}

describe('workspaceChangesSummary', () => {
  it('snapshots the native summary without activating a session', () => {
    const summary = { files: [{ path: '/w/a.ts', status: 'modified' }], seq: 4 }
    const frozen = workspaceChangesSummary(ctx({ summary }), { sessionId: 'session-1' as never, seq: 4 }, new AbortController().signal)
    expect(frozen).toEqual(summary)
    expect(Object.isFrozen(frozen)).toBe(true)
  })

  it('answers null when the native summary cannot cross the wire', () => {
    expect(workspaceChangesSummary(ctx({ summary: { lossy: (): void => {} } }), { sessionId: 'session-1' as never, seq: 4 }, new AbortController().signal)).toBeNull()
  })

  it('refuses to run on an aborted signal', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => workspaceChangesSummary(ctx({ summary: {} }), { sessionId: 'session-1' as never, seq: 4 }, controller.signal)).toThrow()
  })
})

describe('workspaceChangesDiff', () => {
  it('does not start a native comparison after caller cancellation', async () => {
    const diff = vi.fn()
    const context = { workspaceChanges: { diff } } as unknown as Context
    await expect(workspaceChangesDiff(context, { sessionId: 's' as never, seq: 1, index: 0 }, AbortSignal.abort()))
      .rejects.toThrow()
    expect(diff).not.toHaveBeenCalled()
  })

  it('returns the detached diff and re-checks the signal after the await', async () => {
    const diff = { hunks: [{ header: '@@ -1 +1 @@' }] }
    const value = await workspaceChangesDiff(ctx({ diff }), { sessionId: 'session-1' as never, seq: 4, index: 0 }, new AbortController().signal)
    expect(value).toEqual(diff)
  })

  it('answers null for an unusable diff value', async () => {
    expect(await workspaceChangesDiff(ctx({ diff: { lossy: (): void => {} } }), { sessionId: 'session-1' as never, seq: 4, index: 0 }, new AbortController().signal)).toBeNull()
  })
})

describe('workspacePath', () => {
  it('resolves an existing workspace to its frozen identity', async () => {
    const value = await workspacePath(ctx({ resolve: async (): Promise<{ id: string, path: string, title: string }> => ({ id: 'ws-9', path: '/work', title: 'work' }) }), { path: '/work' }, new AbortController().signal)
    expect(value).toEqual({ id: 'ws-9', path: '/work', title: 'work' })
    expect(Object.isFrozen(value)).toBe(true)
  })

  it('answers null for an unresolved path instead of fabricating a workspace', async () => {
    expect(await workspacePath(ctx(), { path: '/nowhere' }, new AbortController().signal)).toBeNull()
    const throwing = ctx({ resolve: async (): Promise<never> => { throw new Error('registry down') } })
    expect(await workspacePath(throwing, { path: '/work' }, new AbortController().signal)).toBeNull()
  })

  it('propagates an abort rather than swallowing it as unresolved', async () => {
    const controller = new AbortController()
    controller.abort()
    const resolver = vi.fn(async (): Promise<undefined> => undefined)
    await expect(workspacePath(ctx({ resolve: resolver }), { path: '/work' }, controller.signal)).rejects.toThrow()
    expect(resolver).not.toHaveBeenCalled()
  })

  it('discards path resolution that settles after caller cancellation', async () => {
    const controller = new AbortController()
    const resolver = async (): Promise<undefined> => {
      controller.abort(new Error('cancelled resolution'))
      return undefined
    }
    await expect(workspacePath(ctx({ resolve: resolver }), { path: '/work' }, controller.signal)).rejects.toThrow('cancelled resolution')
  })
})
