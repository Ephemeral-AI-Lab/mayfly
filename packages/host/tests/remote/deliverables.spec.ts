/** Exact recorded delivery reads, native filesystem ownership and stale/abort refusal. @module */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import { deliveredFile, latestWorkspaceChanges, DELIVERED_PREVIEW_LIMIT } from '../../src/remote/deliverables.ts'

const sessionId = SessionId('one')
const request = { sessionId, deliveryId: '4/0' }
function fixture() {
  let cwd = '/host/work'
  let files: readonly { id: string, path: string }[] | undefined = [{ id: '4/0', path: 'report.txt' }]
  let stat: { type: string, size?: number } | undefined = { type: 'file', size: 12 }
  let bytes: Uint8Array<ArrayBufferLike> = new TextEncoder().encode('preview 第二行')
  const target = { targetKey: 'opaque', displayPath: '~/work/report.txt' }
  const fs = { resolve: vi.fn(async () => target), stat: vi.fn(async () => stat), processPath: vi.fn(() => '/host/work/report.txt'), readBytes: vi.fn(async () => bytes) }
  let events: readonly { type: string, seq: number }[] = [{ type: 'workspace/changes', seq: 8 }, { type: 'turn/end', seq: 9 }]
  const session = { id: sessionId, header: { cwd: '/header', origin: 'user' }, snapshotEvents: () => events }
  const agent = { id: sessionId, session, ctx: { fs } }
  const agents = { get: vi.fn(() => agent) }
  const sessions = { get: vi.fn(() => session) }
  const summary = vi.fn((): unknown => ({ turn: 3, cwd, files: [], total: 0, added: 0, deleted: 0 }))
  const context = { agents, sessions, sessionProjections: { snapshot: (_session: unknown, keys: readonly string[]) => ({ values: keys.includes('workingDirectory') ? { workingDirectory: cwd } : { mayflyDeliverables: files } }) }, workspaceChanges: { summary } } as unknown as Context
  return { context, fs, target, agent, agents, sessions, summary,
    cwd: (value: string) => { cwd = value }, files: (value: typeof files) => { files = value }, stat: (value: typeof stat) => { stat = value }, bytes: (value: Uint8Array) => { bytes = value }, events: (value: typeof events) => { events = value },
  }
}
const signal = () => new AbortController().signal

describe('recorded delivery filesystem reads', () => {
  it('uses the exact Agent filesystem, effective Host cwd, and opaque target; no native target escapes', async () => {
    const f = fixture()
    const caller = signal()
    const result = await deliveredFile(f.context, request, caller)
    expect(f.fs.resolve).toHaveBeenCalledWith('report.txt', { cwd: '/host/work', signal: caller })
    expect(f.fs.stat).toHaveBeenCalledWith(f.target, caller)
    expect(f.fs.processPath).toHaveBeenCalledWith(f.target)
    expect(result).toEqual({ path: '/host/work/report.txt', displayPath: '~/work/report.txt', fileType: 'file', size: 12 })
    expect(Object.isFrozen(result)).toBe(true)
    expect(f.fs.readBytes).not.toHaveBeenCalled()
  })

  it('keeps absent metadata and non-file targets honest without probing their bytes', async () => {
    const f = fixture()
    f.stat(undefined)
    expect(await deliveredFile(f.context, { ...request, preview: true }, signal())).toEqual({ path: '/host/work/report.txt', displayPath: '~/work/report.txt' })
    f.stat({ type: 'directory' })
    expect(await deliveredFile(f.context, { ...request, preview: true }, signal())).toMatchObject({ fileType: 'directory' })
    expect(f.fs.readBytes).not.toHaveBeenCalled()
    f.stat({ type: 'file' })
    expect(await deliveredFile(f.context, request, signal())).not.toHaveProperty('size')
  })

  it('caps UTF-8 preview reads at the frozen 256 KiB window and returns the frozen binary fallback', async () => {
    const f = fixture()
    const caller = signal()
    expect(await deliveredFile(f.context, { ...request, preview: true }, caller)).toMatchObject({ preview: 'preview 第二行' })
    expect(f.fs.readBytes).toHaveBeenCalledWith(f.target, caller, DELIVERED_PREVIEW_LIMIT)
    f.bytes(Uint8Array.of(65, 0, 66))
    expect(await deliveredFile(f.context, { ...request, preview: true }, caller)).toMatchObject({ preview: 'Binary file; use Open in an external application.' })
  })

  it.each([undefined, [], [{ id: 'another', path: 'report.txt' }]])('refuses an id absent from the authoritative delivery projection %#', async files => {
    const f = fixture()
    f.files(files)
    await expect(deliveredFile(f.context, request, signal())).rejects.toMatchObject({ code: 'mayflyHost/delivery-unavailable', message: 'File unavailable' })
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'stat', 'readBytes'] as const)('refuses cancellation settling during native %s', async stage => {
    const f = fixture()
    const caller = new AbortController()
    const original = f.fs[stage].getMockImplementation()!
    f.fs[stage].mockImplementationOnce((async () => { const value = await original(); caller.abort(new Error('cancelled')); return value }) as never)
    await expect(deliveredFile(f.context, { ...request, preview: true }, caller.signal)).rejects.toThrow('cancelled')
  })

  it.each(['cwd', 'delivery-path', 'delivery-id', 'Agent', 'Session'] as const)('refuses a stale %s after resolution and before stat', async changed => {
    const f = fixture()
    f.fs.resolve.mockImplementationOnce(async () => {
      if (changed === 'cwd') f.cwd('/other')
      else if (changed === 'delivery-path') f.files([{ id: '4/0', path: 'other.txt' }])
      else if (changed === 'delivery-id') f.files([])
      else if (changed === 'Agent') f.agents.get.mockReturnValue({ ...f.agent })
      else f.sessions.get.mockReturnValue({ ...f.agent.session })
      return f.target
    })
    await expect(deliveredFile(f.context, request, signal())).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    expect(f.fs.stat).not.toHaveBeenCalled()
  })

  it('refuses already cancelled callers before any filesystem read', async () => {
    const f = fixture()
    await expect(deliveredFile(f.context, request, AbortSignal.abort())).rejects.toThrow()
    expect(f.fs.resolve).not.toHaveBeenCalled()
  })

  it('preserves the native filesystem refusal without manufacturing file details', async () => {
    const f = fixture()
    const failure = new Error('read denied')
    f.fs.stat.mockRejectedValueOnce(failure)
    await expect(deliveredFile(f.context, request, signal())).rejects.toBe(failure)
  })
})

describe('latest native changes summary', () => {
  it('addresses the last workspace/changes event rather than the later turn/end event', () => {
    const f = fixture()
    const value = latestWorkspaceChanges(f.context, { sessionId }, signal())
    expect(value).toMatchObject({ seq: 8, summary: { turn: 3 } })
    expect(f.summary).toHaveBeenCalledWith(sessionId, 8)
    expect(Object.isFrozen(value?.summary)).toBe(true)
    expect(f.agents.get).not.toHaveBeenCalled()
  })
  it('stays passive for cold sessions and absent or retired native change summaries', () => {
    const f = fixture()
    f.sessions.get.mockReturnValueOnce(undefined as never)
    expect(latestWorkspaceChanges(f.context, { sessionId }, signal())).toBeNull()
    f.events([])
    expect(latestWorkspaceChanges(f.context, { sessionId }, signal())).toBeNull()
    f.events([{ type: 'workspace/changes', seq: 2 }])
    f.summary.mockReturnValueOnce(undefined)
    expect(latestWorkspaceChanges(f.context, { sessionId }, signal())).toBeNull()
    f.summary.mockReturnValueOnce({ lossy: () => {} })
    expect(latestWorkspaceChanges(f.context, { sessionId }, signal())).toBeNull()
    expect(f.agents.get).not.toHaveBeenCalled()
  })
  it('refuses cancelled callers before reading native state', () => {
    const f = fixture()
    expect(() => latestWorkspaceChanges(f.context, { sessionId }, AbortSignal.abort())).toThrow()
    expect(f.sessions.get).not.toHaveBeenCalled()
  })
})
