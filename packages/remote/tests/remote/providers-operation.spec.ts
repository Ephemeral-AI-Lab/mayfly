import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureSelection } from '../../src/remote/features.ts'
import {
  REMOTE_PROVIDER_MODELS_LIST_ID,
  REMOTE_PROVIDERS_LIST_ID,
} from '../../src/remote/panels/operations/providers.ts'
import { mountRemoteProviderOperations } from '../../src/remote/operations/providers.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'

const mockedHost = vi.hoisted(() => ({ instances: [] as unknown[] }))

vi.mock('../../src/remote/features/configuration-host.ts', () => ({
  RemoteConfigurationHost: class {
    readonly load = vi.fn(async () => undefined)
    readonly read = vi.fn(async () => ({ provider: '', model: '' }))
    readonly select = vi.fn(async (_client: unknown, next: { provider: string, model: string }) => next)
    constructor() {
      mockedHost.instances.push(this)
    }
  },
}))

interface ProviderInfo {
  readonly id: string
  readonly name: string
}

interface ConfigurableProvider {
  readonly provider: string
  readonly displayName: string
  readonly error?: string
}

interface CatalogModel {
  readonly id: string
  readonly name?: string
}

interface Catalog {
  readonly default: { readonly provider: string, readonly model: string }
  readonly routableProviders: readonly string[]
  readonly groups: readonly { readonly id: string, readonly name: string, readonly models: readonly CatalogModel[] }[]
  readonly failures: readonly unknown[]
}

interface ClientOptions {
  readonly live?: readonly ProviderInfo[]
  readonly configurable?: readonly ConfigurableProvider[]
  readonly catalog?: Catalog
}

interface CommandDefinition {
  readonly name: string
  execute(rawInput: string, signal: AbortSignal): Promise<void>
}

interface UiNode {
  readonly kind?: string
  readonly id?: string
  readonly title?: string
  readonly items?: readonly { readonly id: string, readonly label: string }[]
}

interface OverlayHandle {
  closed: boolean
  set: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function makeClient(options: ClientOptions = {}) {
  const catalog: Catalog = options.catalog ?? {
    default: { provider: '', model: '' },
    routableProviders: [],
    groups: [],
    failures: [],
  }
  return {
    state: {
      getSnapshot: () => ({ generation: 1 }),
      subscribe: vi.fn(() => () => {}),
    },
    remote: {
      llm: {
        listProviders: vi.fn(async () => ({ ok: true, value: options.live ?? [] })),
        listConfigurableProviders: vi.fn(async () => ({ ok: true, value: options.configurable ?? [] })),
      },
      session: {
        modelCatalog: vi.fn(async () => ({ ok: true, value: catalog })),
        selectModel: vi.fn(async () => ({ ok: true, value: { selected: { provider: 'p1', model: 'm1' } } })),
      },
      settings: {
        describe: vi.fn(async () => ({ ok: true, value: { writable: true, namespaces: [] } })),
        mutate: vi.fn(async () => ({ ok: true, value: {} })),
      },
    },
  }
}

function selection(host: HostClient, sessionId = 'session-1'): RemoteFeatureSelection {
  return {
    ref: { host: HostKey('local'), sessionId: SessionId(sessionId) },
    client: host,
    binding: {
      session: {
        projections: {
          faceOf: () => ({ getSnapshot: () => ({ next: { provider: 'p1', model: 'm1' } }) }),
        },
      },
    },
  } as unknown as RemoteFeatureSelection
}

function fixture(host: ReturnType<typeof makeClient>, selected?: RemoteFeatureSelection) {
  mockedHost.instances.length = 0
  const entries = new Map<string, CommandDefinition>()
  const unregister = vi.fn()
  const commands = {
    register: vi.fn((definition: CommandDefinition) => {
      entries.set(definition.name, definition)
      return () => {
        entries.delete(definition.name)
        unregister()
      }
    }),
    execute: vi.fn(async () => true),
    list: () => [...entries.values()],
  }
  const notice = { set: vi.fn() }
  const handle: OverlayHandle = { closed: false, set: vi.fn((_node: unknown) => {}), close: vi.fn() }
  const overlay = { open: vi.fn((_component: unknown, _options: unknown) => handle), subscribe: vi.fn((_listener: () => void) => () => {}) }
  const ctx = {
    inject: vi.fn(),
    get: vi.fn(() => undefined),
    effect: vi.fn((callback: () => unknown) => callback()),
    mayflyLocale: { register: vi.fn(), subscribe: vi.fn(() => () => {}) },
    subscribeLocale: vi.fn(() => () => {}),
    mayflyOverlays: overlay,
  }
  const hosts = {
    current: vi.fn((): RemoteFeatureSelection | undefined => selected),
    list: vi.fn((): readonly HostClient[] => [host as unknown as HostClient]),
    subscribe: vi.fn(() => () => {}),
  }
  const context = {
    base: { ctx, hosts, notice, commands, subscribeLocale: vi.fn(() => () => {}) },
    options: {},
    presentSlot: {},
  } as unknown as RemoteOperationsContext
  const definition = (): CommandDefinition => {
    const registered = entries.get('provider')
    if (registered === undefined) throw new Error('provider command was not registered')
    return registered
  }
  const execute = async (input: string, signal = new AbortController().signal): Promise<void> => {
    await definition().execute(input, signal)
  }
  const node = (): UiNode => overlay.open.mock.calls.at(-1)![1] as unknown as UiNode
  const latestNode = (): UiNode => (handle.set.mock.calls.at(-1)?.[1] ?? overlay.open.mock.calls.at(-1)![1]) as unknown as UiNode
  const action = async (event: unknown): Promise<unknown> => {
    const opened = overlay.open.mock.calls.at(-1)![0] as unknown as {
      onEvent: { action(event: unknown, context: unknown): Promise<unknown> }
    }
    return await opened.onEvent.action(event, { signal: new AbortController().signal })
  }
  return {
    context, commands, notice, overlay, handle, hosts, definition, execute, node, latestNode, action, unregister,
  }
}

function walk(node: unknown): unknown[] {
  if (typeof node !== 'object' || node === null) return []
  const record = node as Record<string, unknown>
  const found: unknown[] = [node]
  if ('child' in record) found.push(...walk(record.child))
  if (Array.isArray(record.children)) {
    for (const child of record.children) found.push(...walk((child as { node?: unknown }).node))
  }
  return found
}

function findList(node: unknown, id: string): { id: string, items: readonly { id: string }[] } {
  const match = walk(node).find(candidate => {
    const record = candidate as { kind?: string, id?: string }
    return record.kind === 'list' && record.id === id
  }) as { id: string, items: readonly { id: string }[] } | undefined
  if (match === undefined) throw new Error(`list ${id} was not rendered`)
  return match
}

const catalog = (models: readonly CatalogModel[]): Catalog => ({
  default: { provider: 'p1', model: models[0]?.id ?? '' },
  routableProviders: ['p1'],
  groups: [{ id: 'p1', name: 'P1', models }],
  failures: [],
})

describe('mountRemoteProviderOperations', () => {
  it('registers exactly the provider command and unregisters it on dispose', () => {
    const host = makeClient()
    const f = fixture(host)
    const dispose = mountRemoteProviderOperations(f.context)
    expect(f.commands.register).toHaveBeenCalledOnce()
    expect(f.definition().name).toBe('provider')
    expect(f.commands.list().map(command => command.name)).toEqual(['provider'])
    dispose()
    expect(f.unregister).toHaveBeenCalledOnce()
    expect(f.commands.list()).toEqual([])
  })

  it('opens a deduplicated roster from the live and configurable directories', async () => {
    const host = makeClient({
      live: [{ id: 'shared', name: 'Shared Live' }, { id: 'live-only', name: 'Live Only' }],
      configurable: [
        { provider: 'shared', displayName: 'Shared Config' },
        { provider: 'config-only', displayName: 'Config Only' },
      ],
    })
    const f = fixture(host)
    const dispose = mountRemoteProviderOperations(f.context)
    await f.execute('')
    expect(host.remote.llm.listProviders).toHaveBeenCalledOnce()
    expect(host.remote.llm.listConfigurableProviders).toHaveBeenCalledOnce()
    expect(f.overlay.open).toHaveBeenCalledOnce()
    const list = findList(f.node(), REMOTE_PROVIDERS_LIST_ID)
    const ids = list.items.map(item => item.id)
    expect(ids).toEqual(['shared', 'config-only', 'live-only'])
    expect(new Set(ids).size).toBe(ids.length)
    expect((list.items[0] as { label?: string }).label).toBe('Shared Live')
    dispose()

    const second = fixture(makeClient({ configurable: [{ provider: 'config-only', displayName: 'Config Only' }] }))
    const secondDispose = mountRemoteProviderOperations(second.context)
    await second.execute('list')
    expect(second.overlay.open).toHaveBeenCalledOnce()
    expect(findList(second.node(), REMOTE_PROVIDERS_LIST_ID).items.map(item => item.id)).toEqual(['config-only'])
    secondDispose()
  })

  it('resolves a provider by id first, then by display name, case-insensitively', async () => {
    const byId = makeClient({
      live: [{ id: 'p1', name: 'Pretty Live' }],
      configurable: [{ provider: 'p1', displayName: 'Pretty One' }, { provider: 'other', displayName: 'P1' }],
    })
    const first = fixture(byId)
    const firstDispose = mountRemoteProviderOperations(first.context)
    await first.execute('P1')
    expect((first.node() as { title?: string }).title).toBe('Models for Pretty Live')
    expect(first.notice.set).not.toHaveBeenCalled()
    firstDispose()

    const byName = makeClient({ configurable: [{ provider: 'p2', displayName: 'Pretty One' }] })
    const second = fixture(byName)
    const secondDispose = mountRemoteProviderOperations(second.context)
    await second.execute('pReTtY oNe')
    expect((second.node() as { title?: string }).title).toBe('Models for Pretty One')
    secondDispose()

    const bySwitch = makeClient({ live: [{ id: 'p3', name: 'Third Live' }] })
    const third = fixture(bySwitch)
    const thirdDispose = mountRemoteProviderOperations(third.context)
    await third.execute('switch THIRD LIVE')
    expect((third.node() as { title?: string }).title).toBe('Models for Third Live')
    thirdDispose()
  })

  it('reports an unknown provider without opening anything', async () => {
    const host = makeClient({ configurable: [{ provider: 'p1', displayName: 'Pretty One' }] })
    const f = fixture(host)
    const dispose = mountRemoteProviderOperations(f.context)
    await f.execute('ghost')
    expect(f.notice.set).toHaveBeenCalledWith('Unknown provider')
    expect(f.overlay.open).not.toHaveBeenCalled()
    dispose()
  })

  it('refuses add, edit, and remove before touching credentials or settings', async () => {
    const host = makeClient({ live: [{ id: 'p1', name: 'P1' }] })
    const f = fixture(host)
    const dispose = mountRemoteProviderOperations(f.context)
    // Every verb, with and without a name, and in any case: a bare `edit` or an
    // upper-case `ADD` used to fall through to the name lookup and answer
    // "Unknown provider" instead of pointing at /providers.
    for (const input of ['add', 'add other', 'edit', 'edit p1', 'remove', 'remove p1', 'ADD', 'Edit p1']) {
      await f.execute(input)
      expect(f.notice.set).toHaveBeenLastCalledWith(
        'Provider configuration and credentials are only editable from /providers',
      )
    }
    expect(f.notice.set).toHaveBeenCalledTimes(8)
    expect(host.remote.settings.describe).not.toHaveBeenCalled()
    expect(host.remote.settings.mutate).not.toHaveBeenCalled()
    expect(host.remote.llm.listProviders).not.toHaveBeenCalled()
    expect(f.overlay.open).not.toHaveBeenCalled()
    dispose()
  })

  it('opens the roster for a bare switch instead of treating "switch" as a provider', async () => {
    const host = makeClient({ live: [{ id: 'p1', name: 'P1' }] })
    const f = fixture(host)
    mountRemoteProviderOperations(f.context)
    await f.execute('switch')
    // A bare `switch` is the roster, exactly like bare `/provider`.
    expect(f.overlay.open).toHaveBeenCalledTimes(1)
    expect(f.notice.set).not.toHaveBeenCalledWith('Unknown provider: switch')
  })

  it('commits a model through session.selectModel when a session is selected', async () => {
    const host = makeClient({
      live: [{ id: 'p1', name: 'P1' }],
      catalog: catalog([{ id: 'm1', name: 'Model One' }]),
    })
    const selected = selection(host as unknown as HostClient)
    const f = fixture(host, selected)
    const dispose = mountRemoteProviderOperations(f.context)
    await f.execute('p1')
    const list = findList(f.node(), REMOTE_PROVIDER_MODELS_LIST_ID)
    expect(list.items.map(item => item.id)).toEqual(['m1'])
    await f.action({ kind: 'selection-accept', controlId: REMOTE_PROVIDER_MODELS_LIST_ID, selectedIds: ['m1'] })
    expect(host.remote.session.selectModel).toHaveBeenCalledExactlyOnceWith({
      sessionId: SessionId('session-1'),
      provider: 'p1',
      model: 'm1',
    })
    expect(f.notice.set).toHaveBeenCalledWith('Switched to m1 (p1)')
    expect(f.handle.close).toHaveBeenCalled()
    dispose()
  })

  it('commits the default-model DTO when no session is selected', async () => {
    const host = makeClient({
      live: [{ id: 'p1', name: 'P1' }],
      catalog: catalog([{ id: 'm1', name: 'Model One' }]),
    })
    const f = fixture(host)
    const dispose = mountRemoteProviderOperations(f.context)
    await f.execute('p1')
    const defaults = mockedHost.instances.at(-1) as {
      read: ReturnType<typeof vi.fn>
      select: ReturnType<typeof vi.fn>
    }
    await f.action({ kind: 'selection-accept', controlId: REMOTE_PROVIDER_MODELS_LIST_ID, selectedIds: ['m1'] })
    expect(defaults.read).toHaveBeenCalled()
    expect(defaults.select).toHaveBeenCalledExactlyOnceWith(
      host as unknown as HostClient,
      { provider: 'p1', model: 'm1' },
    )
    expect(host.remote.session.selectModel).not.toHaveBeenCalled()
    expect(f.notice.set).toHaveBeenCalledWith('Switched to m1 (p1)')
    dispose()
  })

  it('reports no attached Host and opens nothing', async () => {
    const f = fixture(makeClient())
    f.hosts.list.mockReturnValue([])
    const dispose = mountRemoteProviderOperations(f.context)
    await f.execute('')
    expect(f.notice.set).toHaveBeenCalledWith('No Host is attached')
    expect(f.overlay.open).not.toHaveBeenCalled()
    dispose()
  })
})
