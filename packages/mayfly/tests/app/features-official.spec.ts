import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient, SessionRef } from '../../src/client/types.ts'
import type { RemoteFeatureContext as RemoteFeatureContextLike, RemoteFeatureSelection } from '../../src/app/features/contracts.ts'
import {
  RemoteCallError,
  RemoteFeatureController,
  RemoteFeatureOperation,
  remoteErrorMessage,
  remoteProperty,
  remoteStringProjection,
  remoteValue,
} from '../../src/app/features/official.ts'

/** One successful official result, as the typed Remote catalog returns it. */
function ok<T>(value: T): { readonly ok: true, readonly value: T } {
  return { ok: true, value }
}

/** One failed official result carrying the safe Host code and message. */
/** A failed RemoteResult; the loose cast mirrors what the wire sends. */
function failed(code: string, message: string): Promise<never> {
  return Promise.resolve({ ok: false, error: { code, message } } as never)
}

function fixture(options: { readonly attached?: boolean } = {}) {
  const ref: SessionRef = { host: HostKey('local'), sessionId: SessionId('session-1') }
  let generation = 1
  const connectionListeners = new Set<() => void>()
  const topologyListeners = new Set<() => void>()
  const offConnection = vi.fn()
  const client = {
    key: HostKey('local'),
    state: {
      getSnapshot: () => ({ generation }),
      subscribe: vi.fn((listener: () => void) => {
        connectionListeners.add(listener)
        return () => { connectionListeners.delete(listener); offConnection() }
      }),
    },
    remote: {},
  } as unknown as HostClient
  let active = client
  let selection: RemoteFeatureSelection | undefined = { ref, client, binding: {} as RemoteFeatureSelection['binding'] }
  const hosts = {
    list: vi.fn((): readonly HostClient[] => (options.attached === false ? [] : [client])),
    current: vi.fn((): RemoteFeatureSelection | undefined => selection),
    active: vi.fn(() => active),
    subscribe: vi.fn((listener: () => void) => {
      topologyListeners.add(listener)
      return () => { topologyListeners.delete(listener) }
    }),
  }
  const context = { hosts } as unknown as RemoteFeatureContextLike
  return {
    client,
    ref,
    hosts,
    context,
    selection,
    offConnection,
    connectionListeners,
    topology: (): void => { for (const listener of topologyListeners) listener() },
    reconnect: (): void => { generation += 1; for (const listener of connectionListeners) listener() },
    activate: (next: HostClient): void => { active = next },
    replaceBinding: (): void => {
      selection = { ref, client, binding: {} as RemoteFeatureSelection['binding'] }
    },
    clearSelection: (): void => { selection = undefined },
  }
}

describe('remoteValue', () => {
  it('resolves the value of a successful result without wrapping it', async () => {
    const value = { servers: [], orphanCount: 0 }
    await expect(remoteValue(Promise.resolve(ok(value)))).resolves.toBe(value)
  })

  it('throws a RemoteCallError that keeps the Host code and message', async () => {
    const failure = remoteValue(Promise.resolve(failed('mayflyHost/session-stale', 'Host session is stale')))

    await expect(failure).rejects.toBeInstanceOf(RemoteCallError)
    const error = (await failure.catch((reason: unknown) => reason)) as RemoteCallError
    expect(error.name).toBe('RemoteCallError')
    expect(error.code).toBe('mayflyHost/session-stale')
    expect(error.message).toBe('Host session is stale')
  })

  it('passes a message through verbatim instead of substituting a client-side one', async () => {
    const message = 'mcpCatalog failed\nretry after reconnect'
    const error = (await remoteValue(Promise.resolve(failed('unavailable', message))).catch((reason: unknown) => reason)) as RemoteCallError

    expect(error.message).toBe(message)
    expect(error.message).not.toContain('Remote')
  })

  it('propagates a transport rejection unchanged rather than rewrapping it', async () => {
    const transport = new Error('socket closed')
    await expect(remoteValue(Promise.reject(transport))).rejects.toBe(transport)
  })
})

describe('remoteErrorMessage', () => {
  it('uses the caller fallback when a native diagnostic is empty', () => {
    expect(remoteErrorMessage(new Error('   '), [], 'Host unavailable')).toBe('Host unavailable')
  })

  it('returns the message of a real Error', () => {
    expect(remoteErrorMessage(new Error('Host offline'))).toBe('Host offline')
  })

  it('stringifies a non-Error rejection instead of dropping it', () => {
    expect(remoteErrorMessage('socket closed')).toBe('socket closed')
    expect(remoteErrorMessage(503)).toBe('503')
    expect(remoteErrorMessage(undefined)).toBe('undefined')
  })

  it('redacts every supplied secret, including repeated occurrences', () => {
    const message = 'token abc123 rejected; abc123 must not leak'
    expect(remoteErrorMessage(new Error(message), ['abc123'])).toBe('token [redacted] rejected; [redacted] must not leak')
  })

  it('redacts several distinct secrets and leaves unrelated text alone', () => {
    const message = 'auth abc and key xyz'
    expect(remoteErrorMessage(message, ['abc', 'xyz'])).toBe('auth [redacted] and key [redacted]')
  })

  it('ignores an empty secret so it cannot shred the message', () => {
    // `replaceAll('')` inserts the replacement between every character; an
    // absent credential must be a no-op, not a rewrite of the whole message.
    expect(remoteErrorMessage('host offline', [''])).toBe('host offline')
  })
})

describe('remoteProperty and remoteStringProjection', () => {
  it('reads a present string projection as-is', () => {
    expect(remoteProperty({ serverName: 'alpha' }, 'serverName')).toBe('alpha')
    expect(remoteStringProjection({ serverName: 'alpha' }, 'serverName')).toBe('alpha')
  })

  it('keeps an absent projection absent instead of fabricating an empty string', () => {
    expect(remoteProperty({}, 'connection')).toBeUndefined()
    expect(remoteStringProjection({}, 'connection')).toBeUndefined()
    expect(remoteProperty({ connection: undefined }, 'connection')).toBeUndefined()
    expect(remoteStringProjection({ connection: undefined }, 'connection')).toBeUndefined()
  })

  it('rejects a malformed value rather than coercing it', () => {
    expect(remoteStringProjection({ count: 3 }, 'count')).toBeUndefined()
    expect(remoteStringProjection({ count: null }, 'count')).toBeUndefined()
    // A coercion would surface '' here; the projection must stay absent.
    expect(remoteStringProjection({ count: null }, 'count')).not.toBe('')
  })

  it('reads no property from a null, undefined, or primitive boundary value', () => {
    expect(remoteProperty(null, 'x')).toBeUndefined()
    expect(remoteProperty(undefined, 'x')).toBeUndefined()
    expect(remoteProperty('alpha', 'length')).toBeUndefined()
    expect(remoteStringProjection(null, 'x')).toBeUndefined()
  })
})

describe('RemoteFeatureOperation', () => {
  it('rejects stale or displayed-Session writes through a Host-default operation', () => {
    const f = fixture()
    const hostOperation = new RemoteFeatureOperation(f.context, f.client)
    expect(() => hostOperation.assertWritable()).toThrow('Session selection changed')
    f.clearSelection()
    expect(() => hostOperation.assertWritable()).not.toThrow()
    hostOperation.dispose()
    expect(() => hostOperation.assertWritable()).toThrow('Session selection changed')
  })
  it('stays valid only while the exact selection and binding remain current', () => {
    const { context, client, ref, selection, replaceBinding, clearSelection } = fixture()
    const operation = new RemoteFeatureOperation(context, client, selection!)

    expect(operation.valid()).toBe(true)
    clearSelection()
    expect(operation.valid()).toBe(false)

    // A re-published selection with the same Host/Session but a new binding belongs to a new turn.
    const rebound = new RemoteFeatureOperation(context, client, { ...selection!, binding: {} as RemoteFeatureSelection['binding'] })
    replaceBinding()
    expect(rebound.valid()).toBe(false)
    expect(rebound.client).toBe(client)
    expect(rebound.selection?.ref).toEqual(ref)
  })

  it('drops a host-scoped operation once its client is detached', () => {
    const { context, client } = fixture({ attached: false })
    const operation = new RemoteFeatureOperation(context, client)
    expect(operation.valid()).toBe(false)
  })

  it('disposes cleanups once, newest first, and runs a late cleanup immediately', () => {
    const { context, client } = fixture()
    const order: string[] = []
    const operation = new RemoteFeatureOperation(context, client)
    operation.onDispose(() => order.push('first'))
    operation.onDispose(() => order.push('second'))

    operation.dispose()
    operation.dispose()
    expect(order).toEqual(['second', 'first'])

    // Registering after teardown must not retain a listener for a dead operation.
    operation.onDispose(() => order.push('late'))
    expect(order).toEqual(['second', 'first', 'late'])
    expect(operation.valid()).toBe(false)
    expect(operation.signal.aborted).toBe(true)
  })

  it('aborts its own signal when the parent operation is replaced', () => {
    const { context, client } = fixture()
    const parent = new AbortController()
    const operation = new RemoteFeatureOperation(context, client, undefined, parent.signal)

    expect(operation.signal.aborted).toBe(false)
    parent.abort()
    expect(operation.signal.aborted).toBe(true)
    expect(operation.valid()).toBe(false)
  })

  it('releases operation resources immediately when its parent aborts and handles pre-aborted parents', () => {
    const { context, client } = fixture()
    const parent = new AbortController()
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    const cleanup = vi.fn()
    const operation = new RemoteFeatureOperation(context, client, undefined, parent.signal)
    operation.onDispose(cleanup)
    parent.abort()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    const preAborted = new RemoteFeatureOperation(context, client, undefined, parent.signal)
    const lateCleanup = vi.fn()
    preAborted.onDispose(lateCleanup)
    expect(lateCleanup).toHaveBeenCalledOnce()
    expect(preAborted.valid()).toBe(false)
  })

  it('invalidates a Host operation after active Host change or same-object reconnect', () => {
    const f = fixture()
    f.clearSelection()
    const operation = new RemoteFeatureOperation(f.context, f.client)
    f.activate({ key: HostKey('other') } as HostClient)
    expect(operation.valid()).toBe(false)
    f.activate(f.client)
    const next = new RemoteFeatureOperation(f.context, f.client)
    f.reconnect()
    expect(next.valid()).toBe(false)
  })
})

describe('RemoteFeatureController', () => {
  /** Expose the protected operation factories of the shared owner. */
  class ProbeController extends RemoteFeatureController {
    constructor(context: RemoteFeatureContextLike) { super(context) }
    host(client: HostClient): RemoteFeatureOperation | undefined { return this.hostOperation(client) }
    session(selection: RemoteFeatureSelection): RemoteFeatureOperation | undefined { return this.sessionOperation(selection) }
    invalidate(client: HostClient): void { this.invalidateHost(client) }
  }

  it('refuses to capture a client that is not attached', () => {
    const attached = fixture()
    const detached = fixture({ attached: false })
    const controller = new ProbeController(attached.context)

    expect(controller.host(detached.client)).toBeUndefined()
    expect(controller.host(attached.client)).toBeDefined()
    expect(controller.session(attached.selection!)).toBeDefined()
  })

  it('does not capture a session for a client outside the attached set', () => {
    const attached = fixture()
    const detached = fixture({ attached: false })
    const controller = new ProbeController(attached.context)
    const foreignSelection = { ...detached.selection!, client: detached.client }

    expect(controller.session(foreignSelection)).toBeUndefined()
  })

  it('disposes every owned operation on teardown and refuses new ones', () => {
    const { context, client, selection } = fixture()
    const controller = new ProbeController(context)
    const host = controller.host(client)!
    const session = controller.session(selection!)!

    controller.dispose()
    expect(host.valid()).toBe(false)
    expect(session.valid()).toBe(false)
    expect(host.signal.aborted).toBe(true)
    expect(controller.host(client)).toBeUndefined()
    expect(controller.session(selection!)).toBeUndefined()
  })

  it('ignores a topology callback already queued when its feature was unloaded', () => {
    const f = fixture()
    const controller = new ProbeController(f.context)
    const callback = f.hosts.subscribe.mock.calls[0]![0]
    controller.dispose()
    callback()
    expect(f.connectionListeners.size).toBe(0)
    expect(f.client.state.subscribe).toHaveBeenCalledOnce()
  })

  it('keeps an exact operation during an unrelated topology notification', () => {
    const f = fixture()
    const controller = new ProbeController(f.context)
    const operation = controller.session(f.selection!)!
    f.topology()
    expect(operation.valid()).toBe(true)
    expect(operation.signal.aborted).toBe(false)
    controller.dispose()
  })

  it('disposes only the operations rooted at a detached client', () => {
    const { context, client } = fixture()
    const other = { key: HostKey('remote'), state: { getSnapshot: () => ({ generation: 1 }), subscribe: vi.fn(() => () => {}) }, remote: {} } as unknown as HostClient
    const hosts = context.hosts as unknown as { list: () => readonly HostClient[] }
    hosts.list = () => [client, other]
    const controller = new ProbeController(context)
    const first = controller.host(client)!
    const second = controller.host(other)!

    controller.invalidate(client)
    expect(first.valid()).toBe(false)
    expect(second.valid()).toBe(true)
  })

  it('retires exact operations and listeners on reconnect, active Host change, detach, and teardown', () => {
    const f = fixture()
    f.clearSelection()
    const controller = new ProbeController(f.context)
    const beforeReconnect = controller.host(f.client)!
    const cleanup = vi.fn()
    beforeReconnect.onDispose(cleanup)
    f.reconnect()
    expect(beforeReconnect.signal.aborted).toBe(true)
    expect(cleanup).toHaveBeenCalledOnce()
    const beforeSwitch = controller.host(f.client)!
    f.activate({ key: HostKey('other') } as HostClient)
    f.topology()
    expect(beforeSwitch.signal.aborted).toBe(true)
    f.hosts.list.mockReturnValue([])
    f.topology()
    expect(f.offConnection).toHaveBeenCalledOnce()
    expect(f.connectionListeners.size).toBe(0)
    f.hosts.list.mockReturnValue([f.client])
    f.topology()
    expect(f.connectionListeners.size).toBe(1)
    controller.dispose()
    controller.dispose()
    expect(f.offConnection).toHaveBeenCalledTimes(2)
    expect(f.connectionListeners.size).toBe(0)
  })

  it('never throws an empty message when the Host answers with a code only', async () => {
    // A blank notice tells the user nothing; the code stands in for the text.
    await expect(remoteValue(Promise.resolve({ ok: false, error: { code: 'rate-limited', message: '   ' } } as never)))
      .rejects.toThrow('rate-limited')
  })

  it('renders a multi-line Host message as one bounded line', () => {
    const collapsed = remoteErrorMessage(new Error('line one\nline two\r\n  line three'))
    expect(collapsed).not.toContain('\n')
    expect(collapsed).toContain('line one')
    expect(collapsed).toContain('line three')
    // An over-long diagnostic is cut rather than allowed to fill the frame.
    expect(remoteErrorMessage(new Error('x'.repeat(5_000))).length).toBeLessThanOrEqual(2_000)
  })

  it('reads a message off a plain wire error object instead of stringifying it', () => {
    // The capability probe rejects with the wire shape; printing it with String()
    // would render '[object Object]'.
    expect(remoteErrorMessage({ code: 'denied', message: 'not allowed here' })).toBe('not allowed here')
  })
})
