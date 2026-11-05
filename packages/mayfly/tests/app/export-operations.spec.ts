/** Projection-only readable exports, native audit paging, local paths, overwrites and stale ownership. @module */
import * as fs from 'node:fs/promises'
import * as syncfs from 'node:fs'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureSelection } from '../../src/app/features.ts'
import { remoteCommandCatalog } from '../../src/app/command-catalog.ts'
import { RemoteFeatureCommandRegistry } from '../../src/app/features/commands.ts'
import { mountRemoteExportOperations } from '../../src/app/operations/export.ts'
import type { RemoteOperationsContext } from '../../src/app/operations/support.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import { events, projection } from './export-fixture.ts'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile), unlink: vi.fn(actual.unlink), mkdir: vi.fn(actual.mkdir), mkdtemp: vi.fn(actual.mkdtemp), rm: vi.fn(actual.rm) }
})
vi.mock('node:fs', async original => {
  const actual = await original<typeof syncfs>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
const actual = await vi.importActual<typeof fs>('node:fs/promises')
const actualSync = await vi.importActual<typeof syncfs>('node:fs')
beforeEach(() => {
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile)
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile)
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink)
  vi.mocked(fs.mkdir).mockReset().mockImplementation(actual.mkdir)
  vi.mocked(fs.mkdtemp).mockReset().mockImplementation(actual.mkdtemp)
  vi.mocked(fs.rm).mockReset().mockImplementation(actual.rm)
  vi.mocked(syncfs.renameSync).mockReset().mockImplementation(actualSync.renameSync)
})
afterEach(() => { vi.useRealTimers() })
registerTempDirCleanup()

function deferred<T>() { return Promise.withResolvers<T>() }

function fixture(options: { readonly noListCwd?: boolean, readonly projectedCwd?: unknown, readonly projection?: ConversationProjection | null } = {}) {
  const root = mkdtempTracked('mayfly-remote-export-')
  const directory = join(root, 'work')
  mkdirSync(directory)
  const ref = { host: HostKey('one'), sessionId: SessionId('lead') }
  let generation = 1
  const history = vi.fn(async () => ({ ok: true as const, value: { records: events.map(event => ({ type: 'event' as const, event })), hasMore: false } }))
  const projected = options.projection === null ? undefined : options.projection ?? projection
  const binding = { session: { projections: { faceOf: (key: string) => ({ getSnapshot: () => key === 'mayflyConversation' ? projected : options.projectedCwd }) } } } as unknown as SessionBinding
  const client = { key: ref.host, state: { getSnapshot: () => ({ generation }) }, remote: { session: { events: history } }, sessions: { list: { getSnapshot: () => ({ byId: options.noListCwd ? {} : { lead: { cwd: '/host/work' } } }) } } } as unknown as HostClient
  let current: RemoteFeatureSelection | undefined = { ref, client, binding }
  const locale = { register: vi.fn(), subscribe: vi.fn(() => () => {}), translate: vi.fn((_namespace: string, key: string, values?: Readonly<Record<string, unknown>>) => key.replace(/\{([^}]+)\}/gu, (_whole, name: string) => String(values?.[name] ?? ''))) }
  const effect = (fn: () => unknown) => { fn(); return () => {} }
  const ctx = { effect, mayflyLocale: locale, get: (name: string) => name === 'mayflyLocale' ? locale : undefined, inject: (_names: readonly string[], callback: (scope: unknown) => void) => { callback({ mayflyLocale: locale, effect }) } }
  const commands = new RemoteFeatureCommandRegistry()
  const notice = { set: vi.fn() }
  const context = { base: { ctx, commands, notice, hosts: { current: () => current } }, options: { localCwd: directory } } as unknown as RemoteOperationsContext
  const unmount = mountRemoteExportOperations(context)
  return { root, directory, client, binding, ref, history, notice, commands, unmount,
    execute: (text = '', signal = new AbortController().signal) => commands.execute('export', text, signal),
    select: (value: RemoteFeatureSelection | undefined) => { current = value },
    reconnect: () => { generation += 1 },
  }
}

describe('local session export composition', () => {
  it('advertises the reference save descriptor, dispatches the hidden export route locally and removes both on unload', async () => {
    const f = fixture()
    expect(f.commands.list().map(command => command.name)).toEqual(['save'])
    const catalog = remoteCommandCatalog(true, f.commands.list())
    expect(catalog.some(command => command.name === 'export')).toBe(false)
    expect(catalog.find(command => command.name === 'save')).toEqual({
      name: 'save', description: 'Save the current session as a Markdown file', input: { hint: '[full] [<path>]' },
    })
    await expect(f.execute(' visible report ')).resolves.toBe(true)
    expect(f.history).not.toHaveBeenCalled()
    const content = readFileSync(join(f.directory, 'visible report'), 'utf8')
    expect(content).toContain('message_count: 7')
    expect(content).toContain('first question')
    expect(content).not.toContain('CONTEXT')
    expect(content).toContain('work_dir: /host/work')
    expect(f.notice.set).toHaveBeenCalledWith(`exported 7 items to ${join(f.directory, 'visible report')}`, 'success')
    f.unmount()
    expect(f.commands.list()).toEqual([])
    for (const name of ['save', 'export']) await expect(f.commands.execute(name, 'after-unload', new AbortController().signal)).resolves.toBe(false)
    expect(existsSync(join(f.directory, 'after-unload'))).toBe(false)
  })

  it('uses native audit paging for full mode, keeps source injections and acquires projected cwd only when necessary', async () => {
    const f = fixture({ noListCwd: true, projectedCwd: '/projected/work' })
    await f.execute('full audit.md')
    expect(f.history).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: f.ref.sessionId }, maxMessages: 500 }, expect.any(AbortSignal))
    expect(readFileSync(join(f.directory, 'audit.md'), 'utf8')).toContain('CONTEXT')
    expect(readFileSync(join(f.directory, 'audit.md'), 'utf8')).toContain('work_dir: /projected/work')
    expect(f.notice.set).toHaveBeenCalledWith(`exported 14 events to ${join(f.directory, 'audit.md')}`, 'success')
    const unknown = fixture({ noListCwd: true })
    await unknown.execute('unknown')
    expect(readFileSync(join(unknown.directory, 'unknown'), 'utf8')).toContain('work_dir: \n')
  })

  it('preserves the reference default filename and overwrites it within the same second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-21T07:15:30.000Z'))
    const f = fixture()
    await f.execute()
    const target = join(f.directory, 'mayfly-export-lead-20260821-071530.md')
    writeFileSync(target, 'previous export')
    await f.execute()
    expect(readdirSync(f.directory)).toEqual(['mayfly-export-lead-20260821-071530.md'])
    expect(readFileSync(target, 'utf8')).toContain('message_count: 7')
  })

  it('shares save/export path semantics, preserving spaces, Unicode, arbitrary suffixes, absolute and parent paths', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-21T07:15:30.000Z'))
    const f = fixture()
    expect(f.commands.list().map(command => command.input?.hint)).toEqual(['[full] [<path>]'])
    const save = f.commands.list().find(command => command.name === 'save')!
    for (const path of ['nested/报告  visible.txt', '../parent/without-extension', join(f.root, 'absolute/note.data')]) {
      await save.execute(`  ${path}  `, new AbortController().signal)
      const target = path.startsWith('/') ? path : join(f.directory, path)
      const expected = readFileSync(target)
      expect(expected.toString()).toContain('message_count: 7')
      writeFileSync(target, 'old bytes')
      await f.execute(path)
      expect(readFileSync(target)).toEqual(expected)
    }
    await f.execute('full\tnot-a-mode')
    expect(f.history).not.toHaveBeenCalled()
    expect(existsSync(join(f.directory, 'full\tnot-a-mode'))).toBe(true)
  })

  it('refuses missing selection, unavailable or empty projections, empty audit and already aborted callers', async () => {
    const f = fixture()
    f.select(undefined)
    await expect(f.execute()).rejects.toThrow('no session is live yet')
    await expect(fixture({ projection: null }).execute()).rejects.toThrow('Conversation projection is unavailable')
    await expect(fixture({ projection: { ...projection, entries: [] } }).execute()).rejects.toThrow('nothing to export yet')
    const audit = fixture()
    audit.history.mockResolvedValueOnce({ ok: true, value: { records: [], hasMore: false } })
    await expect(audit.execute('full')).rejects.toThrow('nothing to export yet')
    const aborted = new AbortController()
    aborted.abort(new Error('already cancelled'))
    await expect(fixture().execute('', aborted.signal)).rejects.toThrow('already cancelled')
  })

  it('propagates destination read failures without writing or deleting the existing destination', async () => {
    for (const failure of [Object.assign(new Error('denied'), { code: 'EACCES' }), null]) {
      const f = fixture()
      vi.mocked(fs.readFile).mockRejectedValueOnce(failure)
      await expect(f.execute('existing')).rejects.toThrow('could not write export:')
      expect(fs.writeFile).not.toHaveBeenCalled()
      expect(fs.unlink).not.toHaveBeenCalled()
    }
  })

  it('cleans a failed new write and retains the original error even when cleanup fails', async () => {
    for (const failure of [new Error('disk full'), null]) {
      const f = fixture()
      vi.mocked(fs.writeFile).mockRejectedValueOnce(failure)
      vi.mocked(fs.rm).mockRejectedValueOnce(new Error('cleanup denied'))
      await expect(f.execute('failed')).rejects.toThrow('could not write export:')
      expect(fs.rm).toHaveBeenLastCalledWith(expect.stringContaining(join(f.directory, '.mayfly-export-')), { recursive: true, force: true })
      expect(existsSync(join(f.directory, 'failed'))).toBe(false)
      expect(f.notice.set).not.toHaveBeenCalled()
    }
  })

  it('preserves an existing destination after failed staged writes even when temporary cleanup fails', async () => {
    for (const cleanupFails of [false, true]) {
      const f = fixture()
      const target = join(f.directory, 'existing')
      const original = Buffer.from([0, 255, 13, 10, 128])
      writeFileSync(target, original)
      vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
        await actual.writeFile(...args)
        throw new Error('write failed')
      })
      if (cleanupFails) vi.mocked(fs.rm).mockRejectedValueOnce(new Error('cleanup failed'))
      await expect(f.execute('existing')).rejects.toThrow('could not write export: write failed')
      expect(readFileSync(target)).toEqual(original)
      expect(fs.unlink).not.toHaveBeenCalled()
      expect(f.notice.set).not.toHaveBeenCalled()
    }
  })

  it('rejects a full history read that finishes under a different Host, Session, binding, connection generation or unloaded owner', async () => {
    for (const retire of ['detach', 'client', 'host', 'session', 'binding', 'connection', 'unload'] as const) {
      const f = fixture()
      const gate = deferred<Awaited<ReturnType<typeof f.history>>>()
      f.history.mockReturnValueOnce(gate.promise)
      const pending = f.execute('full late')
      const selected = { ref: f.ref, client: f.client, binding: f.binding }
      if (retire === 'detach') f.select(undefined)
      if (retire === 'client') f.select({ ...selected, client: {} as HostClient })
      if (retire === 'host') f.select({ ...selected, ref: { ...f.ref, host: HostKey('two') } })
      if (retire === 'session') f.select({ ...selected, ref: { ...f.ref, sessionId: SessionId('second') } })
      if (retire === 'binding') f.select({ ...selected, binding: {} as SessionBinding })
      if (retire === 'connection') f.reconnect()
      if (retire === 'unload') f.unmount()
      gate.resolve({ ok: true, value: { records: events.map(event => ({ type: 'event', event })), hasMore: false } })
      await expect(pending).rejects.toThrow('Session changed during export')
      expect(readdirSync(f.directory)).toEqual([])
      expect(f.notice.set).not.toHaveBeenCalled()
    }
  })

  it('fences directory preparation and the destination read before writing', async () => {
    const beforeWrite = fixture()
    vi.mocked(fs.mkdir).mockImplementationOnce(async (...args) => { const value = await actual.mkdir(...args); beforeWrite.select(undefined); return value })
    await expect(beforeWrite.execute('late-directory')).rejects.toThrow('Session changed during export')
    expect(readdirSync(beforeWrite.directory)).toEqual([])
    const duringRead = fixture()
    writeFileSync(join(duringRead.directory, 'old'), 'original')
    vi.mocked(fs.readFile).mockImplementationOnce(async (...args) => {
      const value = await actual.readFile(...args)
      duringRead.select(undefined)
      return value
    })
    await expect(duringRead.execute('old')).rejects.toThrow('Session changed during export')
    expect(readFileSync(join(duringRead.directory, 'old'), 'utf8')).toBe('original')
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('removes newly written files and restores overwritten bytes after caller, binding or owner retirement', async () => {
    for (const retire of ['caller', 'detach', 'unload'] as const) {
      for (const existing of [false, true]) {
        const f = fixture()
        const controller = new AbortController()
        const target = join(f.directory, 'late-write')
        if (existing) writeFileSync(target, 'original')
        vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
          await actual.writeFile(...args)
          if (retire === 'caller') controller.abort(new Error('cancelled export'))
          if (retire === 'detach') f.select(undefined)
          if (retire === 'unload') f.unmount()
        })
        await expect(f.execute('late-write', controller.signal)).rejects.toThrow(retire === 'caller' ? 'cancelled export' : 'Session changed during export')
        if (existing) expect(readFileSync(target, 'utf8')).toBe('original')
        else expect(existsSync(target)).toBe(false)
        expect(f.notice.set).not.toHaveBeenCalled()
      }
    }
  })

  it('serializes save/export for the same normalized path and never lets retired cleanup delete a later export', async () => {
    const f = fixture()
    const gate = deferred<void>()
    const caller = new AbortController()
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
      await actual.writeFile(...args)
      await gate.promise
    })
    const first = f.execute('shared', caller.signal)
    const retired = expect(first).rejects.toThrow('cancelled first export')
    await vi.waitFor(() => { expect(fs.writeFile).toHaveBeenCalledOnce() })
    const second = f.commands.execute('save', 'full ./sub/../shared', new AbortController().signal)
    await vi.waitFor(() => { expect(f.history).toHaveBeenCalledOnce() })
    await new Promise(resolve => setImmediate(resolve))
    expect(fs.writeFile).toHaveBeenCalledOnce()
    caller.abort(new Error('cancelled first export'))
    gate.resolve()
    await retired
    await second
    expect(readFileSync(join(f.directory, 'shared'), 'utf8')).toContain('CONTEXT')
    expect(readdirSync(f.directory)).toEqual(['shared'])
    expect(f.notice.set).toHaveBeenCalledOnce()
  })

  it.each([false, true])('preserves an external writer after retirement when a destination previously existed: %s', async existing => {
    const f = fixture()
    const target = join(f.directory, 'external')
    if (existing) writeFileSync(target, 'original')
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
      await actual.writeFile(...args)
      writeFileSync(target, 'external edit')
      f.select(undefined)
    })
    await expect(f.execute('external')).rejects.toThrow('Session changed during export')
    expect(readFileSync(target, 'utf8')).toBe('external edit')
    expect(readdirSync(f.directory)).toEqual(['external'])
    expect(f.notice.set).not.toHaveBeenCalled()
  })

  it.each(['created', 'replaced', 'removed'] as const)('refuses an externally %s destination before atomic replacement', async change => {
    const f = fixture()
    const target = join(f.directory, 'external')
    if (change !== 'created') writeFileSync(target, 'original')
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
      await actual.writeFile(...args)
      if (change === 'removed') await actual.unlink(target)
      else writeFileSync(target, 'external edit')
    })
    await expect(f.execute('external')).rejects.toThrow('The export destination changed during export')
    expect(existsSync(target)).toBe(change !== 'removed')
    if (change !== 'removed') expect(readFileSync(target, 'utf8')).toBe('external edit')
    expect(syncfs.renameSync).not.toHaveBeenCalled()
    expect(readdirSync(f.directory)).toEqual(change === 'removed' ? [] : ['external'])
  })

  it('cleans its temporary directory after preparation retirement or failed atomic replacement', async () => {
    const stale = fixture()
    vi.mocked(fs.mkdtemp).mockImplementationOnce(async (...args) => {
      const value = await actual.mkdtemp(...args)
      stale.unmount()
      return value
    })
    await expect(stale.execute('stale')).rejects.toThrow('Session changed during export')
    expect(readdirSync(stale.directory)).toEqual([])
    const failed = fixture()
    writeFileSync(join(failed.directory, 'original'), 'before')
    vi.mocked(syncfs.renameSync).mockImplementationOnce(() => { throw new Error('rename denied') })
    await expect(failed.execute('original')).rejects.toThrow('rename denied')
    expect(readFileSync(join(failed.directory, 'original'), 'utf8')).toBe('before')
    expect(readdirSync(failed.directory)).toEqual(['original'])
  })
})
