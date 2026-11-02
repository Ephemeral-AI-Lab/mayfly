/** Projection-only readable exports, native audit paging, local paths, overwrites and stale ownership. @module */
import * as fs from 'node:fs/promises'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureSelection } from '../../src/remote/features.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import { mountRemoteExportOperations } from '../../src/remote/operations/export.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../../../mayfly/tests/core/temp-dir.ts'
import { events, projection } from './export-fixture.ts'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  return { ...actual, readFile: vi.fn(actual.readFile), writeFile: vi.fn(actual.writeFile), unlink: vi.fn(actual.unlink), mkdir: vi.fn(actual.mkdir) }
})
const actual = await vi.importActual<typeof fs>('node:fs/promises')
beforeEach(() => {
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile)
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile)
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink)
  vi.mocked(fs.mkdir).mockReset().mockImplementation(actual.mkdir)
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
  const command = commands.list().find(item => item.name === 'export')!
  return { root, directory, client, binding, ref, history, notice, commands, unmount,
    execute: (text = '', signal = new AbortController().signal) => command.execute(text, signal),
    select: (value: RemoteFeatureSelection | undefined) => { current = value },
    reconnect: () => { generation += 1 },
  }
}

describe('local session export composition', () => {
  it('exports the visible Host projection without reading raw history and removes both command registrations', async () => {
    const f = fixture()
    expect(f.commands.list().map(command => command.name)).toEqual(['export', 'save'])
    await f.execute(' visible report ')
    expect(f.history).not.toHaveBeenCalled()
    const content = readFileSync(join(f.directory, 'visible report'), 'utf8')
    expect(content).toContain('message_count: 7')
    expect(content).toContain('first question')
    expect(content).not.toContain('CONTEXT')
    expect(content).toContain('work_dir: /host/work')
    expect(f.notice.set).toHaveBeenCalledWith(`exported 7 items to ${join(f.directory, 'visible report')}`, 'success')
    f.unmount()
    expect(f.commands.list()).toEqual([])
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
    const f = fixture()
    expect(f.commands.list().map(command => command.input?.hint)).toEqual(['[full] [<path>]', '[full] [<path>]'])
    const save = f.commands.list().find(command => command.name === 'save')!
    for (const path of ['nested/报告  visible.txt', '../parent/without-extension', join(f.root, 'absolute/note.data')]) {
      await save.execute(`  ${path}  `, new AbortController().signal)
      const target = path.startsWith('/') ? path : join(f.directory, path)
      expect(readFileSync(target, 'utf8')).toContain('message_count: 7')
      writeFileSync(target, 'old bytes')
      await f.execute(path)
      expect(readFileSync(target, 'utf8')).toContain('message_count: 7')
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
      vi.mocked(fs.unlink).mockRejectedValueOnce(new Error('already gone'))
      await expect(f.execute('failed')).rejects.toThrow('could not write export:')
      expect(fs.unlink).toHaveBeenLastCalledWith(join(f.directory, 'failed'))
      expect(f.notice.set).not.toHaveBeenCalled()
    }
  })

  it('restores an existing destination after failed writes and preserves the write error if restoration fails', async () => {
    for (const cleanupFails of [false, true]) {
      const f = fixture()
      const target = join(f.directory, 'existing')
      const original = Buffer.from([0, 255, 13, 10, 128])
      writeFileSync(target, original)
      vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => {
        await actual.writeFile(...args)
        throw new Error('write failed')
      })
      if (cleanupFails) vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('restore failed'))
      await expect(f.execute('existing')).rejects.toThrow('could not write export: write failed')
      if (!cleanupFails) expect(readFileSync(target)).toEqual(original)
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
})
