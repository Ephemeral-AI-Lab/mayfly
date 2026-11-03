/** Generation, credential, URL, and teardown behavior of the Node HTTP/WS carrier. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import { NodeConnectionTransport } from '../../src/client/transport.ts'
import { HostTransportError } from '../../src/client/types.ts'
import { FakeSocket } from './fake-socket.ts'

function connectResponse(cookie = 'dsh=one'): Response {
  return new Response(null, { status: 302, headers: { 'set-cookie': `${cookie}; Path=/; HttpOnly` } })
}

function requestUrl(call: Parameters<RpcFetch>[0]): URL {
  return new URL(String(call))
}

describe('NodeConnectionTransport', () => {
  it('uses a mounted connect URL, shares initial authentication, and keeps tokens out of later carriers', async () => {
    const connect = Promise.withResolvers<Response>()
    const calls: Array<{ input: string | URL; init: RequestInit }> = []
    const sockets: Array<{ socket: FakeSocket; url: string; cookie: string }> = []
    const doFetch: RpcFetch = (input, init) => {
      calls.push({ input, init })
      if (requestUrl(input).pathname.endsWith('/connect')) return connect.promise
      return Promise.resolve(new Response('ok'))
    }
    const transport = new NodeConnectionTransport('https://example.test/mount?token=a%2Fb&discard=yes#hash', {
      fetch: doFetch,
      createWebSocket: (url, cookie) => {
        const socket = new FakeSocket()
        sockets.push({ socket, url, cookie })
        return socket
      },
    })
    const socket = transport.createWebSocket('wss://example.test/mount/api/remote.mux')
    expect(socket.readyState).toBe(0)
    expect(() => socket.send('early')).toThrow('not open')
    const first = transport.fetch('api/session/list', { method: 'POST', signal: null })
    const second = transport.fetch('api/workspace/list', { method: 'POST' })
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    const connected = requestUrl(calls[0]!.input)
    expect(connected.pathname).toBe('/mount/connect')
    expect(connected.searchParams.get('token')).toBe('a/b')
    expect(connected.searchParams.get('interactions')).toBe('answer')
    expect(transport.hooks.streamBaseUrl).toBe('https://example.test/mount/')

    connect.resolve(connectResponse('dsh=initial'))
    await Promise.all([first, second])
    expect(sockets).toHaveLength(1)
    expect(sockets[0]).toMatchObject({ url: 'wss://example.test/mount/api/remote.mux', cookie: 'dsh=initial' })
    expect(calls).toHaveLength(3)
    for (const call of calls.slice(1)) {
      expect(call.input.toString()).not.toContain('token=')
      expect(new Headers(call.init.headers).get('cookie')).toBe('dsh=initial')
    }
    const opened = vi.fn()
    socket.addEventListener('open', opened, { once: true })
    sockets[0]!.socket.open()
    socket.addEventListener('open', opened, { once: true })
    socket.send('frame')
    expect(opened).toHaveBeenCalledOnce()
    expect(sockets[0]!.socket.sent).toEqual(['frame'])
    const removed = vi.fn()
    const received = vi.fn()
    socket.removeEventListener('error', removed)
    socket.addEventListener('message', removed)
    socket.addEventListener('message', received)
    socket.removeEventListener('message', removed)
    sockets[0]!.socket.emit('message', { data: 'ignored' })
    socket.removeEventListener('message', received)
    socket.addEventListener('message', received, { once: true })
    sockets[0]!.socket.emit('message', { data: 'first' })
    sockets[0]!.socket.emit('message', { data: 'second' })
    expect(removed).not.toHaveBeenCalled()
    expect(received).toHaveBeenCalledTimes(2)
    await transport.detach()
  })

  it('re-authenticates every physical replacement and ignores the old socket closure', async () => {
    let generation = 0
    const sockets: FakeSocket[] = []
    const unaryCookies: Array<string | null> = []
    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: (input, init) => {
        if (requestUrl(input).pathname === '/connect') {
          generation++
          return Promise.resolve(connectResponse(`dsh=${String(generation)}`))
        }
        unaryCookies.push(new Headers(init.headers).get('cookie'))
        return Promise.resolve(new Response('ok'))
      },
      createWebSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    const first = transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    await transport.fetch('api/one', {})
    const second = transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    sockets[1]!.open()
    await vi.waitFor(() => { expect(sockets[0]!.readyState).toBe(3) })
    await transport.fetch('api/two', {})
    expect(generation).toBe(2)
    expect(unaryCookies).toEqual(['dsh=1', 'dsh=2'])
    expect(first.readyState).toBe(3)

    sockets[1]!.emit('close', {})
    await expect(transport.fetch('api/disconnected', {})).rejects.toThrow('unavailable')
    expect(generation).toBe(2)
    expect(second.readyState).toBe(3)
    await transport.detach()
  })

  it('serializes connect requests and never publishes a superseded exchange', async () => {
    const exchanges: Array<PromiseWithResolvers<Response>> = []
    const sockets: Array<{ cookie: string }> = []
    const unaryCookies: Array<string | null> = []
    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: (input, init) => {
        if (requestUrl(input).pathname === '/connect') {
          const exchange = Promise.withResolvers<Response>()
          exchanges.push(exchange)
          return exchange.promise
        }
        unaryCookies.push(new Headers(init.headers).get('cookie'))
        return Promise.resolve(new Response('ok'))
      },
      createWebSocket: (_url, cookie) => {
        sockets.push({ cookie })
        return new FakeSocket()
      },
    })
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await vi.waitFor(() => { expect(exchanges).toHaveLength(1) })
    const pendingUnary = transport.fetch('api/current', {})
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    expect(exchanges).toHaveLength(1)
    exchanges[0]!.resolve(connectResponse('dsh=old'))
    await vi.waitFor(() => { expect(exchanges).toHaveLength(2) })
    expect(sockets).toEqual([])
    exchanges[1]!.resolve(connectResponse('dsh=new'))
    await vi.waitFor(() => { expect(sockets).toEqual([{ cookie: 'dsh=new' }]) })
    await pendingUnary
    expect(unaryCookies).toEqual(['dsh=new'])
    await transport.detach()
  })

  it('rejects a unary response that arrives after its generation was replaced', async () => {
    const unary = Promise.withResolvers<Response>()
    const unaryCalls: Array<PromiseWithResolvers<Response>> = []
    const sockets: FakeSocket[] = []
    let generation = 0
    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: input => {
        if (requestUrl(input).pathname === '/connect') {
          generation++
          return Promise.resolve(connectResponse(`dsh=${String(generation)}`))
        }
        unaryCalls.push(unary)
        return unary.promise
      },
      createWebSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    const pending = transport.fetch('api/slow', {})
    await vi.waitFor(() => { expect(unaryCalls).toHaveLength(1) })
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    unary.resolve(new Response('old'))
    await expect(pending).rejects.toThrow('superseded connection')
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    await transport.detach()
  })

  it('drops a socket whose resolved credential was superseded before attachment', async () => {
    const socketFactory = vi.fn(() => new FakeSocket())
    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: input => Promise.resolve(requestUrl(input).pathname === '/connect'
        ? connectResponse()
        : new Response('ok')),
      createWebSocket: socketFactory,
    })
    await transport.fetch('api/authenticate', {})
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    const pending = transport.fetch('api/current', {})
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await pending
    await vi.waitFor(() => { expect(socketFactory).toHaveBeenCalledOnce() })
    await transport.detach()
  })

  it('closes a physical socket superseded reentrantly by its factory', async () => {
    const sockets: FakeSocket[] = []
    let transport: NodeConnectionTransport
    transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: input => Promise.resolve(requestUrl(input).pathname === '/connect'
        ? connectResponse()
        : new Response('ok')),
      createWebSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        if (sockets.length === 1) transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
        return socket
      },
    })
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    await vi.waitFor(() => { expect(sockets[0]!.readyState).toBe(3) })
    await transport.detach()
  })

  it('closes a raw socket attached after its wrapper was cancelled', async () => {
    const raw = new FakeSocket()
    let wrapper: ReturnType<NodeConnectionTransport['createWebSocket']> | undefined
    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: () => Promise.resolve(connectResponse()),
      createWebSocket: () => {
        wrapper?.close()
        return raw
      },
    })
    wrapper = transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await vi.waitFor(() => { expect(raw.readyState).toBe(3) })
    await transport.detach()
  })

  it('handles detach on both sides of a unary await', async () => {
    const afterAuth = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: input => Promise.resolve(requestUrl(input).pathname === '/connect'
        ? connectResponse()
        : new Response('ok')),
    })
    await afterAuth.fetch('api/authenticate', {})
    const authenticationContinuation = afterAuth.fetch('api/current', {})
    await afterAuth.detach()
    await expect(authenticationContinuation).rejects.toThrow('Host Client is detached')

    const response = Promise.withResolvers<Response>()
    const slow = vi.fn()
    const duringFetch = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: (input, init) => {
        if (requestUrl(input).pathname === '/connect') return Promise.resolve(connectResponse())
        slow()
        // A real fetch rejects when the caller's transport lifetime aborts; the
        // fake must honour the signal or detach's local-quiescence await waits
        // on a response the test itself resolves after detach.
        return new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          }, { once: true })
          void response.promise.then(resolve, reject)
        })
      },
      createWebSocket: () => new FakeSocket(),
    })
    duringFetch.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    const request = duringFetch.fetch('api/slow', {})
    await vi.waitFor(() => { expect(slow).toHaveBeenCalledOnce() })
    await duringFetch.detach()
    response.resolve(new Response('late'))
    await expect(request).rejects.toThrow('Host Client is detached')
  })

  it('surfaces socket factory failures and rejects missing or malformed cookies', async () => {
    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: () => Promise.resolve(connectResponse()),
      createWebSocket: () => { throw new Error('factory failed') },
    })
    const socket = transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    const failure = vi.fn()
    const closed = vi.fn()
    socket.addEventListener('error', failure)
    socket.addEventListener('close', closed)
    await vi.waitFor(() => {
      expect(failure).toHaveBeenCalledOnce()
      expect(closed).toHaveBeenCalledOnce()
      expect(socket.readyState).toBe(3)
    })
    await expect(transport.fetch('api/list', {})).rejects.toThrow('unavailable')
    socket.close()
    await transport.detach()

    for (const response of [new Response(null, { status: 302 }), new Response(null, {
      status: 302,
      headers: { 'set-cookie': 'not-a-cookie' },
    })]) {
      const invalid = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
        fetch: () => Promise.resolve(response),
      })
      await expect(invalid.fetch('api/list', {})).rejects.toThrow('omitted a valid API Peer cookie')
      await invalid.detach()
    }
  })

  it('aborts an in-flight authentication on detach', async () => {
    const started = vi.fn()
    const socketFactory = vi.fn(() => new FakeSocket())
    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=secret', {
      fetch: (_input, init) => {
        started()
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
      },
      createWebSocket: socketFactory,
    })
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await vi.waitFor(() => { expect(started).toHaveBeenCalledOnce() })
    await transport.detach()
    expect(socketFactory).not.toHaveBeenCalled()
  })

  it('detaches during authentication without allowing a late socket or leaking the token', async () => {
    const exchange = Promise.withResolvers<Response>()
    const socketFactory = vi.fn(() => new FakeSocket())
    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=do-not-print', {
      fetch: () => exchange.promise,
      createWebSocket: socketFactory,
    })
    const socket = transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    const closing = transport.detach()
    expect(transport.detach()).toBe(closing)
    exchange.resolve(connectResponse())
    await closing
    expect(socket.readyState).toBe(3)
    expect(socketFactory).not.toHaveBeenCalled()
    await expect(transport.fetch('api/list', {})).rejects.toThrow('Host Client is detached')
    expect(() => transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')).toThrow('Host Client is detached')
    try {
      await transport.fetch('api/list', {})
    } catch (error) {
      expect(String(error)).not.toContain('do-not-print')
    }
  })

  it('keeps two Host credential jars and teardown lifetimes independent', async () => {
    const sockets = new Map<string, FakeSocket[]>()
    const makeTransport = (host: string): NodeConnectionTransport => {
      const owned: FakeSocket[] = []
      sockets.set(host, owned)
      return new NodeConnectionTransport(`http://${host}/?token=${host}-token`, {
        fetch: input => Promise.resolve(requestUrl(input).pathname === '/connect'
          ? connectResponse(`dsh=${host}`)
          : new Response(host)),
        createWebSocket: () => {
          const socket = new FakeSocket()
          owned.push(socket)
          return socket
        },
      })
    }
    const first = makeTransport('127.0.0.1')
    const second = makeTransport('127.0.0.2')
    first.createWebSocket('ws://127.0.0.1/api/remote.mux')
    second.createWebSocket('ws://127.0.0.2/api/remote.mux')
    await vi.waitFor(() => {
      expect(sockets.get('127.0.0.1')).toHaveLength(1)
      expect(sockets.get('127.0.0.2')).toHaveLength(1)
    })
    await first.detach()
    await expect(second.fetch('api/list', {})).resolves.toBeInstanceOf(Response)
    expect(sockets.get('127.0.0.2')?.[0]?.readyState).toBe(0)
    await second.detach()
  })

  it('validates startup inputs and sanitizes authentication failures', async () => {
    for (const url of [
      'http://127.0.0.1:3080/',
      'http://127.0.0.1:3080/?token=one&token=two',
      'ftp://127.0.0.1:3080/?token=secret',
      'http://user:pass@127.0.0.1:3080/?token=secret',
      'http://example.test/?token=secret',
    ]) {
      expect(() => new NodeConnectionTransport(url)).toThrow()
    }
    const rejected = new NodeConnectionTransport('http://127.0.0.1:3080/?token=very-secret', {
      fetch: input => Promise.reject(new Error(`failed ${String(input)}`)),
    })
    const failure = await rejected.fetch('api/list', {}).catch((error: unknown) => error)
    expect(String(failure)).toContain('Host authentication request failed')
    expect(String(failure)).not.toContain('very-secret')
    await rejected.detach()

    const unauthorized = new NodeConnectionTransport('http://127.0.0.1:3080/connect?token=very-secret', {
      fetch: () => Promise.resolve(new Response('very-secret', { status: 401 })),
    })
    const status = await unauthorized.fetch('api/list', {}).catch((error: unknown) => error)
    expect(String(status)).toContain('Host startup token was rejected')
    expect(String(status)).not.toContain('very-secret')
    await unauthorized.detach()

    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/mount/?token=secret')
    await expect(transport.fetch('https://other.test/api', {})).rejects.toThrow('outside the configured origin or mount')
    await expect(transport.fetch('../outside', {})).rejects.toThrow('outside the configured origin or mount')
    await transport.detach()
  })
})

describe('Node transport dispatch and recovery guarantees', () => {
  const transports: NodeConnectionTransport[] = []
  afterEach(async () => { for (const transport of transports.splice(0)) await transport.detach(); vi.restoreAllMocks() })
  const make = (options: ConstructorParameters<typeof NodeConnectionTransport>[1]) => {
    const transport = new NodeConnectionTransport('http://127.0.0.1:3080/?token=never-log-startup-token', options)
    transports.push(transport)
    return transport
  }

  it('replays a string unary envelope once after a definite pre-dispatch 401, replacing its credential and retiring the old socket', async () => {
    let connects = 0
    const cookies: string[] = []
    const raw = new FakeSocket()
    const transport = make({
      fetch: async (input, init) => {
        if (requestUrl(input).pathname === '/connect') return connectResponse(`dsh=${String(++connects)}`)
        cookies.push(new Headers(init.headers).get('cookie')!)
        return new Response('native result', { status: cookies.length === 1 ? 401 : 200 })
      },
      createWebSocket: () => raw,
    })
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await vi.waitFor(() => { expect(connects).toBe(1) })
    const result = await transport.fetch('api/remote', { method: 'POST', body: '{"rpcId":"one"}' })
    expect(await result.text()).toBe('native result')
    expect(cookies).toEqual(['dsh=1', 'dsh=2'])
    expect(connects).toBe(2)
    await vi.waitFor(() => { expect(raw.readyState).toBe(3) })
    expect(transport.state.getSnapshot().generation).toBe(1)
  })

  it('bounds consecutive pre-dispatch unary 401s to one replay even with no request body', async () => {
    let connects = 0, calls = 0
    const transport = make({ fetch: async input => {
      if (requestUrl(input).pathname === '/connect') return connectResponse(`dsh=${String(++connects)}`)
      calls++
      return new Response('unauthorized body', { status: 401 })
    } })
    expect((await transport.fetch('api/remote', {})).status).toBe(401)
    expect(calls).toBe(2)
    expect(connects).toBe(2)
  })

  it.each(['upload', 'one-shot-unary'] as const)('never replays a %s body after a pre-dispatch 401', async kind => {
    let connects = 0, calls = 0
    const transport = make({ fetch: async input => {
      if (requestUrl(input).pathname === '/connect') return connectResponse(`dsh=${String(++connects)}`)
      calls++
      return new Response('not dispatched', { status: 401 })
    } })
    const result = kind === 'upload'
      ? await transport.upload('api/upload', { method: 'POST', body: 'a one-shot upload' })
      : await transport.fetch('api/remote', { method: 'POST', body: new Uint8Array([1, 2, 3]) })
    expect(result.status).toBe(401)
    expect(connects).toBe(1)
    expect(calls).toBe(1)
  })

  it('refuses untrusted Host authorities without leaking native response bytes', async () => {
    const transport = make({ fetch: async input => requestUrl(input).pathname === '/connect'
      ? connectResponse()
      : new Response('native-secret-never-surface', { status: 403 }) })
    const failure = await transport.fetch('api/remote', {}).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'forbidden' })
    expect(String(failure)).toContain('trustedHosts')
    expect(String(failure)).not.toContain('native-secret')
  })

  it.each(['unary', 'upload'] as const)('reports an unknown %s outcome without replaying a failed admitted request', async kind => {
    let calls = 0
    const transport = make({ fetch: async input => {
      if (requestUrl(input).pathname === '/connect') return connectResponse()
      calls++
      throw new Error('unsafe native transport payload never-log-startup-token')
    } })
    const request = kind === 'unary' ? transport.fetch('api/remote', {}) : transport.upload('api/upload', {})
    const failure = await request.catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'unavailable' })
    expect(String(failure)).toContain(kind === 'unary' ? 'business outcome is unknown' : 'storage outcome is unknown')
    expect(String(failure)).not.toContain('never-log-startup-token')
    expect(calls).toBe(1)
  })

  it('keeps an admitted native carrier error and classifies a caller abort independently', async () => {
    const refused = new HostTransportError('forbidden', 'safe native failure')
    const transport = make({ fetch: async input => {
      if (requestUrl(input).pathname === '/connect') return connectResponse()
      throw refused
    } })
    await expect(transport.fetch('api/remote', {})).rejects.toBe(refused)
    const abort = new AbortController()
    abort.abort()
    await expect(transport.fetch('api/remote', { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports a late rejected response as superseded after explicit reconnect and never replays it', async () => {
    const response = Promise.withResolvers<Response>()
    let calls = 0, sockets = 0
    const transport = make({
      fetch: async input => {
        if (requestUrl(input).pathname === '/connect') return connectResponse()
        calls++
        return await response.promise
      },
      createWebSocket: () => { sockets++; return new FakeSocket() },
    })
    const pending = transport.fetch('api/remote', {})
    await vi.waitFor(() => { expect(calls).toBe(1) })
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    await vi.waitFor(() => { expect(sockets).toBe(1) })
    transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    response.reject(new Error('old-generation failure'))
    await expect(pending).rejects.toMatchObject({ code: 'superseded' })
    expect(calls).toBe(1)
  })

  it('waits for a late resolved admitted request during detach and rejects its old result', async () => {
    const response = Promise.withResolvers<Response>()
    let calls = 0
    const transport = make({ fetch: async input => {
      if (requestUrl(input).pathname === '/connect') return connectResponse()
      calls++
      return await response.promise
    } })
    const pending = transport.fetch('api/remote', {})
    await vi.waitFor(() => { expect(calls).toBe(1) })
    const closing = transport.detach()
    response.resolve(new Response('late admitted result'))
    await expect(pending).rejects.toMatchObject({ code: 'detached' })
    await closing
  })

  it('handles an already closed native socket and contains subscriber exceptions without blocking another listener', async () => {
    const closed = new FakeSocket()
    closed.readyState = 3
    const transport = make({ fetch: async () => connectResponse(), createWebSocket: () => closed })
    const socket = transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    const observed = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    socket.addEventListener('close', () => { throw new Error('listener payload never-log-startup-token') })
    socket.addEventListener('close', observed)
    await vi.waitFor(() => { expect(observed).toHaveBeenCalledOnce() })
    expect(error).toHaveBeenCalledExactlyOnceWith('Host WebSocket listener failed')
    expect(transport.state.getSnapshot().status).toBe('disconnected')
  })

  it('forwards safe socket errors and stops automatic supervision after rejected startup authentication', async () => {
    const raw = new FakeSocket()
    const transport = make({ fetch: async () => connectResponse(), createWebSocket: () => raw })
    const socket = transport.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')
    const error = vi.fn()
    socket.addEventListener('error', error)
    await vi.waitFor(() => { expect(raw.readyState).toBe(0) })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    raw.emit('error', {})
    expect(error).toHaveBeenCalledWith({ error: expect.objectContaining({ code: 'unavailable' }) })
    const denied = make({ fetch: async () => new Response(null, { status: 401 }) })
    const terminal = vi.fn()
    const off = denied.onTerminal(terminal)
    await expect(denied.fetch('api/remote', {})).rejects.toMatchObject({ code: 'authentication-required' })
    expect(terminal).toHaveBeenCalledOnce()
    expect(() => denied.createWebSocket('ws://127.0.0.1:3080/api/remote.mux')).toThrow('startup token was rejected')
    const alreadyTerminal = vi.fn()
    denied.onTerminal(alreadyTerminal)()
    expect(alreadyTerminal).toHaveBeenCalledOnce()
    off()
  })
})
