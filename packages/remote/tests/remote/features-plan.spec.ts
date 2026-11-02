import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { mountPlanFeature } from '../../src/remote/features/plan.ts'

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

function fixture(options: { readonly session?: boolean, readonly plan?: unknown } = {}) {
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
  const executeNative = vi.fn(async (_line: string): Promise<unknown> => ({ ok: true, value: { matched: true } }))
  const client = {
    key: HostKey('local'),
    state: { getSnapshot: () => ({ generation: 1 }), subscribe: vi.fn(() => () => {}) },
    remote: { commands: { execute: executeNative } },
  } as unknown as HostClient
  const selection: RemoteFeatureSelection = {
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') },
    client,
    binding: { session: { command: executeNative, projections: { faceOf: vi.fn(() => projection) } } },
  } as unknown as RemoteFeatureSelection
  let selected: RemoteFeatureSelection | undefined = options.session === false ? undefined : selection
  let topology: (() => void) | undefined
  const hosts = {
    list: vi.fn((): readonly HostClient[] => [client]),
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
  let pendingPlan: boolean | undefined = false
  const startupPlan = { pending: () => pendingPlan, set: vi.fn((active: boolean) => { pendingPlan = active; topology?.() }) }
  const context = {
    startupPlan,
    ctx,
    hosts,
    notice,
    commands: { register: registerCommand },
    t: vi.fn((key: string) => key),
    subscribeLocale: vi.fn(() => () => {}),
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
    expect(f.notice.set).toHaveBeenLastCalledWith('transport unavailable')
    dispose()
  })

  it('registers reference sessionless command metadata and one shared key/status owner', () => {
    const f = fixture()
    const dispose = mountPlanFeature(f.context)
    expect([...f.entries.keys()]).toEqual(['plan', 'mode'])
    expect(f.command('plan')).toMatchObject({ description: 'Enter or leave plan mode for the next session', scope: 'sessionless', input: { hint: '[off|message]' } })
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
    expect(f.executeNative.mock.calls).toEqual([['/plan'], ['/plan off'], ['/plan focus on the parser']])
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
    expect(f.executeNative.mock.calls).toEqual([['/plan off'], ['/plan'], ['/plan']])
    dispose()
  })

  it('stores startup selection only in the App seam and keeps repeated /plan enabled', async () => {
    const f = fixture({ session: false })
    const dispose = mountPlanFeature(f.context)
    await f.command('plan').execute('')
    await f.command('plan').execute('')
    expect(f.startupPlan.pending()).toBe(true)
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'plan…', tone: 'accent' })
    expect(f.notice.set).toHaveBeenLastCalledWith('Plan mode on for the next session')
    await f.command('mode').execute('')
    expect(f.startupPlan.pending()).toBe(false)
    expect(f.status.set).toHaveBeenLastCalledWith(null)
    f.keymapBinding().handler()
    expect(f.startupPlan.pending()).toBe(true)
    await f.command('plan').execute('off')
    expect(f.startupPlan.pending()).toBe(false)
    expect(f.notice.set).toHaveBeenLastCalledWith('Plan mode off for the next session')
    await f.command('plan').execute('a task')
    expect(f.notice.set).toHaveBeenLastCalledWith('Send a message first: /plan with a message needs a session')
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
    expect(startup.notice.set).toHaveBeenLastCalledWith('plan mode is unavailable')
    releaseStartup()
    const f = fixture()
    const dispose = mountPlanFeature(f.context)
    await f.command('mode').execute('')
    expect(f.notice.set).toHaveBeenCalledWith('plan mode is unavailable')
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
    expect(f.notice.set).toHaveBeenLastCalledWith('Host refused')
    f.executeNative.mockResolvedValueOnce({ ok: true, value: { matched: false } })
    await f.command('plan').execute('')
    expect(f.notice.set).toHaveBeenLastCalledWith('plan mode is unavailable')
    f.executeNative.mockRejectedValueOnce(new Error('offline'))
    await f.command('plan').execute('')
    expect(f.notice.set).toHaveBeenLastCalledWith('offline')
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
