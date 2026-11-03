/** Controllable loopback HTTP/WebSocket forwarding for real split disconnect/reconnect scenarios. @module script/scenarios/split-network */

import { createServer, request } from 'node:http'

/** Forward actual protocol bytes to the Host; outage drops sockets without altering Agent or Session state. */
export async function startSplitNetwork(startupUrl) {
  const target = new URL(startupUrl)
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Split outage fixture accepts only loopback HTTP Hosts')
  const sockets = new Set()
  let blocked = false
  const upstream = req => request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } })
  const server = createServer((req, res) => {
    if (blocked) { res.writeHead(503).end('isolated test outage'); return }
    const remote = upstream(req)
    remote.on('response', received => { res.writeHead(received.statusCode, received.headers); received.pipe(res) })
    remote.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on('aborted', () => remote.destroy())
    req.pipe(remote)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    if (blocked) { socket.destroy(); return }
    const remote = upstream(req)
    remote.on('upgrade', (res, upstreamSocket, upstreamHead) => {
      sockets.add(upstreamSocket)
      upstreamSocket.on('close', () => sockets.delete(upstreamSocket))
      const headers = res.rawHeaders.flatMap((value, index) => index % 2 === 0 ? [`${value}: ${res.rawHeaders[index + 1]}`] : [])
      socket.write(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${headers.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('error', () => upstreamSocket.destroy())
      socket.on('close', () => upstreamSocket.destroy())
      upstreamSocket.on('close', () => socket.destroy())
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
    })
    remote.on('response', () => socket.destroy())
    remote.on('error', () => socket.destroy())
    remote.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const endpoint = new URL(startupUrl)
  endpoint.hostname = '127.0.0.1'
  endpoint.port = String(server.address().port)
  return {
    startupUrl: endpoint.href,
    drop() { blocked = true; for (const socket of sockets) socket.destroy() },
    restore() { blocked = false },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}
