import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { HostClient, SessionRef } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import {
  RemoteCallError,
  RemoteFeatureController,
  RemoteFeatureOperation,
  remoteErrorMessage,
  remoteProperty,
  remoteStringProjection,
  remoteValue,
} from '../../src/remote/features/official.ts'

/** One successful official result, as the typed Remote catalog returns it. */
function ok<T>(value: T): { readonly ok: true, readonly value: T } {
  return { ok: true, value }
}

/** One failed official result carrying the safe Host code and message. */
function failed(code: string, message: string): { readonly ok: false, readonly error: { readonly code: string, readonly message: string } } {
  return { ok: false, error: { code, message } }
}

function fixture(options: { readonly attached?: boolean } = {}) {
  const ref: SessionRef = { host: HostKey('local'), sessionId: SessionId('session-1') }
  const client = {
    key: HostKey('local'),
    state: { getSnapshot: () => ({ generation: 1 }), subscribe: vi.fn(() => () => {}) },
    remote: {},
  } as unknown as HostClient
  let selection: RemoteFeatureSelection | undefined = { ref, client, binding: {} as RemoteFeatureSelection['binding'] }
  const hosts = {
    list: vi.fn((): readonly HostClient[] => (options.attached === false ? [] : [client])),
    current: vi.fn((): RemoteFeatureSelection | undefined => selection),
    subscribe: vi.fn(() => () => {}),
  }
  const context = { hosts } as unknown as RemoteFeatureContext
  return {
    client,
    ref,
    hosts,
    context,
    selection,
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
})

describe('RemoteFeatureController', () => {
  /** Expose the protected operation factories of the shared owner. */
  class ProbeController extends RemoteFeatureController {
    constructor(context: RemoteFeatureContext) { super(context) }
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
})
