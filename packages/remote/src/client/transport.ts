/**
 * Token-to-cookie authentication and generation-safe HTTP/WebSocket transport
 * for one remote dsh Host.
 * @module @ephemeral-ai/mayfly/client/transport
 */

import WebSocket from 'ws'
import type {
  ClientTransportHooks,
  ConnectionWebSocket,
  RpcFetch,
} from '@deepseek-ai/dsh-client-connection/client'

interface ConnectionWebSocketEventMap {
  readonly open: object
  readonly error: object
  readonly close: object
  readonly message: { readonly data: unknown }
}

/** Authenticated Node socket construction; the cookie stays out of the URL. */
export type NodeWebSocketFactory = (url: string, cookie: string) => ConnectionWebSocket

/** Instance-local carriers, replaceable by focused transport tests. */
export interface NodeConnectionTransportOptions {
  readonly fetch?: RpcFetch
  readonly createWebSocket?: NodeWebSocketFactory
}

type SocketEvent = keyof ConnectionWebSocketEventMap
type SocketListener<Event extends SocketEvent> = (event: ConnectionWebSocketEventMap[Event]) => void

interface ListenerRecord {
  readonly listener: SocketListener<SocketEvent>
  readonly once: boolean
}

class SupersededConnectionError extends Error {}

const DETACHED_MESSAGE = 'Host Client is detached'
const UNAVAILABLE_MESSAGE = 'Host connection is unavailable until its WebSocket reconnects'

/** A socket whose physical construction waits for its generation's cookie exchange. */
class AuthenticatedWebSocket implements ConnectionWebSocket {
  private socket: ConnectionWebSocket | undefined
  private readonly listeners = new Map<SocketEvent, Set<ListenerRecord>>()
  private readonly closed = Promise.withResolvers<void>()
  private closeRequested = false
  private terminated = false

  constructor(private readonly lost: () => void) {}

  get readyState(): number {
    if (this.socket !== undefined) return this.socket.readyState
    return this.closeRequested ? 3 : 0
  }

  get done(): Promise<void> {
    return this.closed.promise
  }

  send(data: string): void {
    if (this.socket?.readyState !== 1 || this.closeRequested) throw new Error('Host WebSocket is not open')
    this.socket.send(data)
  }

  close(code?: number, reason?: string): void {
    if (this.closeRequested) return
    this.closeRequested = true
    if (this.socket !== undefined) {
      this.socket.close(code, reason)
      return
    }
    this.terminated = true
    this.lost()
    queueMicrotask(() => { this.finishClose() })
  }

  addEventListener<Event extends SocketEvent>(
    event: Event,
    listener: SocketListener<Event>,
    options?: { readonly once?: boolean },
  ): void {
    const records = this.listeners.get(event) ?? new Set<ListenerRecord>()
    records.add({ listener: listener as SocketListener<SocketEvent>, once: options?.once === true })
    this.listeners.set(event, records)
  }

  removeEventListener<Event extends SocketEvent>(event: Event, listener: SocketListener<Event>): void {
    const records = this.listeners.get(event)
    if (records === undefined) return
    for (const record of records) {
      if (record.listener === listener) records.delete(record)
    }
  }

  attach(socket: ConnectionWebSocket): void {
    this.socket = socket
    for (const event of ['open', 'error', 'message'] as const) {
      socket.addEventListener(event, value => { this.dispatch(event, value) })
    }
    socket.addEventListener('close', (event) => {
      this.terminated = true
      this.lost()
      this.dispatch('close', event)
      this.finishClose()
    })
    if (this.closeRequested) socket.close(1000, 'Client detached')
  }

  fail(error: unknown): void {
    if (this.terminated) return
    this.terminated = true
    this.dispatch('error', { error })
    this.closeRequested = true
    this.lost()
    this.dispatch('close', {})
    this.finishClose()
  }

  private finishClose(): void {
    this.closed.resolve()
    this.listeners.clear()
  }

  private dispatch<Event extends SocketEvent>(event: Event, value: ConnectionWebSocketEventMap[Event]): void {
    const records = this.listeners.get(event)
    if (records === undefined) return
    for (const record of records) {
      if (record.once) records.delete(record)
      record.listener(value)
    }
  }
}

/**
 * Own one Host's in-memory cookie and physical socket generation. Every
 * replacement socket exchanges the launch token again; stale exchanges and
 * stale socket closures cannot publish or clear a newer credential.
 */
export class NodeConnectionTransport {
  readonly hooks: ClientTransportHooks

  private readonly baseUrl: URL
  private readonly connectUrl: URL
  private readonly doFetch: RpcFetch
  private readonly socketFactory: NodeWebSocketFactory
  private readonly lifetime = new AbortController()
  private readonly authentications = new Map<number, Promise<string>>()
  private authenticationTail: Promise<void> = Promise.resolve()
  private activeSocket: AuthenticatedWebSocket | undefined
  private generation = 0
  private physicalAttempted = false
  private acceptingRequests = true
  private detached = false
  private closing: Promise<void> | undefined

  constructor(startupUrl: string, options: NodeConnectionTransportOptions = {}) {
    const startup = new URL(startupUrl)
    if (startup.protocol !== 'http:' && startup.protocol !== 'https:') {
      throw new Error('Host startup URL must use HTTP or HTTPS')
    }
    if (startup.username !== '' || startup.password !== '') throw new Error('Host startup URL must not contain credentials')
    const tokens = startup.searchParams.getAll('token')
    const token = tokens[0]
    if (tokens.length !== 1 || token === undefined || token === '') {
      throw new Error('Host startup URL must contain exactly one token')
    }
    this.baseUrl = new URL(startup.href)
    this.baseUrl.search = ''
    this.baseUrl.hash = ''
    if (this.baseUrl.pathname.endsWith('/connect')) {
      this.baseUrl.pathname = this.baseUrl.pathname.slice(0, -'/connect'.length)
    }
    if (!this.baseUrl.pathname.endsWith('/')) this.baseUrl.pathname += '/'
    this.connectUrl = new URL('connect', this.baseUrl)
    this.connectUrl.searchParams.set('token', token)
    this.connectUrl.searchParams.set('interactions', 'answer')
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.socketFactory = options.createWebSocket ?? ((url, cookie) => new WebSocket(url, { headers: { cookie } }))
    this.hooks = {
      streamBaseUrl: this.baseUrl.href,
      fetch: (input, init) => this.fetch(input, init),
      createWebSocket: url => this.createWebSocket(url),
    }
  }

  /** Send one unary request with the current generation's in-memory cookie. */
  async fetch(input: string | URL, init: RequestInit): Promise<Response> {
    const target = this.resolve(input)
    while (true) {
      const generation = this.generation
      this.assertAvailable()
      let cookie: string
      try {
        cookie = await this.authenticate(generation)
      } catch (error) {
        if (error instanceof SupersededConnectionError && !this.detached && generation !== this.generation) continue
        throw error
      }
      if (this.detached) throw new Error(DETACHED_MESSAGE)
      if (generation !== this.generation || !this.acceptingRequests) continue
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      const signal = init.signal == null
        ? this.lifetime.signal
        : AbortSignal.any([init.signal, this.lifetime.signal])
      const response = await this.doFetch(target, { ...init, headers, signal })
      if (this.detached) throw new Error(DETACHED_MESSAGE)
      if (generation !== this.generation || !this.acceptingRequests) {
        throw new SupersededConnectionError('Host response belongs to a superseded connection')
      }
      return response
    }
  }

  /** Replace the physical socket and start its serialized token exchange. */
  createWebSocket(url: string): ConnectionWebSocket {
    if (this.detached) throw new Error(DETACHED_MESSAGE)
    if (this.physicalAttempted) {
      this.generation++
      this.invalidateCredential()
    } else {
      this.physicalAttempted = true
    }
    this.acceptingRequests = true
    const generation = this.generation
    const previous = this.activeSocket
    const socket = new AuthenticatedWebSocket(() => { this.socketLost(generation, socket) })
    this.activeSocket = socket
    previous?.close(4000, 'reconnect requested')
    void this.openSocket(socket, generation, url)
    return socket
  }

  /** Abort local authentication and close only this Client's socket. */
  detach(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const authentications = [...this.authentications.values()]
    this.detached = true
    this.acceptingRequests = false
    this.generation++
    this.invalidateCredential()
    this.lifetime.abort(new Error(DETACHED_MESSAGE))
    const socket = this.activeSocket
    socket?.close(1000, 'Client detached')
    this.closing = Promise.allSettled([
      ...authentications,
      ...socket === undefined ? [] : [socket.done],
    ]).then(() => undefined)
    return this.closing
  }

  private resolve(input: string | URL): URL {
    const target = new URL(input, this.baseUrl)
    if (target.origin !== this.baseUrl.origin || !target.pathname.startsWith(this.baseUrl.pathname)) {
      throw new Error('Host transport refused a URL outside the configured mount')
    }
    return target
  }

  private assertAvailable(): void {
    if (this.detached) throw new Error(DETACHED_MESSAGE)
    if (!this.acceptingRequests) throw new Error(UNAVAILABLE_MESSAGE)
  }

  private authenticate(generation: number): Promise<string> {
    const current = this.authentications.get(generation)
    if (current !== undefined) return current
    const previous = this.authenticationTail
    const authentication = previous.then(() => this.exchange(generation))
    this.authentications.set(generation, authentication)
    this.authenticationTail = authentication.then(() => undefined, () => undefined)
    return authentication
  }

  private async exchange(generation: number): Promise<string> {
    if (!this.isCurrent(generation)) throw new SupersededConnectionError('Host authentication was superseded')
    let response: Response
    try {
      response = await this.doFetch(this.connectUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: this.lifetime.signal,
      })
      await response.arrayBuffer()
    } catch {
      if (this.detached) throw new Error(DETACHED_MESSAGE)
      throw new Error('Host authentication request failed')
    }
    if (!this.isCurrent(generation)) throw new SupersededConnectionError('Host authentication was superseded')
    if (response.status !== 302) throw new Error(`Host authentication failed with HTTP ${String(response.status)}`)
    const pairs = response.headers.getSetCookie().map(value => value.split(';', 1).join('').trim())
    if (pairs.length === 0 || pairs.some(value => !/^[^=;\s]+=[^;]*$/u.test(value))) {
      throw new Error('Host authentication omitted its cookie')
    }
    return pairs.join('; ')
  }

  private async openSocket(socket: AuthenticatedWebSocket, generation: number, url: string): Promise<void> {
    try {
      const cookie = await this.authenticate(generation)
      if (!this.isCurrent(generation) || this.activeSocket !== socket) {
        throw new SupersededConnectionError('Host socket was superseded')
      }
      const physical = this.socketFactory(url, cookie)
      if (!this.isCurrent(generation) || this.activeSocket !== socket) {
        physical.close(4000, 'reconnect requested')
        throw new SupersededConnectionError('Host socket was superseded')
      }
      socket.attach(physical)
    } catch (error) {
      socket.fail(error)
    }
  }

  private socketLost(generation: number, socket: AuthenticatedWebSocket): void {
    if (!this.isCurrent(generation) || this.activeSocket !== socket) return
    this.acceptingRequests = false
    this.invalidateCredential()
  }

  private invalidateCredential(): void {
    this.authentications.clear()
  }

  private isCurrent(generation: number): boolean {
    return !this.detached && generation === this.generation
  }
}
