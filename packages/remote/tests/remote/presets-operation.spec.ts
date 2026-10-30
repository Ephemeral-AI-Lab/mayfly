import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureSelection } from '../../src/remote/features.ts'
import { mountRemotePresetOperations } from '../../src/remote/operations/presets.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'

interface PresetRow {
  readonly id: string
  readonly name?: string
  readonly broken?: string
}

interface CommandDefinition {
  readonly name: string
  execute(rawInput: string, signal: AbortSignal): Promise<void>
}

function fixture() {
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
  const overlayOpen = vi.fn()
  const ctx = {
    inject: vi.fn(),
    get: vi.fn(() => undefined),
    effect: vi.fn((callback: () => unknown) => callback()),
    mayflyLocale: { register: vi.fn(), subscribe: vi.fn(() => () => {}) },
    mayflyOverlays: { open: overlayOpen, subscribe: vi.fn(() => () => {}) },
  }
  const hosts = {
    current: vi.fn((): RemoteFeatureSelection | undefined => undefined),
    list: vi.fn((): readonly HostClient[] => []),
    subscribe: vi.fn(() => () => {}),
  }
  const base = { ctx, hosts, notice, commands }
  const context = {
    base,
    options: {},
    presentSlot: {},
  } as unknown as RemoteOperationsContext
  const definition = (): CommandDefinition => {
    const registered = entries.get('preset')
    if (registered === undefined) throw new Error('preset command was not registered')
    return registered
  }
  const attach = (client: HostClient, selected?: RemoteFeatureSelection): void => {
    hosts.list.mockReturnValue([client])
    hosts.current.mockReturnValue(selected)
  }
  const execute = async (input: string, signal = new AbortController().signal): Promise<void> => {
    await definition().execute(input, signal)
  }
  return { context, commands, notice, overlayOpen, hosts, definition, attach, execute, unregister }
}

function client(presets: readonly PresetRow[] = []) {
  return {
    remote: {
      agentPresets: {
        list: vi.fn(async () => ({ ok: true, value: { presets } })),
        select: vi.fn(async () => ({ ok: true, value: 'Alpha' })),
      },
      settings: {
        describe: vi.fn(async () => ({
          ok: true,
          value: { writable: true, namespaces: [{ ns: 'agent-preset-registry', revision: 7 }] },
        })),
        mutate: vi.fn(async () => ({ ok: true, value: {} })),
      },
    },
  }
}

function selection(host: HostClient, sessionId = 'session-1'): RemoteFeatureSelection {
  return {
    ref: { host: HostKey('local'), sessionId: SessionId(sessionId) },
    client: host,
    binding: {},
  } as unknown as RemoteFeatureSelection
}

describe('mountRemotePresetOperations', () => {
  it('registers exactly the preset command and unregisters it on dispose', () => {
    const f = fixture()
    const dispose = mountRemotePresetOperations(f.context)
    expect(f.commands.register).toHaveBeenCalledOnce()
    expect(f.definition().name).toBe('preset')
    expect(f.commands.list().map(command => command.name)).toEqual(['preset'])
    dispose()
    expect(f.unregister).toHaveBeenCalledOnce()
    expect(f.commands.list()).toEqual([])
  })

  it('forwards bare /preset to the existing /presets roster without opening a panel', async () => {
    const f = fixture()
    const host = client([{ id: 'alpha', name: 'Alpha' }])
    f.attach(host as unknown as HostClient)
    const dispose = mountRemotePresetOperations(f.context)
    const signal = new AbortController().signal
    await f.execute('', signal)
    expect(f.commands.execute).toHaveBeenCalledExactlyOnceWith('presets', '', signal)
    expect(f.overlayOpen).not.toHaveBeenCalled()
    expect((host.remote.agentPresets.list as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(f.notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it('resolves a name by id first, then by display name, case-insensitively', async () => {
    const f = fixture()
    const host = client([
      { id: 'alpha', name: 'Alpha' },
      { id: 'other', name: 'Friendly' },
    ])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('ALPHA')
    expect(host.remote.agentPresets.select).toHaveBeenCalledWith(SessionId('session-1'), 'alpha')
    await f.execute('fRiEnDlY')
    expect(host.remote.agentPresets.select).toHaveBeenLastCalledWith(SessionId('session-1'), 'other')
    expect(host.remote.agentPresets.select).toHaveBeenCalledTimes(2)
    expect(f.notice.set).toHaveBeenLastCalledWith('Preset switched to Alpha')
    expect(host.remote.settings.mutate).not.toHaveBeenCalled()
    dispose()
  })

  it('reports an unknown name and performs no switch', async () => {
    const f = fixture()
    const host = client([{ id: 'alpha', name: 'Alpha' }])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('ghost')
    expect(f.notice.set).toHaveBeenCalledWith('Unknown preset: ghost')
    expect(host.remote.agentPresets.select).not.toHaveBeenCalled()
    expect(host.remote.settings.mutate).not.toHaveBeenCalled()
    dispose()
  })

  it('reports a broken preset reason instead of selecting it', async () => {
    const f = fixture()
    const host = client([{ id: 'broken', name: 'Broken', broken: 'missing dependency' }])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('broken')
    expect(f.notice.set).toHaveBeenCalledWith('The preset cannot compose a session: missing dependency')
    expect(host.remote.agentPresets.select).not.toHaveBeenCalled()
    expect(host.remote.settings.mutate).not.toHaveBeenCalled()
    dispose()
  })

  it('selects through the Host agent preset guard for the exact selected session', async () => {
    const f = fixture()
    const host = client([{ id: 'alpha', name: 'Alpha' }])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient, 'session-9'))
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('alpha')
    expect(host.remote.agentPresets.select).toHaveBeenCalledExactlyOnceWith(SessionId('session-9'), 'alpha')
    expect(f.notice.set).toHaveBeenCalledWith('Preset switched to Alpha')
    expect(host.remote.settings.mutate).not.toHaveBeenCalled()
    dispose()
  })

  it('writes the default preset through settings mutate with the descriptor revision', async () => {
    const f = fixture()
    const host = client([{ id: 'alpha', name: 'Alpha' }])
    f.attach(host as unknown as HostClient)
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('alpha')
    expect(host.remote.settings.describe).toHaveBeenCalledOnce()
    expect(host.remote.settings.mutate).toHaveBeenCalledExactlyOnceWith(
      'agent-preset-registry',
      [{ op: 'set', path: ['selectedDefault'], value: 'alpha' }],
      7,
    )
    expect(f.notice.set).toHaveBeenCalledWith('Default preset: Alpha')
    expect(host.remote.agentPresets.select).not.toHaveBeenCalled()
    dispose()
  })

  it('reports a broken preset that carries an empty reason without a dangling colon', async () => {
    const f = fixture()
    const host = client([{ id: 'blank', name: 'Blank', broken: '' }])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
    mountRemotePresetOperations(f.context)
    await f.execute('blank')
    expect(f.notice.set).toHaveBeenLastCalledWith('The preset cannot compose a session')
  })

  it('reports no attached Host without crashing', async () => {
    const f = fixture()
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('alpha')
    expect(f.notice.set).toHaveBeenCalledWith('No Host is attached')
    dispose()
  })
})
