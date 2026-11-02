/** Projection-only readable exports, native audit paging, exclusive local writes and stale ownership. @module */
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
  return { ...actual, writeFile: vi.fn(actual.writeFile), unlink: vi.fn(actual.unlink), mkdir: vi.fn(actual.mkdir) }
})
const actual = await vi.importActual<typeof fs>('node:fs/promises')
beforeEach(() => {
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile)
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink)
  vi.mocked(fs.mkdir).mockReset().mockImplementation(actual.mkdir)
})
afterEach(() => { vi.useRealTimers() })
registerTempDirCleanup()

function deferred<T>() { return Promise.withResolvers<T>() }

function fixture(options: { readonly noListCwd?: boolean, readonly projectedCwd?: unknown, readonly projection?: ConversationProjection | null } = {}) {
  const directory = mkdtempTracked('mayfly-remote-export-')
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
  return { directory, output: join(directory, 'mayfly-exports'), client, binding, ref, history, notice, commands, unmount,
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
    const content = readFileSync(join(f.output, 'visible report.md'), 'utf8')
    expect(content).toContain('message_count: 7')
    expect(content).toContain('first question')
    expect(content).not.toContain('CONTEXT')
    expect(content).toContain('work_dir: /host/work')
    expect(f.notice.set).toHaveBeenCalledWith(expect.stringContaining('7 items'))
    f.unmount()
    expect(f.commands.list()).toEqual([])
  })

  it('uses native audit paging for full mode, keeps source injections and acquires projected cwd only when necessary', async () => {
    const f = fixture({ noListCwd: true, projectedCwd: '/projected/work' })
    await f.execute('full audit.md')
    expect(f.history).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: f.ref.sessionId }, maxMessages: 500 }, expect.any(AbortSignal))
    expect(readFileSync(join(f.output, 'audit.md'), 'utf8')).toContain('CONTEXT')
    expect(readFileSync(join(f.output, 'audit.md'), 'utf8')).toContain('work_dir: /projected/work')
    expect(f.notice.set).toHaveBeenCalledWith(expect.stringContaining('14 events'))
    const unknown = fixture({ noListCwd: true })
    await unknown.execute('unknown')
    expect(readFileSync(join(unknown.output, 'unknown.md'), 'utf8')).toContain('work_dir: \n')
  })

  it('creates a deterministic default bare name and never overwrites an existing export', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-21T07:15:30.000Z'))
    const f = fixture()
    await f.execute()
    await f.execute()
    const names = readdirSync(f.output).sort()
    expect(names).toEqual(['mayfly-export-lead-20260821-071530-2.md', 'mayfly-export-lead-20260821-071530.md'])
    expect(readFileSync(join(f.output, names[0]!), 'utf8')).toBe(readFileSync(join(f.output, names[1]!), 'utf8'))
    await f.commands.list().find(command => command.name === 'save')!.execute('../outside', new AbortController().signal)
    expect(existsSync(join(f.output, '..outside.md'))).toBe(true)
  })

  it('refuses missing selection, unavailable or empty projections, empty audit and invalid names', async () => {
    const f = fixture()
    f.select(undefined)
    await expect(f.execute()).rejects.toThrow('No current session')
    await expect(fixture({ projection: null }).execute()).rejects.toThrow('Conversation projection is unavailable')
    await expect(fixture({ projection: { ...projection, entries: [] } }).execute()).rejects.toThrow('Nothing to export yet')
    const audit = fixture()
    audit.history.mockResolvedValueOnce({ ok: true, value: { records: [], hasMore: false } })
    await expect(audit.execute('full')).rejects.toThrow('Nothing to export yet')
    await expect(fixture().execute('..')).rejects.toThrow('Usage: /export')
    const aborted = new AbortController()
    aborted.abort(new Error('already cancelled'))
    await expect(fixture().execute('', aborted.signal)).rejects.toThrow('already cancelled')
  })

  it('bounds exclusive name retries without touching existing files', async () => {
    const f = fixture()
    mkdirSync(f.output)
    for (let index = 1; index <= 100; index += 1) writeFileSync(join(f.output, index === 1 ? 'full.md' : `full-${String(index)}.md`), 'existing')
    await expect(f.execute('full full')).rejects.toThrow('Could not find an unused export filename')
    expect(fs.unlink).not.toHaveBeenCalled()
    expect(readdirSync(f.output)).toHaveLength(100)
  })

  it('cleans only a failed new write and retains the original error when cleanup fails', async () => {
    for (const failure of [new Error('disk full'), null]) {
      const f = fixture()
      vi.mocked(fs.writeFile).mockRejectedValueOnce(failure)
      vi.mocked(fs.unlink).mockRejectedValueOnce(new Error('already gone'))
      await expect(f.execute('failed')).rejects.toThrow('could not write export:')
      expect(fs.unlink).toHaveBeenLastCalledWith(join(f.output, 'failed.md'))
      expect(f.notice.set).not.toHaveBeenCalled()
    }
  })

  it('rejects a full history read that finishes under a different Host, Session, binding, connection generation or unloaded owner', async () => {
    for (const retire of ['detach', 'host', 'session', 'binding', 'connection', 'unload'] as const) {
      const f = fixture()
      const gate = deferred<Awaited<ReturnType<typeof f.history>>>()
      f.history.mockReturnValueOnce(gate.promise)
      const pending = f.execute('full late')
      const selected = { ref: f.ref, client: f.client, binding: f.binding }
      if (retire === 'detach') f.select(undefined)
      if (retire === 'host') f.select({ ...selected, ref: { ...f.ref, host: HostKey('two') } })
      if (retire === 'session') f.select({ ...selected, ref: { ...f.ref, sessionId: SessionId('second') } })
      if (retire === 'binding') f.select({ ...selected, binding: {} as SessionBinding })
      if (retire === 'connection') f.reconnect()
      if (retire === 'unload') f.unmount()
      gate.resolve({ ok: true, value: { records: events.map(event => ({ type: 'event', event })), hasMore: false } })
      await expect(pending).rejects.toThrow('Session changed during export')
      expect(existsSync(f.output)).toBe(false)
      expect(f.notice.set).not.toHaveBeenCalled()
    }
  })

  it('fences directory preparation and removes a new file whose write finishes after selection retires', async () => {
    const beforeWrite = fixture()
    vi.mocked(fs.mkdir).mockImplementationOnce(async (...args) => { const value = await actual.mkdir(...args); beforeWrite.select(undefined); return value })
    await expect(beforeWrite.execute('late-directory')).rejects.toThrow('Session changed during export')
    expect(readdirSync(beforeWrite.output)).toEqual([])
    const afterWrite = fixture()
    vi.mocked(fs.writeFile).mockImplementationOnce(async (...args) => { await actual.writeFile(...args); afterWrite.select(undefined) })
    await expect(afterWrite.execute('late-write')).rejects.toThrow('Session changed during export')
    expect(readdirSync(afterWrite.output)).toEqual([])
    expect(afterWrite.notice.set).not.toHaveBeenCalled()
  })
})
