/** The Agents view: members from the parent's facts and child states, its panel, and the owner of its one poll. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import type { MayflySubagentTreeEntry } from '../../src/hosts/host-contract.ts'
import { mountAgentsView, type AgentsViewSeam } from '../../src/app/operations/agents-view.ts'
import { agentMembers, agentsLive, agentsPanel, agentsSummary, AGENTS_VIEW_LIST_ID, AGENTS_VIEW_STOP_ID, type AgentMember } from '../../src/app/panels/agents.ts'
import { interpolateLocaleMessage as t } from '../../src/frontend/locale.ts'
import type { SpawnedChildren } from '../../src/transcript/tool-calls.ts'
import { taskFixture, tick } from './task-feature-fixture.ts'

const NOW = 100_000
const PROGRESS = { chars: 8_000, initialChars: 400, startedAt: NOW - 2_000, updatedAt: NOW }
const call = (callId: string, description: string | undefined, result?: { readonly text?: string, readonly isError?: boolean, readonly endedAt?: number }) => ({
  seq: 1, turn: 1, step: 1, callId, name: 'subagent', startedAt: NOW - 41_000,
  arguments: JSON.stringify(description === undefined ? { prompt: 'p' } : { description, prompt: 'p' }),
  ...result === undefined ? {} : { result: { text: 'started', isError: false, endedAt: NOW - 40_900, ...result } },
})
const child = (id: string, extra: Partial<Extract<MayflySubagentTreeEntry, { readonly kind: 'child' }>> = {}): MayflySubagentTreeEntry => ({
  kind: 'child', id: id as never, parentId: 'session' as never, depth: 1, activity: 'running', hasChildren: false, mode: 'continuable', ...extra,
} as MayflySubagentTreeEntry)
const known = (states: Record<string, NonNullable<ReturnType<SpawnedChildren['byId']['get']>> | undefined>): SpawnedChildren => ({
  byCall: new Map(Object.keys(states).map(callId => [callId, `child-${callId}`])),
  byId: new Map(Object.entries(states).flatMap(([callId, state]) => state === undefined ? [] : [[`child-${callId}`, state]])),
})
const member = (extra: Partial<AgentMember> = {}): AgentMember => ({ callId: 'a', childId: 'child-a', label: 'Explore', state: 'running', startedAt: NOW - 41_000, ...extra })

describe('agent members', () => {
  it('reads a spawn as its child does, its failed call as failed, and an unknown child as its call', () => {
    const calls = [
      call('pending', 'Pending'),
      call('refused', 'Refused', { isError: true, endedAt: 5 }),
      call('working', 'Working', {}),
      call('done', 'Done', {}),
      call('broke', 'Broke', {}),
      call('halted', 'Halted', {}),
      call('endless', 'Endless', {}),
      call('nameless', undefined, {}),
      call('unstated', 'Unstated', {}),
    ]
    const children = known({
      pending: { state: 'running' }, working: { state: 'running' },
      done: { state: 'settled', failed: false, endedAt: 77 }, broke: { state: 'settled', failed: true, endedAt: 78 },
      halted: { state: 'settled', failed: false, stopped: true, endedAt: 79 }, endless: { state: 'settled', failed: false }, unstated: undefined,
    })
    const members = agentMembers(calls, children)
    expect(members.map(each => [each.callId, each.state, each.endedAt])).toEqual([
      ['pending', 'running', undefined], ['refused', 'failed', 5], ['working', 'running', undefined], ['done', 'completed', 77], ['broke', 'failed', 78],
      ['halted', 'stopped', 79], ['endless', 'completed', NOW - 40_900], ['nameless', 'completed', NOW - 40_900], ['unstated', 'completed', NOW - 40_900],
    ])
    expect(members[0]).toMatchObject({ childId: 'child-pending', label: 'Pending' })
    expect(members[1]).not.toHaveProperty('childId')
    expect(members[7]!.label).toBe('subagent')
  })

  it('takes the label field of a fork, and needs no child states at all', () => {
    const fork = { ...call('fork', undefined, {}), arguments: JSON.stringify({ label: 'Forked' }) }
    expect(agentMembers([fork], undefined)[0]).toMatchObject({ label: 'Forked', state: 'completed' })
    expect(agentsLive(agentMembers([fork], undefined))).toBe(false)
    expect(agentsLive(agentMembers([call('p', 'P')], undefined))).toBe(true)
  })
})

describe('the Agents item and panel', () => {
  const none = (): undefined => undefined
  const text = (value: unknown): string => JSON.stringify(value)

  it('counts settled over all, marks a failure once all settled, and is absent with no members', () => {
    expect(agentsSummary([], t)).toBeNull()
    expect(text(agentsSummary([member(), member({ state: 'completed' }), member({ state: 'failed' })], t))).toMatch(/●.*agents.*2\/3/u)
    expect(text(agentsSummary([member({ state: 'completed' }), member({ state: 'failed' })], t))).toMatch(/✕.*2\/2/u)
    expect(text(agentsSummary([member({ state: 'completed' }), member({ state: 'stopped' })], t))).toMatch(/✓.*2\/2/u)
  })

  it('lists live members first and says what each does, leaving figures out until they are there', () => {
    expect(agentsPanel([], [], none, NOW, t)).toBeNull()
    const members = [
      member({ callId: 'd', childId: 'd', label: 'Done', state: 'completed', endedAt: NOW - 1_000 }),
      member({ callId: 'l', childId: 'l', label: 'Live' }),
      member({ callId: 'f', childId: 'f', label: 'Failed', state: 'failed', endedAt: NOW - 1_000 }),
      member({ callId: 's', childId: 's', label: 'Stopped', state: 'stopped', endedAt: NOW - 1_000 }),
      member({ callId: 'w', childId: 'w', label: 'Writer' }),
      member({ callId: 'u', childId: 'u', label: 'User' }),
      { callId: 'n', label: 'Unnamed', state: 'running' as const, startedAt: NOW - 41_000 },
    ]
    const tree = [
      child('l', { inputTokens: 49_152, outputTokens: 6_400, outputProgress: PROGRESS, liveChars: 400 }),
      child('w', { streamPhase: 'composing', inputTokens: 0, outputTokens: 0 }),
      child('u', { currentTool: 'bash' }),
      { kind: 'diagnostic', id: 'bad' as never, parentId: 'session' as never, depth: 1, reason: 'corrupt' },
    ] as readonly MayflySubagentTreeEntry[]
    const node = agentsPanel(members, tree, none, NOW, t) as unknown as { children: { node?: { kind: string, items: readonly Record<string, unknown>[] }, kind?: string, items?: readonly Record<string, unknown>[] }[] }
    const list = node.children.map(each => each.node ?? each).find(each => each.kind === 'list')!
    const items = list.items!.filter(item => item['gap'] !== true)
    expect(items.map(item => item['label'])).toEqual(['Live', 'Writer', 'User', 'Unnamed', 'Done', 'Failed', 'Stopped'])
    const activity = (id: string) => text((items.find(item => item['id'] === id)!['cells'] as readonly unknown[])[1])
    expect(activity('l')).toContain('Thinking…')
    expect(activity('w')).toContain('Writing…')
    expect(activity('u')).toContain('Using bash')
    expect(activity('d')).toContain('"spans":[]')
    expect(activity('f')).toContain('failed')
    expect(activity('s')).toContain('stopped')
    const right = (id: string) => text(items.find(item => item['id'] === id)!['right'])
    expect(right('l')).toContain('↑48k  ↓6.3k  ')
    expect(right('l')).toContain('tok/s')
    expect(right('l')).toContain('41s')
    expect(right('w')).toContain('"41s"')
    expect(right('d')).toContain('40s')
    expect(items.find(item => item['id'] === 'n')!['disabled']).toBe(true)
    expect(items.find(item => item['id'] === 'l')).not.toHaveProperty('disabled')
  })

  it('names the reason a row cannot stop', () => {
    const node = agentsPanel([member()], [], () => 'Not live', NOW, t)
    expect(text(node)).toContain(`"unavailableActions":{"${AGENTS_VIEW_STOP_ID}":"Not live"}`)
  })
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); vi.useRealTimers(); vi.restoreAllMocks() })

async function fixture(selected = true) {
  const f = await taskFixture(selected)
  const views = { isEntered: false, active: undefined as string | undefined, listeners: new Set<() => void>(), subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } } }
  Object.assign(f.options, { screen: { views } })
  const childListeners = new Set<() => void>()
  let children: SpawnedChildren | undefined
  const seam = {
    tree: vi.fn(async (_signal: AbortSignal): Promise<readonly MayflySubagentTreeEntry[] | undefined> => [child('child-a', { outputTokens: 2_000 })]),
    stop: vi.fn(async (_id: string, _signal: AbortSignal) => ({ kind: 'completed' as const })),
    open: vi.fn(async (_id: string, _signal: AbortSignal) => ({ kind: 'completed' as const })),
    blocked: vi.fn((reason: string) => `blocked: ${reason}`),
    children: () => children,
    subscribeChildren: (listener: () => void) => { childListeners.add(listener); return () => { childListeners.delete(listener) } },
  } satisfies AgentsViewSeam
  const stop = mountAgentsView(f.options, seam)
  cleanups.push(async () => { stop(); await f.dispose() })
  const pane = () => f.pane('mayfly.view.agents')
  const spawn = (next: readonly unknown[]) => { f.state.mayflyConversationFacts.set({ agentCalls: next }) }
  const enter = async (value = true, active = 'mayfly.view.agents') => { views.isEntered = value; views.active = value ? active : undefined; for (const listener of views.listeners) listener(); await tick() }
  const act = async (event: MayflyUiActionEvent, signal = new AbortController().signal) => await (f.registration.mock.calls[0]![0].onEvent!.action as (event: MayflyUiActionEvent, context: MayflyUiEventContext) => Promise<unknown>)(event, { signal } as MayflyUiEventContext)
  return { ...f, views, seam, stop, pane, spawn, enter, act, childListeners,
    setChildren: (next: SpawnedChildren | undefined) => { children = next; for (const listener of childListeners) listener() } }
}
const stopEvent = (id?: string): MayflyUiActionEvent => ({ kind: 'activate', controlId: 'agents-view-actions', actionId: AGENTS_VIEW_STOP_ID, pagePath: [], ...id === undefined ? {} : { inputs: { actionId: AGENTS_VIEW_STOP_ID, draftRevision: 0, forms: [], selections: [{ pagePath: [], controlId: AGENTS_VIEW_LIST_ID, selectedIds: [id] }] } } } as unknown as MayflyUiActionEvent)
const accept = (controlId: string, selectedIds: readonly string[]): MayflyUiActionEvent => ({ kind: 'selection-accept', pagePath: [], controlId, selectedIds } as unknown as MayflyUiActionEvent)

describe('the Agents view owner', () => {
  it('registers first among the views and follows the facts and children with no read of the tree', async () => {
    const f = await fixture()
    expect(f.registration.mock.calls[0]![0]).toMatchObject({ id: 'mayfly.view.agents', placement: 'views', priority: 11 })
    expect(f.pane()?.summary).toBeNull()
    f.spawn([call('a', 'Explore', {})])
    expect(JSON.stringify(f.pane()?.summary)).toContain('1/1')
    f.setChildren(known({ a: { state: 'running' } }))
    expect(JSON.stringify(f.pane()?.summary)).toContain('0/1')
    expect(f.seam.tree).not.toHaveBeenCalled()
    f.state.mayflyConversationFacts.set(undefined)
    expect(f.pane()?.summary).toBeNull()
  })

  it('reads the tree once on entry, and polls at one a second only while it is entered with a live member', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const f = await fixture()
    f.spawn([call('a', 'Explore', {})])
    await f.enter(true, 'mayfly.view.jobs')
    expect(f.seam.tree).not.toHaveBeenCalled()
    await f.enter()
    expect(f.seam.tree).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    f.setChildren(known({ a: { state: 'running' } }))
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.seam.tree).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(f.pane()?.node)).toContain('↓2k')
    f.setChildren(known({ a: { state: 'settled', failed: false } }))
    expect(vi.getTimerCount()).toBe(0)
    f.setChildren(known({ a: { state: 'running' } }))
    expect(vi.getTimerCount()).toBe(1)
    await f.enter(false)
    expect(vi.getTimerCount()).toBe(0)
    await f.enter()
    expect(vi.getTimerCount()).toBe(1)
    f.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.pane()).toBeUndefined()
  })

  it('reads the tree on a new selection while entered, and keeps one read per generation in flight', async () => {
    const f = await fixture()
    let release!: (value: readonly MayflySubagentTreeEntry[]) => void
    f.seam.tree.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await f.enter()
    f.setChildren(known({}))
    await f.enter(false)
    await f.enter()
    expect(f.seam.tree).toHaveBeenCalledOnce()
    const stale = f.seam.tree.mock.calls[0]![0]
    f.reconnect()
    expect(stale.aborted).toBe(true)
    expect(f.seam.tree).toHaveBeenCalledTimes(2)
    release([child('child-a', { outputTokens: 9_000 })])
    await tick()
    f.spawn([call('a', 'Explore', {})])
    f.setChildren(known({ a: { state: 'running' } }))
    expect(JSON.stringify(f.pane()?.node)).not.toContain('↓9k')
  })

  it('keeps the last readable tree when a read fails or finds no Session, and stops following on deselection', async () => {
    const f = await fixture()
    f.spawn([call('a', 'Explore', {})])
    f.setChildren(known({ a: { state: 'running' } }))
    await f.enter()
    await tick()
    expect(JSON.stringify(f.pane()?.node)).toContain('↓2k')
    f.seam.tree.mockRejectedValueOnce(new Error('no tree'))
    await f.enter(false); await f.enter()
    expect(JSON.stringify(f.pane()?.node)).toContain('↓2k')
    f.seam.tree.mockResolvedValueOnce(undefined)
    await f.enter(false); await f.enter()
    expect(JSON.stringify(f.pane()?.node)).toContain('↓2k')
    const listeners = f.state.mayflyConversationFacts.listeners
    expect(listeners.size).toBe(1)
    f.select(false)
    expect(listeners.size).toBe(0)
    expect(f.pane()?.summary).toBeNull()
    await tick()
  })

  it('names why a row cannot stop: the native reason first, then a settled member', async () => {
    const f = await fixture()
    f.spawn([call('a', 'Explore', {}), call('b', 'Settled', {})])
    f.setChildren(known({ a: { state: 'running' }, b: { state: 'settled', failed: false } }))
    f.seam.tree.mockResolvedValue([child('child-a', { stopBlocked: 'not-continuable' }), child('child-b')])
    await f.enter(); await tick()
    expect(JSON.stringify(f.pane()?.node)).toContain('blocked: not-continuable')
    expect(JSON.stringify(f.pane()?.node)).toContain('blocked: not-live')
    f.seam.tree.mockResolvedValue([child('child-a')])
    await f.enter(false); await f.enter()
    expect(JSON.stringify(f.pane()?.node)).not.toContain('blocked: not-continuable')
  })

  it('opens and stops the selected child through the seam, and reads again after a stop', async () => {
    const f = await fixture()
    await expect(f.act(accept(AGENTS_VIEW_LIST_ID, ['child-a']))).resolves.toEqual({ kind: 'completed' })
    expect(f.seam.open).toHaveBeenCalledWith('child-a', expect.any(AbortSignal))
    await expect(f.act(accept(AGENTS_VIEW_LIST_ID, []))).resolves.toEqual({ kind: 'completed' })
    await expect(f.act(accept('other', ['child-a']))).resolves.toEqual({ kind: 'completed' })
    await expect(f.act({ kind: 'activate', controlId: 'x', actionId: 'other', pagePath: [] } as never)).resolves.toEqual({ kind: 'completed' })
    await expect(f.act(stopEvent())).resolves.toEqual({ kind: 'completed' })
    expect(f.seam.stop).not.toHaveBeenCalled()
    await expect(f.act(stopEvent('child-a'))).resolves.toEqual({ kind: 'completed' })
    expect(f.seam.stop).toHaveBeenCalledWith('child-a', expect.any(AbortSignal))
    expect(f.seam.tree).toHaveBeenCalledOnce()
    f.seam.stop.mockResolvedValueOnce({ kind: 'failed', message: 'no' } as never)
    await expect(f.act(stopEvent('child-a'))).resolves.toEqual({ kind: 'failed', message: 'no' })
    expect(f.seam.tree).toHaveBeenCalledOnce()
    expect(f.seam.open).toHaveBeenCalledOnce()
  })

  it('answers cancelled to an aborted caller and after unload, ignores late facts and reads, and disposes once', async () => {
    const f = await fixture()
    const aborted = new AbortController(); aborted.abort()
    await expect(f.act(stopEvent('child-a'), aborted.signal)).resolves.toEqual({ kind: 'cancelled' })
    let release!: (value: readonly MayflySubagentTreeEntry[]) => void
    f.seam.tree.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await f.enter()
    const signal = f.seam.tree.mock.calls[0]![0]
    const late = [...f.childListeners][0]!
    const panes = f.ctx.mayflyPanes.list().length
    f.stop(); f.stop()
    expect(signal.aborted).toBe(true)
    expect(f.ctx.mayflyPanes.list().length).toBe(panes - 1)
    expect(f.childListeners.size).toBe(0)
    expect(f.views.listeners.size).toBe(0)
    expect(f.state.mayflyConversationFacts.listeners.size).toBe(0)
    late()
    release([])
    await tick()
    await expect(f.act(stopEvent('child-a'))).resolves.toEqual({ kind: 'cancelled' })
  })

  it('ignores a facts callback left over from the previous generation', async () => {
    const f = await fixture()
    const stale = [...f.state.mayflyConversationFacts.listeners][0]!
    f.reconnect()
    f.state.mayflyConversationFacts.listeners.delete(stale)
    const before = f.pane()?.revision
    stale()
    expect(f.pane()?.revision).toBe(before)
  })

  it('starts without a Session', async () => {
    const f = await fixture(false)
    expect(f.pane()?.summary).toBeNull()
    await f.enter()
  })
})
