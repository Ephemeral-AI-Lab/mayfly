/** Actual private-file, lock and authenticated socket integration scenarios. @module */
import { createServer } from 'node:net'
import * as fs from 'node:fs/promises'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile), link: vi.fn(actual.link) }
})
import { alive, delay, locked, paths, privateDirectory, readJson, request, writeJson, type RecordState } from '../src/state.ts'

registerTempDirCleanup()
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.readFile).mockImplementation(actual.readFile)
  vi.mocked(fs.writeFile).mockImplementation(actual.writeFile)
  vi.mocked(fs.link).mockImplementation(actual.link)
})

it('isolates profiles and creates private atomic records without leftover temporary files', async () => {
  vi.stubEnv('MAYFLY_HOME', mkdtempTracked('mayfly-state-'))
  const p = paths('work')
  expect(paths('other').dir).not.toBe(p.dir)
  await privateDirectory(p.dir)
  await writeJson(p.record, { value: 1 })
  await writeJson(p.record, { value: 2 })
  expect(await readJson(p.record)).toEqual({ value: 2 })
  expect((await stat(p.record)).mode & 0o777).toBe(0o600)
  expect((await stat(p.dir)).mode & 0o777).toBe(0o700)
  expect(await readJson(join(p.dir, 'absent'))).toBeUndefined()
  await writeFile(p.record, '{broken')
  await expect(readJson(p.record)).rejects.toThrow('Cannot read Mayfly state')
  await expect(writeJson(join(p.dir, 'absent', 'file'), {})).rejects.toThrow()
  await symlink(p.dir, join(p.home, 'alias'))
  await expect(privateDirectory(join(p.home, 'alias'))).rejects.toThrow('real directory')
  await writeFile(join(p.home, 'plain'), '')
  await expect(privateDirectory(join(p.home, 'plain'))).rejects.toThrow()
})

it('never treats arbitrary or inaccessible PIDs as termination authority', () => {
  expect(alive(0)).toBe(false)
  expect(alive(-1)).toBe(false)
  expect(alive(Number.NaN)).toBe(false)
  expect(alive(process.pid)).toBe(true)
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'EPERM' }) })
  expect(alive(100)).toBe(true)
  kill.mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }) })
  expect(alive(100)).toBe(false)
})

it('serializes concurrent operations, releases failures and recovers a dead owner', async () => {
  vi.stubEnv('MAYFLY_HOME', mkdtempTracked('mayfly-locks-'))
  const p = paths('work')
  const events: number[] = []
  await Promise.all([
    locked(p, async () => { events.push(1); await delay(50); events.push(2) }),
    locked(p, async () => { events.push(3) }),
  ])
  expect(events).toHaveLength(3)
  expect(events.indexOf(2)).toBe(events.indexOf(1) + 1)
  expect(events).toContain(3)
  await expect(locked(p, async () => { throw new Error('operation failed') })).rejects.toThrow('operation failed')
  await writeFile(p.lock, '0')
  await expect(locked(p, async () => 'recovered')).resolves.toBe('recovered')
  await mkdir(join(p.dir, 'bad-parent'))
  const broken = { ...p, lock: join(p.dir, 'bad-parent') }
  await expect(locked(broken, async () => 'bad')).rejects.toThrow()
})

it('bounds lock waits without deleting a live owner', async () => {
  vi.stubEnv('MAYFLY_HOME', mkdtempTracked('mayfly-busy-lock-'))
  const p = paths('work')
  await privateDirectory(p.dir)
  await writeFile(p.lock, String(process.pid))
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120_001)
  await expect(locked(p, async () => 'bad')).rejects.toThrow('still running')
  expect(await readFile(p.lock, 'utf8')).toBe(String(process.pid))
})

it('propagates lock creation errors and never races another stale-lock reaper', async () => {
  vi.stubEnv('MAYFLY_HOME', mkdtempTracked('mayfly-lock-reaper-'))
  const p = paths('work')
  await expect(locked({ ...p, lock: join(p.dir, 'missing/lock') }, async () => {})).rejects.toThrow()
  vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error('cannot acquire'), { code: 'EACCES' }))
  await expect(locked(p, async () => {})).rejects.toThrow('cannot acquire')
  await writeFile(p.lock, '0')
  await writeFile(`${p.lock}.reap`, '')
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120_001)
  await expect(locked(p, async () => {})).rejects.toThrow('still running')
})

it('rechecks a lock acquired by another owner and propagates reaper filesystem failures', async () => {
  vi.stubEnv('MAYFLY_HOME', mkdtempTracked('mayfly-lock-recheck-'))
  const p = paths('work')
  await privateDirectory(p.dir)
  await writeFile(p.lock, '0')
  const read = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile
  let reads = 0
  vi.spyOn(fs, 'readFile').mockImplementation(((path: string, ...args: unknown[]) => {
    if (path === p.lock) return Promise.resolve(++reads === 1 ? '0' : String(process.pid))
    return Reflect.apply(read, fs, [path, ...args])
  }) as typeof fs.readFile)
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120_001)
  await expect(locked(p, async () => {})).rejects.toThrow('still running')
  vi.restoreAllMocks()
  vi.mocked(fs.readFile).mockImplementation(read)
  const write = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).writeFile
  vi.spyOn(fs, 'writeFile').mockImplementation(((path: string, ...args: unknown[]) => {
    if (path.endsWith('.reap')) return Promise.reject(Object.assign(new Error('reap denied'), { code: 'EACCES' }))
    return Reflect.apply(write, fs, [path, ...args])
  }) as typeof fs.writeFile)
  await expect(locked(p, async () => {})).rejects.toThrow('reap denied')
})

it('authenticates requests and rejects incorrect, truncated and oversized supervisor replies', async () => {
  vi.stubEnv('MAYFLY_HOME', mkdtempTracked('mayfly-rpc-'))
  const p = paths('work')
  await privateDirectory(p.dir)
  const record: RecordState = { generation: 'generation', secret: 'secret', pid: process.pid, profile: 'work', version: '1', state: 'running' }
  let response = `${JSON.stringify(record)}\n`
  const server = createServer(socket => {
    socket.on('error', () => {})
    socket.on('data', data => {
      expect(JSON.parse(String(data))).toEqual({ generation: 'generation', secret: 'secret', action: 'status' })
      if (response !== 'wait') socket.end(response)
    })
  })
  await new Promise<void>(resolveListen => server.listen(p.socket, resolveListen))
  try {
    expect(await request(p, record, 'status')).toMatchObject({ generation: 'generation' })
    for (response of ['bad\n', '{}\n', `${JSON.stringify({ ...record, pid: 1 })}\n`, 'a'.repeat(65 * 1024), 'truncated']) await expect(request(p, record, 'status')).rejects.toThrow()
    response = 'wait'
    await expect(request(p, record, 'status')).rejects.toThrow('timed out')
  } finally { await new Promise<void>(resolveClose => server.close(() => resolveClose())) }
  await expect(request(p, record, 'status')).rejects.toThrow('unavailable')
})
