/** Local Host readiness, serialized server actions and terminal attachment admission. @module */
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { initialize, packageManifest } from './profiles.ts'
import { isEnabled, setEnabled, startService, stopService } from './platform.ts'
import { alive, delay, locked, paths, readJson, request, writeJson, type Configuration, type Paths, type RecordState, type Reply } from './state.ts'
import type { Options } from './options.ts'
import { showLogs } from './logs.ts'

/** Authenticate against the real Host rather than trusting PID or supervisor state. */
export async function healthy(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    const connect = new URL('connect', parsed)
    connect.searchParams.set('token', parsed.searchParams.get('token') ?? '')
    const response = await fetch(connect, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
    await response.body?.cancel()
    return response.status >= 200 && response.status < 400 && response.headers.has('set-cookie')
  } catch { return false }
}

/** Resolve the exact live supervisor and optionally verify its Host handshake. */
export async function inspect(p: Paths, authenticate = true): Promise<Reply | undefined> {
  const record = await readJson<RecordState>(p.record)
  if (!record) return undefined
  if (!alive(record.pid) || record.state === 'stopped') {
    const { url: _url, ...rest } = record
    return { ...rest, state: record.state === 'stopped' ? 'stopped' : 'failed' }
  }
  const reply = await request(p, record, 'status')
  if (reply.state === 'running' && (!reply.url || (authenticate && !await healthy(reply.url)))) return { ...reply, state: 'failed' }
  return reply
}

async function stop(p: Paths): Promise<void> {
  const record = await readJson<RecordState>(p.record)
  if (record && record.state !== 'stopped' && alive(record.pid)) await request(p, record, 'stop')
  await stopService(p)
  const started = Date.now()
  while (record && alive(record.pid)) {
    const current = await readJson<RecordState>(p.record)
    if (current?.generation !== record.generation || current.state === 'stopped' || current.state === 'failed') break
    if (Date.now() - started > 12_000) throw new Error('Mayfly server did not stop; inspect its service manager and logs')
    await delay(100)
  }
}

/** Initialize and start one instance, returning only after the native Host authenticates. */
export async function ensure(options: Options, bin: string, output: (text: string) => void): Promise<Reply> {
  const p = paths(options.profile)
  return locked(p, async () => {
    if (options.action === 'restart') await stop(p)
    const current = await inspect(p)
    const stored = await readJson<Configuration>(p.config)
    const configuration: Configuration = { host: options.host ?? stored?.host ?? '127.0.0.1', port: options.port ?? stored?.port ?? 0,
      version: packageManifest('@ephemeral-ai/mayfly-host').version }
    if (!isIP(configuration.host) || ['0.0.0.0', '::'].includes(configuration.host)) throw new Error('--host must be a concrete local IPv4 or IPv6 address')
    if (current?.state === 'running') {
      if (configuration.host !== stored?.host || configuration.port !== stored.port) throw new Error('Server is running with different settings; use mayfly server restart')
      if (current.version !== configuration.version) throw new Error('Running Host version differs from Mayfly; install a matching release')
      return current
    }
    if (current && ['starting', 'stopping', 'failed'].includes(current.state) && alive(current.pid)) throw new Error('Mayfly server is not healthy; use mayfly server restart or inspect logs')
    await initialize(p, options.profile, message => output(`${message}\n`))
    await writeJson(p.config, configuration)
    output(`Starting Mayfly server (${options.profile})…\n`)
    try {
      await startService(p, options.profile, bin)
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const ready = await inspect(p).catch(() => undefined)
        if (ready?.state === 'running') return ready
        if (ready?.state === 'failed' && ready.generation !== current?.generation && !alive(ready.pid)) throw new Error('Mayfly Host exited before readiness; run mayfly server logs')
        await delay(200)
      }
      throw new Error('Mayfly Host did not become ready within 60 seconds; run mayfly server logs')
    } catch (error) {
      await stop(p)
      throw error
    }
  })
}

/** Execute a management action without entering terminal mode. */
export async function manage(options: Options, bin: string, output: (text: string) => void): Promise<void> {
  const p = paths(options.profile)
  if (options.action === 'logs') {
    const lifetime = new AbortController()
    const cancel = (): void => lifetime.abort()
    process.on('SIGINT', cancel)
    process.on('SIGTERM', cancel)
    try { await showLogs(p.log, options.follow, lifetime.signal, output) } finally {
      process.off('SIGINT', cancel)
      process.off('SIGTERM', cancel)
    }
    return
  }
  if (options.action === 'status') {
    const state = await inspect(p)
    const enabled = await isEnabled(p)
    const status = state?.state ?? 'stopped'
    const address = state?.url ? new URL(state.url).origin : '-'
    output(`${options.profile}: ${status}\nManager: ${process.platform === 'linux' ? 'systemd user' : process.platform === 'darwin' ? 'launchd' : 'Mayfly supervisor'}\nAddress: ${address}\nPID: ${state?.hostPid ?? '-'} (supervisor ${state?.pid ?? '-'})\nVersion: ${state?.version ?? '-'}\nLogin startup: ${enabled ? 'enabled' : 'disabled'}\nLogs: ${p.log}\n`)
    process.exitCode = status === 'running' ? 0 : status === 'stopped' ? 3 : 1
    return
  }
  if (options.action === 'start' || options.action === 'restart') {
    const state = await ensure(options, bin, output)
    output(`Mayfly server ${options.profile}: running at ${new URL(state.url!).origin}\n`)
    if (options.printUrl) output(`${state.url}\n`)
    return
  }
  await locked(p, async () => {
    if (options.action === 'stop') await stop(p)
    else if (options.action === 'upgrade') {
      const record = await readJson<RecordState>(p.record)
      if (record && record.state !== 'stopped' && alive(record.pid)) throw new Error('Stop this Host with its original installer and back up its data before upgrading the profile')
      await initialize(p, options.profile, message => output(`${message}\n`), true)
    }
    else {
      await initialize(p, options.profile, message => output(`${message}\n`))
      if (!await readJson<Configuration>(p.config)) await writeJson(p.config, {
        host: '127.0.0.1', port: 0, version: packageManifest('@ephemeral-ai/mayfly-host').version,
      })
      await setEnabled(p, options.profile, bin, options.action === 'enable')
    }
    output(`Mayfly server ${options.profile}: ${options.action === 'stop' ? 'stopped' : options.action === 'upgrade' ? 'profile upgraded; run mayfly server start' : options.action === 'enable' ? 'login startup enabled' : 'login startup disabled'}\n`)
  })
}

/** Bundled bin path is stable for generated OS service definitions. */
export function ownBin(): string { return fileURLToPath(new URL('./bin.js', import.meta.url)) }
