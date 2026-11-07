/** Real official Client-plugin assembly over a local authenticated HTTP/WS Host fixture. */
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TYPERT_REMOTE } from '@ephemeral-ai/mayfly-host/remote'
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
  readonly uploads: Array<{ readonly sessionId: string | null, readonly name: string | null, readonly bytes: Buffer }>
  readonly disconnect: () => void
  readonly rejectAuthentication: () => void
  readonly close: () => Promise<void>
}

async function hostFixture(label: string): Promise<HostFixture> {
  const requests: RequestRecord[] = []
  const upgrades: RequestRecord[] = []
  const uploads: HostFixture['uploads'] = []
  let authentications = 0
  let rejectToken = false
  const rawSockets = new Set<Duplex>()
  const mux = new WebSocketServer({ noServer: true })
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid')
    const record = { path: url.pathname, cookie: request.headers.cookie, token: url.searchParams.get('token') }
    requests.push(record)
    if (url.pathname === '/mount/connect') {
      if (rejectToken) { response.writeHead(401); response.end(); return }
      if (url.searchParams.get('token') !== `${label}-token` || url.searchParams.get('interactions') !== 'answer') {
        response.writeHead(400)
        response.end()
        return
      }
      response.writeHead(302, {
        location: './api/remote.mux',
        'set-cookie': `dsh=${label}${++authentications === 1 ? '' : `-${String(authentications)}`}; Path=/; HttpOnly`,
      })
      response.end()
      return
    }
    if (url.pathname === '/mount/api/session/uploadFileBinary') {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
        const bytes = Buffer.concat(chunks)
        uploads.push({ sessionId: url.searchParams.get('sessionId'), name: url.searchParams.get('name'), bytes })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, value: { receiptId: 'upload-receipt', file: { attachmentId: 'attachment', name: 'upload.txt', bytes: bytes.length } } }))
      })().catch(() => { response.destroy() })
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
    uploads,
    disconnect: () => { for (const peer of mux.clients) peer.terminate() },
    rejectAuthentication: () => { rejectToken = true },
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

  it('mounts the actual generated Host namespace and uploads one exact Blob through its authenticated Node carrier', async () => {
    const host = await hostFixture('upload')
    let client: HostClient | undefined
    try {
      client = await createHostClient({ key: HostKey('upload'), startupUrl: host.startupUrl, mayflyHost: TYPERT_REMOTE })
      expect(client.remote.mayflyHost.capabilities).toBeTypeOf('function')
      const bytes = new Blob(['exact upload 你好'])
      await expect(client.fileUpload.upload(SessionId('upload-session'), bytes, 'upload.txt')).resolves.toMatchObject({ ok: true, value: { receiptId: 'upload-receipt', file: { bytes: bytes.size } } })
      expect(host.uploads).toEqual([{ sessionId: 'upload-session', name: 'upload.txt', bytes: Buffer.from('exact upload 你好') }])
      expect(host.requests.find(row => row.path === '/mount/api/session/uploadFileBinary')?.cookie).toBe('dsh=upload')
    } finally {
      await client?.detach()
      await host.close()
    }
  })

  it('reconnects the actual HTTP/WS Client with a new authenticated Peer and retires only its local generation on detach', async () => {
    const host = await hostFixture('reconnect')
    let client: HostClient | undefined
    try {
      client = await createHostClient({ key: HostKey('reconnect'), startupUrl: host.startupUrl })
      await vi.waitFor(() => { expect(client?.connection.generation.getSnapshot()).toBeDefined() })
      const first = client.connection.generation.getSnapshot()!.id
      const statuses: string[] = []
      const off = client.state.subscribe(() => { statuses.push(client!.state.getSnapshot().status) })
      host.disconnect()
      await vi.waitFor(() => { expect(statuses).toContain('disconnected') })
      client.connection.reconnect()
      await vi.waitFor(() => { expect(client?.connection.generation.getSnapshot()?.id).toBeGreaterThan(first) })
      expect(host.upgrades.map(row => row.cookie)).toEqual(['dsh=reconnect', 'dsh=reconnect-2'])
      expect(client.state.getSnapshot().status).toBe('connected')
      await expect(client.connection.rpc.call('/api', 'probe/reconnected', {})).resolves.toEqual({ ok: true, value: 'reconnect:probe/reconnected' })
      await client.detach()
      expect(client.state.getSnapshot().status).toBe('detached')
      expect(client.connection.generation.getSnapshot()).toBeUndefined()
      const count = host.requests.length
      client.connection.reconnect()
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(host.requests).toHaveLength(count)
      expect(host.requests.some(row => row.path.includes('cancel'))).toBe(false)
      off()
    } finally {
      await client?.detach()
      await host.close()
    }
  })

  it('stops native retry supervision on terminal startup-token rejection and safely refuses a later start', async () => {
    const host = await hostFixture('expired')
    host.rejectAuthentication()
    let client: HostClient | undefined
    try {
      client = await createHostClient({ key: HostKey('expired'), startupUrl: host.startupUrl })
      await vi.waitFor(() => { expect(client?.state.getSnapshot().status).toBe('authentication-required') })
      const stopped = client.connection.start({})
      stopped.stop()
      client.connection.reconnect()
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(host.requests.filter(row => row.path === '/mount/connect')).toHaveLength(1)
      expect(host.upgrades).toEqual([])
    } finally {
      await client?.detach()
      await host.close()
    }
  })
})
