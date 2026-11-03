/** Frontend updater staging, exact release consistency and bounded I/O contracts. @module tests/remote/local-update */
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../../mayfly/tests/core/temp-dir.ts'
import { LocalFrontendUpdater, systemLocalUpdateIo, type LocalUpdateIo, type LocalUpdateSnapshot } from '../../src/remote/operations/local-update.ts'

const system = vi.hoisted(() => ({ execFile: vi.fn(), temporary: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: system.execFile }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), mkdtemp: system.temporary }))
registerTempDirCleanup()
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })
const current = '1.0.0'
const target = '1.1.0'
const root = '/npm/node_modules/@ephemeral-ai/mayfly-cli'
const signal = () => new AbortController().signal

function fixture() {
  let installed = current
  const versionAt = (path: string) => path.includes('/candidate/') ? target : path.includes('/previous/') ? current : installed
  const io: LocalUpdateIo = {
    entry: `${root}/lib/bin.js`, node: '/node', npm: '/npm-cli.js', pid: 123,
    running: vi.fn(() => false), claim: vi.fn(async () => {}),
    replace: vi.fn(async () => {}), lock: async (_path, operation) => operation(),
    real: vi.fn(async path => path),
    read: vi.fn(async path => {
      if (path.endsWith('.worker')) throw Object.assign(new Error('no worker'), { code: 'ENOENT' })
      const version = versionAt(path)
      return JSON.stringify(path.endsWith('mayfly-remote/package.json')
        ? { version, dependencies: { '@ephemeral-ai/mayfly': version, '@ephemeral-ai/mayfly-ui': version } }
        : { name: '@ephemeral-ai/mayfly-cli', version, dependencies: { '@ephemeral-ai/mayfly-remote': version } })
    }),
    temporary: vi.fn(async () => '/tmp/mayfly-update'), write: vi.fn(async () => {}), append: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    run: vi.fn(async (_command, args) => {
      if (args.includes('root')) return '/npm/node_modules\n'
      if (args.includes('--version')) return `mayfly ${versionAt(args[0]!)}\n`
      if (args.includes('--global')) installed = args.at(-1)!.endsWith(`@${target}`) ? target : current
      return 'validated\n'
    }),
  }
  return { io, updater: new LocalFrontendUpdater(io), installed: () => installed }
}

async function prepared(test: ReturnType<typeof fixture>): Promise<LocalUpdateSnapshot> {
  return test.updater.preflight(current, target, signal())
}

describe('frontend-local updater', () => {
  it('reads the complete canonical channel table through the frontend npm configuration, including npm singleton output', async () => {
    const test = fixture()
    for (const singleton of [false, true]) {
      const document = { 'dist-tags': { latest: target, rc: current, invalid: 42 }, versions: [current, target], time: { [target]: '2026-10-01T00:00:00Z', bad: null } }
      vi.mocked(test.io.run).mockResolvedValueOnce(JSON.stringify(singleton ? [document] : document))
      const caller = signal()
      expect(await test.updater.releases(caller)).toEqual({ tags: { latest: target, rc: current }, versions: [current, target], time: { [target]: '2026-10-01T00:00:00Z' } })
      expect(test.io.run).toHaveBeenLastCalledWith('/node', ['/npm-cli.js', 'view', '@ephemeral-ai/mayfly-cli', '--json'], caller)
    }
    expect(test.io.read).not.toHaveBeenCalled()
    expect(test.io.write).not.toHaveBeenCalled()
  })

  it('refuses malformed or ambiguous registry metadata rather than inventing a channel target', async () => {
    const test = fixture()
    const document = { 'dist-tags': {}, versions: [current], time: {} }
    for (const value of [null, 42, [], [document, document], { ...document, versions: null }, { ...document, versions: [42] }, { ...document, 'dist-tags': [] }, { ...document, time: null }]) {
      vi.mocked(test.io.run).mockResolvedValueOnce(JSON.stringify(value))
      await expect(test.updater.releases(signal())).rejects.toThrow('invalid Mayfly release metadata')
    }
    vi.mocked(test.io.run).mockResolvedValueOnce('invalid json')
    await expect(test.updater.releases(signal())).rejects.toThrow()
    vi.mocked(test.io.run).mockRejectedValueOnce(new Error('registry unavailable'))
    await expect(test.updater.releases(signal())).rejects.toThrow('registry unavailable')
    expect(test.installed()).toBe(current)
  })

  it('stages both pinned graphs, validates exact Remote/presentation dependencies, smokes the real entries and restores offline', async () => {
    const test = fixture()
    const snapshot = await prepared(test)
    expect(snapshot).toMatchObject({ current, target, root, directory: '/tmp/mayfly-update', logPath: '/tmp/mayfly-update/update.log' })
    await test.updater.stage(snapshot, signal())
    const commands = vi.mocked(test.io.run).mock.calls.map(call => call[1])
    expect(commands).toContainEqual(['/npm-cli.js', 'install', '--prefix', '/tmp/mayfly-update/previous', '--ignore-scripts', '--no-audit', '--no-fund', '@ephemeral-ai/mayfly-cli@1.0.0'])
    expect(commands).toContainEqual(['/npm-cli.js', 'install', '--prefix', '/tmp/mayfly-update/candidate', '--ignore-scripts', '--no-audit', '--no-fund', '@ephemeral-ai/mayfly-cli@1.1.0'])
    expect(commands.some(args => args.includes('--input-type=module') && args.includes('--eval'))).toBe(true)
    await test.updater.install(snapshot, signal())
    expect(test.installed()).toBe(target)
    await test.updater.restore(snapshot)
    expect(test.installed()).toBe(current)
    expect(test.io.run).toHaveBeenCalledWith('/node', ['/npm-cli.js', 'install', '--global', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '@ephemeral-ai/mayfly-cli@1.0.0'], undefined, `${snapshot.lockPath}.worker`)
    await test.updater.cleanup(snapshot)
    expect(test.io.remove).toHaveBeenCalledWith('/tmp/mayfly-update/previous')
    expect(test.io.remove).toHaveBeenCalledWith('/tmp/mayfly-update/candidate')
    expect(test.io.write).toHaveBeenCalledWith('/tmp/mayfly-update/recovery.json', expect.stringContaining('"current":"1.0.0"'))
  })

  it('refuses malformed versions, missing entries, linked sources and another global prefix before mutating packages', async () => {
    const test = fixture()
    await expect(test.updater.preflight('bad', target, signal())).rejects.toThrow('exact released versions')
    await expect(test.updater.preflight(current, 'bad', signal())).rejects.toThrow('exact released versions')
    await expect(new LocalFrontendUpdater({ ...test.io, entry: undefined }).preflight(current, target, signal())).rejects.toThrow('installed mayfly launcher')
    vi.mocked(test.io.read).mockResolvedValueOnce(JSON.stringify({ name: 'other', version: current }))
    await expect(prepared(test)).rejects.toThrow('Linked or standalone')
    vi.mocked(test.io.read).mockResolvedValueOnce(JSON.stringify({ name: '@ephemeral-ai/mayfly-cli', version: target }))
    await expect(prepared(test)).rejects.toThrow('Linked or standalone')
    vi.mocked(test.io.real).mockResolvedValueOnce(`${root}/lib/bin.js`).mockResolvedValueOnce('/another/prefix')
    await expect(prepared(test)).rejects.toThrow('original installer')
    expect(test.io.temporary).not.toHaveBeenCalled()
  })

  it('falls back to the hoisted official Remote manifest and rejects inconsistent installed graphs', async () => {
    const test = fixture()
    const snapshot = await prepared(test)
    vi.mocked(test.io.read).mockImplementationOnce(async () => JSON.stringify({ version: target, dependencies: { '@ephemeral-ai/mayfly-remote': target } }))
      .mockRejectedValueOnce(new Error('nested missing'))
      .mockResolvedValueOnce(JSON.stringify({ version: target, dependencies: { '@ephemeral-ai/mayfly': target, '@ephemeral-ai/mayfly-ui': target } }))
    await test.updater.install(snapshot)
    expect(test.io.read).toHaveBeenCalledWith('/npm/node_modules/@ephemeral-ai/mayfly-remote/package.json')
    vi.mocked(test.io.read).mockResolvedValueOnce(JSON.stringify({ version: target, dependencies: {} }))
    await expect(test.updater.install(snapshot)).rejects.toThrow('Launcher and Remote versions are inconsistent')
    vi.mocked(test.io.read).mockResolvedValueOnce(JSON.stringify({ version: target, dependencies: { '@ephemeral-ai/mayfly-remote': target } }))
      .mockResolvedValueOnce(JSON.stringify({ version: current, dependencies: {} }))
    await expect(test.updater.install(snapshot)).rejects.toThrow('presentation versions are inconsistent')
    vi.mocked(test.io.read).mockResolvedValueOnce(JSON.stringify({ version: target, dependencies: { '@ephemeral-ai/mayfly-remote': target } }))
      .mockResolvedValueOnce(JSON.stringify({ version: target, dependencies: { '@ephemeral-ai/mayfly': current } }))
    await expect(test.updater.install(snapshot)).rejects.toThrow('presentation versions are inconsistent')
    vi.mocked(test.io.read).mockResolvedValueOnce(JSON.stringify({ version: target, dependencies: { '@ephemeral-ai/mayfly-remote': target } }))
      .mockResolvedValueOnce(JSON.stringify({ version: target, dependencies: { '@ephemeral-ai/mayfly': target, '@ephemeral-ai/mayfly-ui': current } }))
    await expect(test.updater.install(snapshot)).rejects.toThrow('presentation versions are inconsistent')
  })

  it('refuses a failed staged startup and propagates I/O/cancellation failures without installing', async () => {
    const test = fixture()
    const snapshot = await prepared(test)
    vi.mocked(test.io.run).mockImplementation(async (_command, args) => args.includes('--version') ? 'wrong-version' : '')
    await expect(test.updater.stage(snapshot, signal())).rejects.toThrow('version startup check')
    vi.mocked(test.io.run).mockRejectedValueOnce(new Error('aborted'))
    await expect(test.updater.stage(snapshot, AbortSignal.abort())).rejects.toThrow('aborted')
    expect(test.installed()).toBe(current)
  })

  it('uses private file modes and strips authenticated startup/task inputs from every subprocess', async () => {
    const io = systemLocalUpdateIo()
    const directory = mkdtempTracked(join('/tmp', 'mayfly-local-io-'))
    system.temporary.mockResolvedValueOnce(directory)
    expect(await io.temporary()).toBe(directory)
    const lock = join(directory, 'lock')
    await io.claim(lock, 'pending')
    await expect(io.claim(lock, 'again')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(io.running(process.pid)).toBe(true)
    expect(io.running(2_147_483_647)).toBe(false)
    vi.spyOn(process, 'kill').mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    expect(io.running(1)).toBe(true)
    const log = join(directory, 'log')
    await io.write(log, 'one')
    await io.append(log, 'two')
    expect(await io.read(log)).toBe('onetwo')
    expect(await io.real(log)).toBe(log)
    vi.stubEnv('MAYFLY_DSH_STARTUP_URL', 'http://host/?token=do-not-copy')
    vi.stubEnv('MAYFLY_TASK', 'private initial task')
    vi.stubEnv('MAYFLY_SESSION_ID', 'private-session')
    system.execFile.mockImplementationOnce((_cmd, _args, options, done) => {
      expect(options).toMatchObject({ timeout: 1_200_000, maxBuffer: 4 * 1024 * 1024 })
      expect(options.env).not.toHaveProperty('MAYFLY_DSH_STARTUP_URL')
      expect(options.env).not.toHaveProperty('MAYFLY_TASK')
      expect(options.env).not.toHaveProperty('MAYFLY_SESSION_ID')
      done(null, 'stdout', 'stderr')
    })
    expect(await io.run('/node', ['--version'])).toBe('stdoutstderr')
    system.execFile.mockImplementationOnce((_cmd, _args, _options, done) => { done(Object.assign(new Error('private stdout'), { code: 1 }), '', '') })
    await expect(io.run('/node', ['bad'], signal())).rejects.toThrow('Local update process failed: 1')
    system.execFile.mockImplementationOnce((_cmd, _args, _options, done) => { done(new Error('private stdout'), '', '') })
    await expect(io.run('/node', ['bad'])).rejects.toThrow('Local update process failed: unknown')
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(systemLocalUpdateIo().npm).toContain('node_modules/npm/bin/npm-cli.js')
    await io.remove(directory)
    vi.unstubAllEnvs()
  })
})


it('holds a durable exclusive marker until verification/recovery and preserves staged graphs while pending', async () => {
  const test = fixture()
  const snapshot = await prepared(test)
  await test.updater.begin(snapshot, 'host-one', true)
  expect(test.io.claim).toHaveBeenCalledWith(snapshot.lockPath, expect.stringContaining('"host":"host-one"'))
  await test.updater.cleanup(snapshot)
  expect(test.io.remove).not.toHaveBeenCalled()
  await test.updater.finish(snapshot)
  expect(test.io.remove).toHaveBeenCalledWith(snapshot.lockPath)
  await test.updater.cleanup(snapshot)
  expect(test.io.remove).toHaveBeenCalledWith('/tmp/mayfly-update/previous')
  vi.mocked(test.io.claim).mockRejectedValueOnce(Object.assign(new Error('already locked'), { code: 'EEXIST' }))
  await expect(test.updater.begin(snapshot, 'host-one', true)).rejects.toThrow('already locked')
})

it('reads interrupted ownership, refuses a live updater/invalid marker, and fences cancelled pending reads', async () => {
  const test = fixture()
  const snapshot = await prepared(test)
  const marker = JSON.stringify({ snapshot, host: 'host-one', enabled: true, pid: 123 })
  vi.mocked(test.io.read).mockResolvedValueOnce(marker)
  const pending = await test.updater.pending(signal())
  expect(pending).toEqual({ snapshot, host: 'host-one', enabled: true })
  await test.updater.cleanup(pending!.snapshot)
  expect(test.io.remove).not.toHaveBeenCalled()
  vi.mocked(test.io.read).mockResolvedValueOnce(JSON.stringify({ snapshot, host: 'host-one', enabled: true, pid: 456 }))
  vi.mocked(test.io.running).mockReturnValueOnce(true)
  await expect(test.updater.pending(signal())).rejects.toThrow('still running')
  for (const invalid of [
    { snapshot, host: null, enabled: true, pid: 123 },
    { snapshot, host: 'host-one', enabled: null, pid: 123 },
    { snapshot, host: 'host-one', enabled: true, pid: null },
    { snapshot: null, host: 'host-one', enabled: true, pid: 123 },
    { snapshot: { ...snapshot, lockPath: '/wrong' }, host: 'host-one', enabled: true, pid: 123 },
    { snapshot: { ...snapshot, current: 'bad' }, host: 'host-one', enabled: true, pid: 123 },
    { snapshot: { ...snapshot, target: 'bad' }, host: 'host-one', enabled: true, pid: 123 },
    { snapshot: { ...snapshot, directory: null }, host: 'host-one', enabled: true, pid: 123 },
    { snapshot: { ...snapshot, logPath: '/wrong' }, host: 'host-one', enabled: true, pid: 123 },
  ]) {
    vi.mocked(test.io.read).mockResolvedValueOnce(JSON.stringify(invalid))
    await expect(test.updater.pending(signal())).rejects.toThrow('marker is invalid')
  }
  vi.mocked(test.io.read).mockRejectedValueOnce(Object.assign(new Error('absent'), { code: 'ENOENT' }))
  expect(await test.updater.pending(signal())).toBeUndefined()
  vi.mocked(test.io.read).mockRejectedValueOnce(new Error('read denied'))
  await expect(test.updater.pending(signal())).rejects.toThrow('read denied')
  vi.mocked(test.io.read).mockResolvedValueOnce(marker)
  expect(await test.updater.pending(AbortSignal.abort())).toBeUndefined()
  expect(await new LocalFrontendUpdater({ ...test.io, entry: undefined }).pending(signal())).toBeUndefined()
})


it('verifies actual shared manifests after dependency declarations, including hoisted packages', async () => {
  const test = fixture()
  const snapshot = await prepared(test)
  const read = vi.mocked(test.io.read).getMockImplementation()!
  vi.mocked(test.io.read).mockImplementation(async path => {
    if (path.endsWith('mayfly-ui/package.json') && path.includes('/node_modules/@ephemeral-ai/mayfly-remote/node_modules/')) throw new Error('shared package hoisted')
    return read(path)
  })
  await test.updater.stage(snapshot, signal())
  vi.mocked(test.io.read).mockImplementation(async path => path.endsWith('mayfly-ui/package.json') ? JSON.stringify({ version: 'wrong' }) : read(path))
  await expect(test.updater.install(snapshot)).rejects.toThrow('installed shared presentation version is inconsistent')
})

it('refuses unreadable, malformed and unconfirmed npm worker ownership before taking a transaction lock into mutation', async () => {
  const test = fixture()
  const snapshot = await prepared(test)
  const read = vi.mocked(test.io.read).getMockImplementation()!
  const mutate = vi.fn(async () => {})
  for (const text of ['invalid-json', 'null', '[]', '{"state":"starting"}', '{"state":"running","pid":"123"}', '{"state":"running","pid":0}', '{"state":"running","pid":1.5}']) {
    vi.mocked(test.io.read).mockImplementation(async path => path.endsWith('.worker') ? text : read(path))
    await expect(test.updater.transaction(snapshot, mutate, signal())).rejects.toThrow('manual repair')
  }
  vi.mocked(test.io.read).mockImplementation(async path => {
    if (path.endsWith('.worker')) throw new Error('worker ownership unreadable')
    return read(path)
  })
  await expect(test.updater.transaction(snapshot, mutate, signal())).rejects.toThrow('worker ownership unreadable')
  expect(mutate).not.toHaveBeenCalled()
})
