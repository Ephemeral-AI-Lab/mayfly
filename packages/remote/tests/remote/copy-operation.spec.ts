import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { Context } from '@deepseek-ai/cordis'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import type { RemoteOperationsContext, RemotePresentSlot } from '../../src/remote/operations/support.ts'
import { collectRemoteSessionEvents } from '../../src/remote/operations/support.ts'
import { mountRemoteCopyOperations } from '../../src/remote/operations/copy.ts'

vi.mock('../../src/remote/operations/support.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/remote/operations/support.ts')>(),
  collectRemoteSessionEvents: vi.fn(),
}))

/**
 * Minimal Cordis context for the locale seam: `effect` owns the registration
 * disposer, `inject` resolves the locale service, and a registered namespace's
 * English catalog is the identity map the module ships.
 */
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
    effect: (callback: () => void | (() => void)) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject: (_names: readonly string[], callback: (scoped: unknown) => void) => {
      callback(ctx)
      return () => {}
    },
    get: (name: string) => (name === 'mayflyLocale' ? locale : undefined),
  }
  return ctx as unknown as Context
}

function selection(client: HostClient, sessionId = 'session-1'): RemoteFeatureSelection {
  return {
    ref: { host: HostKey('local'), sessionId: SessionId(sessionId) },
    client,
    binding: { session: { projections: { faceOf: vi.fn() } } } as unknown as SessionBinding,
  }
}

/** One assistant message in the wire shape the copy fold reads. */
function assistant(seq: number, content: readonly unknown[]): SessionWireEvent {
  return { type: 'assistant/message', seq, time: seq, data: { message: { content } } } as unknown as SessionWireEvent
}

function user(seq: number, text: string): SessionWireEvent {
  return { type: 'user/message', seq, time: seq, data: { content: [{ type: 'text', text }] } } as unknown as SessionWireEvent
}

function fixture(options: { withoutCopy?: boolean } = {}) {
  const ctx = fakeContext()
  const notice = { set: vi.fn() }
  const commands = new RemoteFeatureCommandRegistry()
  const copy = vi.fn(async (_text: string) => {})
  const journal = vi.mocked(collectRemoteSessionEvents)
  journal.mockReset()
  const client = { key: 'host-client' } as unknown as HostClient
  let current: RemoteFeatureSelection | undefined = selection(client)
  const hosts = {
    list: () => (current === undefined ? [] : [current.client]),
    current: () => current,
    subscribe: () => () => {},
  }
  const base = {
    ctx,
    hosts,
    notice,
    commands,
    subscribeLocale: () => () => {},
  } as unknown as RemoteFeatureContext
  const context = {
    base,
    options: { localCwd: '/work', copy: options.withoutCopy === true ? undefined : copy },
    presentSlot: {} as unknown as RemotePresentSlot,
  } as unknown as RemoteOperationsContext
  const run = (input = '', signal = new AbortController().signal): Promise<boolean> => commands.execute('copy', input, signal)
  const setSelection = (next: RemoteFeatureSelection | undefined): void => { current = next }
  return { context, notice, commands, copy, journal, client, run, setSelection }
}

describe('mountRemoteCopyOperations', () => {
  it('registers exactly the copy command and its disposer unregisters it', () => {
    const { context, commands } = fixture()
    const dispose = mountRemoteCopyOperations(context)
    expect(commands.list().map(command => command.name)).toEqual(['copy'])
    expect(commands.list()[0]?.description).toBe('Copy the last assistant message to the clipboard')
    dispose()
    expect(commands.list()).toEqual([])
    mountRemoteCopyOperations(context)
    expect(commands.list().map(command => command.name)).toEqual(['copy'])
  })

  it('reports the localized no-session notice instead of throwing', async () => {
    const { context, notice, copy, journal, run, setSelection } = fixture()
    mountRemoteCopyOperations(context)
    setSelection(undefined)
    await expect(run()).resolves.toBe(true)
    expect(notice.set).toHaveBeenCalledWith('No current session')
    expect(journal).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
  })

  it('reports clipboard unavailability without reading the journal', async () => {
    const { context, notice, journal, run } = fixture({ withoutCopy: true })
    mountRemoteCopyOperations(context)
    await expect(run()).resolves.toBe(true)
    expect(notice.set).toHaveBeenCalledOnce()
    expect(notice.set).toHaveBeenCalledWith('Clipboard is unavailable in this frontend')
    expect(journal).not.toHaveBeenCalled()
  })

  it('reports no assistant reply for a bounded backwards read of a journal without one', async () => {
    const { context, notice, copy, journal, client, run } = fixture()
    journal.mockResolvedValue([user(1, 'question'), user(2, 'another question')])
    mountRemoteCopyOperations(context)
    await expect(run()).resolves.toBe(true)
    expect(notice.set).toHaveBeenCalledWith('No assistant reply to copy yet')
    expect(copy).not.toHaveBeenCalled()
    expect(journal).toHaveBeenCalledOnce()
    expect(journal).toHaveBeenCalledWith(client, expect.objectContaining({
      address: { kind: 'session', sessionId: SessionId('session-1') },
      maxMessages: 500,
      maxPages: 4,
    }))
  })

  it('copies only the newest assistant text, joining text blocks and skipping reasoning and images', async () => {
    const { context, notice, copy, journal, run } = fixture()
    journal.mockResolvedValue([
      assistant(1, [{ type: 'text', text: 'older reply' }]),
      user(2, 'the newest question'),
      assistant(3, [
        { type: 'reasoning', text: 'thinking about the answer' },
        { type: 'text', text: 'alpha' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA' },
        { type: 'text', text: '   ' },
        { type: 'text', text: 'beta' },
      ]),
    ])
    mountRemoteCopyOperations(context)
    await expect(run()).resolves.toBe(true)
    expect(copy).toHaveBeenCalledOnce()
    expect(copy).toHaveBeenCalledWith('alpha\n\nbeta')
    expect(notice.set).toHaveBeenCalledWith('Copied 11 characters')
  })

  it('falls back to the newest assistant reply that carries text', async () => {
    const { context, copy, journal, run } = fixture()
    journal.mockResolvedValue([
      assistant(1, [{ type: 'text', text: 'kept reply' }]),
      assistant(2, [{ type: 'reasoning', text: 'reasoning only' }]),
    ])
    mountRemoteCopyOperations(context)
    await expect(run()).resolves.toBe(true)
    expect(copy).toHaveBeenCalledWith('kept reply')
  })

  it('surfaces a could-not-copy notice instead of throwing when the clipboard rejects', async () => {
    const { context, notice, copy, journal, run } = fixture()
    journal.mockResolvedValue([assistant(1, [{ type: 'text', text: 'reply' }])])
    copy.mockRejectedValue(new Error('clipboard closed'))
    mountRemoteCopyOperations(context)
    await expect(run()).resolves.toBe(true)
    expect(notice.set).toHaveBeenCalledWith('Could not copy: clipboard closed')
  })

  it('ignores aborted calls, rejects arguments, and retires a retained dispatcher after unload', async () => {
    const f = fixture()
    const dispose = mountRemoteCopyOperations(f.context)
    const command = f.commands.list()[0]!
    const abort = new AbortController()
    abort.abort()
    await f.run('', abort.signal)
    expect(f.journal).not.toHaveBeenCalled()
    await expect(f.run('extra')).rejects.toThrow('Usage: /copy')
    dispose()
    await command.execute('', new AbortController().signal)
    expect(f.journal).not.toHaveBeenCalled()
  })

  it('skips malformed native message content and non-text blocks', async () => {
    const f = fixture()
    f.journal.mockResolvedValue([
      { type: 'assistant/message', data: null },
      { type: 'assistant/message', data: { message: false } },
      { type: 'assistant/message', data: { message: { content: 'unavailable' } } },
      assistant(4, [null, { type: 'text', text: 123 }, { type: 'text', text: 'valid text' }]),
    ] as unknown as SessionWireEvent[])
    mountRemoteCopyOperations(f.context)
    await f.run()
    expect(f.copy).toHaveBeenCalledWith('valid text')
    f.copy.mockClear()
    f.journal.mockResolvedValue([
      { type: 'assistant/message', data: null },
      { type: 'assistant/message', data: { message: false } },
      { type: 'assistant/message', data: { message: { content: 'unavailable' } } },
    ] as unknown as SessionWireEvent[])
    await f.run()
    expect(f.copy).not.toHaveBeenCalled()
    expect(f.notice.set).toHaveBeenLastCalledWith('No assistant reply to copy yet')
  })

  it.each(['abort', 'selection', 'binding', 'dispose'] as const)('does not copy a late native read after %s retirement', async retirement => {
    const f = fixture()
    const dispose = mountRemoteCopyOperations(f.context)
    const pending = Promise.withResolvers<SessionWireEvent[]>()
    f.journal.mockReturnValueOnce(pending.promise)
    const abort = new AbortController()
    const copying = f.run('', abort.signal)
    if (retirement === 'abort') abort.abort()
    else if (retirement === 'dispose') dispose()
    else f.setSelection(selection(f.client, retirement === 'selection' ? 'other-session' : 'session-1'))
    pending.resolve([assistant(1, [{ type: 'text', text: 'old reply' }])])
    await copying
    expect(f.copy).not.toHaveBeenCalled()
    expect(f.notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it.each(['success', 'failure'] as const)('does not publish late clipboard %s after caller cancellation', async settlement => {
    const f = fixture()
    const dispose = mountRemoteCopyOperations(f.context)
    f.journal.mockResolvedValue([assistant(1, [{ type: 'text', text: 'reply' }])])
    const pending = Promise.withResolvers<void>()
    f.copy.mockReturnValueOnce(pending.promise)
    const abort = new AbortController()
    const copying = f.run('', abort.signal)
    await vi.waitFor(() => { expect(f.copy).toHaveBeenCalledOnce() })
    abort.abort()
    if (settlement === 'success') pending.resolve()
    else pending.reject(new Error('obsolete clipboard error'))
    await copying
    expect(f.notice.set).not.toHaveBeenCalled()
    dispose()
  })

  it('propagates a current native read failure and suppresses one that settles after unload', async () => {
    const f = fixture()
    const dispose = mountRemoteCopyOperations(f.context)
    f.journal.mockRejectedValueOnce(new Error('native history offline'))
    await expect(f.run()).rejects.toThrow('native history offline')
    const pending = Promise.withResolvers<SessionWireEvent[]>()
    f.journal.mockReturnValueOnce(pending.promise)
    const copying = f.run()
    dispose()
    pending.reject(new Error('obsolete native read failure'))
    await copying
    expect(f.notice.set).not.toHaveBeenCalled()
  })
})
