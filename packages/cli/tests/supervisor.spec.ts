/** Authenticated supervision, stop ownership, crash recovery and stale generations. @module */
import { EventEmitter } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), fork: vi.fn() }))
const network = vi.hoisted(() => ({ accepted: [] as Socket[] }))
vi.mock('node:net', async original => {
  const actual = await original<typeof import('node:net')>()
  return { ...actual, createServer: (callback: (socket: Socket) => void) => actual.createServer(socket => { network.accepted.push(socket); callback(socket) }) }
})
vi.mock('../src/profiles.ts', () => ({ dshBin: () => '/native-dsh', hostEnvironment: () => ({}), packageManifest: () => ({ version: '1' }) }))
vi.mock('../src/state.ts', async original => {
  const actual = await original<typeof import('../src/state.ts')>()
  return { ...actual, paths: vi.fn(actual.paths), privateDirectory: vi.fn(async (path: string) => { await mkdir(path, { recursive: true }) }) }
})

import { fork } from 'node:child_process'
import * as state from '../src/state.ts'
import { paths, readJson, request, writeJson, type Paths, type RecordState } from '../src/state.ts'
import { sameSecret, supervise } from '../src/supervisor.ts'

registerTempDirCleanup()
const platform = process.platform
const exitCode = process.exitCode
let p: Paths
interface FakeChild extends EventEmitter { pid: number | undefined, exitCode: number | null, signalCode: string | null, connected: boolean, stdout: EventEmitter, stderr: EventEmitter, send: ReturnType<typeof vi.fn>, kill: ReturnType<typeof vi.fn> }
let children: FakeChild[]
let ready = true
function exit(child: FakeChild, code: number | null = 0, signal: string | null = null): void {
  child.exitCode = code
  child.signalCode = signal
  child.emit('exit', code, signal)
}
function child(): FakeChild {
  const value = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null, connected: true, stdout: new EventEmitter(), stderr: new EventEmitter(), send: vi.fn(), kill: vi.fn() }) as FakeChild
  value.send.mockImplementation(() => queueMicrotask(() => exit(value)))
  value.kill.mockImplementation(() => { queueMicrotask(() => exit(value, null, 'SIGKILL')); return true })
  children.push(value)
  if (ready) queueMicrotask(() => value.emit('message', { type: 'mayfly-ready', url: 'http://127.0.0.1/?token=secret' }))
  return value
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 3000
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setImmediate(resolve)) }
  throw new Error('Supervisor fixture did not settle')
}
async function running(): Promise<RecordState> {
  return until(async () => { const record = await readJson<RecordState>(p.record); return record?.state === 'running' ? record : undefined })
}
beforeEach(async () => {
  vi.stubEnv('MAYFLY_HOME', mkdtempTracked('mayfly-supervise-'))
  vi.mocked(paths).mockImplementation((await vi.importActual<typeof import('../src/state.ts')>('../src/state.ts')).paths)
  p = paths('work')
  vi.mocked(paths).mockReturnValue(p)
  await mkdir(p.dir, { recursive: true })
  await writeJson(p.config, { host: '127.0.0.1', port: 0, version: '1' })
  children = []
  network.accepted = []
  ready = true
  vi.mocked(fork).mockReset().mockImplementation(() => child() as never)
})
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); process.exitCode = exitCode; vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('compares secrets without accepting incorrect types or lengths', () => {
  expect(sameSecret('secret', 'secret')).toBe(true)
  expect(sameSecret('secrex', 'secret')).toBe(false)
  expect(sameSecret('short', 'secret')).toBe(false)
  expect(sameSecret(null, 'secret')).toBe(false)
})

it('authenticates a real control socket, rejects malformed commands and retires late readiness', async () => {
  const task = supervise('work')
  const record = await running()
  expect(await request(p, record, 'status')).toMatchObject({ state: 'running', hostPid: 100 })
  expect(fork).toHaveBeenCalledWith('/native-dsh', ['--profile', 'work', '--host', '127.0.0.1', '--port', '0'], expect.objectContaining({ silent: true, windowsHide: true }))
  for (const message of ['bad\n', 'a'.repeat(5000), `${JSON.stringify({ secret: 'wrong', generation: record.generation, action: 'stop' })}\n`, `${JSON.stringify({ secret: record.secret, generation: 'wrong', action: 'stop' })}\n`, `${JSON.stringify({ secret: record.secret, generation: record.generation, action: 'bad' })}\n`]) {
    await new Promise<void>((resolveClose, reject) => {
      const socket = createConnection(p.socket, () => socket.write(message))
      socket.on('error', reject)
      socket.on('close', () => resolveClose())
    })
  }
  for (const message of [null, 'bad', {}, { type: 'other' }, { type: 'mayfly-ready', url: 42 }]) children[0]!.emit('message', message)
  children[0]!.stdout.emit('data', Buffer.from('normal diagnostic\n'))
  children[0]!.stderr.emit('data', Buffer.from('?token=secret\n'))
  // A second worker must verify and reuse the existing owner.
  await supervise('work')
  expect(children).toHaveLength(1)
  await request(p, record, 'stop')
  await task
  const stopped = await readJson<RecordState>(p.record)
  expect(stopped).toMatchObject({ state: 'stopped' })
  expect(stopped?.url).toBeUndefined()
  children[0]!.emit('message', { type: 'mayfly-ready', url: 'late' })
  expect(await readJson(p.record)).toEqual(stopped)
})

it('refuses to overwrite an alive owner whose control identity cannot be verified', async () => {
  await writeJson(p.record, { pid: process.pid, generation: 'old', secret: 'old' })
  await expect(supervise('work')).rejects.toThrow('cannot be verified')
})

it('reports a native crash for system service restart and a clean native exit as stopped', async () => {
  let task = supervise('work')
  await running()
  exit(children[0]!, 2)
  await task
  expect(process.exitCode).toBe(1)
  expect(await readJson(p.record)).toMatchObject({ state: 'failed' })
  // Simulate process replacement: the old worker PID no longer owns the record.
  await writeJson(p.record, { pid: 0 })
  task = supervise('work')
  await running()
  exit(children[1]!, 0)
  await task
  expect(await readJson(p.record)).toMatchObject({ state: 'stopped' })
})

it('handles spawn failure and native signal exits without leaking control listeners', async () => {
  ready = false
  vi.mocked(fork).mockImplementation(() => {
    const value = child()
    value.pid = undefined
    queueMicrotask(() => value.emit('error', new Error('cannot spawn')))
    return value as never
  })
  const listeners = process.listenerCount('SIGTERM')
  await supervise('work')
  expect(process.exitCode).toBe(1)
  expect(process.listenerCount('SIGTERM')).toBe(listeners)
})

it('coalesces signal stops and preserves a replacement generation record', async () => {
  await writeJson(p.record, { pid: process.pid, state: 'stopped' })
  const task = supervise('work')
  const record = await running()
  const listener = process.listeners('SIGTERM').at(-1)!
  listener.call(process, 'SIGTERM')
  listener.call(process, 'SIGTERM')
  await task
  expect(children[0]!.send).toHaveBeenCalledTimes(1)
  expect(await readJson(p.record)).toMatchObject({ state: 'stopped', generation: record.generation })
})

it('retries Windows crashes and cancels a pending backoff on explicit stop', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const task = supervise('work')
  const record = await running()
  exit(children[0]!, 2)
  await until(async () => { const current = await readJson<RecordState>(p.record); return current?.state === 'failed' ? current : undefined })
  await request(p, record, 'stop')
  await task
  expect(children).toHaveLength(1)
  expect(await readJson(p.record)).toMatchObject({ state: 'stopped' })
})

it('forces only its own child after a disconnected Host misses the graceful deadline', async () => {
  const task = supervise('work')
  const record = await running()
  children[0]!.connected = false
  await request(p, record, 'stop')
  await task
  expect(children[0]!.send).not.toHaveBeenCalled()
  expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL')
})

it('limits Windows crash loops, resets after a stable minute and ignores retired child callbacks', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const retries: (() => void)[] = []
  const timeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
    if (ms >= 1000 && ms <= 30_000) { retries.push(callback); return timeout(() => {}, 0) }
    return timeout(callback, ms, ...args)
  }) as typeof setTimeout)
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const task = supervise('work')
  await running()
  now += 70_000
  for (let index = 0; index < 10; index++) {
    const owned = children[index]!
    exit(owned, index === 0 ? null : 2, index === 0 ? 'SIGTERM' : null)
    if (index === 9) break
    const callback = await until(async () => retries.shift())
    callback()
    await until(async () => children[index + 1])
    await running()
    owned.emit('message', { type: 'mayfly-ready', url: 'retired' })
    expect((await readJson<RecordState>(p.record))?.url).not.toBe('retired')
  }
  await task
  expect(process.exitCode).toBe(1)
  expect(children).toHaveLength(10)
})

it('cannot relaunch from a cancelled callback or remove a replacement generation', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  let callback: (() => void) | undefined
  const timeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 1000) { callback = fn; return timeout(() => {}, 0) }
    return timeout(fn, ms, ...args)
  }) as typeof setTimeout)
  const task = supervise('work')
  const record = await running()
  exit(children[0]!, 2)
  await until(async () => callback)
  vi.spyOn(state, 'readJson').mockResolvedValueOnce({ generation: 'replacement' })
  await request(p, record, 'stop')
  await task
  callback!()
  expect(children).toHaveLength(1)
})

it('retires idle, partially written and failed local control connections', async () => {
  const task = supervise('work')
  const record = await running()
  await new Promise<void>((resolveClose, reject) => {
    const socket = createConnection(p.socket, () => socket.write('partial'))
    socket.on('error', reject)
    socket.on('close', () => resolveClose())
  })
  await new Promise<void>((resolveClose, reject) => {
    const socket = createConnection(p.socket, () => {
      network.accepted.at(-1)!.emit('error', new Error('control disconnected'))
    })
    socket.on('error', reject)
    socket.on('close', () => resolveClose())
  })
  await request(p, record, 'stop')
  await task
})

it('still shuts down its child after a failed state write', async () => {
  const task = supervise('work')
  const record = await running()
  vi.spyOn(state, 'writeJson').mockRejectedValueOnce(new Error('disk full'))
  await request(p, record, 'stop')
  await task
  expect(children[0]!.send).toHaveBeenCalledWith({ type: 'mayfly-stop' })
})

it('does not schedule recovery after shutdown supersedes a pending crash write', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const task = supervise('work')
  await running()
  exit(children[0]!, 2)
  process.listeners('SIGTERM').at(-1)!.call(process, 'SIGTERM')
  await task
  expect(children).toHaveLength(1)
})
