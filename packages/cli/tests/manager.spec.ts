/** Server action behavior, real readiness admission and local/remote isolation. @module */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parse } from '../src/options.ts'
import type { RecordState } from '../src/state.ts'

vi.mock('../src/state.ts', async original => ({
  ...await original<typeof import('../src/state.ts')>(), readJson: vi.fn(), writeJson: vi.fn(), request: vi.fn(), alive: vi.fn(),
  locked: vi.fn(async (_p, operation) => operation()), delay: vi.fn(),
}))
vi.mock('../src/profiles.ts', () => ({ initialize: vi.fn(), packageManifest: () => ({ version: '1' }) }))
vi.mock('../src/platform.ts', () => ({ isEnabled: vi.fn(), setEnabled: vi.fn(), startService: vi.fn(), stopService: vi.fn() }))
vi.mock('../src/logs.ts', () => ({ showLogs: vi.fn() }))

import { alive, paths, readJson, request, writeJson, delay } from '../src/state.ts'
import { initialize } from '../src/profiles.ts'
import { isEnabled, setEnabled, startService, stopService } from '../src/platform.ts'
import { showLogs } from '../src/logs.ts'
import { ensure, healthy, inspect, manage, ownBin } from '../src/manager.ts'

const record: RecordState = { generation: 'one', secret: 'secret', pid: 123, profile: 'mayfly', version: '1', state: 'running', hostPid: 456, url: 'http://127.0.0.1:1/?token=SECRET' }
const output = vi.fn()
let current: RecordState | undefined
let configuration: { host: string, port: number, version: string } | undefined
const exitCode = process.exitCode
beforeEach(() => {
  vi.clearAllMocks()
  current = undefined
  configuration = undefined
  vi.mocked(readJson).mockImplementation(async path => path.endsWith('config.json') ? configuration : current)
  vi.mocked(writeJson).mockImplementation(async (path, value) => { if (path.endsWith('config.json')) configuration = value as typeof configuration })
  vi.mocked(alive).mockReturnValue(true)
  vi.mocked(request).mockImplementation(async () => ({ ...current! }))
  vi.mocked(startService).mockImplementation(async () => { current = { ...record } })
  vi.mocked(isEnabled).mockResolvedValue(false)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { 'set-cookie': 'secret' } })))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = exitCode })

it('authenticates readiness without retaining cookies or following redirects', async () => {
  expect(await healthy(record.url!)).toBe(true)
  expect(fetch).toHaveBeenCalledWith(expect.any(URL), { redirect: 'manual', signal: expect.any(AbortSignal) })
  vi.mocked(fetch).mockResolvedValueOnce(new Response('body', { status: 401 }))
  expect(await healthy(record.url!)).toBe(false)
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
  expect(await healthy(record.url!)).toBe(false)
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
  expect(await healthy(record.url!)).toBe(false)
  expect(await healthy('bad')).toBe(false)
  expect(await healthy('http://localhost')).toBe(true)
})

it('upgrades a stopped managed profile explicitly and refuses a live supervisor', async () => {
  vi.mocked(initialize).mockImplementation(async (_p, _profile, progress) => progress('upgrading'))
  for (const state of [undefined, { ...record, state: 'stopped' }, { ...record, state: 'failed' }]) {
    current = state
    vi.mocked(alive).mockReturnValue(false)
    await manage(parse(['server', 'upgrade']), '/bin', output)
    expect(initialize).toHaveBeenLastCalledWith(paths('mayfly'), 'mayfly', expect.any(Function), true)
  }
  vi.mocked(alive).mockReturnValue(true)
  current = { ...record, state: 'stopped' }
  await manage(parse(['server', 'upgrade']), '/bin', output)
  current = { ...record }
  await expect(manage(parse(['server', 'upgrade']), '/bin', output)).rejects.toThrow('original installer')
  expect(startService).not.toHaveBeenCalled()
  expect(output).toHaveBeenCalledWith(expect.stringContaining('profile upgraded'))
})

it('distinguishes absent, stale, stopped, unhealthy and healthy instances', async () => {
  const p = paths('mayfly')
  expect(await inspect(p)).toBeUndefined()
  current = { ...record }
  vi.mocked(alive).mockReturnValue(false)
  expect(await inspect(p)).toMatchObject({ state: 'failed' })
  current.state = 'stopped'
  expect(await inspect(p)).toMatchObject({ state: 'stopped' })
  vi.mocked(alive).mockReturnValue(true)
  current = { ...record }
  expect(await inspect(p)).toMatchObject({ state: 'running' })
  delete current.url
  expect(await inspect(p)).toMatchObject({ state: 'failed' })
  current = { ...record }
  vi.mocked(fetch).mockRejectedValueOnce(new Error())
  expect(await inspect(p)).toMatchObject({ state: 'failed' })
  expect(await inspect(p, false)).toMatchObject({ state: 'running' })
  current.state = 'starting'
  expect(await inspect(p)).toMatchObject({ state: 'starting' })
})

it('initializes once, waits for readiness and returns a matching running instance', async () => {
  vi.mocked(initialize).mockImplementation(async (_p, _profile, progress) => progress('installing'))
  expect(await ensure(parse([]), '/bin', output)).toMatchObject({ state: 'running' })
  expect(output).toHaveBeenCalledWith('installing\n')
  expect(configuration).toEqual({ host: '127.0.0.1', port: 0, version: '1' })
  vi.mocked(initialize).mockClear()
  await ensure(parse([]), '/bin', output)
  expect(initialize).not.toHaveBeenCalled()
  await expect(ensure(parse(['server', '--port=10']), '/bin', output)).rejects.toThrow('different settings')
  current!.version = 'old'
  await expect(ensure(parse([]), '/bin', output)).rejects.toThrow('version differs')
})

it('validates bind settings and refuses to replace an unverified running supervisor', async () => {
  for (const host of ['0.0.0.0', '::', 'localhost']) await expect(ensure(parse(['server', `--host=${host}`]), '/bin', output)).rejects.toThrow('concrete')
  current = { ...record, state: 'starting' }
  await expect(ensure(parse([]), '/bin', output)).rejects.toThrow('not healthy')
})

it('waits through transient control errors, rolls back failed startup and bounds readiness', async () => {
  vi.mocked(startService).mockImplementation(async () => { current = { ...record, state: 'starting' } })
  vi.mocked(delay).mockImplementationOnce(async () => { current = { ...record } })
  await ensure(parse([]), '/bin', output)
  current = undefined
  vi.mocked(delay).mockImplementationOnce(async () => { current = { ...record, state: 'failed' }; vi.mocked(alive).mockReturnValue(false) })
  await expect(ensure(parse([]), '/bin', output)).rejects.toThrow('exited before readiness')
  expect(stopService).toHaveBeenCalled()
  current = undefined
  vi.mocked(alive).mockReturnValue(true)
  vi.mocked(startService).mockImplementation(async () => {})
  let time = 0
  vi.spyOn(Date, 'now').mockImplementation(() => { time += 30_001; return time })
  await expect(ensure(parse([]), '/bin', output)).rejects.toThrow('60 seconds')
})

it('reports safe status with conventional exit codes and action output', async () => {
  await manage(parse(['server', 'status']), '/bin', output)
  expect(process.exitCode).toBe(3)
  current = { ...record }
  await manage(parse(['server', 'status']), '/bin', output)
  expect(process.exitCode).toBe(0)
  expect(output.mock.calls.flat().join('')).not.toContain('SECRET')
  vi.mocked(isEnabled).mockResolvedValue(true)
  current.state = 'failed'
  await manage(parse(['server', 'status']), '/bin', output)
  expect(process.exitCode).toBe(1)
  current = undefined
  await manage(parse(['server', 'start', '--print-startup-url']), '/bin', output)
  expect(output).toHaveBeenCalledWith(`${record.url}\n`)
  expect(ownBin()).toMatch(/[/\\]bin\.js$/u)
})

it('stops idempotently and changes enablement without starting a Host', async () => {
  await manage(parse(['server', 'stop']), '/bin', output)
  expect(stopService).toHaveBeenCalled()
  current = { ...record, state: 'stopped' }
  await manage(parse(['server', 'stop']), '/bin', output)
  expect(request).not.toHaveBeenCalled()
  current = undefined
  await manage(parse(['server', 'enable']), '/bin', output)
  expect(setEnabled).toHaveBeenLastCalledWith(expect.anything(), 'mayfly', '/bin', true)
  await manage(parse(['server', 'disable']), '/bin', output)
  expect(setEnabled).toHaveBeenLastCalledWith(expect.anything(), 'mayfly', '/bin', false)
  expect(startService).not.toHaveBeenCalled()
  current = { ...record }
  vi.mocked(request).mockImplementation(async (_p, _record, action) => {
    if (action === 'stop') current = { ...record, state: 'stopped' }
    return { ...current! }
  })
  await manage(parse(['server', 'restart']), '/bin', output)
  expect(startService).toHaveBeenCalled()
})

it('retires log-follow signal listeners after success and failure', async () => {
  const before = process.listenerCount('SIGINT')
  vi.mocked(showLogs).mockImplementation(async (_file, _follow, signal) => {
    const listener = process.listeners('SIGINT').at(-1)!
    listener.call(process, 'SIGINT')
    expect(signal.aborted).toBe(true)
  })
  await manage(parse(['server', 'logs', '--follow']), '/bin', output)
  expect(process.listenerCount('SIGINT')).toBe(before)
  vi.mocked(showLogs).mockRejectedValueOnce(new Error('read failed'))
  await expect(manage(parse(['server', 'logs']), '/bin', output)).rejects.toThrow('read failed')
  expect(process.listenerCount('SIGINT')).toBe(before)
})

it('waits for exact supervisor shutdown, handles replacement and bounds a stalled stop', async () => {
  current = { ...record }
  vi.mocked(delay).mockImplementationOnce(async () => { current = { ...record, generation: 'replacement' } })
  await manage(parse(['server', 'stop']), '/bin', output)
  current = { ...record }
  let time = 0
  vi.spyOn(Date, 'now').mockImplementation(() => { time += 13_000; return time })
  await expect(manage(parse(['server', 'stop']), '/bin', output)).rejects.toThrow('did not stop')
})

it('retries a transient control failure during startup and prints each platform manager', async () => {
  vi.mocked(startService).mockImplementation(async () => {
    current = { ...record }
    vi.mocked(request).mockRejectedValueOnce(new Error('control starting'))
  })
  await ensure(parse([]), '/bin', output)
  const platform = process.platform
  const getuid = Object.getOwnPropertyDescriptor(process, 'getuid')
  Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true })
  try {
    for (const value of ['darwin', 'win32']) {
      Object.defineProperty(process, 'platform', { value })
      await manage(parse(['server', 'status']), '/bin', output)
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: platform })
    if (getuid) Object.defineProperty(process, 'getuid', getuid)
    else Reflect.deleteProperty(process, 'getuid')
  }
})
