/** Native tree facts and completed stops preserve catalog, exact identity and Host-owned lifetimes. @module */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { subagentStop, subagentTree } from '../../src/remote/subagent.ts'

const id = SessionId
const child = (name: string, parent = 'root', mode: 'continuable' | 'one-shot' | 'external' = 'continuable'): SubagentDescendantListEntry => ({ kind: 'child', id: id(name), parentId: id(parent), depth: parent === 'root' ? 1 : 2, mode, activity: 'running', hasChildren: false, ...mode === 'continuable' ? { label: name } : {} }) as SubagentDescendantListEntry
const diagnostic = (name: string, parent = 'root'): SubagentDescendantListEntry => ({ kind: 'diagnostic', id: id(name), parentId: id(parent), depth: 1, reason: 'unavailable' })

function fixture(entries: readonly SubagentDescendantListEntry[] = []) {
  const sessions = new Map<string, Session>()
  const agents = new Map<string, Agent>()
  const values = new Map<string, Record<string, unknown>>()
  const resident = (name: string, status = 'idle') => {
    const session = { id: id(name), header: { origin: name === 'root' ? 'user' : 'subagent' } } as Session
    const agent = { id: session.id, session, status } as Agent
    sessions.set(name, session); agents.set(name, agent)
    return agent
  }
  const root = resident('root')
  const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
  const opening = vi.fn(async () => ({ done: false, value: { type: 'snapshot', assistantStream: { revision: 1 } } }))
  const follow = vi.fn((..._args: Parameters<Context['sessionController']['follow']>) => ({ [Symbol.asyncIterator]: () => ({ next: opening, return: returned }) }))
  const list = vi.fn(async () => entries)
  const drain = vi.fn(async () => {})
  const projections = vi.fn((session: Session) => ({ values: values.get(String(session.id)) ?? {} }))
  const resolve = vi.fn(async () => { throw new Error('passive reads must not activate') })
  const ctx = { agents: { get: (name: string) => agents.get(name) }, sessions: { get: (name: string) => sessions.get(name) },
    sessionController: { follow, resolveAgent: resolve }, sessionProjections: { snapshot: projections },
    subagents: { listDescendants: list, drainChildren: drain },
  } as unknown as Context
  const workflows = { snapshot: vi.fn(() => ({ sessionId: id('root'), runs: [] })) }
  const tree = (signal = new AbortController().signal) => subagentTree(ctx, { sessionId: id('root') }, signal, workflows)
  const stop = (name: string, signal = new AbortController().signal) => subagentStop(ctx, { sessionId: id('root'), childSessionId: id(name) }, signal)
  return { ctx, root, agents, sessions, values, resident, list, drain, follow, opening, returned, projections, resolve, workflows, tree, stop }
}

async function flush() { await Promise.resolve(); await Promise.resolve() }

describe('subagentTree', () => {
  it('returns the whole native pre-order tree, keeps diagnostics, recomputes activity, and never activates cold children', async () => {
    const f = fixture([child('parent'), child('nested', 'parent'), diagnostic('broken'), child('cold'), child('external', 'root', 'external')])
    f.resident('parent', 'running')
    f.resident('nested')
    f.values.set('parent', { mayflyConversationFacts: { epochTokens: 123, epochOutputTokens: 23, epochToolCount: 2, outputProgress: { step: 1 }, inFlight: [{ callId: 'p', name: 'read', preparing: true }, { callId: 'r', name: 'bash' }, { callId: 's', name: 'grep' }] }, subagentTiming: { settledMs: 30, active: { since: 40 } } })
    const rows = await f.tree()
    expect(rows.map(row => row.id)).toEqual(['parent', 'nested', 'broken', 'cold', 'external'])
    expect(rows[0]).toMatchObject({ parentId: 'root', depth: 1, activity: 'running', live: true, tokens: 123, inputTokens: 100, outputTokens: 23, currentTool: 'bash', outputProgress: { step: 1 }, toolCount: 2, settledMs: 30, activeSince: 40, stopBlocked: 'live-descendants' })
    expect(rows[1]).toMatchObject({ parentId: 'parent', depth: 2, activity: 'inactive', live: true })
    expect(rows[1]).not.toHaveProperty('stopBlocked')
    expect(rows[2]).toEqual(diagnostic('broken'))
    expect(rows[3]).toMatchObject({ activity: 'inactive', live: false, stopBlocked: 'not-live' })
    expect(rows[4]).toMatchObject({ stopBlocked: 'not-continuable' })
    expect(f.follow).toHaveBeenCalledTimes(2)
    expect(f.follow.mock.calls.map(([request]) => request)).toEqual([
      { address: { kind: 'subagent', parentSessionId: 'root', childSessionId: 'parent', mode: 'continuable' }, assistantStream: true, maxMessages: 1 },
      { address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'nested', mode: 'continuable' }, assistantStream: true, maxMessages: 1 },
    ])
    await flush()
    expect(f.returned).toHaveBeenCalledTimes(2)
    expect(f.resolve).not.toHaveBeenCalled()
    expect(Object.isFrozen(rows)).toBe(true)
    expect(rows.every(Object.isFrozen)).toBe(true)
  })

  it.each(['thinking', 'composing', 'waiting'] as const)('reads exact native %s stream output and preserves workflow labels and optional metrics', async phase => {
    const f = fixture([child('leaf', 'root', 'one-shot'), child('orphan', 'missing'), child('empty', 'missing', 'one-shot')])
    f.resident('leaf', 'running'); f.resident('orphan')
    const active = { stream: phase === 'waiting' ? [] : [{ type: phase === 'thinking' ? 'reasoning-chunks' : 'text-chunks', time0: 1, index: 0, dt: [], texts: ['hello你好'] }] }
    f.opening.mockResolvedValueOnce({ done: false, value: { type: 'snapshot', assistantStream: { revision: 2, activeAttempt: active } } } as never)
    f.workflows.snapshot.mockReturnValue({ sessionId: id('root'), runs: [{ agents: [{ childId: id('leaf'), label: 'Native workflow label' }] }] } as never)
    f.values.set('leaf', { mayflyConversationFacts: { epochTokens: 0, epochToolCount: 0 }, subagentTiming: { settledMs: 0, active: { since: 0 } } })
    const rows = await f.tree()
    expect(rows[0]).toMatchObject({ label: 'Native workflow label', tokens: 0, toolCount: 0, settledMs: 0, activeSince: 0 })
    expect(rows[0]).toMatchObject({ inputTokens: 0 })
    expect(rows[0]).not.toHaveProperty('outputTokens')
    if (phase === 'waiting') { expect(rows[0]).not.toHaveProperty('streamPhase'); expect(rows[0]).not.toHaveProperty('liveChars') }
    else expect(rows[0]).toMatchObject({ streamPhase: phase, liveChars: 7 })
    expect(rows[1]).toMatchObject({ stopBlocked: 'parent-not-live' })
    expect(rows[2]).not.toHaveProperty('label')
    expect(f.workflows.snapshot).toHaveBeenCalledOnce()
  })

  it('does not invent a workflow label or metrics and supports a passive cold root', async () => {
    const f = fixture([child('plain', 'root', 'one-shot')])
    f.agents.clear(); f.sessions.clear()
    const rows = await f.tree()
    expect(rows[0]).not.toHaveProperty('label')
    expect(rows[0]).not.toHaveProperty('tokens')
    for (const field of ['inputTokens', 'outputTokens', 'currentTool', 'outputProgress']) expect(rows[0]).not.toHaveProperty(field)
    expect(f.follow).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
    const resident = fixture([child('plain', 'root', 'one-shot')])
    expect((await resident.tree())[0]).not.toHaveProperty('label')
  })

  it('never follows an external execution through an unrelated local Agent with the same id', async () => {
    const f = fixture([child('external', 'root', 'external')])
    f.resident('external', 'running')
    expect((await f.tree())[0]).toMatchObject({ mode: 'external', activity: 'inactive', live: false })
    expect(f.follow).not.toHaveBeenCalled()
  })

  it.each(['done', 'event', 'missing'] as const)('refuses a %s native opening and releases the exact reader', async shape => {
    const f = fixture([child('leaf')]); f.resident('leaf')
    f.opening.mockResolvedValueOnce(shape === 'done' ? { done: true, value: undefined } as never : shape === 'event' ? { done: false, value: { type: 'event' } } as never : { done: false, value: { type: 'snapshot' } } as never)
    await expect(f.tree()).rejects.toMatchObject({ code: 'mayflyHost/subagent-tree-unavailable' })
    await flush()
    expect(f.returned).toHaveBeenCalledOnce()
  })

  it.each(['root', 'root-session', 'child', 'child-session', 'cold-child', 'cancel'] as const)('retires an opening after %s replacement and releases a stalled foreign iterator', async reason => {
    const f = fixture([child('leaf'), child('cold')]); const leaf = f.resident('leaf')
    const gate = Promise.withResolvers<unknown>()
    f.opening.mockReturnValueOnce(gate.promise as never)
    const caller = new AbortController()
    const pending = f.tree(caller.signal)
    await vi.waitFor(() => { expect(f.opening).toHaveBeenCalled() })
    if (reason === 'root') f.resident('root')
    if (reason === 'root-session') f.sessions.set('root', { ...f.root.session } as Session)
    if (reason === 'child') f.resident('leaf')
    if (reason === 'child-session') f.sessions.set('leaf', { ...leaf.session } as Session)
    if (reason === 'cold-child') f.resident('cold')
    if (reason === 'cancel') caller.abort(new Error('caller retired'))
    const rejection = expect(pending).rejects.toThrow(reason === 'cancel' ? 'caller retired' : 'changed before')
    if (reason !== 'cancel') gate.resolve({ done: false, value: { type: 'snapshot', assistantStream: { revision: 1 } } })
    await rejection
    await flush()
    expect(f.returned).toHaveBeenCalledOnce()
    gate.resolve({ done: false, value: { type: 'snapshot', assistantStream: { revision: 1 } } })
    await flush()
    expect(f.drain).not.toHaveBeenCalled()
  })

  it('publishes native catalog refusal only while owned and refuses pre-aborted work', async () => {
    const f = fixture()
    f.list.mockRejectedValueOnce('native catalog failed')
    await expect(f.tree()).rejects.toMatchObject({ code: 'mayflyHost/subagent-tree-unavailable', message: 'native catalog failed' })
    const caller = new AbortController(); caller.abort(new Error('pre-aborted'))
    await expect(f.tree(caller.signal)).rejects.toThrow('pre-aborted')
    expect(f.list).toHaveBeenCalledOnce()
    const stale = fixture()
    stale.list.mockImplementationOnce(async () => { stale.resident('root'); throw new Error('retired refusal') })
    await expect(stale.tree()).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    const noReturn = fixture([child('leaf')]); noReturn.resident('leaf')
    noReturn.follow.mockReturnValueOnce({ [Symbol.asyncIterator]: () => ({ next: noReturn.opening }) } as never)
    await noReturn.tree()
  })

  it('retires synchronous follow cancellation and suppresses a released reader refusal', async () => {
    const cancelled = fixture([child('leaf')]); cancelled.resident('leaf')
    const caller = new AbortController()
    cancelled.follow.mockImplementationOnce(() => {
      caller.abort(new Error('follow opening retired'))
      return { [Symbol.asyncIterator]: () => ({ next: cancelled.opening, return: cancelled.returned }) }
    })
    await expect(cancelled.tree(caller.signal)).rejects.toThrow('follow opening retired')
    const released = fixture([child('leaf')]); released.resident('leaf')
    released.returned.mockRejectedValueOnce(new Error('already closed reader'))
    await expect(released.tree()).resolves.toHaveLength(1)
    await flush()
    expect(released.returned).toHaveBeenCalledOnce()
  })

  it.each(['synchronous', 'asynchronous'] as const)('wraps a %s native stream refusal in the public domain vocabulary', async timing => {
    const f = fixture([child('leaf')]); f.resident('leaf')
    if (timing === 'synchronous') f.follow.mockImplementationOnce(() => { throw new Error('native stream refused') })
    else f.opening.mockRejectedValueOnce(new Error('native stream refused'))
    await expect(f.tree()).rejects.toMatchObject({ code: 'mayflyHost/subagent-tree-unavailable', message: 'native stream refused', details: { sessionId: 'root', reason: 'stream-opening-unavailable' } })
  })
})

describe('subagentStop', () => {
  it('stops a nested idle live child through its exact direct parent, waits for native completion and preserves its conversation', async () => {
    const f = fixture([child('branch'), child('leaf', 'branch')])
    const parent = f.resident('branch'); f.resident('leaf')
    const gate = Promise.withResolvers<void>()
    f.drain.mockReturnValueOnce(gate.promise)
    const pending = f.stop('leaf')
    let settled = false
    void pending.then(() => { settled = true })
    await vi.waitFor(() => { expect(f.drain).toHaveBeenCalledWith(parent, ['leaf']) })
    expect(settled).toBe(false)
    gate.resolve()
    expect(await pending).toEqual({ kind: 'success', text: 'stopped subagent leaf' })
    expect(f.sessions.has('leaf')).toBe(true)
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', [], [], 'unknown subagent: missing'],
    ['external', [child('external', 'root', 'external')], [], 'subagent external is external; it has no local Agent to stop'],
    ['once', [child('once', 'root', 'one-shot')], [], 'subagent once is not continuable'],
    ['cold', [child('cold')], [], 'subagent cold is not live; there is no running Agent to stop'],
    ['leaf', [child('leaf', 'absent')], ['leaf'], 'cannot stop subagent leaf: its direct parent is not live'],
    ['branch', [child('branch'), child('leaf', 'branch')], ['branch', 'leaf'], 'subagent branch owns 1 live descendant; stop its live descendants first'],
    ['branch', [child('branch'), child('middle', 'branch'), child('leaf', 'middle')], ['branch', 'middle', 'leaf'], 'subagent branch owns 2 live descendants; stop its live descendants first'],
  ] as const)('refuses %s from current native facts with the exact reference message', async (name, rows, live, message) => {
    const f = fixture(rows)
    for (const name of live) f.resident(name)
    await expect(f.stop(name)).rejects.toMatchObject({ code: 'mayflyHost/subagent-stop-unavailable', message })
    expect(f.drain).not.toHaveBeenCalled()
  })

  it('counts live descendants through cold parents and ignores broken, unrelated and cyclic ancestry', async () => {
    const f = fixture([child('target'), child('middle', 'target'), child('leaf', 'middle'), diagnostic('diagnostic'), child('unrelated', 'missing'), child('a', 'b'), child('b', 'a')])
    for (const name of ['target', 'leaf', 'unrelated', 'a', 'b']) f.resident(name)
    await expect(f.stop('target')).rejects.toThrow('owns 1 live descendant')
    f.agents.delete('leaf')
    await expect(f.stop('target')).resolves.toMatchObject({ text: 'stopped subagent target' })
  })

  it('rejects an absent or replaced root without activating it, including catalogue late failure and pre-abort', async () => {
    const f = fixture(); f.agents.clear()
    await expect(f.stop('leaf')).rejects.toThrow('no session is live yet')
    expect(f.resolve).not.toHaveBeenCalled()
    const caller = new AbortController(); caller.abort(new Error('pre-aborted'))
    await expect(f.stop('leaf', caller.signal)).rejects.toThrow('pre-aborted')
    const stale = fixture([child('leaf')]); stale.resident('leaf')
    stale.list.mockImplementationOnce(async () => { stale.resident('root'); return [child('leaf')] })
    await expect(stale.stop('leaf')).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    stale.list.mockRejectedValueOnce(new Error('catalogue failed'))
    await expect(stale.stop('leaf')).rejects.toThrow('catalogue failed')
    stale.list.mockImplementationOnce(async () => { stale.resident('root'); throw new Error('retired failure') })
    await expect(stale.stop('leaf')).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
  })

  it.each(['cancel', 'root', 'parent'] as const)('retires both sent stop outcomes after %s without cancelling native teardown', async reason => {
    for (const fails of [false, true]) {
      const f = fixture([child('branch'), child('leaf', 'branch')]); f.resident('branch'); f.resident('leaf')
      const gate = Promise.withResolvers<void>()
      f.drain.mockReturnValueOnce(gate.promise)
      const caller = new AbortController()
      const pending = f.stop('leaf', caller.signal)
      await vi.waitFor(() => { expect(f.drain).toHaveBeenCalled() })
      if (reason === 'cancel') caller.abort(new Error('retired stop'))
      if (reason === 'root') f.resident('root')
      if (reason === 'parent') f.resident('branch')
      const rejected = expect(pending).rejects.toThrow(reason === 'cancel' ? 'retired stop' : 'changed before')
      if (fails) gate.reject(new Error('native teardown refusal'))
      else gate.resolve()
      await rejected
      expect(f.drain).toHaveBeenCalledOnce()
    }
  })

  it.each([new Error('native failure'), 'plain failure', Object.assign(new Error('ownership changed'), { code: 'UNAUTHORIZED' })])('wraps a native stop refusal in the public domain vocabulary: %s', async error => {
    const f = fixture([child('leaf')]); f.resident('leaf')
    f.drain.mockRejectedValueOnce(error)
    await expect(f.stop('leaf')).rejects.toMatchObject({ code: error instanceof Error && 'code' in error ? 'mayflyHost/subagent-stop-unauthorized' : 'mayflyHost/subagent-stop-unavailable', message: `could not stop subagent leaf: ${error instanceof Error ? error.message : error}` })
  })
})
