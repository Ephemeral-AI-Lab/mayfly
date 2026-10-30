import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyListNode, MayflyStackNode, MayflySurfaceNode, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import type { RemoteOperationsContext, RemotePresentSlot } from '../../src/remote/operations/support.ts'
import { openRemoteBrowser, type RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { mountRemoteFilesOperations } from '../../src/remote/operations/files.ts'

vi.mock('../../src/remote/panels/browser.ts', () => ({
  openRemoteBrowser: vi.fn(() => ({ closed: false, refresh: vi.fn(), close: vi.fn() })),
}))

/**
 * Minimal Cordis context for the locale seam: `effect` owns the registration
 * disposer, `inject` resolves the locale service, and a registered namespace's
 * English catalog is the identity map the module ships.
 */
function fakeContext(): Context {
  const catalogs = new Map<string, Readonly<Record<string, string>>>()
  const translate = (namespace: string, key: string, values?: Readonly<Record<string, string | number>>): string => {
    const template = catalogs.get(namespace)?.[key] ?? key
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (placeholder: string, name: string) => {
      const value = values?.[name]
      return value === undefined ? placeholder : String(value)
    })
  }
  const locale = {
    register: vi.fn((namespace: string, catalog: { readonly en: Readonly<Record<string, string>> }) => {
      catalogs.set(namespace, catalog.en)
      return () => { catalogs.delete(namespace) }
    }),
    subscribe: vi.fn(() => () => {}),
    translate,
  }
  const ctx: Record<string, unknown> = {
    mayflyLocale: locale,
    effect: (callback: () => void | (() => void)) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject: (_names: readonly string[], callback: (scoped: unknown) => void) => {
      callback(ctx)
      return () => {}
    },
    get: (name: string) => (name === 'mayflyLocale' ? locale : undefined),
  }
  return ctx as unknown as Context
}

/** One Host projection face: absence is an undefined snapshot, never a missing face. */
interface ProjectionFace {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

function fixture(snapshot: unknown = undefined) {
  const ctx = fakeContext()
  const notice = { set: vi.fn() }
  const commands = new RemoteFeatureCommandRegistry()
  vi.mocked(openRemoteBrowser).mockClear()

  let projected: unknown = snapshot
  let projectionListener: (() => void) | undefined
  const face: ProjectionFace = {
    getSnapshot: () => projected,
    subscribe: listener => {
      projectionListener = listener
      return () => { projectionListener = undefined }
    },
  }
  const faceOf = vi.fn((_key: string) => face)
  const binding = { session: { projections: { faceOf } } } as unknown as SessionBinding

  let clientGeneration = 1
  let stateListener: (() => void) | undefined
  const client = {
    key: 'host-client',
    state: {
      getSnapshot: () => ({ generation: clientGeneration }),
      subscribe: (listener: () => void) => {
        stateListener = listener
        return () => { stateListener = undefined }
      },
    },
  } as unknown as HostClient

  const ref = (sessionId: string) => ({ host: HostKey('local'), sessionId: SessionId(sessionId) })
  let current: RemoteFeatureSelection | undefined = { ref: ref('session-1'), client, binding }
  let topologyListener: (() => void) | undefined
  const hosts = {
    list: () => (current === undefined ? [] : [current.client]),
    current: () => current,
    subscribe: (listener: () => void) => {
      topologyListener = listener
      return () => { topologyListener = undefined }
    },
  }

  const base = {
    ctx,
    hosts,
    notice,
    commands,
    subscribeLocale: () => () => {},
  } as unknown as RemoteFeatureContext
  const context = {
    base,
    options: { localCwd: '/work' },
    presentSlot: {} as unknown as RemotePresentSlot,
  } as unknown as RemoteOperationsContext

  const run = (): Promise<boolean> => commands.execute('files', '', new AbortController().signal)
  const openedOptions = (): RemoteBrowserOptions => {
    const call = vi.mocked(openRemoteBrowser).mock.calls.at(-1)
    if (call === undefined) throw new Error('no files browser was opened')
    return call[1]
  }
  const openedPanel = () => vi.mocked(openRemoteBrowser).mock.results.at(-1)?.value as unknown as {
    refresh: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  return {
    context, notice, commands, run, faceOf, openedOptions, openedPanel,
    setProjection: (value: unknown): void => { projected = value },
    fireProjection: (): void => { projectionListener?.() },
    setSelection: (sessionId: string | undefined): void => {
      current = sessionId === undefined ? undefined : { ref: ref(sessionId), client, binding }
    },
    fireTopology: (): void => { topologyListener?.() },
    bumpGeneration: (): void => { clientGeneration += 1 },
    fireState: (): void => { stateListener?.() },
  }
}

/** The one list the panel body carries, whatever else the stack holds. */
function listOf(node: MayflyUiNode): MayflyListNode {
  const surface = node as MayflySurfaceNode
  const column = surface.child as MayflyStackNode
  const list = column.children.map(child => child.node).find((child): child is MayflyListNode => child.kind === 'list')
  if (list === undefined) throw new Error('the files panel carries no list')
  return list
}

/** The list's empty-state title, or '' while rows hide it. */
function emptyTitleOf(node: MayflyUiNode): string {
  const empty = listOf(node).empty
  return empty !== undefined && empty.kind === 'empty' ? empty.title : ''
}

describe('mountRemoteFilesOperations', () => {
  it('registers exactly the files command, and its disposer unregisters and closes the panel', async () => {
    const f = fixture()
    const dispose = mountRemoteFilesOperations(f.context)
    expect(f.commands.list().map(command => command.name)).toEqual(['files'])
    expect(f.commands.list()[0]?.description).toBe('Browse files delivered by the agent')

    await f.run()
    const panel = f.openedPanel()
    dispose()
    expect(f.commands.list()).toEqual([])
    expect(panel.close).toHaveBeenCalledOnce()
  })

  it('reports the localized no-session notice without opening a panel', async () => {
    const f = fixture()
    mountRemoteFilesOperations(f.context)
    f.setSelection(undefined)
    await expect(f.run()).resolves.toBe(true)
    expect(f.notice.set).toHaveBeenCalledWith('No current session')
    expect(vi.mocked(openRemoteBrowser)).not.toHaveBeenCalled()
  })

  it('opens the projection-unavailable empty state when the deliverables key has no snapshot', async () => {
    const f = fixture()
    mountRemoteFilesOperations(f.context)
    await f.run()
    expect(f.faceOf).toHaveBeenCalledWith('mayflyDeliverables')
    const view = f.openedOptions().view()
    expect(listOf(view).items).toHaveLength(0)
    expect(emptyTitleOf(view)).toBe('This session does not expose the deliverables projection')
  })

  it('shows one row per well-formed deliverable and skips malformed rows', async () => {
    const f = fixture([
      { id: 'row-1', path: '/work/a.txt', description: 'Alpha' },
      { path: '/work/b.txt' },
      { id: 'missing-path' },
      { id: 'blank-path', path: '   ' },
      { id: 'row-2', path: '/work/c.txt', description: '' },
      'not-a-row',
    ])
    mountRemoteFilesOperations(f.context)
    await f.run()
    const items = listOf(f.openedOptions().view()).items
    expect(items.map(item => item.label)).toEqual(['/work/a.txt', '/work/b.txt', '/work/c.txt'])
    expect(items.map(item => item.id)).toEqual(['row-1', '1', 'row-2'])
  })

  it('refreshes the open panel view when the projection face publishes an update', async () => {
    const f = fixture()
    mountRemoteFilesOperations(f.context)
    await f.run()
    const options = f.openedOptions()
    expect(listOf(options.view()).items).toHaveLength(0)

    f.setProjection([{ id: 'row-1', path: '/work/new.txt' }])
    f.fireProjection()
    expect(f.openedPanel().refresh).toHaveBeenCalledOnce()
    expect(listOf(options.view()).items.map(item => item.label)).toEqual(['/work/new.txt'])
  })

  it('closes the panel when the selected Session stops being current', async () => {
    const f = fixture()
    mountRemoteFilesOperations(f.context)
    await f.run()
    const panel = f.openedPanel()
    f.setSelection(undefined)
    f.fireTopology()
    expect(panel.close).toHaveBeenCalledOnce()
  })

  it('closes the panel when the Host connection generation changes', async () => {
    const f = fixture()
    mountRemoteFilesOperations(f.context)
    await f.run()
    const panel = f.openedPanel()
    f.bumpGeneration()
    f.fireState()
    expect(panel.close).toHaveBeenCalledOnce()
  })

  it('opens one session-scoped browser whose isCurrent predicate follows the exact selection', async () => {
    const f = fixture()
    mountRemoteFilesOperations(f.context)
    await f.run()
    const options = f.openedOptions()
    expect(options.id).toBe('remote.operations.files')
    expect(options.scope).toEqual({ kind: 'session', sessionId: SessionId('session-1') })
    expect(options.isCurrent()).toBe(true)
    f.setSelection('session-2')
    expect(options.isCurrent()).toBe(false)
  })
})
