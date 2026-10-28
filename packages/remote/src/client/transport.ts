/**
 * Generation-safe authenticated HTTP, WebSocket, and raw-upload carriers for
 * one remote dsh Host. Only a definite pre-dispatch 401 permits one RPC replay.
 * @module @ephemeral-ai/mayfly/client/transport
 */

import WebSocket from 'ws'
import type {
  ClientTransportHooks,
  ConnectionState,
  ConnectionWebSocket,
  RpcFetch,
} from '@deepseek-ai/dsh-client-connection/client'
import { HostAuthBroker, resolveHostEndpoint } from './auth.ts'
import {
  HostTransportError,
  type HostConnectionStateSource,
} from './types.ts'

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

const DETACHED_MESSAGE = 'Host Client is detached'
const UNAVAILABLE_MESSAGE = 'Host connection is unavailable until its WebSocket reconnects'
const SUPERSEDED_RESPONSE_MESSAGE = 'Host response belongs to a superseded connection; the request was not replayed'

/** A socket whose physical construction waits for its generation's cookie exchange. */
class AuthenticatedWebSocket implements ConnectionWebSocket {
  private socket: ConnectionWebSocket | undefined
  private removePhysicalListeners: (() => void) | undefined
  private readonly listeners = new Map<SocketEvent, Set<ListenerRecord>>()
  private readonly closed = Promise.withResolvers<void>()
  private closeRequested = false
  private terminated = false

  constructor(private readonly lost: (error?: HostTransportError) => void) {}

  get readyState(): number {
    if (this.socket !== undefined) return this.socket.readyState
    return this.closeRequested ? 3 : 0
  }

  get done(): Promise<void> {
    return this.closed.promise
  }

  send(data: string): void {
    if (this.socket?.readyState !== 1 || this.closeRequested) {
      throw new HostTransportError('unavailable', 'Host WebSocket is not open')
    }
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
    const opened = (value: object): void => { this.dispatch('open', value) }
    const failed = (): void => {
      this.dispatch('error', {
        error: new HostTransportError('unavailable', 'Host WebSocket failed; its credential cannot be reused'),
      })
    }
    const received = (value: { readonly data: unknown }): void => { this.dispatch('message', value) }
    const closed = (value: object): void => {
      this.terminated = true
      this.lost()
      this.dispatch('close', value)
      this.finishClose()
    }
    socket.addEventListener('open', opened)
    socket.addEventListener('error', failed)
    socket.addEventListener('message', received)
    socket.addEventListener('close', closed)
    this.removePhysicalListeners = () => {
      socket.removeEventListener('open', opened)
      socket.removeEventListener('error', failed)
      socket.removeEventListener('message', received)
      socket.removeEventListener('close', closed)
    }
    if (this.closeRequested) {
      socket.close(1000, 'Client detached')
      return
    }
    if (socket.readyState === 3) closed({})
  }

  fail(error: HostTransportError): void {
    if (this.terminated) return
    this.terminated = true
    this.dispatch('error', { error })
    this.closeRequested = true
    this.lost(error)
    this.dispatch('close', {})
    this.finishClose()
  }

  private finishClose(): void {
    this.removePhysicalListeners?.()
    this.removePhysicalListeners = undefined
    this.closed.resolve()
    this.listeners.clear()
  }

  private dispatch<Event extends SocketEvent>(event: Event, value: ConnectionWebSocketEventMap[Event]): void {
    const records = this.listeners.get(event)
    if (records === undefined) return
    for (const record of [...records]) {
      if (record.once) records.delete(record)
      try {
        record.listener(value)
      } catch {
        console.error('Host WebSocket listener failed')
      }
    }
  }
}

/** Own all authenticated carriers and their in-flight local work for one Host. */
export class NodeConnectionTransport {
  readonly hooks: ClientTransportHooks
  readonly state: HostConnectionStateSource
  readonly hostname: string

  private readonly endpoint: ReturnType<typeof resolveHostEndpoint>
  private readonly doFetch: RpcFetch
  private readonly broker: HostAuthBroker
  private readonly socketFactory: NodeWebSocketFactory
  private readonly lifetime = new AbortController()
  private readonly sockets = new Set<AuthenticatedWebSocket>()
  private readonly operations = new Set<Promise<Response>>()
  private activeSocket: AuthenticatedWebSocket | undefined
  private acceptingRequests = true
  private detached = false
  private closing: Promise<void> | undefined

  constructor(startupUrl: string, options: NodeConnectionTransportOptions = {}) {
    this.endpoint = resolveHostEndpoint(startupUrl)
    this.hostname = this.endpoint.hostname
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.broker = new HostAuthBroker(this.endpoint, this.doFetch)
    this.state = this.broker.state
    this.socketFactory = options.createWebSocket ?? ((url, cookie) => new WebSocket(url, { headers: { cookie } }))
    this.hooks = {
      streamBaseUrl: this.endpoint.baseUrl.href,
      fetch: (input, init) => this.fetch(input, init),
      createWebSocket: url => this.createWebSocket(url),
    }
  }

  /** Terminal error used to stop the official Connection retry loop. */
  get terminalError(): HostTransportError | undefined {
    return this.broker.terminalError
  }

  /** Mirror official Connection readiness into the public state source. */
  connectionChanged(state: ConnectionState): void {
    this.broker.connectionChanged(state)
  }

  /** Stop retry supervision after authentication or protocol failure. */
  onTerminal(listener: () => void): () => void {
    return this.broker.onTerminal(listener)
  }

  /** Send unary RPC, retrying once only when a 401 proves dispatch did not occur. */
  fetch(input: string | URL, init: RequestInit): Promise<Response> {
    return this.track(this.request(input, init, true))
  }

  /** Send one raw upload without replaying its one-shot body after any failure. */
  upload(input: string | URL, init: RequestInit): Promise<Response> {
    return this.track(this.request(input, init, false))
  }

  /** Replace the physical socket and authenticate its generation once. */
  createWebSocket(url: string): ConnectionWebSocket {
    const target = this.endpoint.resolveWebSocket(url)
    this.assertUsable()
    if (this.activeSocket !== undefined) this.broker.invalidate()
    this.acceptingRequests = true
    this.broker.connecting()
    const generation = this.broker.currentGeneration
    const previous = this.activeSocket
    const socket = new AuthenticatedWebSocket((error) => { this.socketLost(generation, socket, error) })
    this.activeSocket = socket
    this.sockets.add(socket)
    void socket.done.then(() => { this.sockets.delete(socket) })
    previous?.close(4000, 'reconnect requested')
    void this.openSocket(socket, generation, target.href)
    return socket
  }

  /** Abort local work, close every owned socket, and await local quiescence. */
  detach(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const operations = [...this.operations]
    const sockets = [...this.sockets]
    this.detached = true
    this.acceptingRequests = false
    this.lifetime.abort(new HostTransportError('detached', DETACHED_MESSAGE))
    const authenticationClosed = this.broker.detach()
    for (const socket of sockets) socket.close(1000, 'Client detached')
    this.closing = Promise.allSettled([
      authenticationClosed,
      ...operations,
      ...sockets.map(socket => socket.done),
    ]).then(() => undefined)
    return this.closing
  }

  private async request(input: string | URL, init: RequestInit, unary: boolean): Promise<Response> {
    const target = this.endpoint.resolveHttp(input)
    let retried = false
    while (true) {
      const generation = this.broker.currentGeneration
      this.assertAvailable()
      let cookie: string
      try {
        cookie = await this.broker.authenticate(generation)
      } catch (error) {
        if (isSuperseded(error) && generation !== this.broker.currentGeneration && !this.detached) continue
        throw error
      }
      if (this.detached) throw new HostTransportError('detached', DETACHED_MESSAGE)
      if (generation !== this.broker.currentGeneration || !this.acceptingRequests) continue
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      const signal = init.signal == null
        ? this.lifetime.signal
        : AbortSignal.any([init.signal, this.lifetime.signal])
      let response: Response
      try {
        response = await this.doFetch(target, { ...init, headers, signal, redirect: 'manual' })
      } catch (error) {
        if (this.detached) throw new HostTransportError('detached', DETACHED_MESSAGE)
        if (generation !== this.broker.currentGeneration) {
          throw new HostTransportError('superseded', SUPERSEDED_RESPONSE_MESSAGE)
        }
        if (init.signal?.aborted === true) throw new DOMException('The operation was aborted.', 'AbortError')
        if (error instanceof HostTransportError) throw error
        throw new HostTransportError(
          'unavailable',
          unary
            ? 'Host request ended without a response; its business outcome is unknown and it was not replayed'
            : 'Host upload ended without a response; its storage outcome is unknown and it was not replayed',
        )
      }
      if (this.detached) throw new HostTransportError('detached', DETACHED_MESSAGE)
      if (generation !== this.broker.currentGeneration) {
        throw new HostTransportError('superseded', SUPERSEDED_RESPONSE_MESSAGE)
      }
      if (response.status === 401) {
        this.expirePeer(generation)
        if (unary && !retried && (init.body == null || typeof init.body === 'string')) {
          retried = true
          await response.arrayBuffer()
          continue
        }
        return response
      }
      if (response.status === 403) {
        await response.arrayBuffer()
        throw new HostTransportError(
          'forbidden',
          'Host refused the configured authority (HTTP 403); add its host[:port] to the dsh trustedHosts configuration',
        )
      }
      return response
    }
  }

  private async openSocket(socket: AuthenticatedWebSocket, generation: number, url: string): Promise<void> {
    try {
      const cookie = await this.broker.authenticate(generation)
      if (!this.broker.isCurrent(generation) || this.activeSocket !== socket) {
        throw new HostTransportError('superseded', 'Host socket was superseded')
      }
      const physical = this.socketFactory(url, cookie)
      if (!this.broker.isCurrent(generation) || this.activeSocket !== socket) {
        physical.close(4000, 'reconnect requested')
        throw new HostTransportError('superseded', 'Host socket was superseded')
      }
      socket.attach(physical)
    } catch (error) {
      const failure = error instanceof HostTransportError
        ? error
        : new HostTransportError('unavailable', 'Host WebSocket could not be constructed; reconnect with a new API Peer')
      socket.fail(failure)
    }
  }

  private socketLost(generation: number, socket: AuthenticatedWebSocket, error?: HostTransportError): void {
    if (!this.broker.isCurrent(generation) || this.activeSocket !== socket) return
    this.activeSocket = undefined
    this.acceptingRequests = false
    this.broker.invalidate()
    this.broker.socketLost(error)
  }

  private expirePeer(generation: number): void {
    if (!this.broker.isCurrent(generation)) return
    const socket = this.activeSocket
    this.activeSocket = undefined
    this.acceptingRequests = true
    this.broker.invalidate()
    this.broker.connecting()
    socket?.close(4001, 'authentication expired')
  }

  private assertUsable(): void {
    if (this.detached) throw new HostTransportError('detached', DETACHED_MESSAGE)
    if (this.broker.terminalError !== undefined) throw this.broker.terminalError
  }

  private assertAvailable(): void {
    this.assertUsable()
    if (!this.acceptingRequests) throw new HostTransportError('unavailable', UNAVAILABLE_MESSAGE)
  }

  private track(operation: Promise<Response>): Promise<Response> {
    this.operations.add(operation)
    void operation.then(
      () => { this.operations.delete(operation) },
      () => { this.operations.delete(operation) },
    )
    return operation
  }
}

function isSuperseded(error: unknown): boolean {
  return error instanceof HostTransportError && error.code === 'superseded'
}
