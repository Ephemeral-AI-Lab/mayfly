/** Actual file locks and owned npm-process startup fence concurrent and interrupted updates. @module */
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import { LocalFrontendUpdater, systemLocalUpdateIo } from '../../src/app/operations/local-update.ts'

registerTempDirCleanup()
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
})
const signal = () => new AbortController().signal

async function fixture() {
  const directory = mkdtempTracked('mayfly-update-process-')
  const root = join(directory, 'node_modules', '@ephemeral-ai/mayfly-cli')
  await mkdir(join(root, 'lib'), { recursive: true })
  const entry = join(root, 'lib/bin.js')
  await writeFile(entry, '')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@ephemeral-ai/mayfly-cli', version: '1.0.0' }))
  const native = systemLocalUpdateIo()
  const io = { ...native, entry, temporary: async () => mkdtempTracked('mayfly-update-stage-'),
    run: async (command: string, args: readonly string[], caller?: AbortSignal, ownerPath?: string) => args.includes('root') ? join(directory, 'node_modules') : native.run(command, args, caller, ownerPath),
  }
  const updater = new LocalFrontendUpdater(io)
  const snapshot = await updater.preflight('1.0.0', '1.1.0', signal())
  const marker = (pid: number) => JSON.stringify({ snapshot, host: 'original-host', enabled: true, pid })
  const writer = join(directory, 'writer.mjs')
  await writeFile(writer, `
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const directory = process.argv[2]
const owner = JSON.parse(await readFile(process.argv[3], 'utf8'))
if (owner.state !== 'running' || owner.pid !== process.pid) throw new Error('Prefix write admitted without its durable process owner')
await writeFile(join(directory, 'started'), String(process.pid))
for (let attempt = 0; ; attempt += 1) {
  if (await readFile(join(directory, 'continue'), 'utf8').catch(() => '') === 'yes') break
  if (attempt === 400) throw new Error('Fixture writer timed out')
  await delay(10)
}
await writeFile(join(directory, 'prefix-write'), 'committed')
`)
  return { directory, io, updater, snapshot, marker, writer }
}

it('holds the actual process lock through admitted work after caller abort and allows explicit recovery in the same process', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const caller = new AbortController()
  const pending = f.updater.transaction(f.snapshot, async () => {
    await f.updater.begin(f.snapshot, 'original-host', true)
    entered.resolve()
    await finish.promise
    throw new Error('recovery required')
  }, caller.signal)
  await entered.promise
  caller.abort()
  const other = new LocalFrontendUpdater(f.io)
  await expect(other.transaction(f.snapshot, async () => {}, signal())).rejects.toThrow('lock')
  finish.resolve()
  await expect(pending).rejects.toThrow('recovery required')
  const recovery = await f.updater.pending(signal())
  expect(recovery?.host).toBe('original-host')
  await f.updater.recovery(recovery!, async () => {
    await expect(other.recovery(recovery!, async () => {}, signal())).rejects.toThrow('lock')
    expect(JSON.parse(await readFile(f.snapshot.lockPath, 'utf8')).pid).toBe(process.pid)
    await f.updater.finish(f.snapshot)
  }, signal())
  expect(await f.updater.pending(signal())).toBeUndefined()
})

it('rejects changed recovery facts and unconfirmed worker startup before any recovery mutation', async () => {
  const f = await fixture()
  await writeFile(f.snapshot.lockPath, f.marker(2_147_483_647))
  const recovery = await f.updater.pending(signal())
  await writeFile(f.snapshot.lockPath, JSON.stringify({ ...JSON.parse(f.marker(2_147_483_647)), host: 'different-host' }))
  const mutate = vi.fn(async () => {})
  await expect(f.updater.recovery(recovery!, mutate, signal())).rejects.toThrow('changed before recovery')
  await writeFile(`${f.snapshot.lockPath}.worker`, JSON.stringify({ state: 'starting' }))
  await expect(f.updater.pending(signal())).rejects.toThrow('manual repair')
  expect(mutate).not.toHaveBeenCalled()
})

it('recovers the captured installation after npm removes its entry and manifest, while refusing foreign prefixes and changed snapshots', async () => {
  const f = await fixture()
  await expect(f.updater.transaction(f.snapshot, async () => {
    await f.updater.begin(f.snapshot, 'original-host', true)
    await rm(f.io.entry!)
    await rm(join(f.snapshot.root, 'package.json'))
    throw new Error('npm left the launcher incomplete')
  }, signal())).rejects.toThrow('launcher incomplete')
  await expect(new LocalFrontendUpdater(f.io).pending(signal())).rejects.toMatchObject({ code: 'ENOENT' })
  vi.spyOn(f.io, 'run').mockResolvedValueOnce(f.directory)
  await expect(f.updater.pending(signal())).rejects.toThrow('original installer')
  const changed = { ...f.snapshot, target: '1.2.0' }
  await writeFile(f.snapshot.lockPath, JSON.stringify({ snapshot: changed, host: 'original-host', enabled: true, pid: process.pid }))
  await expect(f.updater.pending(signal())).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(f.snapshot.lockPath, f.marker(process.pid))
  const recovery = await f.updater.pending(signal())
  expect(recovery).toEqual({ snapshot: f.snapshot, host: 'original-host', enabled: true })
  await f.updater.recovery(recovery!, async () => {
    await writeFile(f.io.entry!, '')
    await writeFile(join(f.snapshot.root, 'package.json'), JSON.stringify({ name: '@ephemeral-ai/mayfly-cli', version: f.snapshot.current }))
    await f.updater.finish(f.snapshot)
  }, signal())
  expect(await f.updater.pending(signal())).toBeUndefined()
})

it('rejects an npm-linked source checkout even when the global package symlink resolves to its launcher', async () => {
  const f = await fixture()
  const linked = join(f.directory, 'source')
  await mkdir(join(linked, 'lib'), { recursive: true })
  await writeFile(join(linked, 'lib/bin.js'), '')
  await writeFile(join(linked, 'package.json'), JSON.stringify({ name: '@ephemeral-ai/mayfly-cli', version: '1.0.0' }))
  await rm(f.snapshot.root, { recursive: true })
  await symlink(linked, f.snapshot.root, 'dir')
  await expect(new LocalFrontendUpdater(f.io).preflight('1.0.0', '1.1.0', signal())).rejects.toThrow('original installer')
})

it('records the actual npm Node PID before that same process can write the prefix', async () => {
  const f = await fixture()
  const workerPath = `${f.snapshot.lockPath}.worker`
  const pending = f.io.run(process.execPath, [f.writer, f.directory, workerPath], undefined, workerPath)
  await vi.waitFor(async () => { expect(await readFile(join(f.directory, 'started'), 'utf8')).toMatch(/^\d+$/u) })
  const worker = JSON.parse(await readFile(workerPath, 'utf8')) as { pid: number, state: string }
  expect(worker.state).toBe('running')
  expect(f.io.running(worker.pid)).toBe(true)
  await writeFile(join(f.directory, 'continue'), 'yes')
  await pending
  expect(await readFile(join(f.directory, 'prefix-write'), 'utf8')).toBe('committed')
  await expect(readFile(workerPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('starts the actual npm CLI through the owned preloader and clears ownership after a failed process', async () => {
  const f = await fixture()
  const native = systemLocalUpdateIo()
  const workerPath = `${f.snapshot.lockPath}.worker`
  expect((await native.run(native.node, [native.npm, '--version'], undefined, workerPath)).trim()).toMatch(/^\d+\.\d+\.\d+/u)
  await expect(native.run(native.node, [join(f.directory, 'missing-npm.mjs')], undefined, workerPath)).rejects.toThrow('Local update process failed')
  await expect(readFile(workerPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses takeover while an npm writer survives its parent and takes over a dead holder only after the writer is gone', async () => {
  const f = await fixture()
  const moduleUrl = new URL('../../src/app/operations/local-update.ts', import.meta.url).href
  const code = `
const { systemLocalUpdateIo } = await import(process.argv[1])
const io = systemLocalUpdateIo()
const [lock, marker, writer, directory] = process.argv.slice(2)
await io.lock(lock, async () => {
  await io.claim(lock, JSON.stringify({ ...JSON.parse(marker), pid: process.pid }))
  await io.run(process.execPath, [writer, directory, lock + '.worker'], undefined, lock + '.worker')
}, new AbortController().signal)
`
  const parent = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '--eval', code, moduleUrl, f.snapshot.lockPath, f.marker(0), f.writer, f.directory], { stdio: ['ignore', 'ignore', 'pipe'] })
  children.push(parent)
  let stderr = ''
  parent.stderr!.on('data', data => { stderr += String(data) })
  let workerPid: number | undefined
  try {
    await vi.waitFor(async () => {
      if (parent.exitCode !== null) throw new Error(stderr)
      workerPid = Number(await readFile(join(f.directory, 'started'), 'utf8'))
      expect(workerPid).toBeGreaterThan(0)
    })
    parent.kill('SIGKILL')
    await once(parent, 'exit')
    await expect(f.updater.pending(signal())).rejects.toThrow('earlier npm worker')
    await writeFile(join(f.directory, 'continue'), 'yes')
    await vi.waitFor(async () => { expect(await readFile(join(f.directory, 'prefix-write'), 'utf8')).toBe('committed') })
    await vi.waitFor(() => { expect(f.io.running(workerPid!)).toBe(false) })
    const recovery = await f.updater.pending(signal())
    expect(recovery?.host).toBe('original-host')
    await f.updater.recovery(recovery!, async () => { await f.updater.finish(f.snapshot) }, signal())
    expect(await f.updater.pending(signal())).toBeUndefined()
  } finally { if (workerPid !== undefined && f.io.running(workerPid)) process.kill(workerPid, 'SIGKILL') }
})
