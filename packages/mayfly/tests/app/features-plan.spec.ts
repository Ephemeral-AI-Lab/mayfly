import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/app/features.ts'
import { mountPlanFeature } from '../../src/app/features/plan.ts'
import { flush, submissionFixture, wire } from './editor-feature-fixture.ts'

interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly scope?: 'sessionless' | 'session'
  readonly input?: { readonly hint?: string }
  execute(rawInput: string, signal?: AbortSignal): Promise<void>
}

interface KeymapBinding {
  readonly id: string
  readonly keys: readonly string[]
  readonly scope: string
  readonly description: string
  handler(): void
}

function fixture(options: { readonly session?: boolean, readonly plan?: unknown, readonly access?: 'interactive' | 'resumable' | 'readonly' } = {}) {
  let snapshot: unknown = options.plan
  const projectionListeners = new Set<() => void>()
  const unsubscribeProjection = vi.fn()
  const subscribeProjection = vi.fn((listener: () => void) => {
    projectionListeners.add(listener)
    return () => {
      projectionListeners.delete(listener)
      unsubscribeProjection()
    }
  })
  const projection = {
    getSnapshot: vi.fn(() => snapshot),
    subscribe: subscribeProjection,
  }
  const permissionsListeners = new Set<() => void>()
  const permissionsProjection = { getSnapshot: () => ({ currentValue: 'custom' }), subscribe: (listener: () => void) => { permissionsListeners.add(listener); return () => { permissionsListeners.delete(listener) } } }
  const events = new Map<string, Set<(...args: unknown[]) => void>>()
  const stateListeners = new Set<() => void>()
  let connection = 1
  const permissionDetails = vi.fn(async (_request: unknown, _signal?: AbortSignal): Promise<unknown> => ({ ok: true, value: { yolo: false, specs: {} } }))
  const executeNative = vi.fn(async (_id: unknown, _line: string, _attachments: readonly unknown[], _signal: AbortSignal): Promise<unknown> => ({ ok: true, value: { result: { kind: 'success' } } }))
  const client = {
    key: HostKey('local'),
    state: { getSnapshot: () => ({ generation: connection }), subscribe: vi.fn((listener: () => void) => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } }) },
    remote: { commands: { execute: executeNative },
      mayflyHost: { capabilities: async () => ({ ok: true, value: { features: ['permissionCatalogDetails'] } }), permissionCatalogDetails: permissionDetails },
      $on: (event: string, listener: (...args: unknown[]) => void) => {
        const listeners = events.get(event) ?? new Set<(...args: unknown[]) => void>()
        events.set(event, listeners)
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  } as unknown as HostClient
  const selection: RemoteFeatureSelection = {
    access: options.access,
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') },
    client,
    binding: { session: { command: executeNative, projections: { faceOf: vi.fn((key: string) => key === 'permissions' ? permissionsProjection : projection) } } },
  } as unknown as RemoteFeatureSelection
  let selected: RemoteFeatureSelection | undefined = options.session === false ? undefined : selection
  let topology: (() => void) | undefined
  let clients: readonly HostClient[] = [client]
  let active: HostClient | undefined = client
  const hosts = {
    list: vi.fn((): readonly HostClient[] => clients),
    active: () => active,
    current: vi.fn((): RemoteFeatureSelection | undefined => selected),
    subscribe: vi.fn((listener: () => void) => {
      topology = listener
      return () => {}
    }),
  }
  const notice = { set: vi.fn() }
  const entries = new Map<string, CommandDefinition>()
  const unregisterCommand = vi.fn()
  const registerCommand = vi.fn((definition: CommandDefinition) => {
    entries.set(definition.name, definition)
    return () => {
      entries.delete(definition.name)
      unregisterCommand()
    }
  })
  const status = { set: vi.fn(), dispose: vi.fn() }
  const registerStatus = vi.fn(() => status)
  const unregisterKey = vi.fn()
  const registerKeymap = vi.fn((_bindings: readonly KeymapBinding[]) => unregisterKey)
  const locale = {
    register: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    translate: vi.fn((_namespace: string, key: string) => key),
  }
  const effect = vi.fn((callback: () => unknown) => {
    const dispose = callback()
    return () => { if (typeof dispose === 'function') dispose() }
  })
  const ctx = {
    effect,
    inject: vi.fn((_dependencies: readonly string[], callback: (scope: { mayflyLocale: typeof locale, effect: typeof effect }) => void) => {
      callback({ mayflyLocale: locale, effect })
    }),
    get: vi.fn(() => undefined),
    mayflyLocale: locale,
    mayflyStatus: { register: registerStatus },
    mayflyKeymap: { register: registerKeymap },
  }
  const localeListeners = new Set<() => void>()
  let pendingPlan: boolean | undefined = false
  const startupPlan = { pending: () => pendingPlan, set: vi.fn((active: boolean) => { pendingPlan = active; topology?.() }) }
  const context = {
    startupPlan,
    ctx,
    hosts,
    notice,
    commands: { register: registerCommand },
    t: vi.fn((key: string) => key),
    subscribeLocale: vi.fn((listener: () => void) => { localeListeners.add(listener); return () => { localeListeners.delete(listener) } }),
  } as unknown as RemoteFeatureContext
  /** Resolve the single command registered under `name`. */
  const command = (name: string): CommandDefinition => {
    const registered = entries.get(name)
    if (registered === undefined) throw new Error(`${name} was not registered`)
    return registered
  }
  /** Fire the Host topology listener once, as an attach or selection commit does. */
  const fireTopology = (): void => { topology!() }
  /** Publish a new plan snapshot through the projection subscription. */
  const emitPlan = (next: unknown): void => {
    snapshot = next
    for (const listener of projectionListeners) listener()
  }
  /** Detach the selected Session, leaving the Host attached. */
  const detach = (): void => {
    selected = undefined
    fireTopology()
  }
  /** Attach the selected Session again after a detach. */
  const attach = (): void => {
    selected = selection
    fireTopology()
  }
  const keymapBinding = (): KeymapBinding => registerKeymap.mock.calls[0]![0][0]!
  return {
    context,
    client,
    permissionDetails,
    permissionsListeners,
    events,
    stateListeners,
    localeListeners,
    emitLocale: () => { for (const listener of localeListeners) listener() },
    emitPermissions: () => { for (const listener of permissionsListeners) listener() },
    event: (name: string, ...args: unknown[]) => { for (const listener of events.get(name) ?? []) listener(...args) },
    reconnect: () => { connection += 1; for (const listener of stateListeners) listener() },
    select: (next: RemoteFeatureSelection | undefined) => { selected = next; topology?.() },
    hosts: (next: readonly HostClient[], nextActive?: HostClient) => { clients = next; active = nextActive; topology?.() },
    startupPlan,
    clearPending: () => { pendingPlan = undefined; topology?.() },
    command,
    keymapBinding,
    executeNative,
    notice,
    status,
    registerStatus,
    registerKeymap,
    unregisterKey,
    registerCommand,
    unregisterCommand,
    locale,
    projection,
    subscribeProjection,
    unsubscribeProjection,
    emitPlan,
    fireTopology,
    detach,
    attach,
    entries,
    selection,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('mountPlanFeature', () => {
  it('shows independent plan and yolo badges immediately for readonly custom permissions without opening a picker', async () => {
    const f = fixture({ plan: { active: true, pending: false }, access: 'readonly' })
    f.permissionDetails.mockResolvedValue({ ok: true, value: { yolo: true, specs: {} } })
    const dispose = mountPlanFeature(f.context)
    await flush()
    expect(f.permissionDetails).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session-1' }, expect.any(AbortSignal))
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'stack', direction: 'row', gap: 1, children: [
      { node: { kind: 'text', content: 'plan', tone: 'accent' } }, { node: { kind: 'text', content: 'yolo', tone: 'warning' } },
    ] })
    f.emitPlan({ active: false, pending: false })
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'yolo', tone: 'warning' })
    f.permissionDetails.mockResolvedValue({ ok: true, value: { yolo: false, specs: {} } })
    f.emitPermissions()
    await flush()
    expect(f.status.set).toHaveBeenLastCalledWith(null)
    expect(f.executeNative).not.toHaveBeenCalled()
    dispose()
    expect(f.permissionsListeners.size + f.stateListeners.size + f.localeListeners.size).toBe(0)
    expect([...f.events.values()].every(listeners => listeners.size === 0)).toBe(true)
  })

  it('reads sessionless native defaults and refreshes mode status for catalog, default settings and locale updates', async () => {
    const f = fixture({ session: false })
    f.permissionDetails.mockResolvedValue({ ok: true, value: { yolo: true, specs: {} } })
    const dispose = mountPlanFeature(f.context)
    await flush()
    expect(f.permissionDetails).toHaveBeenLastCalledWith({}, expect.any(AbortSignal))
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'yolo', tone: 'warning' })
    await f.command('plan').execute('')
    await flush()
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'stack', direction: 'row', gap: 1, children: [
      { node: { kind: 'text', content: 'plan…', tone: 'accent' } }, { node: { kind: 'text', content: 'yolo', tone: 'warning' } },
    ] })
    const count = f.permissionDetails.mock.calls.length
    for (const ns of ['other', 'permission', 'shell', 'approval']) f.event('settings/document-updated', ns, 2)
    f.event('permission-presets/catalog-changed')
    await flush()
    expect(f.permissionDetails).toHaveBeenCalledTimes(count + 4)
    f.emitLocale()
    expect(f.status.set).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'stack' }))
    dispose()
  })

  it('uses newest confirmed permission facts across projection and withdrawn-catalog refreshes', async () => {
    const f = fixture()
    const first = Promise.withResolvers<unknown>()
    f.permissionDetails.mockReturnValueOnce(first.promise)
    const dispose = mountPlanFeature(f.context)
    await flush()
    f.permissionDetails.mockResolvedValueOnce({ ok: true, value: { yolo: false, specs: {} } })
    f.event('permission-presets/catalog-changed')
    await flush()
    const paints = f.status.set.mock.calls.length
    first.resolve({ ok: true, value: { yolo: true, specs: {} } })
    await flush()
    expect(f.status.set).toHaveBeenCalledTimes(paints)
    expect(f.status.set).toHaveBeenLastCalledWith(null)
    dispose()
  })

  it.each(['session', 'host', 'connection', 'unload'] as const)('retires old permission reads and queued observers after %s replacement', async change => {
    const f = fixture({ plan: { active: false, pending: false } })
    const answer = Promise.withResolvers<unknown>()
    f.permissionDetails.mockReturnValueOnce(answer.promise)
    const dispose = mountPlanFeature(f.context)
    await flush()
    const projection = [...f.permissionsListeners][0]!
    const catalog = [...f.events.get('permission-presets/catalog-changed')!][0]!
    const locale = [...f.localeListeners][0]!
    const signal = f.permissionDetails.mock.calls[0]![1]!
    if (change === 'session') f.select({ ...f.selection, ref: { ...f.selection.ref, sessionId: SessionId('second') } })
    if (change === 'host') { f.select(undefined); f.hosts([], undefined) }
    if (change === 'connection') f.reconnect()
    if (change === 'unload') dispose()
    expect(signal.aborted).toBe(true)
    await flush()
    const paints = f.status.set.mock.calls.length
    const reads = f.permissionDetails.mock.calls.length
    answer.resolve({ ok: true, value: { yolo: true, specs: {} } })
    projection(); catalog()
    if (change === 'unload') locale()
    await flush()
    expect(f.status.set).toHaveBeenCalledTimes(paints)
    expect(f.permissionDetails).toHaveBeenCalledTimes(reads)
    expect(f.notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it('reads the newly selected Host rather than retaining another Host yolo value', async () => {
    const f = fixture()
    const other = fixture()
    Object.assign(other.client, { key: HostKey('other') })
    other.permissionDetails.mockResolvedValue({ ok: true, value: { yolo: true, specs: {} } })
    const dispose = mountPlanFeature(f.context)
    await flush()
    f.select({ ...other.selection, client: other.client, ref: { host: other.client.key, sessionId: SessionId('other-session') } })
    f.hosts([f.client, other.client], other.client)
    await flush()
    expect(other.permissionDetails).toHaveBeenLastCalledWith({ sessionId: 'other-session' }, expect.any(AbortSignal))
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'yolo', tone: 'warning' })
    dispose()
  })

  it('refuses readonly /plan, /mode and Shift+Tab writes without changing startup intent', async () => {
    const f = fixture({ access: 'readonly', plan: { active: false, pending: false } })
    const dispose = mountPlanFeature(f.context)
    await f.command('plan').execute('')
    await f.command('plan').execute('off')
    await f.command('plan').execute('message')
    await f.command('mode').execute('')
    f.keymapBinding().handler()
    await flush()
    expect(f.executeNative).not.toHaveBeenCalled()
    expect(f.startupPlan.set).not.toHaveBeenCalled()
    expect(f.notice.set).toHaveBeenLastCalledWith('This conversation is read-only', 'error')
    dispose()
  })
  it.each(['investigate', 'OFF', 'off extra'])('runs the actual sessionless /plan %s parser without creating or prompting a Session', async input => {
    const f = fixture({ session: false })
    const dispose = mountPlanFeature(f.context)
    const create = vi.fn(async () => wire().selected)
    const editor = submissionFixture(undefined, create)
    editor.local.list = () => [{ name: 'plan', description: f.command('plan').description }]
    editor.local.execute = async invocation => { await f.command('plan').execute(invocation.rawInput, invocation.signal); return { kind: 'success' } }
    editor.enter(`/plan ${input}`); await flush()
    expect(create).not.toHaveBeenCalled()
    expect(f.executeNative).not.toHaveBeenCalled()
    expect(f.startupPlan.set).not.toHaveBeenCalled()
    expect(editor.editor.getText()).toBe('')
    expect(editor.feedback).toEqual([{ text: 'Send a message first: /plan with a message needs a session', severity: 'error' }])
    dispose()
  })

  it.each(['plan', 'mode'] as const)('reports the actual native %s returned outcome with its reference feedback path', async command => {
    const f = fixture({ plan: { active: false, pending: false } })
    const dispose = mountPlanFeature(f.context)
    for (const kind of ['success', 'error'] as const) {
      f.executeNative.mockResolvedValueOnce({ ok: true, value: { result: { kind, text: 'native plan outcome' } } })
      await f.command(command).execute('')
      expect(f.notice.set).toHaveBeenLastCalledWith('native plan outcome', kind === 'error' ? 'error' : command === 'mode' ? 'success' : 'info')
    }
    f.executeNative.mockResolvedValueOnce({ ok: true, value: undefined })
    await f.command(command).execute('')
    expect(f.notice.set).toHaveBeenLastCalledWith(command === 'mode' ? 'mode command is unavailable: /plan' : 'plan mode is unavailable', 'error')
    dispose()
  })

  it('enables plan intent when App has not supplied a previous choice', async () => {
    const f = fixture({ session: false })
    f.clearPending()
    const dispose = mountPlanFeature(f.context)
    await f.command('mode').execute('')
    expect(f.startupPlan.pending()).toBe(true)
    dispose()
  })

  it('retires projection callbacks and queued mode keys before reading or writing state', async () => {
    const f = fixture({ plan: { active: false, pending: false } })
    const dispose = mountPlanFeature(f.context)
    const update = f.subscribeProjection.mock.calls[0]![0]
    const mode = f.command('mode')
    const plan = f.command('plan')
    const key = f.keymapBinding()
    f.detach()
    f.status.set.mockClear()
    update()
    expect(f.status.set).not.toHaveBeenCalled()
    await plan.execute('', AbortSignal.abort())
    dispose()
    await mode.execute('')
    await plan.execute('', AbortSignal.abort())
    key.handler()
    expect(f.startupPlan.set).not.toHaveBeenCalled()
    expect(f.executeNative).not.toHaveBeenCalled()
  })

  it.each(['retire', 'abort'] as const)('contains a rejected native command after %s', async reason => {
    const f = fixture({ plan: { active: false, pending: false } })
    let reject!: (error: unknown) => void
    f.executeNative.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const dispose = mountPlanFeature(f.context)
    const abort = new AbortController()
    const pending = f.command('plan').execute('', abort.signal)
    if (reason === 'retire') f.detach()
    else abort.abort()
    reject(new Error('retired native command'))
    await pending
    expect(f.notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it('preserves a string transport rejection as command feedback', async () => {
    const f = fixture({ plan: { active: false, pending: false } })
    const dispose = mountPlanFeature(f.context)
    f.executeNative.mockRejectedValueOnce('transport unavailable')
    await f.command('plan').execute('')
    expect(f.notice.set).toHaveBeenLastCalledWith('transport unavailable', 'error')
    dispose()
  })

  it('registers reference sessionless command metadata and one shared key/status owner', () => {
    const f = fixture()
    const dispose = mountPlanFeature(f.context)
    expect([...f.entries.keys()]).toEqual(['plan', 'mode'])
    expect(f.command('plan')).toMatchObject({ description: 'Enter or leave plan mode for the next session', scope: 'sessionless', input: { hint: '[off]' } })
    expect(f.command('mode')).toMatchObject({ description: 'Toggle plan mode (same as Shift+Tab)', scope: 'sessionless' })
    expect(f.command('mode').input).toBeUndefined()
    expect(f.registerKeymap).toHaveBeenCalledOnce()
    expect(f.keymapBinding()).toMatchObject({ id: 'mayfly.interaction.cycle-mode', keys: ['shift+tab'], scope: 'editor', description: 'Toggle plan mode' })
    expect(f.registerStatus).toHaveBeenCalledExactlyOnceWith({ id: 'mayfly.status.mode', priority: 2 }, null)
    const [namespace, catalog] = f.locale.register.mock.calls[0] as unknown as [string, { readonly en: Readonly<Record<string, string>>, readonly zh: Readonly<Record<string, string>> }]
    expect(namespace).toBe('remote-plan')
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog.zh).sort())
    expect(catalog.zh['Plan mode on for the next session']).toBe('下一个会话将进入计划模式')
    dispose(); dispose()
    expect(f.entries.size).toBe(0)
    expect(f.unregisterCommand).toHaveBeenCalledTimes(2)
    expect(f.unregisterKey).toHaveBeenCalledOnce()
    expect(f.status.dispose).toHaveBeenCalledOnce()
    expect(f.unsubscribeProjection).toHaveBeenCalledOnce()
  })

  it('admits /plan idempotently and /plan off explicitly through the exact native Session', async () => {
    const f = fixture({ plan: { active: true, pending: false } })
    const dispose = mountPlanFeature(f.context)
    await f.command('plan').execute('')
    await f.command('plan').execute('off')
    await f.command('plan').execute('focus on the parser')
    expect(f.executeNative.mock.calls.map(call => call[1])).toEqual(['/plan', '/plan off', '/plan focus on the parser'])
    expect(f.executeNative.mock.calls.every(call => call[0] === f.selection.ref.sessionId && call[2].length === 0 && call[3] instanceof AbortSignal)).toBe(true)
    expect(f.notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it('cycles only /mode and Shift+Tab from native active/pending facts', async () => {
    const f = fixture({ plan: { active: true, pending: false } })
    const dispose = mountPlanFeature(f.context)
    await f.command('mode').execute('')
    f.emitPlan({ active: true, pending: true })
    await f.command('mode').execute('')
    f.emitPlan({ active: false, pending: false })
    f.keymapBinding().handler()
    await vi.waitFor(() => { expect(f.executeNative).toHaveBeenCalledTimes(3) })
    expect(f.executeNative.mock.calls.map(call => call[1])).toEqual(['/plan off', '/plan', '/plan'])
    dispose()
  })

  it('stores startup selection only in the App seam and keeps repeated /plan enabled', async () => {
    const f = fixture({ session: false })
    const dispose = mountPlanFeature(f.context)
    await f.command('plan').execute('')
    await f.command('plan').execute('')
    expect(f.startupPlan.pending()).toBe(true)
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'plan…', tone: 'accent' })
    expect(f.notice.set).toHaveBeenLastCalledWith('Plan mode on for the next session', 'info')
    await f.command('mode').execute('')
    expect(f.startupPlan.pending()).toBe(false)
    expect(f.status.set).toHaveBeenLastCalledWith(null)
    f.keymapBinding().handler()
    expect(f.startupPlan.pending()).toBe(true)
    await f.command('plan').execute('off')
    expect(f.startupPlan.pending()).toBe(false)
    expect(f.notice.set).toHaveBeenLastCalledWith('Plan mode off for the next session', 'info')
    await expect(f.command('plan').execute('a task')).rejects.toThrow('Send a message first: /plan with a message needs a session')
    expect(f.executeNative).not.toHaveBeenCalled()
    dispose()
  })

  it('leaves startup admission to App preparePrompt and never races selection with an async write', async () => {
    const f = fixture({ session: false, plan: { active: false, pending: false } })
    const dispose = mountPlanFeature(f.context)
    await f.command('plan').execute('')
    f.attach(); f.fireTopology()
    expect(f.executeNative).not.toHaveBeenCalled()
    expect(f.startupPlan.pending()).toBe(true)
    f.clearPending()
    f.emitPlan({ active: true, pending: false })
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'plan', tone: 'accent' })
    dispose()
  })

  it('reports absent startup coordination and absent native projection without writing', async () => {
    const startup = fixture({ session: false })
    const context = { ...startup.context }; delete context.startupPlan
    const releaseStartup = mountPlanFeature(context)
    await startup.command('plan').execute('')
    expect(startup.notice.set).toHaveBeenLastCalledWith('plan mode is unavailable', 'error')
    releaseStartup()
    const f = fixture()
    const dispose = mountPlanFeature(f.context)
    await f.command('mode').execute('')
    expect(f.notice.set).toHaveBeenCalledWith('plan mode is unavailable', 'error')
    expect(f.executeNative).not.toHaveBeenCalled()
    dispose()
  })

  it('publishes settled/pending native plan badges and clears them on detach', () => {
    const f = fixture({ plan: { active: true, pending: false } })
    const dispose = mountPlanFeature(f.context)
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'plan', tone: 'accent' })
    f.emitPlan({ active: true, pending: true })
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'plan…', tone: 'accent' })
    f.emitPlan({ active: false, pending: false })
    expect(f.status.set).toHaveBeenLastCalledWith(null)
    f.detach()
    expect(f.status.set).toHaveBeenLastCalledWith(null)
    dispose()
  })

  it('reports native failure/unmatched admissions without replaying command result text', async () => {
    const f = fixture({ plan: { active: false, pending: false } })
    const dispose = mountPlanFeature(f.context)
    f.executeNative.mockResolvedValueOnce({ ok: false, error: { message: 'Host refused' } })
    await f.command('plan').execute('')
    expect(f.notice.set).toHaveBeenLastCalledWith('Host refused', 'error')
    f.executeNative.mockResolvedValueOnce({ ok: true, value: undefined })
    await f.command('plan').execute('')
    expect(f.notice.set).toHaveBeenLastCalledWith('plan mode is unavailable', 'error')
    f.executeNative.mockRejectedValueOnce(new Error('offline'))
    await f.command('plan').execute('')
    expect(f.notice.set).toHaveBeenLastCalledWith('offline', 'error')
    dispose()
  })

  it('fences late native failures after Host selection retirement or caller cancellation', async () => {
    const f = fixture({ plan: { active: false, pending: false } })
    let release!: (result: unknown) => void
    f.executeNative.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const dispose = mountPlanFeature(f.context)
    const pending = f.command('plan').execute('')
    f.detach()
    release({ ok: false, error: { message: 'old Host' } })
    await pending
    expect(f.notice.set).not.toHaveBeenCalled()
    f.attach()
    f.executeNative.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const abort = new AbortController()
    const cancelled = f.command('plan').execute('', abort.signal)
    abort.abort()
    release({ ok: false, error: { message: 'cancelled Host' } })
    await cancelled
    expect(f.notice.set).not.toHaveBeenCalled()
    const count = f.executeNative.mock.calls.length
    await f.command('mode').execute('', abort.signal)
    expect(f.executeNative).toHaveBeenCalledTimes(count)
    dispose()
  })

  it('ignores held commands and native completions after unload', async () => {
    const f = fixture({ plan: { active: false, pending: false } })
    let release!: (result: unknown) => void
    f.executeNative.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const dispose = mountPlanFeature(f.context)
    const command = f.command('plan')
    const pending = command.execute('')
    dispose()
    release({ ok: false, error: { message: 'unloaded' } })
    await pending
    await command.execute('')
    expect(f.executeNative).toHaveBeenCalledOnce()
    expect(f.notice.set).not.toHaveBeenCalled()
  })
})
