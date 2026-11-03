/** Copy the latest visible Host conversation item with exact selection ownership. @module */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationEntry, ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import type { Context } from '@deepseek-ai/cordis'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import { mountRemoteCopyOperations } from '../../src/remote/operations/copy.ts'
import { entry } from './export-fixture.ts'

/** The real operation and registry receive the mounted catalog's English messages. */
function fakeContext(): Context {
  const catalogs = new Map<string, Readonly<Record<string, string>>>()
  const translate = (namespace: string, key: string, values?: Readonly<Record<string, string | number>>): string => {
    const template = catalogs.get(namespace)?.[key] ?? key
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (placeholder: string, name: string) => {
      const value = values?.[name]
      return value === undefined ? placeholder : String(value)
    })
  }
  const locale = {
    register: vi.fn((namespace: string, catalog: { readonly en: Readonly<Record<string, string>> }) => {
      catalogs.set(namespace, catalog.en)
      return () => { catalogs.delete(namespace) }
    }),
    subscribe: vi.fn(() => () => {}),
    translate,
  }
  const ctx: Record<string, unknown> = {
    mayflyLocale: locale,
    effect: (callback: () => void | (() => void)) => callback() ?? (() => {}),
    inject: (_names: readonly string[], callback: (scoped: unknown) => void) => { callback(ctx); return () => {} },
    get: (name: string) => name === 'mayflyLocale' ? locale : undefined,
  }
  return ctx as unknown as Context
}

function conversation(entries: readonly ConversationEntry[]): ConversationProjection {
  return { entries, streaming: false, settledSteps: [], turns: [] }
}

const assistant = (text: string) => entry({ kind: 'assistant', text, step: 0, streaming: false })
const question = (text: string) => entry({ kind: 'user', text, attachments: [] })

function fixture(options: { readonly withoutCopy?: boolean, readonly entries?: readonly ConversationEntry[] } = {}) {
  const ctx = fakeContext()
  const notice = { set: vi.fn() }
  const commands = new RemoteFeatureCommandRegistry()
  const copy = vi.fn(async (_text: string): Promise<'native' | 'osc52' | void> => 'native')
  const journal = vi.fn()
  const snapshot = vi.fn((): ConversationProjection | undefined => conversation(options.entries ?? [assistant('reply')]))
  const faceOf = vi.fn(() => ({ getSnapshot: snapshot }))
  const binding = { session: { projections: { faceOf } } } as unknown as SessionBinding
  let generation = 1
  const client = { key: HostKey('local'), state: { getSnapshot: () => ({ generation }), subscribe: () => () => {} }, remote: { session: { events: journal } } } as unknown as HostClient
  let current: RemoteFeatureSelection | undefined = { ref: { host: client.key, sessionId: SessionId('session-1') }, client, binding }
  const selected = current
  const hosts = { list: () => current === undefined ? [] : [current.client], current: () => current, subscribe: () => () => {} }
  const base = { ctx, hosts, notice, commands, subscribeLocale: () => () => {} } as unknown as RemoteFeatureContext
  const context = { base, options: { localCwd: '/work', ...options.withoutCopy === true ? {} : { copy } } } as unknown as RemoteOperationsContext
  return { context, notice, commands, copy, journal, snapshot, faceOf, selected,
    run: (input = '', signal = new AbortController().signal) => commands.execute('copy', input, signal),
    select: (next: RemoteFeatureSelection | undefined) => { current = next },
    reconnect: () => { generation += 1 },
  }
}

describe('mountRemoteCopyOperations', () => {
  it('registers the reference command and releases it on unload', () => {
    const f = fixture()
    const dispose = mountRemoteCopyOperations(f.context)
    expect(f.commands.list().map(command => command.name)).toEqual(['copy'])
    expect(f.commands.list()[0]!.description).toBe('Copy the last assistant message to the clipboard')
    dispose()
    expect(f.commands.list()).toEqual([])
  })

  it('copies the authoritative visible text after retraction instead of raw hidden history', async () => {
    const f = fixture({ entries: [question('question'), assistant('visible answer'), entry({ kind: 'interrupted' })] })
    f.journal.mockResolvedValue({ records: [{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'retracted answer' }] } } } }] })
    mountRemoteCopyOperations(f.context)
    await f.run()
    expect(f.faceOf).toHaveBeenCalledExactlyOnceWith('mayflyConversation')
    expect(f.copy).toHaveBeenCalledExactlyOnceWith('visible answer')
    expect(f.notice.set).toHaveBeenCalledWith('copied the last assistant message (14 characters)', 'success')
    expect(f.journal).not.toHaveBeenCalled()
    f.snapshot.mockReturnValueOnce(conversation([question('question')]))
    await f.run()
    expect(f.copy).toHaveBeenCalledTimes(1)
    expect(f.notice.set).toHaveBeenLastCalledWith('no assistant message to copy', 'error')
  })

  it('uses the whole projection beyond the old 2000-event window and preserves folded text verbatim', async () => {
    const f = fixture({ entries: [assistant('  alpha\n\nbeta  '), ...Array.from({ length: 2500 }, (_, index) => question(String(index))), assistant(' \n '), entry({ kind: 'thinking', text: 'private', step: 0, streaming: false })] })
    mountRemoteCopyOperations(f.context)
    await f.run()
    expect(f.copy).toHaveBeenCalledWith('  alpha\n\nbeta  ')
    expect(f.journal).not.toHaveBeenCalled()
  })

  it('reports empty and unavailable projections without using a journal fallback', async () => {
    const f = fixture({ entries: [] })
    mountRemoteCopyOperations(f.context)
    await f.run()
    expect(f.notice.set).toHaveBeenCalledWith('no assistant message to copy', 'error')
    f.snapshot.mockReturnValueOnce(undefined)
    await expect(f.run()).rejects.toThrow('Conversation projection is unavailable')
    expect(f.journal).not.toHaveBeenCalled()
    expect(f.copy).not.toHaveBeenCalled()
  })

  it('keeps terminal escape clipboard delivery explicitly unverified', async () => {
    const f = fixture()
    mountRemoteCopyOperations(f.context)
    f.copy.mockResolvedValueOnce('osc52')
    await f.run()
    expect(f.notice.set).toHaveBeenCalledExactlyOnceWith('copied via terminal escape sequence (unverified, 5 characters)', 'success')
  })

  it('reports missing selection and clipboard without reading the projection', async () => {
    const f = fixture()
    mountRemoteCopyOperations(f.context)
    f.select(undefined)
    await f.run()
    expect(f.notice.set).toHaveBeenCalledWith('no session is live yet', 'error')
    expect(f.snapshot).not.toHaveBeenCalled()
    const unavailable = fixture({ withoutCopy: true })
    mountRemoteCopyOperations(unavailable.context)
    await unavailable.run()
    expect(unavailable.notice.set).toHaveBeenCalledWith('Clipboard is unavailable in this frontend', 'error')
    expect(unavailable.snapshot).not.toHaveBeenCalled()
  })

  it('ignores caller abort and retired dispatchers, and accepts ignored reference arguments', async () => {
    const f = fixture()
    const dispose = mountRemoteCopyOperations(f.context)
    const command = f.commands.list()[0]!
    await f.run('', AbortSignal.abort())
    expect(f.snapshot).not.toHaveBeenCalled()
    await f.run('extra')
    expect(f.snapshot).toHaveBeenCalledOnce()
    f.snapshot.mockClear(); f.copy.mockClear()
    dispose()
    await command.execute('', new AbortController().signal)
    expect(f.snapshot).not.toHaveBeenCalled()
    expect(f.copy).not.toHaveBeenCalled()
  })

  it('refuses a snapshot whose exact binding retires while it is observed', async () => {
    const f = fixture()
    mountRemoteCopyOperations(f.context)
    f.snapshot.mockImplementationOnce(() => { f.select({ ...f.selected, binding: {} as SessionBinding }); return conversation([assistant('stale')]) })
    await f.run()
    expect(f.copy).not.toHaveBeenCalled()
    expect(f.notice.set).not.toHaveBeenCalled()
  })

  it.each(['abort', 'session', 'host', 'binding', 'connection', 'unload'] as const)('does not publish late clipboard results after %s', async retirement => {
    for (const settlement of ['success', 'failure'] as const) {
      const f = fixture()
      const dispose = mountRemoteCopyOperations(f.context)
      const pending = Promise.withResolvers<void>()
      f.copy.mockReturnValueOnce(pending.promise)
      const abort = new AbortController()
      const copying = f.run('', abort.signal)
      expect(f.copy).toHaveBeenCalledOnce()
      if (retirement === 'abort') abort.abort()
      if (retirement === 'session') f.select({ ...f.selected, ref: { ...f.selected.ref, sessionId: SessionId('other') } })
      if (retirement === 'host') f.select({ ...f.selected, client: { ...f.selected.client } })
      if (retirement === 'binding') f.select({ ...f.selected, binding: {} as SessionBinding })
      if (retirement === 'connection') f.reconnect()
      if (retirement === 'unload') dispose()
      if (settlement === 'success') pending.resolve()
      else pending.reject(new Error('obsolete clipboard failure'))
      await copying
      expect(f.notice.set).not.toHaveBeenCalled()
      dispose()
    }
  })

  it('reports a current clipboard rejection and propagates only current projection failures', async () => {
    const f = fixture()
    mountRemoteCopyOperations(f.context)
    f.copy.mockRejectedValueOnce(new Error('clipboard closed'))
    await f.run()
    expect(f.notice.set).toHaveBeenCalledWith('could not copy to clipboard: clipboard closed', 'error')
    f.snapshot.mockImplementationOnce(() => { throw new Error('projection offline') })
    await expect(f.run()).rejects.toThrow('projection offline')
    f.snapshot.mockImplementationOnce(() => { f.select(undefined); throw new Error('obsolete projection error') })
    await expect(f.run()).resolves.toBe(true)
  })
})
