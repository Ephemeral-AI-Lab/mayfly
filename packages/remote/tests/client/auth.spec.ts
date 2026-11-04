/** Authentication generations, redaction, scoped endpoint validation, and lifecycle observers. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import { HostAuthBroker, resolveHostEndpoint } from '../../src/client/auth.ts'
import { HostTransportError } from '../../src/client/types.ts'

const brokers: HostAuthBroker[] = []
afterEach(async () => { for (const broker of brokers.splice(0)) await broker.detach(); vi.restoreAllMocks() })
const connected = () => new Response(null, { status: 302, headers: { 'set-cookie': 'dsh=safe; Path=/; HttpOnly' } })
function broker(fetch: RpcFetch = async () => connected()) {
  const value = new HostAuthBroker(resolveHostEndpoint('http://127.0.0.1:3080/mount?token=never-surface-this-token'), fetch)
  brokers.push(value)
  return value
}

describe('Host endpoint credential boundary', () => {
  it.each([
    ['/', '/'], ['/connect', '/'], ['/connect/', '/'], ['/connect///', '/'],
    ['/mount', '/mount/'], ['/mount/', '/mount/'], ['/mount/connect', '/mount/'], ['/mount/connect/', '/mount/'],
  ])('shares one canonical base for startup path %s and token changes', (path, base) => {
    for (const token of ['first', 'second']) {
      const endpoint = resolveHostEndpoint(`https://host.example${path}?token=${token}&extra=query#fragment`)
      expect(endpoint.baseUrl.href).toBe(`https://host.example${base}`)
      expect(endpoint.connectUrl.href).toBe(`https://host.example${base}connect?token=${token}&interactions=answer`)
    }
  })

  it('accepts both native loopback names and enforces origin, mount, and scheme for every carrier', () => {
    for (const host of ['localhost', '[::1]']) expect(resolveHostEndpoint(`http://${host}/?token=local`).hostname).toBe(host)
    expect(() => resolveHostEndpoint('not a startup URL')).toThrow('startup URL is invalid')
    const endpoint = resolveHostEndpoint('https://host.example/mount/connect?token=secret')
    expect(endpoint.resolveWebSocket('wss://host.example/mount/api/remote.mux').href).toBe('wss://host.example/mount/api/remote.mux')
    for (const input of ['http://[', 'http://user@host.example/mount/api', 'https://host.example/elsewhere', 'https://other.example/mount/api']) expect(() => endpoint.resolveHttp(input)).toThrow()
    expect(() => endpoint.resolveWebSocket('ws://host.example/mount/api/remote.mux')).toThrow('outside the configured origin or mount')
  })
})

describe('Host authentication broker ownership', () => {
  it('shares one exchange and rejects stale callers before starting another credential exchange', async () => {
    const exchange = Promise.withResolvers<Response>()
    const fetch = vi.fn<RpcFetch>(() => exchange.promise)
    const auth = broker(fetch)
    const first = auth.authenticate(0)
    expect(auth.authenticate(0)).toBe(first)
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    auth.invalidate()
    await expect(auth.authenticate(0)).rejects.toMatchObject({ code: 'superseded' })
    exchange.reject(new Error('old native carrier failure with credential'))
    await expect(first).rejects.toMatchObject({ code: 'superseded' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(auth.terminalError).toBeUndefined()
  })

  it('publishes whole lifecycle snapshots, deduplicates unchanged state, and isolates observer exceptions', async () => {
    const auth = broker()
    const observed = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const offBad = auth.state.subscribe(() => { throw new Error('private observer error with credential') })
    const off = auth.state.subscribe(observed)
    const initial = auth.state.getSnapshot()
    auth.connectionChanged('connecting')
    expect(auth.state.getSnapshot()).toBe(initial)
    auth.connectionChanged('connected')
    auth.connectionChanged('connected')
    auth.connectionChanged('disconnected')
    auth.connectionChanged('connecting')
    expect(observed).toHaveBeenCalledTimes(3)
    expect(error.mock.calls.every(([message]) => message === 'Host connection-state listener failed')).toBe(true)
    const failure = new HostTransportError('unavailable', 'safe external failure')
    auth.socketLost(failure)
    expect(auth.state.getSnapshot()).toMatchObject({ status: 'disconnected', error: failure })
    offBad(); off()
    await auth.detach()
    const detached = auth.state.getSnapshot()
    auth.connecting(); auth.connectionChanged('connected'); auth.socketLost(); auth.invalidate()
    expect(auth.state.getSnapshot()).toBe(detached)
    const late = vi.fn()
    auth.state.subscribe(late)()
    expect(late).not.toHaveBeenCalled()
    const closing = auth.detach()
    expect(auth.detach()).toBe(closing)
  })

  it.each([
    [401, 'authentication-required', 'authentication-required'],
    [403, 'forbidden', 'failed'],
    [200, 'protocol', 'failed'],
  ] as const)('turns HTTP %s into a stable terminal %s and prohibits repeated token exchange', async (status, code, state) => {
    const fetch = vi.fn<RpcFetch>(async () => new Response('native secret payload', { status }))
    const auth = broker(fetch)
    const terminal = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const offBad = auth.onTerminal(() => { throw new Error('secret listener details') })
    auth.onTerminal(terminal)
    const failure = await auth.authenticate(0).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code })
    expect(String(failure)).not.toMatch(/native secret|never-surface/u)
    expect(auth.state.getSnapshot().status).toBe(state)
    expect(terminal).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledExactlyOnceWith('Host terminal-state listener failed')
    await expect(auth.authenticate(0)).rejects.toBe(failure)
    auth.connecting(); auth.connectionChanged('connected'); auth.socketLost(); auth.invalidate()
    expect(auth.state.getSnapshot().status).toBe(state)
    expect(fetch).toHaveBeenCalledOnce()
    offBad()
  })

  it('permits a fresh generation after a temporary Host failure without converting it to a terminal authentication error', async () => {
    let calls = 0
    const auth = broker(async () => ++calls === 1 ? new Response('temporary secret payload', { status: 503 }) : connected())
    await expect(auth.authenticate(0)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('temporarily unavailable (HTTP 503)') })
    expect(auth.terminalError).toBeUndefined()
    const next = auth.invalidate()
    auth.connecting()
    await expect(auth.authenticate(next)).resolves.toBe('dsh=safe')
    expect(calls).toBe(2)
  })
})
