/**
 * Redacted Host endpoint validation and one in-memory API Peer credential
 * generation. No authentication result contains the startup URL.
 * @module @ephemeral-ai/mayfly/client/auth
 */

import type {
  ConnectionState,
  RpcFetch,
} from '@deepseek-ai/dsh-client-connection/client'
import {
  HostTransportError,
  type HostConnectionState,
  type HostConnectionStateSource,
} from './types.ts'

/** Validated URLs and mount checks shared by every Host carrier. */
export interface HostEndpoint {
  readonly baseUrl: URL
  readonly connectUrl: URL
  readonly hostname: string
  resolveHttp(input: string | URL): URL
  resolveWebSocket(input: string | URL): URL
}

interface Authentication {
  readonly promise: Promise<string>
  readonly controller: AbortController
}

type TerminalStatus = 'authentication-required' | 'failed'

const DETACHED_MESSAGE = 'Host Client is detached'
const SUPERSEDED_MESSAGE = 'Host authentication was superseded'

/** Parse a startup URL without retaining credentials anywhere outside memory. */
export function resolveHostEndpoint(startupUrl: string): HostEndpoint {
  let startup: URL
  try {
    startup = new URL(startupUrl)
  } catch {
    throw new HostTransportError('configuration', 'Host startup URL is invalid')
  }
  if (startup.protocol !== 'http:' && startup.protocol !== 'https:') {
    throw new HostTransportError('configuration', 'Host startup URL must use HTTP or HTTPS')
  }
  if (startup.protocol === 'http:' && !isLoopbackHostname(startup.hostname)) {
    throw new HostTransportError(
      'configuration',
      'Non-loopback Host URLs require HTTPS; use HTTP only for a loopback dsh Host',
    )
  }
  if (startup.username !== '' || startup.password !== '') {
    throw new HostTransportError('configuration', 'Host startup URL must not contain credentials')
  }
  const tokens = startup.searchParams.getAll('token')
  const token = tokens[0]
  if (tokens.length !== 1 || token === undefined || token === '') {
    throw new HostTransportError('configuration', 'Host startup URL must contain exactly one token')
  }

  const baseUrl = new URL(startup.href)
  baseUrl.search = ''
  baseUrl.hash = ''
  if (baseUrl.pathname.endsWith('/connect')) {
    baseUrl.pathname = baseUrl.pathname.slice(0, -'/connect'.length)
  }
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/'
  const connectUrl = new URL('connect', baseUrl)
  connectUrl.searchParams.set('token', token)
  connectUrl.searchParams.set('interactions', 'answer')
  const socketBaseUrl = new URL(baseUrl.href)
  socketBaseUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'

  return {
    baseUrl,
    connectUrl,
    hostname: baseUrl.hostname,
    resolveHttp(input) {
      return resolveMounted(baseUrl, input, 'Host transport')
    },
    resolveWebSocket(input) {
      // The mounted origin check includes the scheme and enforces TLS too.
      return resolveMounted(socketBaseUrl, input, 'Host WebSocket')
    },
  }
}

/** Own token exchange, credential invalidation, and the public lifecycle source. */
export class HostAuthBroker {
  readonly state: HostConnectionStateSource

  private readonly lifetime = new AbortController()
  private readonly authentications = new Map<number, Authentication>()
  private readonly listeners = new Set<() => void>()
  private readonly terminalListeners = new Set<() => void>()
  private authenticationTail: Promise<void> = Promise.resolve()
  private generation = 0
  private snapshot: HostConnectionState = { status: 'connecting', generation: 0 }
  private terminal: HostTransportError | undefined
  private detached = false
  private closing: Promise<void> | undefined

  constructor(private readonly endpoint: HostEndpoint, private readonly doFetch: RpcFetch) {
    this.state = {
      getSnapshot: () => this.snapshot,
      subscribe: (listener) => {
        if (this.detached) return () => {}
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    }
  }

  /** Current credential/socket generation. */
  get currentGeneration(): number {
    return this.generation
  }

  /** Terminal failure that prevents further automatic retries. */
  get terminalError(): HostTransportError | undefined {
    return this.terminal
  }

  /** Whether a generation still owns the current credential exchange. */
  isCurrent(generation: number): boolean {
    return !this.detached && generation === this.generation
  }

  /** Invalidate the current credential and cancel its in-flight exchange. */
  invalidate(): number {
    if (this.detached || this.terminal !== undefined) return this.generation
    this.generation++
    for (const authentication of this.authentications.values()) {
      authentication.controller.abort(new HostTransportError('superseded', SUPERSEDED_MESSAGE))
    }
    this.authentications.clear()
    return this.generation
  }

  /** Share one serialized token exchange among every caller in a generation. */
  authenticate(generation: number): Promise<string> {
    if (this.terminal !== undefined) return Promise.reject(this.terminal)
    if (!this.isCurrent(generation)) {
      return Promise.reject(new HostTransportError('superseded', SUPERSEDED_MESSAGE))
    }
    const current = this.authentications.get(generation)
    if (current !== undefined) return current.promise
    const previous = this.authenticationTail
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const promise = previous.then(() => this.exchange(generation, signal))
    this.authentications.set(generation, { promise, controller })
    this.authenticationTail = promise.then(() => undefined, () => undefined)
    return promise
  }

  /** Publish a new physical or logical connection attempt. */
  connecting(): void {
    if (this.detached || this.terminal !== undefined) return
    this.publish({ status: 'connecting', generation: this.generation })
  }

  /** Publish a recoverable socket loss without leaking a carrier error. */
  socketLost(error?: HostTransportError): void {
    if (this.detached || this.terminal !== undefined) return
    this.publish({
      status: 'disconnected',
      generation: this.generation,
      error: error ?? new HostTransportError(
        'unavailable',
        'Host WebSocket closed; reconnect using a new authenticated API Peer',
      ),
    })
  }

  /** Mirror the official Connection state after its baseline readiness decision. */
  connectionChanged(state: ConnectionState): void {
    if (this.detached || this.terminal !== undefined) return
    switch (state) {
      case 'connected':
        this.publish({ status: 'connected', generation: this.generation })
        return
      case 'connecting':
        this.connecting()
        return
      case 'disconnected':
        this.socketLost()
        return
    }
  }

  /** Stop the official retry loop after a terminal authentication or protocol failure. */
  onTerminal(listener: () => void): () => void {
    if (this.terminal !== undefined) {
      listener()
      return () => {}
    }
    this.terminalListeners.add(listener)
    return () => { this.terminalListeners.delete(listener) }
  }

  /** Abort exchanges and publish the final local-only state. */
  detach(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const authentications = [...this.authentications.values()]
    this.detached = true
    this.generation++
    for (const authentication of authentications) {
      authentication.controller.abort(new HostTransportError('detached', DETACHED_MESSAGE))
    }
    this.authentications.clear()
    this.lifetime.abort(new HostTransportError('detached', DETACHED_MESSAGE))
    this.publish({ status: 'detached', generation: this.generation })
    this.listeners.clear()
    this.terminalListeners.clear()
    this.closing = Promise.allSettled(authentications.map(authentication => authentication.promise))
      .then(() => undefined)
    return this.closing
  }

  private async exchange(generation: number, signal: AbortSignal): Promise<string> {
    this.assertExchangeCurrent(generation)
    let response: Response
    try {
      response = await this.doFetch(this.endpoint.connectUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal,
      })
      await response.arrayBuffer()
    } catch {
      if (this.detached) throw new HostTransportError('detached', DETACHED_MESSAGE)
      if (!this.isCurrent(generation) || signal.aborted) {
        throw new HostTransportError('superseded', SUPERSEDED_MESSAGE)
      }
      const error = new HostTransportError(
        'unavailable',
        'Host authentication request failed; check that the dsh Host is running and reachable',
      )
      this.socketLost(error)
      throw error
    }
    this.assertExchangeCurrent(generation)
    if (response.status === 401) {
      throw this.fail(
        'authentication-required',
        new HostTransportError(
          'authentication-required',
          'Host startup token was rejected; attach using the new URL printed by the restarted dsh Host',
        ),
      )
    }
    if (response.status === 403) {
      throw this.fail('failed', forbiddenError())
    }
    if (response.status !== 302) {
      if (response.status >= 500) {
        const error = new HostTransportError(
          'unavailable',
          `Host authentication is temporarily unavailable (HTTP ${String(response.status)}); retry after the Host recovers`,
        )
        this.socketLost(error)
        throw error
      }
      throw this.fail(
        'failed',
        new HostTransportError(
          'protocol',
          `Host authentication returned HTTP ${String(response.status)} instead of its required 302 redirect; verify the dsh version and mount`,
        ),
      )
    }
    const pairs = response.headers.getSetCookie().map(value => value.split(';', 1).join('').trim())
    if (pairs.length === 0 || pairs.some(value => !/^[^=;\s]+=[^;]*$/u.test(value))) {
      throw this.fail(
        'failed',
        new HostTransportError(
          'protocol',
          'Host authentication omitted a valid API Peer cookie; verify the dsh version and mount',
        ),
      )
    }
    return pairs.join('; ')
  }

  private assertExchangeCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new HostTransportError('superseded', SUPERSEDED_MESSAGE)
  }

  private fail(status: TerminalStatus, error: HostTransportError): HostTransportError {
    // Only the current serialized exchange reaches a terminal response; its
    // generation was checked synchronously immediately before this call.
    this.terminal = error
    this.publish({ status, generation: this.generation, error })
    for (const listener of [...this.terminalListeners]) {
      try {
        listener()
      } catch {
        console.error('Host terminal-state listener failed')
      }
    }
    return error
  }

  private publish(next: HostConnectionState): void {
    const current = this.snapshot
    const currentError = 'error' in current ? current.error : undefined
    const nextError = 'error' in next ? next.error : undefined
    if (current.status === next.status
      && current.generation === next.generation
      && currentError === nextError) return
    this.snapshot = next
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        console.error('Host connection-state listener failed')
      }
    }
  }
}

function resolveMounted(base: URL, input: string | URL, carrier: string): URL {
  let target: URL
  try {
    target = new URL(input, base)
  } catch {
    throw new HostTransportError('configuration', `${carrier} URL is invalid`)
  }
  if (target.username !== '' || target.password !== ''
    || target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    throw new HostTransportError('configuration', `${carrier} refused a URL outside the configured origin or mount`)
  }
  return target
}

function forbiddenError(): HostTransportError {
  return new HostTransportError(
    'forbidden',
    'Host refused the configured authority (HTTP 403); add its host[:port] to the dsh trustedHosts configuration',
  )
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}
