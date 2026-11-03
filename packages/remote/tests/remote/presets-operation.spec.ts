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
    key: HostKey('local'),
    remote: {
      agentPresets: {
        list: vi.fn(async () => ({ ok: true, value: { presets } })),
        select: vi.fn(async (_sessionId: string, id: string) => ({ ok: true, value: id })),
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
    binding: { session: { getSnapshot: () => ({ running: false }) } },
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
    expect(f.commands.execute).toHaveBeenCalledExactlyOnceWith('presets', '', expect.any(AbortSignal))
    expect(f.overlayOpen).not.toHaveBeenCalled()
    expect((host.remote.agentPresets.list as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(f.notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it('resolves exact native ids and rejects display names or a different case', async () => {
    const f = fixture()
    const host = client([{ id: 'alpha', name: 'Alpha' }, { id: 'other', name: 'Friendly' }])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
    const dispose = mountRemotePresetOperations(f.context)
    for (const name of ['ALPHA', 'Friendly', 'fRiEnDlY']) {
      await f.execute(name)
      expect(f.notice.set).toHaveBeenLastCalledWith(`Unknown agent preset: ${name}`, 'error')
    }
    expect(host.remote.agentPresets.select).not.toHaveBeenCalled()
    await f.execute('alpha')
    expect(host.remote.agentPresets.select).toHaveBeenCalledExactlyOnceWith(SessionId('session-1'), 'alpha')
    expect(f.notice.set).toHaveBeenLastCalledWith('preset alpha', 'info')
    expect(host.remote.settings.mutate).not.toHaveBeenCalled()
    dispose()
  })

  it('reports an unknown name and performs no switch', async () => {
    const f = fixture()
    const host = client([{ id: 'alpha', name: 'Alpha' }])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('ghost')
    expect(f.notice.set).toHaveBeenCalledWith('Unknown agent preset: ghost', 'error')
    expect(host.remote.agentPresets.select).not.toHaveBeenCalled()
    expect(host.remote.settings.mutate).not.toHaveBeenCalled()
    dispose()
  })

  it('rejects busy native Agents before catalog reads and ignores a detached selected Client', async () => {
    const f = fixture()
    const host = client([{ id: 'alpha' }])
    const current = selection(host as unknown as HostClient)
    vi.spyOn(current.binding.session, 'getSnapshot').mockReturnValue({ running: true } as never)
    f.attach(host as unknown as HostClient, current)
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('alpha')
    expect(f.notice.set).toHaveBeenCalledExactlyOnceWith('cannot switch presets while the agent is running', 'error')
    expect(host.remote.agentPresets.list).not.toHaveBeenCalled()
    expect(host.remote.agentPresets.select).not.toHaveBeenCalled()
    f.hosts.list.mockReturnValue([])
    await f.execute('alpha')
    expect(f.notice.set).toHaveBeenCalledOnce()
    expect(host.remote.agentPresets.list).not.toHaveBeenCalled()
    dispose()
  })

  it('reports a broken preset reason instead of selecting it', async () => {
    const f = fixture()
    const host = client([{ id: 'broken', name: 'Broken', broken: 'missing dependency' }])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('broken')
    expect(f.notice.set).toHaveBeenCalledWith('missing dependency', 'error')
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
    expect(f.notice.set).toHaveBeenCalledWith('preset alpha', 'info')
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
    expect(f.notice.set).toHaveBeenCalledWith('Default preset: alpha', 'info')
    expect(host.remote.agentPresets.select).not.toHaveBeenCalled()
    dispose()
  })

  it('reports a broken preset that carries an empty reason without a dangling colon', async () => {
    const f = fixture()
    const host = client([{ id: 'blank', name: 'Blank', broken: '' }])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
    mountRemotePresetOperations(f.context)
    await f.execute('blank')
    expect(f.notice.set).toHaveBeenLastCalledWith('', 'error')
  })

  it('reports no attached Host without crashing', async () => {
    const f = fixture()
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('alpha')
    expect(f.notice.set).toHaveBeenCalledWith('No Host is attached')
    dispose()
  })

  it('keeps queued command callbacks inert after cancellation or unload and refuses a detached roster', async () => {
    const f = fixture()
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('')
    expect(f.notice.set).toHaveBeenCalledExactlyOnceWith('No Host is attached')
    const execute = f.definition().execute
    const cancelled = new AbortController(); cancelled.abort()
    await execute('alpha', cancelled.signal)
    dispose()
    await execute('', new AbortController().signal)
    expect(f.commands.execute).not.toHaveBeenCalled()
    expect(f.notice.set).toHaveBeenCalledOnce()
  })

  it('reports missing roster handlers and current execution failures without surfacing retired outcomes', async () => {
    const f = fixture()
    const host = client()
    f.attach(host as unknown as HostClient)
    const dispose = mountRemotePresetOperations(f.context)
    f.commands.execute.mockResolvedValueOnce(false)
    await f.execute('')
    expect(f.notice.set).toHaveBeenCalledWith('Preset browsing is unavailable in this build')
    f.commands.execute.mockRejectedValueOnce(new Error('roster dispatch failed'))
    await f.execute('')
    expect(f.notice.set).toHaveBeenCalledWith('roster dispatch failed')
    const late = Promise.withResolvers<boolean>()
    f.commands.execute.mockReturnValueOnce(late.promise)
    const pending = f.execute('')
    dispose(); late.reject(new Error('obsolete roster dispatch'))
    await pending
    expect(f.notice.set).toHaveBeenCalledTimes(2)

    const cancelled = fixture()
    cancelled.attach(host as unknown as HostClient)
    const stop = mountRemotePresetOperations(cancelled.context)
    const answer = Promise.withResolvers<boolean>()
    cancelled.commands.execute.mockReturnValueOnce(answer.promise)
    const signal = new AbortController()
    const executing = cancelled.execute('', signal.signal)
    signal.abort(); answer.resolve(false)
    await executing
    expect(cancelled.notice.set).not.toHaveBeenCalled()
    stop()
  })

  it('retires pending roster reads after unload or exact Session replacement', async () => {
    for (const detach of [false, true]) {
      const f = fixture()
      const host = client([{ id: 'alpha' }])
      f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
      const dispose = mountRemotePresetOperations(f.context)
      const pending = Promise.withResolvers<Awaited<ReturnType<typeof host.remote.agentPresets.list>>>()
      host.remote.agentPresets.list.mockReturnValueOnce(pending.promise)
      const executing = f.execute('alpha')
      if (detach) f.hosts.current.mockReturnValue(selection(host as unknown as HostClient, 'replacement'))
      else dispose()
      pending.resolve({ ok: true, value: { presets: [{ id: 'alpha' }] } })
      await executing
      expect(host.remote.agentPresets.select).not.toHaveBeenCalled()
      expect(f.notice.set).not.toHaveBeenCalled()
      if (detach) dispose()
    }
  })

  it('fences late Session selections and reports only errors owned by the current command', async () => {
    const f = fixture()
    const host = client([{ id: 'alpha' }])
    f.attach(host as unknown as HostClient, selection(host as unknown as HostClient))
    const dispose = mountRemotePresetOperations(f.context)
    host.remote.agentPresets.select.mockRejectedValueOnce(new Error('native turn guard failed'))
    await f.execute('alpha')
    expect(f.notice.set).toHaveBeenCalledExactlyOnceWith('native turn guard failed', 'error')
    const late = Promise.withResolvers<Awaited<ReturnType<typeof host.remote.agentPresets.select>>>()
    host.remote.agentPresets.select.mockReturnValueOnce(late.promise)
    const selecting = f.execute('alpha')
    await vi.waitFor(() => { expect(host.remote.agentPresets.select).toHaveBeenCalledTimes(2) })
    f.hosts.current.mockReturnValue(selection(host as unknown as HostClient, 'new-selection'))
    late.resolve({ ok: true, value: 'Alpha' })
    await selecting
    expect(f.notice.set).toHaveBeenCalledOnce()
    const failed = Promise.withResolvers<Awaited<ReturnType<typeof host.remote.agentPresets.list>>>()
    host.remote.agentPresets.list.mockReturnValueOnce(failed.promise)
    const request = f.execute('alpha')
    f.hosts.list.mockReturnValue([])
    failed.reject(new Error('detached native failure'))
    await request
    expect(f.notice.set).toHaveBeenCalledOnce()
    dispose()
  })

  it.each([false, true])('refuses unavailable native default settings (readonly=%s)', async readonly => {
    const f = fixture()
    const host = client([{ id: 'alpha' }])
    f.attach(host as unknown as HostClient)
    const dispose = mountRemotePresetOperations(f.context)
    host.remote.settings.describe.mockResolvedValueOnce({ ok: true, value: { writable: !readonly, namespaces: readonly ? [{ ns: 'agent-preset-registry', revision: 7 }] : [] } })
    await f.execute('alpha')
    expect(f.notice.set).toHaveBeenCalledExactlyOnceWith('preset selection is unavailable')
    expect(host.remote.settings.mutate).not.toHaveBeenCalled()
    dispose()
  })

  it('writes unnamed defaults and fences description and mutation settlement under the original Host', async () => {
    const f = fixture()
    const host = client([{ id: 'alpha' }])
    f.attach(host as unknown as HostClient)
    const dispose = mountRemotePresetOperations(f.context)
    await f.execute('alpha')
    expect(f.notice.set).toHaveBeenCalledExactlyOnceWith('Default preset: alpha', 'info')
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof host.remote.settings.describe>>>()
    host.remote.settings.describe.mockReturnValueOnce(pending.promise)
    const describing = f.execute('alpha')
    await vi.waitFor(() => { expect(host.remote.settings.describe).toHaveBeenCalledTimes(2) })
    f.hosts.list.mockReturnValue([])
    pending.resolve({ ok: true, value: { writable: true, namespaces: [{ ns: 'agent-preset-registry', revision: 9 }] } })
    await describing
    expect(host.remote.settings.mutate).toHaveBeenCalledOnce()
    expect(f.notice.set).toHaveBeenCalledOnce()
    dispose()
    const late = fixture()
    late.attach(host as unknown as HostClient)
    const stop = mountRemotePresetOperations(late.context)
    const response = Promise.withResolvers<Awaited<ReturnType<typeof host.remote.settings.mutate>>>()
    host.remote.settings.mutate.mockReturnValueOnce(response.promise)
    const mutating = late.execute('alpha')
    await vi.waitFor(() => { expect(host.remote.settings.mutate).toHaveBeenCalledTimes(2) })
    stop(); response.resolve({ ok: true, value: {} })
    await mutating
    expect(late.notice.set).not.toHaveBeenCalled()
  })
})
