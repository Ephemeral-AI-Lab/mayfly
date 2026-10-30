import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { RemoteFeatureLifecycle, remoteSelectionKey } from '../../src/remote/features/lifecycle.ts'

interface HostStateSnapshot {
  readonly generation: number
}

function fixture() {
  const state: { generation: number } = { generation: 1 }
  const stateListeners = new Set<() => void>()
  const subscribeState = vi.fn((listener: () => void) => {
    stateListeners.add(listener)
    return () => { stateListeners.delete(listener) }
  })
  const client = {
    key: HostKey('local'),
    state: {
      getSnapshot: (): HostStateSnapshot => ({ generation: state.generation }),
      subscribe: subscribeState,
    },
  } as unknown as HostClient
  const selection: RemoteFeatureSelection = {
    ref: { host: HostKey('local'), sessionId: SessionId('session-1') },
    client,
    binding: {},
  } as unknown as RemoteFeatureSelection
  let topology: (() => void) | undefined
  const offTopology = vi.fn()
  const hosts = {
    list: vi.fn((): readonly HostClient[] => [client]),
    current: vi.fn((): RemoteFeatureSelection | undefined => selection),
    subscribe: vi.fn((listener: () => void) => {
      topology = listener
      return offTopology
    }),
  }
  const context = { hosts } as unknown as RemoteFeatureContext
  const changed = vi.fn()
  const lifecycle = new RemoteFeatureLifecycle(context, changed)
  /** Fire the Host topology listener once, as an attach, detach, or selection commit does. */
  const fireTopology = (): void => { topology!() }
  /** Fire every Host connection generation listener once, as a reconnect does. */
  const fireState = (): void => { for (const listener of [...stateListeners]) listener() }
  return {
    lifecycle,
    changed,
    hosts,
    client,
    selection,
    subscribeState,
    offTopology,
    fireTopology,
    fireState,
    stateListeners,
    state,
  }
}

describe('RemoteFeatureLifecycle', () => {
  it('observes topology once at construction and attaches no Host listener before start', () => {
    const f = fixture()

    expect(f.hosts.subscribe).toHaveBeenCalledOnce()
    expect(f.subscribeState).not.toHaveBeenCalled()
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.lifecycle.currentGeneration()).toBe(0)
    // Nothing owns a generation before the feature starts, so a continuation
    // captured from the construction-time generation is refused.
    expect(f.lifecycle.owns(0)).toBe(false)
    expect(f.lifecycle.selection(0)).toBeUndefined()
  })

  it('attaches every attached Host exactly once and invalidates once on start', () => {
    const f = fixture()

    f.lifecycle.start()

    expect(f.subscribeState).toHaveBeenCalledOnce()
    expect(f.changed).toHaveBeenCalledOnce()
    expect(f.changed).toHaveBeenCalledWith(1)
    expect(f.lifecycle.currentGeneration()).toBe(1)
    expect(f.lifecycle.owns(1)).toBe(true)
    expect(f.lifecycle.selection(1)).toBe(f.selection)
  })

  it('does not attach a second Host listener or bump the generation on a second start', () => {
    const f = fixture()

    f.lifecycle.start()
    f.lifecycle.start()

    expect(f.subscribeState).toHaveBeenCalledOnce()
    expect(f.changed).toHaveBeenCalledOnce()
    expect(f.lifecycle.currentGeneration()).toBe(1)
  })

  it('re-invalidates exactly once for a selection change and refuses the stale generation', () => {
    const f = fixture()
    f.lifecycle.start()

    f.fireTopology()

    expect(f.changed).toHaveBeenCalledTimes(2)
    expect(f.changed).toHaveBeenLastCalledWith(2)
    expect(f.lifecycle.currentGeneration()).toBe(2)
    // A selection change is a feature refresh, not a re-subscription: the Host
    // listener stays attached rather than double-attaching.
    expect(f.subscribeState).toHaveBeenCalledOnce()
    expect(f.lifecycle.owns(1)).toBe(false)
    expect(f.lifecycle.selection(1)).toBeUndefined()
    expect(f.lifecycle.owns(2)).toBe(true)
    expect(f.lifecycle.selection(2)).toBe(f.selection)
  })

  it('invalidates once per new Host connection generation and ignores a repeated snapshot', () => {
    const f = fixture()
    f.lifecycle.start()

    f.state.generation = 2
    f.fireState()
    expect(f.changed).toHaveBeenCalledTimes(2)
    expect(f.changed).toHaveBeenLastCalledWith(2)

    // The same generation delivered twice is one reconnection, not two.
    f.fireState()
    expect(f.changed).toHaveBeenCalledTimes(2)

    f.state.generation = 3
    f.fireState()
    expect(f.changed).toHaveBeenCalledTimes(3)
    expect(f.changed).toHaveBeenLastCalledWith(3)
    expect(f.lifecycle.owns(2)).toBe(false)
    expect(f.lifecycle.owns(3)).toBe(true)
  })

  it('detaches every listener once, is idempotent, and refuses generations after dispose', () => {
    const f = fixture()
    f.lifecycle.start()

    f.lifecycle.dispose()
    f.lifecycle.dispose()

    expect(f.offTopology).toHaveBeenCalledOnce()
    expect(f.stateListeners.size).toBe(0)
    // Teardown never invokes another feature refresh.
    expect(f.changed).toHaveBeenCalledOnce()
    expect(f.lifecycle.currentGeneration()).toBe(2)
    expect(f.lifecycle.owns(2)).toBe(false)
    expect(f.lifecycle.selection(2)).toBeUndefined()
  })

  it('ignores a topology callback and a Host generation change that land after dispose', () => {
    const f = fixture()
    f.lifecycle.start()
    f.lifecycle.dispose()

    f.fireTopology()
    f.state.generation = 9
    f.fireState()

    expect(f.changed).toHaveBeenCalledOnce()
    expect(f.subscribeState).toHaveBeenCalledOnce()
    expect(f.lifecycle.currentGeneration()).toBe(2)
  })
})

describe('remoteSelectionKey', () => {
  it('keys an absent selection as the empty string and an exact selection by Host, Session, and Client', () => {
    expect(remoteSelectionKey(undefined)).toBe('')
    const f = fixture()
    expect(remoteSelectionKey(f.selection)).toBe('local\0session-1\0local')
  })
})
