/** Additional native session browsing paths: refresh, a failed workspace lookup, missing workspace display
 * fields, a closed-then-throwing registry, and cancellation during a refresh.
 * @module @ephemeral-ai/mayfly/tests/interaction/native-sessions-extra
 */
import { Context } from '@deepseek-ai/cordis'
import type { SessionListValue, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import { informationFixture } from './information-fixture.ts'
import { flushRequests } from './request-fixture.ts'
import { activate, nativeAction } from './native-action-fixture.ts'
import { createSessionListCache } from '../../src/interaction/session-list-reads.ts'
import { openSessions } from '../../src/interaction/native-sessions.ts'
import { interactionTranslator } from '../../src/interaction/locale.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

const now = Date.now()

function workspace(id: string, path: string | undefined, title: string | undefined): Workspace {
  return { id: id as WorkspaceId, path, title, sessionIds: [], createdAt: '', updatedAt: '' } as unknown as Workspace
}

function summary(sessionId: string, cwd: string | undefined): SessionSummary {
  return {
    sessionId: SessionId(sessionId), updatedAt: now - 60_000, running: false, blank: false,
    agentAvailable: false, cwd,
    projections: { kind: 'cached', asOfSeq: 1, values: { title: sessionId } },
  } as SessionSummary
}

async function setup(options: { blankWorkspace?: boolean } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  const workspaces = [
    workspace('alpha', '/repo/current', 'Alpha'),
    workspace('beta', '/repo/other', 'Beta'),
    ...options.blankWorkspace === true ? [workspace('blank', undefined, undefined)] : [],
  ]
  const summaries = [summary('current', '/repo/current'), summary('other', '/repo/other')]
  const controller = {
    list: vi.fn(async (): Promise<SessionListValue> => ({ items: summaries })),
  }
  const registry = {
    list: () => workspaces,
    resolveByPath: vi.fn(async (path: string) => workspaces.find(item => item.path === path)),
    archivedSessionIds: [] as string[],
  }
  ctx.provide('sessionController', controller as never)
  ctx.provide('workspaceRegistry', registry as never)
  const cache = createSessionListCache(ctx)
  const root = () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.sessions')!
  const rootText = () => JSON.stringify(root().node)
  const openRoot = async (signal?: AbortSignal) => {
    const result = await openSessions(ctx, signal ?? new AbortController().signal, interactionTranslator(ctx), cache)
    await flushRequests()
    await vi.waitFor(() => { expect(rootText()).toContain('workspace:alpha') })
    return result
  }
  const chooseRail = async (rowId: string) => {
    root().emit({ kind: 'tab-change', pagePath: [], controlId: 'session-rail', tabId: rowId })
    await flushRequests()
  }
  return { ...bench, controller, registry, workspaces, summaries, cache, root, rootText, openRoot, chooseRail }
}

it('refreshes the catalog on demand and reports progress', async () => {
  const bench = await setup()
  await bench.openRoot()
  expect(bench.controller.list).toHaveBeenCalledOnce()
  const report = vi.fn()
  const prepared = await bench.root().endpoint.prepare(activate('refresh', 'session-actions'), {
    surfaceId: bench.root().id, source: bench.root().source, revision: bench.root().revision,
    operationId: 'refresh-test', signal: new AbortController().signal, report,
  })
  expect(prepared.reply).toMatchObject({ kind: 'completed' })
  expect(report).toHaveBeenCalledWith({ message: 'Loading workspace sessions…', severity: 'info' })
  expect(bench.controller.list).toHaveBeenCalledTimes(2)
  await vi.waitFor(() => { expect(bench.rootText()).toContain('workspace:beta') })
})

it('contains a workspace lookup failure and lists the registered rows', async () => {
  const bench = await setup()
  bench.registry.resolveByPath.mockRejectedValueOnce(new Error('registry down'))
  await bench.openRoot()
  expect(bench.rootText()).toContain('Alpha')
  expect(bench.rootText()).toContain('Beta')
  expect(bench.rootText()).not.toContain('Could not load workspaces')
})

it('uses the process cwd and empty display fallbacks when no conversation or workspace metadata exists', async () => {
  const bench = await setup({ blankWorkspace: true })
  vi.spyOn(bench.ctx.mayflyConversations, 'primary').mockReturnValue(null)
  await bench.openRoot()
  expect(bench.rootText()).toContain('No working directory')
  await bench.chooseRail('workspace:blank')
  expect(bench.ctx.mayflyOverlays.list().map(entry => entry.id)).toEqual(['mayfly.sessions'])
  expect(bench.rootText()).toContain('No sessions')
  expect(bench.controller.list).toHaveBeenCalledOnce()
})

it('ignores an action it does not own', async () => {
  const bench = await setup()
  await bench.openRoot()
  expect(await nativeAction(bench.root(), activate('unknown', 'session-actions'))).toMatchObject({ kind: 'completed' })
  expect(bench.controller.list).toHaveBeenCalledOnce()
})

it('returns an error result when the overlay registry refuses to open', async () => {
  const bench = await setup()
  await bench.openRoot()
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  vi.spyOn(bench.ctx.mayflyOverlays, 'open').mockImplementation(() => { throw new Error('registry down') })
  expect(await openSessions(bench.ctx, new AbortController().signal, interactionTranslator(bench.ctx), bench.cache)).toEqual({
    kind: 'error', text: 'Error: registry down',
  })
})

it('discards a refresh whose overlay closed while the catalog read was pending', async () => {
  const bench = await setup()
  await bench.openRoot()
  const gate = Promise.withResolvers<SessionListValue>()
  bench.controller.list.mockReturnValueOnce(gate.promise)
  const call = nativeAction(bench.root(), activate('refresh', 'session-actions'))
  await vi.waitFor(() => { expect(bench.controller.list).toHaveBeenCalledTimes(2) })
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  gate.reject(new Error('cancelled read'))
  await call
  expect(bench.ctx.mayflyOverlays.list()).toEqual([])
})

it('does not notify a closing panel when its opening read ends aborted', async () => {
  const bench = await setup()
  const signal = new AbortController()
  bench.registry.resolveByPath.mockImplementationOnce(() => {
    const thenable = {
      // oxlint-disable-next-line unicorn/no-thenable -- the microtask ordering is the point of this stub
      then(resolve: (value: unknown) => void) {
        queueMicrotask(() => {
          resolve(bench.workspaces[0])
          queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => signal.abort())))
        })
      },
    }
    return thenable as never
  })
  expect(await openSessions(bench.ctx, signal.signal, interactionTranslator(bench.ctx), bench.cache)).toEqual({ kind: 'success' })
  await flushRequests()
  expect(signal.signal.aborted).toBe(true)
  expect(bench.ctx.mayflyOverlays.list()).toEqual([])
})

it('cancels a refresh that is aborted after the last catalog read boundary', async () => {
  const bench = await setup()
  await bench.openRoot()
  const signal = new AbortController()
  bench.registry.resolveByPath.mockImplementationOnce(() => {
    const thenable = {
      // oxlint-disable-next-line unicorn/no-thenable -- the microtask ordering is the point of this stub
      then(resolve: (value: unknown) => void) {
        queueMicrotask(() => {
          resolve(bench.workspaces[0])
          queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => signal.abort())))
        })
      },
    }
    return thenable as never
  })
  const call = nativeAction(bench.root(), activate('refresh', 'session-actions'), signal.signal)
  await call
  expect(signal.signal.aborted).toBe(true)
  expect(bench.controller.list).toHaveBeenCalledTimes(2)
  expect(bench.ctx.mayflyOverlays.list().map(entry => entry.id)).toContain('mayfly.sessions')
})
