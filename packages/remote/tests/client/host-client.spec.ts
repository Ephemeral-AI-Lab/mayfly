/** Real official Client-plugin assembly over a local authenticated HTTP/WS Host fixture. */
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { createHostClient } from '../../src/client/host-client.ts'
import { HostKey, type HostClient } from '../../src/client/types.ts'

interface RequestRecord {
  readonly path: string
  readonly cookie: string | undefined
  readonly token: string | null
}

interface HostFixture {
  readonly startupUrl: string
  readonly requests: RequestRecord[]
  readonly upgrades: RequestRecord[]
  readonly close: () => Promise<void>
}

async function hostFixture(label: string): Promise<HostFixture> {
  const requests: RequestRecord[] = []
  const upgrades: RequestRecord[] = []
  const rawSockets = new Set<Duplex>()
  const mux = new WebSocketServer({ noServer: true })
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    const record = { path: url.pathname, cookie: request.headers.cookie, token: url.searchParams.get('token') }
    requests.push(record)
    if (url.pathname === '/mount/connect') {
      if (url.searchParams.get('token') !== `${label}-token` || url.searchParams.get('interactions') !== 'answer') {
        response.writeHead(400)
        response.end()
        return
      }
      response.writeHead(302, {
        location: './api/remote.mux',
        'set-cookie': `dsh=${label}; Path=/; HttpOnly`,
      })
      response.end()
      return
    }
    if (!url.pathname.startsWith('/mount/api/')) {
      response.writeHead(404)
      response.end()
      return
    }
    void (async () => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const envelope = JSON.parse(body) as { rpcId: string; method: string }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: envelope.method === 'session/list' ? { items: [] } : `${label}:${envelope.method}`,
        },
      }))
    })().catch((error: unknown) => { response.destroy(error instanceof Error ? error : undefined) })
  })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    upgrades.push({ path: url.pathname, cookie: request.headers.cookie, token: url.searchParams.get('token') })
    rawSockets.add(socket)
    socket.on('error', () => { socket.destroy() })
    socket.once('close', () => { rawSockets.delete(socket) })
    mux.handleUpgrade(request, socket, head, (peer) => {
      peer.on('error', () => { peer.terminate() })
      peer.on('message', (data) => {
        const frame = JSON.parse(String(data)) as { type: string; streamId?: string; endpoint?: string }
        if (frame.type !== 'open' || frame.endpoint !== '$events') return
        peer.send(JSON.stringify({
          type: 'item',
          streamId: frame.streamId,
          value: { type: 'ready', clientId: `${label}-client`, host: { home: `/${label}` } },
        }))
      })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not acquire a port')
  return {
    startupUrl: `http://127.0.0.1:${String(address.port)}/mount/?token=${label}-token`,
    requests,
    upgrades,
    async close() {
      for (const socket of rawSockets) socket.destroy()
      for (const peer of mux.clients) peer.terminate()
      await new Promise<void>((resolve) => { mux.close(() => { resolve() }) })
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}

describe('createHostClient', () => {
  it('assembles the official object layer and detaches only local resources', async () => {
    const host = await hostFixture('one')
    let client: HostClient | undefined
    try {
      client = await createHostClient({ key: HostKey('local'), startupUrl: host.startupUrl })
      expect(client.connection.interactions).toBe('answer')
      expect(client.remote.commands).toBeDefined()
      await expect(client.connection.rpc.call('/api', 'probe/read', {})).resolves.toEqual({ ok: true, value: 'one:probe/read' })
      await vi.waitFor(() => { expect(client?.connection.generation.getSnapshot()?.host.home).toBe('/one') })
      expect(host.upgrades.map(record => record.cookie)).toEqual(['dsh=one'])
      const detaching = client.detach()
      expect(client.detach()).toBe(detaching)
      await detaching
      await expect(client.connection.rpc.call('/api', 'probe/after-detach', {})).rejects.toThrow('Host Client is detached')
      expect(host.requests.some(record => record.path.includes('cancel'))).toBe(false)
      for (const record of [...host.requests, ...host.upgrades]) {
        if (record.path !== '/mount/connect') expect(record.token).toBeNull()
      }
    } finally {
      await client?.detach()
      await host.close()
    }
  })

  it('keeps two official Clients independent across detach', async () => {
    const firstHost = await hostFixture('first')
    const secondHost = await hostFixture('second')
    let first: HostClient | undefined
    let second: HostClient | undefined
    try {
      ;[first, second] = await Promise.all([
        createHostClient({ key: HostKey('first'), startupUrl: firstHost.startupUrl }),
        createHostClient({ key: HostKey('second'), startupUrl: secondHost.startupUrl }),
      ])
      await expect(first.connection.rpc.call('/api', 'probe/read', {})).resolves.toEqual({ ok: true, value: 'first:probe/read' })
      await expect(second.connection.rpc.call('/api', 'probe/read', {})).resolves.toEqual({ ok: true, value: 'second:probe/read' })
      await vi.waitFor(() => {
        expect(firstHost.upgrades[0]?.cookie).toBe('dsh=first')
        expect(secondHost.upgrades[0]?.cookie).toBe('dsh=second')
      })
      await first.detach()
      await expect(second.connection.rpc.call('/api', 'probe/still-live', {})).resolves.toEqual({ ok: true, value: 'second:probe/still-live' })
      expect(firstHost.requests.filter(record => record.path === '/mount/connect')).toHaveLength(1)
      expect(secondHost.requests.filter(record => record.path === '/mount/connect')).toHaveLength(1)
    } finally {
      await first?.detach()
      await second?.detach()
      await Promise.all([firstHost.close(), secondHost.close()])
    }
  })
})
