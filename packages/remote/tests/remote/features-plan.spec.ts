import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { mountPlanFeature } from '../../src/remote/features/plan.ts'

interface PlanProjectionState {
  readonly active: boolean
  readonly pending: boolean
}

interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint?: string }
  execute(rawInput: string): Promise<void>
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
  const executeNative = vi.fn(async (_session: unknown, _line: string, _args: unknown, _signal: AbortSignal): Promise<unknown> => ({
    ok: true,
    value: { result: { text: 'Plan mode is on' } },
  }))
  const client = {
    key: HostKey('local'),
    state: { getSnapshot: () => ({ generation: 1 }), subscribe: vi.fn(() => () => {}) },
    remote: { commands: { execute: executeNative } },
  } as unknown as HostClient
  const selection: RemoteFeatureSelection = {
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') },
    client,
    binding: { session: { projections: { faceOf: vi.fn(() => projection) } } },
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
  const context = {
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
    for (const listener of [...projectionListeners]) listener()
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
  it('registers exactly /plan and /mode, one shift+tab keymap entry, one status row, and the locale catalog', () => {
    const f = fixture()
    const dispose = mountPlanFeature(f.context)

    expect(f.registerCommand).toHaveBeenCalledTimes(2)
    expect([...f.entries.keys()]).toEqual(['plan', 'mode'])
    expect(f.command('plan').description).toBe('Enter or leave plan mode')
    expect(f.command('mode').description).toBe('Toggle plan mode (same as /plan or Shift+Tab)')
    expect(f.command('plan').input).toEqual({ hint: '[off]' })
    expect(f.command('mode').input).toEqual({ hint: '[off]' })

    expect(f.registerKeymap).toHaveBeenCalledOnce()
    expect(f.keymapBinding()).toMatchObject({
      id: 'mayfly.interaction.cycle-mode',
      keys: ['shift+tab'],
      scope: 'editor',
      description: 'Toggle plan mode',
    })
    expect(typeof f.keymapBinding().handler).toBe('function')

    expect(f.registerStatus).toHaveBeenCalledExactlyOnceWith({ id: 'mayfly.status.mode', priority: 2 }, null)

    expect(f.locale.register).toHaveBeenCalledOnce()
    const [namespace, catalog] = f.locale.register.mock.calls[0] as unknown as [
      string,
      { readonly en: Readonly<Record<string, string>>, readonly zh: Readonly<Record<string, string>> },
    ]
    expect(namespace).toBe('remote-plan')
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog.zh).sort())
    expect(catalog.zh['Plan mode on for the next session']).toBe('已为下个会话开启计划模式')

    dispose()
    expect(f.entries.size).toBe(0)
    expect(f.unregisterCommand).toHaveBeenCalledTimes(2)
    expect(f.unregisterKey).toHaveBeenCalledOnce()
    expect(f.status.dispose).toHaveBeenCalledOnce()
    expect(f.subscribeProjection).toHaveBeenCalledOnce()
    expect(f.unsubscribeProjection).toHaveBeenCalledOnce()
  })

  it('executes the Host native /plan, and /plan off when the plan is active but not pending', async () => {
    const f = fixture({ plan: { active: false, pending: false } satisfies PlanProjectionState })
    const dispose = mountPlanFeature(f.context)

    await f.command('plan').execute('')
    expect(f.executeNative).toHaveBeenCalledOnce()
    expect(f.executeNative.mock.calls[0]![0]).toEqual(SessionId('session-1'))
    expect(f.executeNative.mock.calls[0]![1]).toBe('/plan')
    expect(f.executeNative.mock.calls[0]![2]).toEqual([])
    expect(f.executeNative.mock.calls[0]![3]).toBeInstanceOf(AbortSignal)
    // The Host's own answer is the feedback, not a locally invented sentence.
    expect(f.notice.set).toHaveBeenCalledWith('Plan mode is on')

    // An active, settled plan is left by asking the Host for `/plan off`; the
    // projection's own state decides the direction.
    f.emitPlan({ active: true, pending: false } satisfies PlanProjectionState)
    f.executeNative.mockClear()
    await f.command('plan').execute('')
    // A projection publish may itself resync through the Host, so only the
    // most recent native line is this command's own decision.
    expect(f.executeNative.mock.calls.at(-1)![1]).toBe('/plan off')
    dispose()
  })

  it('forwards a plan argument verbatim and sends Shift+Tab through the same cycle path', async () => {
    const f = fixture({ plan: { active: false, pending: false } satisfies PlanProjectionState })
    const dispose = mountPlanFeature(f.context)

    await f.command('mode').execute('  focus on the parser  ')
    expect(f.executeNative).toHaveBeenCalledOnce()
    expect(f.executeNative.mock.calls[0]![1]).toBe('/plan focus on the parser')

    f.executeNative.mockClear()
    f.keymapBinding().handler()
    await vi.waitFor(() => { expect(f.executeNative).toHaveBeenCalledOnce() })
    expect(f.executeNative.mock.calls[0]![1]).toBe('/plan')
    dispose()
  })

  it('tears down idempotently, running each registration disposer once', async () => {
    const f = fixture()
    const dispose = mountPlanFeature(f.context)
    dispose()
    dispose()
    // A second teardown must not re-run registration disposers or the status row.
    expect(f.unregisterKey).toHaveBeenCalledOnce()
    expect(f.status.dispose).toHaveBeenCalledOnce()
  })

  it('sets the pending next-session flag without a Host and notices each state', async () => {
    const f = fixture({ session: false })
    const dispose = mountPlanFeature(f.context)

    await f.command('plan').execute('')
    expect(f.notice.set).toHaveBeenLastCalledWith('Plan mode on for the next session')
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'plan…', tone: 'accent' })
    expect(f.executeNative).not.toHaveBeenCalled()

    // A bare second `/plan` toggles back off, the same way Shift+Tab does; the
    // two entry points must not disagree about what "toggle" means.
    await f.command('plan').execute('')
    expect(f.notice.set).toHaveBeenLastCalledWith('Plan mode off for the next session')
    expect(f.status.set).toHaveBeenLastCalledWith(null)

    // `/plan off` stays available as the explicit direction.
    await f.command('plan').execute('off')
    expect(f.notice.set).toHaveBeenLastCalledWith('Plan mode off for the next session')
    expect(f.status.set).toHaveBeenLastCalledWith(null)

    // Text cannot be queued for a Session that does not exist; the notice says so
    // and no Host command is sent.
    await f.command('plan').execute('tighten the parser')
    expect(f.notice.set).toHaveBeenLastCalledWith('Send a message first: /plan with a message needs a session')
    expect(f.executeNative).not.toHaveBeenCalled()
    dispose()
  })

  it('applies the pending flag to the next selected session exactly once', async () => {
    const f = fixture({ session: false, plan: { active: false, pending: false } satisfies PlanProjectionState })
    const dispose = mountPlanFeature(f.context)

    await f.command('plan').execute('')
    expect(f.executeNative).not.toHaveBeenCalled()

    f.attach()
    expect(f.executeNative).toHaveBeenCalledOnce()
    expect(f.executeNative.mock.calls[0]![1]).toBe('/plan')

    // The flag is consumed, so a later re-attach does not repeat the write.
    f.fireTopology()
    expect(f.executeNative).toHaveBeenCalledOnce()
    dispose()
  })

  it('notices plan mode is unavailable when the projection exposes no state and calls no Host', async () => {
    const f = fixture({ plan: undefined })
    const dispose = mountPlanFeature(f.context)
    expect(f.status.set).toHaveBeenLastCalledWith(null)

    await f.command('plan').execute('')

    expect(f.notice.set).toHaveBeenCalledWith('plan mode is unavailable')
    expect(f.executeNative).not.toHaveBeenCalled()
    dispose()
  })

  it('publishes the plan badge while active, a pending ellipsis while pending, and null otherwise', async () => {
    const f = fixture({ plan: { active: true, pending: false } satisfies PlanProjectionState })
    const dispose = mountPlanFeature(f.context)

    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'plan', tone: 'accent' })

    f.emitPlan({ active: true, pending: true } satisfies PlanProjectionState)
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'plan…', tone: 'accent' })

    f.emitPlan({ active: false, pending: false } satisfies PlanProjectionState)
    expect(f.status.set).toHaveBeenLastCalledWith(null)

    f.emitPlan({ active: true, pending: false } satisfies PlanProjectionState)
    expect(f.status.set).toHaveBeenLastCalledWith({ kind: 'text', content: 'plan', tone: 'accent' })
    f.detach()
    expect(f.status.set).toHaveBeenLastCalledWith(null)
    dispose()
  })

  it('aborts the attach signal on the next generation and drops the stale Host answer', async () => {
    const f = fixture({ plan: { active: false, pending: false } satisfies PlanProjectionState })
    let release!: (result: unknown) => void
    f.executeNative.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const dispose = mountPlanFeature(f.context)

    const run = f.command('plan').execute('')
    const signal = f.executeNative.mock.calls[0]![3] as AbortSignal
    expect(signal.aborted).toBe(false)

    // A selection change re-attaches, which must cancel the previous generation's
    // command instead of letting its answer paint the new one.
    f.emitPlan({ active: true, pending: false } satisfies PlanProjectionState)
    f.detach()
    expect(signal.aborted).toBe(true)
    release({ ok: true, value: { result: { text: 'Plan mode is on' } } })
    await run
    expect(f.notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it('aborts the in-flight command when the feature is disposed', async () => {
    const f = fixture({ plan: { active: false, pending: false } satisfies PlanProjectionState })
    f.executeNative.mockImplementationOnce(() => new Promise(() => {}))
    const dispose = mountPlanFeature(f.context)

    void f.command('plan').execute('')
    const signal = f.executeNative.mock.calls[0]![3] as AbortSignal
    expect(signal.aborted).toBe(false)
    dispose()
    expect(signal.aborted).toBe(true)
  })
})
