/**
 * The Agents item of the status row (`status-agents`): the rows it takes from the parent's spawn calls and the children's
 * facts (foreground and background, working, finished, failed, and stopped by the user), its summary, its panel, and the view
 * that follows the exact current Agent: `Enter` opens a child's conversation and `F8` returns to the view, `x` stops behind
 * the shared Yes/No, `b` is listed and unavailable, and a side conversation keeps only the subagents it spawned itself.
 * @module @ephemeral-ai/mayfly/transcript/tests/status-agents
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import type { MayflyListItem, MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { describe, expect, it, vi } from 'vitest'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import type { ConversationAgentCall, ConversationFacts } from '../../src/conversation/types.ts'
import * as agentsItem from '../../src/transcript/status-agents.ts'
import type { ChildSessionFacts } from '../../src/transcript/session-facts.ts'
import { SHED } from '../../src/transcript/status-shed.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'
import { bootPanePlugin, HandTick } from './pane-fakes.ts'
import { fakeAgent } from './status-fakes.ts'

const stopSubagent = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ kind: string, text: string }>>(async () => ({ kind: 'ok', text: 'Stopped reviewer' })))
vi.mock('../../src/interaction/agents-stop.ts', async (importOriginal) => ({ ...await importOriginal<typeof import('../../src/interaction/agents-stop.ts')>(), stopSubagent }))

const T0 = 1_000_000
const call = (id: string, extra: Partial<ConversationAgentCall> = {}): ConversationAgentCall => ({
  seq: 1, turn: 1, step: 1, callId: id, name: 'subagent', arguments: JSON.stringify({ name: id, description: `task of ${id}`, prompt: `prompt ${id}` }), startedAt: T0, ...extra,
})
const done = (text = 'done', endedAt = T0 + 41_000, isError = false) => ({ text, isError, endedAt })
const child = (id: string, extra: Partial<ChildSessionFacts> = {}): ChildSessionFacts => ({ id, phase: 'running', tokens: 0, inputTokens: 0, outputTokens: 0, toolCount: 0, ...extra })
const rowsOf = (calls: ConversationAgentCall[], children: ChildSessionFacts[] = [], turn = { turn: 1, active: true }, ...rest: [((id: string) => boolean)?, ReadonlySet<string>?]) =>
  agentsItem.agentRows(calls, children, turn, ...rest)

describe('agentRows', () => {
  it('takes a call without its result as a working foreground subagent, from the moment the call starts', () => {
    const [row] = rowsOf([call('review')])
    expect(row).toMatchObject({ id: 'review', label: 'review', task: 'task of review', foreground: true, live: true, failed: false, stopped: false, startedAt: T0 })
    expect(row).not.toHaveProperty('endedAt')
  })

  it('takes an acknowledged call as a background subagent that works while its child says so', () => {
    const ack = call('audit', { result: done('started subagent child-1') })
    expect(rowsOf([ack], [child('child-1')])[0]).toMatchObject({ foreground: false, live: true, childId: 'child-1' })
    expect(rowsOf([ack], [child('child-1', { phase: 'waiting' })])[0]).toMatchObject({ live: true })
    expect(rowsOf([ack], [child('child-1', { phase: 'completed', endedAt: T0 + 9_000, toolCount: 3, inputTokens: 800, outputTokens: 200 })])[0]).toMatchObject({ live: false, failed: false, stopped: false, endedAt: T0 + 9_000, toolCount: 3, inputTokens: 800, outputTokens: 200 })
    expect(rowsOf([ack], [child('child-1', { phase: 'failed' })])[0]).toMatchObject({ live: false, failed: true })
    // No facts for the child yet: it works while the turn that spawned it does.
    expect(rowsOf([ack], [], { turn: 1, active: true })[0]).toMatchObject({ live: true, childId: 'child-1' })
    expect(rowsOf([ack], [], { turn: 1, active: false })[0]).toMatchObject({ live: false })
    expect(rowsOf([call('bg', { arguments: JSON.stringify({ name: 'bg', run_in_background: true }), result: done('queued') })], [])[0]).toMatchObject({ foreground: false })
  })

  it('finds a child by its prompt when the call carries no acknowledgement', () => {
    const [row] = rowsOf([call('review', { result: done() })], [child('child-9', { promptText: 'prompt review', phase: 'completed', endedAt: T0 + 5_000 })])
    expect(row).toMatchObject({ childId: 'child-9', foreground: true, live: false, endedAt: T0 + 5_000 })
  })

  it('settles a foreground call by its result: done, or failed when it errored or its turn was cut before one came', () => {
    expect(rowsOf([call('ok', { result: done() })])[0]).toMatchObject({ live: false, failed: false, endedAt: T0 + 41_000 })
    expect(rowsOf([call('bad', { result: done('boom', T0 + 3_000, true) })])[0]).toMatchObject({ live: false, failed: true })
    // A later turn started, or this one ended, with the call still unanswered: nothing is working.
    expect(rowsOf([call('lost')], [], { turn: 2, active: true })[0]).toMatchObject({ live: false, failed: true })
    expect(rowsOf([call('lost')], [], { turn: 1, active: false })[0]).toMatchObject({ live: false, failed: true })
  })

  it('tells a subagent the user stopped from one that failed on its own', () => {
    const ack = call('audit', { result: done('started subagent child-1') })
    expect(rowsOf([ack], [child('child-1', { phase: 'failed', stopped: true })])[0]).toMatchObject({ stopped: true, failed: false, live: false })
    // Stopped from the panel while its last facts still read working.
    expect(rowsOf([ack], [child('child-1')], undefined, undefined, new Set(['child-1']))[0]).toMatchObject({ live: true })
    expect(rowsOf([ack], [child('child-1', { phase: 'failed' })], undefined, undefined, new Set(['child-1']))[0]).toMatchObject({ stopped: true, failed: false })
    // A continuable child whose Agent is gone does not work, whatever its last facts say.
    expect(rowsOf([ack], [child('child-1')], undefined, id => id === 'child-1')[0]).toMatchObject({ live: false, stopped: true, failed: false })
  })

  it('cuts a long task and keeps the name a spawn call gives', () => {
    const long = 'x'.repeat(200)
    const [row] = rowsOf([call('r', { arguments: JSON.stringify({ name: 'r', description: long }) })])
    expect(row!.task).toHaveLength(80)
    expect(row!.task!.endsWith('…')).toBe(true)
    expect(rowsOf([call('plain', { name: 'subagent', arguments: '' })])[0]).toMatchObject({ label: 'subagent' })
  })

  it('parses a spawn call once, even when a republish hands over a fresh call object', () => {
    const spawn = call('cached')
    const parse = vi.spyOn(JSON, 'parse')
    try {
      rowsOf([spawn])
      const first = parse.mock.calls.length
      expect(first).toBeGreaterThan(0)
      rowsOf([spawn])
      expect(parse.mock.calls.length).toBe(first)
      // A fresh object with the same identity and arguments is served by the identity fallback.
      rowsOf([{ ...spawn }])
      expect(parse.mock.calls.length).toBe(first)
    } finally {
      parse.mockRestore()
    }
  })

  it('carries the live characters and the output progress only while a child works', () => {
    const progress = { startedAt: 1, updatedAt: 2_000, chars: 400, initialChars: 0 } as never
    const ack = call('audit', { result: done('started subagent child-1') })
    expect(rowsOf([ack], [child('child-1', { liveChars: 400, outputProgress: progress })])[0]).toMatchObject({ liveChars: 400, outputProgress: progress })
    const settled = rowsOf([ack], [child('child-1', { phase: 'completed', liveChars: 400, outputProgress: progress })])[0]!
    expect(settled.liveChars).toBe(0)
    expect(settled).not.toHaveProperty('outputProgress')
  })
})

describe('agentsSummary', () => {
  const t = transcriptTranslatorFake
  const row = (id: string, extra: Partial<agentsItem.AgentRow> = {}): agentsItem.AgentRow => ({ id, label: id, foreground: false, live: false, failed: false, stopped: false, toolCount: 0, inputTokens: 0, outputTokens: 0, liveChars: 0, startedAt: T0, ...extra })
  const words = (state: agentsItem.AgentsState) => {
    const node = agentsItem.agentsSummary(state, t)!.node as unknown as { readonly node: { readonly spans: { readonly text: string, readonly tone?: string }[] }, readonly narrower: readonly { readonly rank: number }[] }
    return { text: node.node.spans.map(span => span.text).join(''), mark: node.node.spans[0], ranks: node.narrower.map(form => form.rank) }
  }

  it('has no item for a conversation without a subagent', () => {
    expect(agentsItem.agentsSummary({ rows: [], now: T0 }, t)).toBeNull()
  })

  it('counts the settled over all, with the time of the oldest working one', () => {
    const state = { rows: [row('a', { live: true, startedAt: T0 }), row('b', { live: true, startedAt: T0 + 10_000 }), row('c', { endedAt: T0 + 5_000 })], now: T0 + 41_000 }
    expect(words(state)).toEqual({ text: '● agents 1/3 41s', mark: { text: '●', tone: 'accent' }, ranks: [SHED.time] })
  })

  it('measures a settled subagent that has no end yet against now', () => {
    expect(words({ rows: [row('a', { startedAt: T0 })], now: T0 + 7_000 })).toMatchObject({ text: '✓ agents 1/1 7s' })
  })

  it('stays after the last one settles: the longest time that ran, `✓`, or `✕` when one failed on its own', () => {
    const settled = [row('a', { endedAt: T0 + 9_000 }), row('b', { endedAt: T0 + 41_000 })]
    expect(words({ rows: settled, now: T0 + 999_000 })).toMatchObject({ text: '✓ agents 2/2 41s', mark: { text: '✓', tone: 'success' } })
    expect(words({ rows: [...settled, row('c', { failed: true, endedAt: T0 + 2_000 })], now: T0 + 999_000 })).toMatchObject({ text: '✕ agents 3/3 41s', mark: { text: '✕', tone: 'danger' } })
    // One the user stopped is no failure.
    expect(words({ rows: [...settled, row('d', { stopped: true, endedAt: T0 + 2_000 })], now: T0 + 999_000 })).toMatchObject({ mark: { text: '✓' } })
  })
})

describe('agentsPanel', () => {
  const t = transcriptTranslatorFake
  const row = (id: string, extra: Partial<agentsItem.AgentRow> = {}): agentsItem.AgentRow => ({ id, label: id, task: `task of ${id}`, foreground: false, live: false, failed: false, stopped: false, toolCount: 6, inputTokens: 2_048, outputTokens: 4_096, liveChars: 0, startedAt: T0, endedAt: T0 + 41_000, ...extra })
  /** A working row: it has no end yet. */
  const working = (id: string, extra: Partial<agentsItem.AgentRow> = {}): agentsItem.AgentRow => {
    const { endedAt: _endedAt, ...rest } = row(id)
    return { ...rest, live: true, ...extra }
  }
  const items = (node: unknown): MayflyListItem[] => {
    const found: MayflyListItem[] = []
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      const record = value as { readonly kind?: string, readonly items?: MayflyListItem[] }
      if (record.kind === 'list') found.push(...record.items!)
      for (const child of Object.values(value)) walk(child)
    }
    walk(node)
    return found
  }
  const cells = (item: MayflyListItem): string[] => (item.cells ?? []).map(cell => cell.spans.map(span => span.text).join(''))

  it('has no panel without a subagent', () => {
    expect(agentsItem.agentsPanel({ rows: [], now: T0 }, t, () => ({}))).toBeNull()
  })

  it('lists every subagent of the conversation, the working ones first, in spawn order', () => {
    const state = { rows: [row('done-1'), working('live-1'), row('done-2'), working('live-2')], now: T0 + 41_000 }
    expect(items(agentsItem.agentsPanel(state, t, () => ({}))).map(item => item.id)).toEqual(['live-1', 'live-2', 'done-1', 'done-2'])
  })

  it('draws the mark, then aligned columns with the time last', () => {
    const state = { rows: [working('review', { foreground: true }), row('audit', { failed: true }), row('lint', { stopped: true }), row('docs')], now: T0 + 41_000 }
    const rows = items(agentsItem.agentsPanel(state, t, () => ({})))
    expect(rows.map(item => item.labelSpans![0])).toEqual([{ text: '●', tone: 'accent' }, { text: '✕', tone: 'danger' }, { text: '⊘', tone: 'muted' }, { text: '✓', tone: 'success' }].map(mark => mark))
    // name, task, fg/bg, tools, tokens total, up, down, rate, time.
    expect(cells(rows[0]!)).toEqual(['review', 'task of review', 'fg', '6 tools', '6k', '↑2k', '↓4k', '', '41s'])
    expect(cells(rows[1]!)).toEqual(['audit', 'task of audit', 'bg', '6 tools', '6k', '↑2k', '↓4k', '', '41s'])
    const columns = rows[0]!.cells!
    expect(columns.at(-1)).toMatchObject({ align: 'right' })
    expect(columns[1]).toMatchObject({ min: 34, max: 52 })
    // The narrow row gives up the rate, then the up count, the down count, the foreground tag, and the tools, in that order.
    expect(columns.map(cell => cell.shed)).toEqual([undefined, undefined, 3, 4, 2, 6, 5, 7, undefined])
  })

  it('counts the streamed characters of a working child as output, and says the rate while it streams', () => {
    const progress = { startedAt: T0, updatedAt: T0 + 4_000, chars: 4_000, initialChars: 0 } as never
    const state = { rows: [working('stream', { outputTokens: 0, inputTokens: 0, liveChars: 4_000, outputProgress: progress })], now: T0 + 4_500 }
    const [item] = items(agentsItem.agentsPanel(state, t, () => ({})))
    expect(cells(item!)).toEqual(['stream', 'task of stream', 'bg', '6 tools', '1000', '', '↓1000', '250 tok/s', '4s'].map(text => text === '1000' ? '1000' : text))
  })

  it('says no rate for a trickle that rounds to zero', () => {
    const progress = { startedAt: T0, updatedAt: T0 + 10_000, chars: 1, initialChars: 0 } as never
    const [item] = items(agentsItem.agentsPanel({ rows: [working('slow', { outputProgress: progress })], now: T0 + 10_500 }, t, () => ({})))
    expect(cells(item!)[7]).toBe('')
  })

  it('says one tool in the singular, a settled row without an end against now, and no rate when the child streams nothing yet', () => {
    const progress = { startedAt: T0, updatedAt: T0 + 100, chars: 8, initialChars: 0 } as never
    const state = { rows: [working('one', { toolCount: 1, outputProgress: progress }), row('open', { toolCount: 0, endedAt: undefined as never })], now: T0 + 130 }
    const [live, settled] = items(agentsItem.agentsPanel(state, t, () => ({})))
    expect(cells(live!)[3]).toBe('1 tool')
    expect(cells(live!)[7]).toBe('')
    expect(cells(settled!)[3]).toBe('0 tools')
    expect(cells(settled!).at(-1)).toBe('0s')
  })

  it('carries the stop and background keys hidden, and says why a row cannot take one', () => {
    const state = { rows: [row('done')], now: T0 }
    const panel = JSON.stringify(agentsItem.agentsPanel(state, t, () => ({ 'agents-stop': 'Not live; there is nothing to stop' })))
    expect(panel).toContain('"id":"agents-stop"')
    expect(panel).toContain('"id":"agents-background"')
    expect(panel).toContain('"key":"b"')
    expect(panel).toContain('"confirm"')
    expect(panel).toContain('Not live; there is nothing to stop')
  })
})

function currentAgentService(initial: Agent | null) {
  let current = initial
  const listeners = new Set<(agent: Agent | null, revision: number) => void>()
  return {
    service: {
      current: () => current,
      revision: () => 0,
      subscribe(listener: (agent: Agent | null, revision: number) => void) {
        listeners.add(listener)
        listener(current, 0)
        return () => { listeners.delete(listener) }
      },
    },
    switchTo(agent: Agent | null) {
      current = agent
      for (const listener of listeners) listener(agent, 1)
    },
  }
}

/** The session facts the view reads, driven by hand: the conversation facts, the children, and the Agent switch. */
function handFacts(agent: Agent | null) {
  let value: ConversationFacts = initialConversationFacts()
  let kids: readonly ChildSessionFacts[] = []
  const factsListeners = new Set<(facts: ConversationFacts) => void>()
  const childListeners = new Set<(facts: readonly ChildSessionFacts[]) => void>()
  const agentListeners = new Set<(agent: unknown) => void>()
  return {
    service: {
      get current() { return value },
      currentAgent: agent,
      subscribe(listener: (facts: ConversationFacts) => void) { factsListeners.add(listener); listener(value); return () => { factsListeners.delete(listener) } },
      subscribeChildren(listener: (facts: readonly ChildSessionFacts[]) => void) { childListeners.add(listener); listener(kids); return () => { childListeners.delete(listener) } },
      subscribeAgent(listener: (agent: unknown) => void) { agentListeners.add(listener); return () => { agentListeners.delete(listener) } },
    },
    setFacts(next: Partial<ConversationFacts>) { value = { ...value, ...next }; for (const listener of factsListeners) listener(value) },
    setChildren(next: readonly ChildSessionFacts[]) { kids = next; for (const listener of childListeners) listener(kids) },
    switchTo(next: Agent | null) { for (const listener of agentListeners) listener(next) },
    listenerCount: () => factsListeners.size + childListeners.size + agentListeners.size,
  }
}

/** The registry of open conversations, driven by what the view opens and by the spec closing it. */
interface ConversationsSnapshot { readonly primaryId: string | null, readonly displayedId: string | null, readonly views: readonly { readonly id: string }[] }

function handConversations() {
  const listeners = new Set<(snapshot: ConversationsSnapshot) => void>()
  let snapshot: ConversationsSnapshot = { primaryId: 'main', displayedId: 'main', views: [{ id: 'main' }] }
  const publish = (): void => { for (const listener of listeners) listener(snapshot) }
  const open = vi.fn((_view: unknown) => {
    snapshot = { ...snapshot, displayedId: 'child-view', views: [...snapshot.views, { id: 'child-view' }] }
    publish()
    return 'child-view'
  })
  return {
    service: { open, snapshot: () => snapshot, subscribe(listener: (next: ConversationsSnapshot) => void) { listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener) } } },
    /** `F8`: the child closes and the main conversation shows again. */
    close() { snapshot = { ...snapshot, displayedId: 'main', views: [{ id: 'main' }] }; publish() },
    /** Another conversation was open and showing when the child closed: the main one is not displayed. */
    closeBehind() { snapshot = { ...snapshot, displayedId: 'other', views: [{ id: 'main' }, { id: 'other' }] }; publish() },
    /** Something else about the conversations changed while the child stays open and showing. */
    touch() { publish() },
    /** `F7`: the main conversation shows while the child stays open. */
    switchAway() { snapshot = { ...snapshot, displayedId: 'main' }; publish() },
  }
}

async function bootAgents(options: { readonly modes?: Record<string, string>, readonly live?: string[], readonly isOwnSeq?: (seq: unknown) => boolean } = {}) {
  const base = fakeAgent([]) as unknown as Agent & { session: { isOwnSeq?: (seq: unknown) => boolean } }
  base.session.isOwnSeq = options.isOwnSeq ?? (() => true)
  const selected = currentAgentService(base)
  const facts = handFacts(base)
  const conversations = handConversations()
  const tick = new HandTick()
  const screen = { leaveViews: vi.fn(), enterViews: vi.fn() }
  const listChildren = vi.fn(async () => Object.entries(options.modes ?? {}).map(([id, mode]) => ({ id, mode, label: `label ${id}` })))
  const resident = new Set(options.live ?? [])
  const harness = await bootPanePlugin(agentsItem, base as never, {
    mayflyTick: tick, mayflyCurrentAgent: selected.service, mayflySessionFacts: facts.service, mayflyConversations: conversations.service,
    mayflyScreen: screen, subagents: { listChildren }, agents: { get: (id: unknown) => resident.has(String(id)) ? {} : undefined },
  })
  const entry = () => harness.ctx.mayflyPanes.list().find(candidate => candidate.id === 'mayfly.view.agents')!
  const act = async (event: Record<string, unknown>, signal: AbortSignal = new AbortController().signal): Promise<unknown> => {
    const current = entry()
    const context = { surfaceId: current.id, operationId: 'agents-test', source: current.source, revision: current.revision, signal, report: vi.fn() } as unknown as MayflyUiEventContext
    return current.definition.onEvent!.action!({ pagePath: [], ...event } as unknown as MayflyUiActionEvent, context)
  }
  const open = (id: string) => act({ kind: 'selection-accept', controlId: 'agents-list', selectedIds: [id] })
  const key = (actionId: string, id: string) => act({ kind: 'activate', controlId: actionId, actionId, inputs: { selections: [{ pagePath: [], controlId: 'agents-list', selectedIds: [id] }] } })
  const summaryText = (): string => {
    const summary = entry().summary as { readonly node: { readonly node: { readonly spans: { readonly text: string }[] } } } | null | undefined
    return summary === null || summary === undefined ? '' : summary.node.node.spans.map(span => span.text).join('')
  }
  return { ...harness, base, selected, facts, conversations, tick, screen, listChildren, entry, act, open, key, summaryText, resident }
}

describe('mayfly-status-agents', () => {
  it('registers a views pane at priority 11 with no item until a subagent is spawned', async () => {
    const harness = await bootAgents()
    expect(harness.entry().definition).toMatchObject({ placement: 'views', priority: 11 })
    expect(harness.entry().summary).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
    expect(harness.ctx.mayflyPanes.list().some(candidate => candidate.id === 'mayfly.view.agents')).toBe(false)
  })

  it('shows a subagent from the moment its call starts, and keeps the item once it settles: it stays for the conversation', async () => {
    const harness = await bootAgents()
    const spawn = call('review', { startedAt: Date.now() })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [spawn] })
    expect(harness.summaryText()).toMatch(/^● agents 0\/1/u)
    expect(harness.tick.subscribers).toBe(1)
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [{ ...spawn, result: done('done', Date.now() + 41_000) }] })
    expect(harness.summaryText()).toMatch(/^✓ agents 1\/1/u)
    // Settled, it needs no clock, and no `viewHistory` or closing line takes it away.
    expect(harness.tick.subscribers).toBe(0)
    harness.facts.setFacts({ turn: 2, active: false })
    expect(harness.summaryText()).toMatch(/^✓ agents 1\/1/u)
    await harness.dispose()
  })

  it('follows the children facts, and a new Agent starts a new conversation', async () => {
    const harness = await bootAgents()
    const ack = call('audit', { startedAt: Date.now(), result: done('started subagent child-1') })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [ack] })
    harness.facts.setChildren([child('child-1', { toolCount: 4 })])
    expect(JSON.stringify(harness.entry().node)).toContain('4 tools')
    harness.facts.setChildren([child('child-1', { phase: 'failed', toolCount: 4, endedAt: Date.now() })])
    expect(harness.summaryText()).toMatch(/^✕ agents 1\/1/u)
    harness.facts.switchTo(fakeAgent([]) as unknown as Agent)
    expect(harness.entry().summary).toBeNull()
    expect(harness.entry().node).toBeNull()
    await harness.dispose()
    expect(harness.facts.listenerCount()).toBe(0)
  })

  it('keeps only the calls its own conversation made, since a side conversation inherits its parent\'s log', async () => {
    const harness = await bootAgents({ isOwnSeq: seq => seq === 2 })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('inherited', { seq: 1, startedAt: Date.now() }), call('own', { seq: 2, startedAt: Date.now() })] })
    expect(harness.summaryText()).toMatch(/^● agents 0\/1/u)
    expect(JSON.stringify(harness.entry().node)).toContain('"id":"own"')
    expect(JSON.stringify(harness.entry().node)).not.toContain('"id":"inherited"')
    await harness.dispose()
  })

  describe('the keys', () => {
    const background = (id: string, child: string) => call(id, { startedAt: Date.now(), result: done(`started subagent ${child}`) })

    it('opens a child\'s conversation as /agents does, and returns to the view when it is closed', async () => {
      const harness = await bootAgents({ modes: { 'child-1': 'continuable' }, live: ['child-1'] })
      harness.facts.setFacts({ turn: 1, active: true, agentCalls: [background('audit', 'child-1')] })
      harness.facts.setChildren([child('child-1')])
      await expect(harness.open('audit')).resolves.toEqual({ kind: 'completed' })
      expect(harness.screen.leaveViews).toHaveBeenCalledTimes(1)
      expect(harness.conversations.service.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'subagent', sessionId: 'child-1', label: 'label child-1', mode: 'continuable' }))
      // `F8` closes the child and the main conversation shows again: back into the view that opened it.
      harness.conversations.close()
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(harness.screen.enterViews).toHaveBeenCalledTimes(1)
      await harness.dispose()
    })

    it('does not return to the view after `F7` away, or once the child was opened from /agents', async () => {
      const harness = await bootAgents({ modes: { 'child-1': 'continuable' } })
      harness.facts.setFacts({ turn: 1, active: true, agentCalls: [background('audit', 'child-1')] })
      harness.facts.setChildren([child('child-1')])
      await harness.open('audit')
      harness.conversations.switchAway()
      harness.conversations.close()
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(harness.screen.enterViews).not.toHaveBeenCalled()
      await harness.dispose()
    })

    it('refuses a row it does not have, a subagent that has not started, and one that cannot be opened', async () => {
      const harness = await bootAgents({ modes: { 'child-2': 'unknown' } })
      harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('pending', { startedAt: Date.now() }), background('odd', 'child-2')] })
      harness.facts.setChildren([child('child-2')])
      await expect(harness.open('missing')).resolves.toMatchObject({ kind: 'failed', message: 'Select a subagent first' })
      await expect(harness.open('pending')).resolves.toMatchObject({ kind: 'failed', message: 'This subagent has not started yet' })
      await expect(harness.open('odd')).resolves.toMatchObject({ kind: 'failed', message: 'This subagent cannot be opened' })
      expect(harness.conversations.service.open).not.toHaveBeenCalled()
      await harness.dispose()
    })

    it('lists `b` and says dsh cannot move a running subagent to the background yet', async () => {
      const harness = await bootAgents()
      harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('fg', { startedAt: Date.now() })] })
      await expect(harness.key('agents-background', 'fg')).resolves.toMatchObject({ kind: 'failed', message: 'dsh cannot move a running subagent to the background yet' })
      expect(JSON.stringify(harness.entry().node)).toContain('"key":"b"')
      await harness.dispose()
    })

    it('stops a child behind the shared stop, remembers it was the user, and answers a failed stop with its text', async () => {
      const harness = await bootAgents({ modes: { 'child-1': 'continuable' }, live: ['child-1'] })
      harness.facts.setFacts({ turn: 1, active: true, agentCalls: [background('audit', 'child-1')] })
      harness.facts.setChildren([child('child-1')])
      await expect(harness.key('agents-stop', 'audit')).resolves.toMatchObject({ kind: 'completed', feedback: { severity: 'success', message: 'Stopped reviewer' } })
      stopSubagent.mockImplementationOnce(async (...args: unknown[]) => { (args[4] as () => boolean)(); return { kind: 'ok', text: 'Stopped reviewer' } })
      await harness.key('agents-stop', 'audit')
      const [, stopped, signal] = stopSubagent.mock.calls.at(-1)!
      expect(stopped).toBe('child-1')
      expect(signal).toBeInstanceOf(AbortSignal)
      // Its last facts still read working, but the user stopped it: a stopped row, not a failure.
      harness.resident.delete('child-1')
      harness.facts.setChildren([child('child-1', { phase: 'failed', endedAt: Date.now() })])
      expect(JSON.stringify(harness.entry().node)).toContain('"text":"⊘"')
      expect(harness.summaryText()).toMatch(/^✓ agents 1\/1/u)
      stopSubagent.mockResolvedValueOnce({ kind: 'error', text: 'Only continuable subagents can be stopped' })
      await expect(harness.key('agents-stop', 'audit')).resolves.toMatchObject({ kind: 'failed', message: 'Only continuable subagents can be stopped' })
      await harness.dispose()
    })

    it('answers nothing for another Agent, and ignores events that are not a key', async () => {
      const harness = await bootAgents()
      harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('fg', { startedAt: Date.now() })] })
      await expect(harness.act({ kind: 'dismiss' })).resolves.toEqual({ kind: 'completed' })
      harness.selected.switchTo(null)
      await expect(harness.open('fg')).resolves.toMatchObject({ kind: 'failed', message: 'The agent changed; open it again' })
      await harness.dispose()
    })
  })

  it('counts a working subagent\'s time on the shared tick, and refreshes when a resident Agent comes or goes', async () => {
    const harness = await bootAgents({ modes: { 'child-1': 'continuable' }, live: ['child-1'] })
    const startedAt = Date.now()
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('fg', { startedAt })] })
    expect(harness.summaryText()).toMatch(/^● agents 0\/1 /u)
    harness.tick.fire(startedAt + 41_000)
    expect(harness.summaryText()).toBe('● agents 0/1 41s')
    harness.facts.setChildren([child('child-1')])
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('fg', { startedAt, result: done('started subagent child-1') })] })
    // The resident Agent of a continuable child goes: nothing works, though its last facts say so.
    harness.resident.delete('child-1')
    await new Promise<void>(resolve => { setImmediate(resolve) })
    harness.ctx.emit('agent/disposed', {} as never)
    expect(harness.summaryText()).toMatch(/^✓ agents 1\/1/u)
    harness.resident.add('child-1')
    harness.ctx.emit('agent/created', {} as never)
    expect(harness.summaryText()).toMatch(/^● agents 0\/1/u)
    await harness.dispose()
  })

  it('stays where it is when something else about the conversations changes, and when the child closes behind another conversation', async () => {
    const harness = await bootAgents({ modes: { 'child-1': 'continuable' } })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done('started subagent child-1') })] })
    harness.facts.setChildren([child('child-1')])
    await harness.open('audit')
    harness.conversations.touch()
    harness.conversations.closeBehind()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(harness.screen.enterViews).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('reads the catalog of no Agent as nothing, and lists a stoppable child without a reason', async () => {
    const harness = await bootAgents({ modes: { 'child-1': 'continuable' }, live: ['child-1'] })
    harness.selected.switchTo(null)
    harness.listChildren.mockClear()
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done('started subagent child-1') })] })
    expect(harness.listChildren).not.toHaveBeenCalled()
    await harness.dispose()
    const live = await bootAgents({ modes: { 'child-1': 'continuable' }, live: ['child-1'] })
    live.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done('started subagent child-1') })] })
    live.facts.setChildren([child('child-1')])
    await new Promise<void>(resolve => { setImmediate(resolve) })
    // A live continuable child can be stopped: its row names no reason `x` cannot act.
    expect(JSON.stringify(live.entry().node)).not.toContain('Only continuable subagents can be stopped')
    expect(JSON.stringify(live.entry().node)).not.toContain('Not live; there is nothing to stop')
    await live.dispose()
  })

  it('republishes when the language changes', async () => {
    const harness = await bootAgents()
    await harness.ctx.plugin({ name: 'agents-locale', apply(owner: Context) { const service = new MayflyLocaleService(owner, { systemLocale: 'en' }); owner.effect(() => () => service.dispose()) } })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('fg', { startedAt: Date.now() })] })
    expect(harness.summaryText()).toMatch(/^● agents/u)
    // The item republishes under the new language (its words come from the transcript catalog the transcript plugin registers).
    harness.ctx.mayflyLocale.setPreference('zh')
    expect(harness.summaryText()).toMatch(/^● .* 0\/1/u)
    await harness.dispose()
  })

  it('ignores a repeated Agent and repeated facts, and takes every call when the Agent has no session to ask', async () => {
    const harness = await bootAgents()
    harness.facts.switchTo(harness.base)
    const calls = [call('fg', { startedAt: Date.now() })]
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: calls })
    const revision = harness.entry().revision
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: calls })
    expect(harness.entry().revision).toBe(revision)
    await harness.dispose()
    const bare = await bootAgents()
    ;(bare.base as unknown as { session: unknown }).session = undefined
    bare.facts.setFacts({ turn: 1, active: true, agentCalls: [call('own', { seq: 9, startedAt: Date.now() })] })
    expect(bare.summaryText()).toMatch(/^● agents 0\/1/u)
    await bare.dispose()
  })

  it('keeps going when the catalog cannot be read, and drops a catalog that arrives for an Agent that is gone', async () => {
    const harness = await bootAgents({ modes: { 'child-1': 'continuable' } })
    harness.listChildren.mockRejectedValueOnce(new Error('catalog offline'))
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done('started subagent child-1') })] })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(harness.summaryText()).toMatch(/^● agents/u)
    // A catalog still in flight when the Agent changes is not applied to the new one.
    let release!: () => void
    harness.listChildren.mockImplementationOnce(() => new Promise(resolve => { release = () => { resolve([{ id: 'child-2', mode: 'one-shot', label: 'x' }] as never) } }))
    harness.facts.setChildren([child('child-2')])
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done('started subagent child-2') })] })
    harness.selected.switchTo(fakeAgent([]) as unknown as Agent)
    release()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(JSON.stringify(harness.entry().node)).not.toContain('Only continuable subagents can be stopped')
    await harness.dispose()
  })

  it('answers with the failure text when opening a child cannot read the catalog, and falls back on the row\'s own name', async () => {
    const harness = await bootAgents({ modes: { 'child-1': 'continuable' }, live: ['child-1'] })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done('started subagent child-1') })] })
    harness.facts.setChildren([child('child-1')])
    harness.listChildren.mockRejectedValueOnce(new Error('catalog offline'))
    await expect(harness.open('audit')).resolves.toMatchObject({ kind: 'failed', message: 'catalog offline' })
    harness.listChildren.mockRejectedValueOnce('catalog string failure')
    await expect(harness.open('audit')).resolves.toMatchObject({ kind: 'failed', message: 'catalog string failure' })
    harness.listChildren.mockResolvedValueOnce([{ id: 'child-1', mode: 'continuable' }] as never)
    await harness.open('audit')
    expect(harness.conversations.service.open).toHaveBeenCalledWith(expect.objectContaining({ label: 'audit' }))
    await harness.dispose()
  })

  it('returns to the view only from the conversation it opened, and not once its Agent is no longer current', async () => {
    const harness = await bootAgents({ modes: { 'child-1': 'continuable' } })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done('started subagent child-1') })] })
    harness.facts.setChildren([child('child-1')])
    await harness.open('audit')
    harness.selected.switchTo(fakeAgent([]) as unknown as Agent)
    harness.conversations.close()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(harness.screen.enterViews).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('names why a row cannot be stopped, from what is known without reading the catalog', async () => {
    const harness = await bootAgents({ modes: { 'child-1': 'one-shot' }, live: ['child-1'] })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('fg', { startedAt: Date.now() }), call('audit', { startedAt: Date.now(), result: done('started subagent child-1') })] })
    harness.facts.setChildren([child('child-1')])
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const panel = JSON.stringify(harness.entry().node)
    // The foreground row has no child to stop yet; the one-shot child cannot be stopped.
    expect(panel).toContain('Not live; there is nothing to stop')
    expect(panel).toContain('Only continuable subagents can be stopped')
    expect(panel).toContain('Already in the background')
    await harness.dispose()
  })
})
