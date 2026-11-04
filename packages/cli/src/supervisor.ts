/** Authenticated local control and the platform-owned Host supervisor lifetime. @module */
import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { appendLog, logStream } from './logs.ts'
import { dshBin, hostEnvironment, packageManifest } from './profiles.ts'
import { removeSocket } from './platform.ts'
import { alive, paths, privateDirectory, readJson, request, writeJson, type Configuration, type RecordState } from './state.ts'

/** Compare control secrets without leaking matching prefixes. */
export function sameSecret(left: unknown, right: string): boolean {
  return typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

/** Supervise an initialized native Host; the OS owns this process on Linux/macOS. */
export async function supervise(profile: string): Promise<void> {
  const p = paths(profile)
  await privateDirectory(p.home)
  await privateDirectory(p.dir)
  await privateDirectory(dirname(p.log))
  if (process.platform !== 'win32') await privateDirectory(dirname(p.socket))
  const previous = await readJson<RecordState>(p.record)
  if (previous && previous.state !== 'stopped' && alive(previous.pid)) {
    const existing = await request(p, previous, 'status').catch(() => undefined)
    if (existing) return
    throw new Error('An existing Mayfly supervisor cannot be verified; refusing to replace its record')
  }
  await removeSocket(p)
  const config = (await readJson<Configuration>(p.config))!
  const record: RecordState = { generation: randomUUID(), secret: randomBytes(32).toString('hex'), pid: process.pid,
    profile, version: packageManifest('@ephemeral-ai/mayfly-host').version, state: 'starting' }
  let child: ChildProcess | undefined
  let stopping = false
  let failed = false
  let failures = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopPromise: Promise<void> | undefined
  const finished = Promise.withResolvers<void>()
  let writes = Promise.resolve()
  const persist = (): Promise<void> => {
    const snapshot = { ...record }
    writes = writes.catch(() => {}).then(() => writeJson(p.record, snapshot))
    return writes
  }
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopping = true
    clearTimeout(retry)
    record.state = 'stopping'
    stopPromise = (async () => {
      // A full disk must not prevent termination of the exact owned child.
      await persist().catch(() => {})
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const owned = child
        if (owned.connected) owned.send({ type: 'mayfly-stop' })
        const exited = new Promise<void>(resolveExit => owned.once('exit', () => resolveExit()))
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([exited, new Promise<void>(resolveTimeout => { timer = setTimeout(resolveTimeout, 10_000) })])
        clearTimeout(timer)
        if (owned.exitCode === null && owned.signalCode === null) { owned.kill('SIGKILL'); await exited }
      }
      finished.resolve()
    })()
    return stopPromise
  }
  const server = createServer(socket => {
    let input = ''
    socket.setTimeout(2000, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.on('data', data => {
      input += String(data)
      if (input.length > 4096) { socket.destroy(); return }
      if (!input.includes('\n')) return
      socket.removeAllListeners('data')
      try {
        const command = JSON.parse(input.split('\n')[0]!) as { secret: unknown, generation: string, action: string }
        if (!sameSecret(command.secret, record.secret) || command.generation !== record.generation || !['status', 'stop'].includes(command.action)) { socket.destroy(); return }
        const { secret: _secret, ...reply } = record
        socket.end(`${JSON.stringify(reply)}\n`)
        if (command.action === 'stop') void stop().catch(finished.reject)
      } catch { socket.destroy() }
    })
  })
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(p.socket, resolveListen) })
  const signal = (): void => { void stop().catch(finished.reject) }
  process.on('SIGTERM', signal)
  process.on('SIGINT', signal)
  const launch = (): void => {
    if (stopping) return
    record.state = 'starting'
    delete record.url
    const started = Date.now()
    const stream = logStream(p.log)
    child = fork(dshBin(), ['--profile', profile, '--host', config.host, '--port', String(config.port)], {
      env: { ...hostEnvironment(p), MAYFLY_MANAGED_HOST: '1' }, silent: true, windowsHide: true,
    })
    const owned = child
    if (owned.pid !== undefined) record.hostPid = owned.pid
    void persist().catch(finished.reject)
    owned.stdout!.on('data', chunk => stream.write(chunk as Buffer))
    owned.stderr!.on('data', chunk => stream.write(chunk as Buffer))
    owned.on('message', message => {
      if (stopping || child !== owned || message === null || typeof message !== 'object') return
      const ready = message as { type?: string, url?: string }
      if (ready.type !== 'mayfly-ready' || typeof ready.url !== 'string') return
      record.url = ready.url
      record.state = 'running'
      void persist().catch(finished.reject)
    })
    owned.once('error', error => { appendLog(p.log, `Host spawn failed: ${error.message}\n`); failed = true; finished.resolve() })
    owned.once('exit', (code, exitSignal) => {
      stream.end()
      if (stopping) return
      delete record.url
      delete record.hostPid
      record.state = code === 0 ? 'stopped' : 'failed'
      appendLog(p.log, `Host exited: ${code ?? exitSignal}\n`)
      if (code === 0 || process.platform !== 'win32') { failed = code !== 0; finished.resolve(); return }
      if (Date.now() - started >= 60_000) failures = 0
      failures++
      if (failures >= 10) { failed = true; finished.resolve(); return }
      void persist().then(() => {
        if (!stopping) retry = setTimeout(launch, Math.min(30_000, 1000 * 2 ** (failures - 1)))
      }).catch(finished.reject)
    })
  }
  try {
    await persist()
    launch()
    await finished.promise
  } finally {
    stopping = true
    process.off('SIGTERM', signal)
    process.off('SIGINT', signal)
    await stop()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    const current = await readJson<RecordState>(p.record)
    if (current?.generation === record.generation) {
      record.state = failed ? 'failed' : 'stopped'
      delete record.url
      delete record.hostPid
      await persist()
      await removeSocket(p)
    }
    // Host diagnostics stay in rotating logs; the private record retains the last failure.
    if (failed) process.exitCode = 1
  }
}
