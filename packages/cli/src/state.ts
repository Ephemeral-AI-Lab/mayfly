/** Private local service records, authenticated control and serialized management. @module */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, lstat, chmod, link } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createConnection } from 'node:net'
import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
/** Execute a native tool directly, retaining ordinary string diagnostics. */
export async function execute(file: string, args: readonly string[], options: ExecFileOptions = {}): Promise<{ stdout: string, stderr: string }> {
  return exec(file, args, { ...options, encoding: 'utf8' })
}
export interface Paths { home: string, dir: string, config: string, record: string, socket: string, log: string, lock: string }
export interface RecordState { generation: string, secret: string, pid: number, profile: string, version: string, url?: string, hostPid?: number, state: string }
export interface Configuration { host: string, port: number, version: string }
export interface Reply { state: string, generation: string, pid: number, hostPid?: number, url?: string, version: string }

/** Resolve an instance without consulting global Harness state. */
export function paths(profile: string): Paths {
  const home = resolve(process.env.MAYFLY_HOME || join(homedir(), '.mayfly'))
  const dir = join(home, 'run', profile)
  const key = createHash('sha256').update(dir).digest('hex').slice(0, 24)
  return { home, dir, config: join(dir, 'config.json'), record: join(dir, 'connection.json'),
    socket: process.platform === 'win32' ? `\\\\.\\pipe\\mayfly-${key}` : join('/tmp', `mayfly-${process.getuid!()}`, `${key}.sock`),
    log: join(home, 'logs', profile, 'server.log'), lock: join(dir, 'operation.lock') }
}

/** Restrict directories before writing any credentials, including Windows inheritance. */
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Mayfly runtime directory must be a real directory')
  if (process.platform === 'win32') {
    // Replace the DACL atomically: removing inheritance alone would retain
    // pre-existing explicit grants to other users on a configured data root.
    const script = '$ErrorActionPreference="Stop"; '
      + '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; '
      + '$acl=New-Object System.Security.AccessControl.DirectorySecurity; '
      + '$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); '
      + '$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); '
      + '$acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($env:MAYFLY_ACL_PATH,$acl)'
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, MAYFLY_ACL_PATH: path },
    })
  } else {
    if (stat.uid !== process.getuid!()) throw new Error('Mayfly runtime directory belongs to another user')
    await chmod(path, 0o700)
  }
}

/** Atomically replace a private JSON record. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** Read optional state, treating malformed records as errors rather than overwriting them. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`Cannot read Mayfly state at ${path}`)
  }
}

/** Check liveness only; a PID is never authority to terminate a process. */
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/** Serialize operations and recover locks left by a dead CLI process. */
export async function locked<T>(p: Paths, operation: () => Promise<T>): Promise<T> {
  await privateDirectory(p.home)
  await privateDirectory(p.dir)
  const started = Date.now()
  const candidate = `${p.lock}.${randomUUID()}`
  await writeFile(candidate, String(process.pid), { flag: 'wx', mode: 0o600 })
  try {
    while (true) {
      try {
        // Publish a completely written owner atomically. A reader must never
        // mistake a newly created, still-empty file for a dead owner.
        await link(candidate, p.lock)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const owner = Number(await readFile(p.lock, 'utf8').catch(() => '0'))
        if (!alive(owner)) {
          // Only one reaper may remove a stale lock. Re-read under that guard so
          // a second contender cannot remove a newly acquired live lock.
          let reaping = false
          try {
            await writeFile(`${p.lock}.reap`, '', { flag: 'wx', mode: 0o600 })
            reaping = true
            const current = Number(await readFile(p.lock, 'utf8').catch(() => '0'))
            if (!alive(current)) await rm(p.lock, { force: true })
          } catch (reapError) {
            if ((reapError as NodeJS.ErrnoException).code !== 'EEXIST') throw reapError
          } finally { if (reaping) await rm(`${p.lock}.reap`, { force: true }) }
        }
        if (Date.now() - started > 120_000) throw new Error('Another Mayfly server operation is still running')
        await delay(100)
      }
    }
    try { return await operation() } finally { await rm(p.lock, { force: true }) }
  } finally { await rm(candidate, { force: true }) }
}

/** A bounded authenticated request to the exact local supervisor generation. */
export function request(p: Paths, record: RecordState, action: 'status' | 'stop'): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const socket = createConnection(p.socket)
    let received = ''
    const done = (error?: Error, reply?: Reply): void => {
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else resolveReply(reply!)
    }
    socket.setTimeout(2000, () => done(new Error('Mayfly service control timed out')))
    socket.on('error', () => done(new Error('Mayfly service control is unavailable')))
    socket.on('connect', () => socket.write(`${JSON.stringify({ action, secret: record.secret, generation: record.generation })}\n`))
    socket.on('end', () => done(new Error('Incomplete Mayfly service reply')))
    socket.on('data', data => {
      received += String(data)
      if (received.length > 64 * 1024) { done(new Error('Invalid Mayfly service reply')); return }
      if (!received.includes('\n')) return
      try {
        const reply = JSON.parse(received.split('\n')[0]!) as Reply
        if (reply.generation !== record.generation || reply.pid !== record.pid) throw new Error('Mayfly service identity changed')
        done(undefined, reply)
      } catch { done(new Error('Invalid Mayfly service identity')) }
    })
  })
}

/** Timer waits used by bounded readiness and shutdown loops. */
export function delay(ms: number): Promise<void> { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)) }
