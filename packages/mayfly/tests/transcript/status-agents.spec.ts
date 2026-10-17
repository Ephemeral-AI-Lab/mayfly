/**
 * The Agents item of the status row (`status-agents`): rows from the parent's
 * spawn calls and native catalog/identity/timing/activation status, the
 * summary, the panel, external executions, and the exact-Agent view.
 * @module @ephemeral-ai/mayfly/transcript/tests/status-agents
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentCatalogEntry, SubagentIdentityProjection, SubagentTimingProjection } from '@deepseek-ai/dsh-subagent'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import type { MayflyListItem, MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { describe, expect, it, vi } from 'vitest'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import type { ConversationAgentCall, ConversationFacts } from '../../src/conversation/types.ts'
import * as agentsItem from '../../src/transcript/status-agents.ts'
import type { AgentRow } from '../../src/transcript/status-agents.ts'
import type { ChildSessionFacts } from '../../src/transcript/session-facts.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'
import { bootPanePlugin, HandTick } from './pane-fakes.ts'
import { fakeAgent } from './status-fakes.ts'
import { fakeAgent as coreFakeAgent } from '../helpers.ts'

const stopSubagent = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ kind: string, text: string }>>(async () => ({ kind: 'success', text: 'stopped subagent child-1' })))
vi.mock('../../src/interaction/agents-stop.ts', async (importOriginal) => ({ ...await importOriginal<typeof import('../../src/interaction/agents-stop.ts')>(), stopSubagent }))

const T0 = 1_000_000
const activation = (childId: string) => JSON.stringify({ kind: 'activation', subagentId: childId })
const call = (id: string, extra: Partial<ConversationAgentCall> = {}): ConversationAgentCall => ({
  seq: 1, turn: 1, step: 1, callId: id, name: 'subagent',
  arguments: JSON.stringify({ description: `task of ${id}`, prompt: `prompt ${id}` }), startedAt: T0, ...extra,
})
const done = (text = 'done', endedAt = T0 + 41_000, isError = false) => ({ text, isError, endedAt })
const child = (id: string, extra: Partial<ChildSessionFacts> = {}): ChildSessionFacts => ({ id, phase: 'running', tokens: 0, inputTokens: 0, outputTokens: 0, toolCount: 0, ...extra })
const entry = (id: string, mode: SubagentCatalogEntry['mode'], label?: string): SubagentCatalogEntry => ({ id: id as never, createdAt: T0, mode, ...(label === undefined ? {} : { label }) } as SubagentCatalogEntry)
const native = (overrides: Partial<agentsItem.AgentRowsInput> = {}): agentsItem.AgentRowsInput => ({
  calls: [], catalog: [], children: [], timing: new Map(), identity: new Map(), runs: new Map(),
  turn: { turn: 1, active: true }, ...overrides,
})
const rowsOf = (overrides: Partial<agentsItem.AgentRowsInput> = {}): readonly AgentRow[] => agentsItem.agentRows(native(overrides))

describe('agentRows', () => {
  it('takes a call without its result as a starting activation, until its turn is cut', () => {
    const [row] = rowsOf({ calls: [call('review')] })
    expect(row).toMatchObject({ id: 'review', label: 'task of review', mode: 'unknown', external: false, live: true, failed: false, stopped: false, startedAt: T0 })
    expect(row).not.toHaveProperty('endedAt')
    expect(rowsOf({ calls: [call('lost')], turn: { turn: 2, active: true } })[0]).toMatchObject({ live: false, failed: true })
    expect(rowsOf({ calls: [call('lost')], turn: { turn: 1, active: false } })[0]).toMatchObject({ live: false, failed: true })
  })

  it('links the activation result id to the child, then reads its native mode, label, and facts', () => {
    const calls = [call('audit', { result: done(activation('child-1')) })]
    const catalog = [entry('child-1', 'continuable', 'catalog label')]
    const identity = new Map<string, SubagentIdentityProjection>([['child-1', { mode: 'continuable', label: 'native label', seq: 1 as never }]])
    expect(rowsOf({ calls, catalog, identity, children: [child('child-1')] })[0]).toMatchObject({
      childId: 'child-1', mode: 'continuable', label: 'native label', live: true, external: false,
    })
    expect(rowsOf({ calls, catalog, children: [child('child-1', { phase: 'completed', endedAt: T0 + 9_000, toolCount: 3 })] })[0])
      .toMatchObject({ live: false, failed: false, endedAt: T0 + 9_000 })
    expect(rowsOf({ calls, catalog, children: [child('child-1', { phase: 'failed' })] })[0]).toMatchObject({ live: false, failed: true })
  })

  it('finds a child by the activation label when the result is not the canonical JSON, never by prompt', () => {
    const calls = [call('audit', { result: done('started subagent child-1') })]
    const catalog = [entry('child-1', 'continuable', 'task of audit')]
    expect(rowsOf({ calls, catalog, children: [child('child-1')] })[0]).toMatchObject({ childId: 'child-1', live: true })
    // A child with the same prompt but no activation id or matching label is not the call's child.
    const other = rowsOf({
      calls: [call('other', { result: done('queued') })],
      catalog: [entry('child-9', 'continuable', 'different label')],
      children: [child('child-9', { promptText: 'prompt other' })],
    })[0]!
    expect(other.childId).toBeUndefined()
    expect(other).toMatchObject({ live: false, failed: false, stopped: false })
  })

  it('reads native timing as the child activity, and has no foreground or background form', () => {
    const calls = [call('audit', { result: done(activation('child-1')), arguments: JSON.stringify({ description: 'task of audit', run_in_background: true }) })]
    const catalog = [entry('child-1', 'continuable', 'task of audit')]
    const timing = new Map<string, SubagentTimingProjection>([['child-1', { settledMs: 0, active: { since: T0, through: T0 + 1_000 } }]])
    const [row] = rowsOf({ calls, catalog, timing })
    expect(row).toMatchObject({ live: true, mode: 'continuable', external: false })
    expect(row).not.toHaveProperty('foreground')
    // A closed turn that completed is settled; the timing projection supplies the native measure.
    const settled = new Map<string, SubagentTimingProjection>([['child-1', { settledMs: 9_000, lastTurnCompleted: true }]])
    expect(rowsOf({ calls, catalog, timing: settled })[0]).toMatchObject({ live: false, failed: false })
  })

  it('takes the activation start/end pair as authoritative for liveness and the stop reason', () => {
    const calls = [call('audit', { result: done(activation('child-1')) })]
    const catalog = [entry('child-1', 'continuable', 'task of audit')]
    const live = new Map([['child-1', { live: true }]])
    const aborted = new Map([['child-1', { live: false, stopReason: 'aborted', endedAt: T0 + 3_000 }]])
    const failed = new Map([['child-1', { live: false, stopReason: 'error', endedAt: T0 + 3_000 }]])
    expect(rowsOf({ calls, catalog, runs: live })[0]).toMatchObject({ live: true })
    expect(rowsOf({ calls, catalog, runs: aborted })[0]).toMatchObject({ live: false, stopped: true, failed: false, endedAt: T0 + 3_000 })
    expect(rowsOf({ calls, catalog, runs: failed })[0]).toMatchObject({ live: false, failed: true, stopped: false })
  })

  it('tells a child the user stopped from one that failed, including a gone resident Agent', () => {
    const calls = [call('audit', { result: done(activation('child-1')) })]
    const catalog = [entry('child-1', 'continuable', 'task of audit')]
    expect(rowsOf({ calls, catalog, children: [child('child-1', { phase: 'failed', stopped: true })] })[0]).toMatchObject({ stopped: true, failed: false })
    expect(rowsOf({ calls, catalog, children: [child('child-1', { phase: 'failed' })], stoppedByUser: new Set(['child-1']) })[0]).toMatchObject({ stopped: true, failed: false })
    expect(rowsOf({ calls, catalog, children: [child('child-1')], gone: id => id === 'child-1' })[0]).toMatchObject({ live: false, stopped: true, failed: false })
  })

  it('shows an external activation as (ext), with no local conversation or metrics', () => {
    const calls = [call('remote', { result: done(activation('external-1')) })]
    const catalog = [entry('external-1', 'external', 'remote task')]
    const [row] = rowsOf({ calls, catalog })
    expect(row).toMatchObject({ childId: 'external-1', mode: 'external', external: true, live: false, inputTokens: 0, outputTokens: 0 })
    expect(rowsOf({ calls, catalog, runs: new Map([['external-1', { live: true }]]) })[0]).toMatchObject({ live: true })
  })

  it('cuts a long task and keeps the native catalog label', () => {
    const [row] = rowsOf({ calls: [call('r', { arguments: JSON.stringify({ name: 'r', description: 'x'.repeat(200) }) })], catalog: [entry('r', 'one-shot', 'native')] })
    expect(row!.task).toHaveLength(80)
    expect(row!.task!.endsWith('…')).toBe(true)
    expect(rowsOf({ calls: [call('plain', { arguments: '' })] })[0]).toMatchObject({ label: 'subagent' })
  })

  it('carries the live characters and the output progress only while a child works', () => {
    const progress = { startedAt: 1, updatedAt: 2_000, chars: 400, initialChars: 0 }
    const calls = [call('audit', { result: done(activation('child-1')) })]
    const catalog = [entry('child-1', 'continuable', 'task of audit')]
    expect(rowsOf({ calls, catalog, children: [child('child-1', { liveChars: 400, outputProgress: progress })] })[0]).toMatchObject({ liveChars: 400, outputProgress: progress })
    const settled = rowsOf({ calls, catalog, children: [child('child-1', { phase: 'completed', liveChars: 400, outputProgress: progress })] })[0]!
    expect(settled.liveChars).toBe(0)
    expect(settled).not.toHaveProperty('outputProgress')
  })
})

describe('agentsSummary', () => {
  const t = transcriptTranslatorFake
  const row = (id: string, extra: Partial<AgentRow> = {}): AgentRow => ({ id, label: id, mode: 'continuable', external: false, live: false, failed: false, stopped: false, inputTokens: 0, outputTokens: 0, liveChars: 0, startedAt: T0, ...extra })
  const text = (state: agentsItem.AgentsState): string => {
    const node = agentsItem.agentsSummary(state, t)!.node
    const spans: { readonly text: string }[] = []
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      const record = value as { readonly kind?: string, readonly spans?: { readonly text: string }[] }
      if (record.kind === 'rich-text') spans.push(...record.spans!)
      for (const child of Object.values(value)) walk(child)
    }
    walk(node)
    return spans.map(span => span.text).join('')
  }

  it('has no item for a conversation without a subagent', () => {
    expect(agentsItem.agentsSummary({ rows: [], now: T0 }, t)).toBeNull()
  })

  it('counts the settled over all, with no time', () => {
    expect(text({ rows: [row('a', { live: true }), row('b', { live: true }), row('c')], now: T0 + 41_000 })).toBe('● agents 1/3')
    expect(text({ rows: [row('a')], now: T0 + 7_000 })).toBe('✓ agents 1/1')
  })

  it('stays after the last one settles, `✓` or `✕` when one failed on its own', () => {
    const settled = [row('a'), row('b')]
    expect(text({ rows: settled, now: T0 + 999_000 })).toBe('✓ agents 2/2')
    expect(text({ rows: [...settled, row('c', { failed: true })], now: T0 + 999_000 })).toBe('✕ agents 3/3')
    expect(text({ rows: [...settled, row('d', { stopped: true })], now: T0 + 999_000 })).toBe('✓ agents 3/3')
  })
})

describe('agentsPanel', () => {
  const t = transcriptTranslatorFake
  const row = (id: string, extra: Partial<AgentRow> = {}): AgentRow => ({
    id, label: id, task: `task of ${id}`, mode: 'continuable', external: false, live: false, failed: false, stopped: false,
    inputTokens: 2_048, outputTokens: 4_096, liveChars: 0, startedAt: T0, endedAt: T0 + 41_000, ...extra,
  })
  const working = (id: string, extra: Partial<AgentRow> = {}): AgentRow => {
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
    return found.filter(item => !item.id.includes('-pad-'))
  }
  const cells = (item: MayflyListItem): string[] => (item.cells ?? []).map(cell => cell.spans.map(span => span.text).join(''))

  it('has no panel without a subagent', () => {
    expect(agentsItem.agentsPanel({ rows: [], now: T0 }, t, () => ({}))).toBeNull()
  })

  it('lists every subagent live first, in spawn order, with the stop key only', () => {
    const state = { rows: [row('done-1'), working('live-1'), row('done-2'), working('live-2')], now: T0 + 41_000 }
    expect(items(agentsItem.agentsPanel(state, t, () => ({}))).map(item => item.id)).toEqual(['live-1', 'live-2', 'done-1', 'done-2'])
    const panel = JSON.stringify(agentsItem.agentsPanel(state, t, () => ({})))
    expect(panel).toContain('"id":"agents-stop"')
    expect(panel).not.toContain('agents-background')
  })

  it('draws the mark, the name, the brief, and the figures with the time last', () => {
    const state = { rows: [working('review'), row('audit', { failed: true }), row('lint', { stopped: true }), row('docs')], now: T0 + 41_000 }
    const rows = items(agentsItem.agentsPanel(state, t, () => ({})))
    expect(rows.map(item => item.labelSpans![0])).toEqual([{ text: '●', tone: 'accent' }, { text: '✕', tone: 'danger' }, { text: '⊘', tone: 'muted' }, { text: '✓', tone: 'success' }])
    expect(cells(rows[0]!)).toEqual(['review', 'task of review'])
    expect(rows[0]!.right).toEqual([{ text: '↑2k  ↓4k · ', tone: 'muted' }, { text: '41s', tone: 'muted' }])
    expect(rows[0]!.cells![1]).toMatchObject({ max: 52, shed: 1 })
  })

  it('marks an external row (ext) and keeps its metrics empty', () => {
    const external = row('remote', { external: true, mode: 'external', task: 'remote task', inputTokens: 0, outputTokens: 0 })
    const [item] = items(agentsItem.agentsPanel({ rows: [external], now: T0 }, t, () => ({ 'agents-stop': 'Only continuable subagents can be stopped' })))
    expect(item!.label).toBe('remote (ext)  remote task')
    expect(cells(item!)[0]).toBe('remote (ext)')
    expect(item!.unavailableActions).toEqual({ 'agents-stop': 'Only continuable subagents can be stopped' })
  })

  it('counts streamed characters as output and says the rate while it streams', () => {
    const progress = { startedAt: T0, updatedAt: T0 + 4_000, chars: 4_000, initialChars: 0 }
    const [item] = items(agentsItem.agentsPanel({ rows: [working('stream', { inputTokens: 0, outputTokens: 0, liveChars: 4_000, outputProgress: progress })], now: T0 + 4_500 }, t, () => ({})))
    expect(cells(item!)).toEqual(['stream', 'task of stream'])
    expect(item!.right).toEqual([{ text: '↓1000  250 tok/s · ', tone: 'muted' }, { text: '4s', tone: 'muted' }])
  })

  it('says no rate for a trickle that rounds to zero', () => {
    const progress = { startedAt: T0, updatedAt: T0 + 10_000, chars: 1, initialChars: 0 }
    const [item] = items(agentsItem.agentsPanel({ rows: [working('slow', { outputProgress: progress })], now: T0 + 10_500 }, t, () => ({})))
    expect(item!.right?.at(-1)).toEqual({ text: '10s', tone: 'muted' })
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
    close() { snapshot = { ...snapshot, displayedId: 'main', views: [{ id: 'main' }] }; publish() },
    closeBehind() { snapshot = { ...snapshot, displayedId: 'other', views: [{ id: 'main' }, { id: 'other' }] }; publish() },
    touch() { publish() },
    switchAway() { snapshot = { ...snapshot, displayedId: 'main' }; publish() },
  }
}

async function bootAgents(options: {
  readonly isOwnSeq?: (seq: unknown) => boolean
  readonly resident?: readonly string[]
} = {}) {
  const base = fakeAgent([]) as unknown as Agent & { session: { isOwnSeq?: (seq: unknown) => boolean } }
  base.session.isOwnSeq = options.isOwnSeq ?? (() => true)
  const selected = currentAgentService(base)
  const facts = handFacts(base)
  const conversations = handConversations()
  const tick = new HandTick()
  const screen = { leaveViews: vi.fn(), enterViews: vi.fn() }
  const resident = new Map<string, Agent>([[String(base.id), base]])
  const catalog: SubagentCatalogEntry[] = []
  const timing = new Map<string, SubagentTimingProjection>()
  const identity = new Map<string, SubagentIdentityProjection | null>()
  for (const id of options.resident ?? []) resident.set(id, coreFakeAgent(id, { status: 'running', parentId: String(base.id) }) as unknown as Agent)
  const listChildren = vi.fn(async () => [...catalog])
  let projectionListener: ((session: unknown, key: string, value: unknown) => void) | undefined
  const projections = {
    snapshot: (session: { readonly id?: unknown }, _keys?: readonly string[]) => session === base.session
      ? { asOfSeq: 0, values: { subagentCatalog: [...catalog] } }
      : {
          asOfSeq: 0,
          values: {
            ...(timing.has(String(session.id)) ? { subagentTiming: timing.get(String(session.id)) } : {}),
            subagent: identity.get(String(session.id)) ?? null,
          },
        },
    onChanged: (listener: typeof projectionListener) => { projectionListener = listener; return () => {} },
  }
  const harness = await bootPanePlugin(agentsItem, base as never, {
    mayflyTick: tick, mayflyCurrentAgent: selected.service, mayflySessionFacts: facts.service, mayflyConversations: conversations.service,
    mayflyScreen: screen, sessionProjections: projections as never, subagents: { listChildren },
    agents: { get: (id: unknown) => resident.get(String(id)) },
  })
  const pane = () => harness.ctx.mayflyPanes.list().find(candidate => candidate.id === 'mayfly.view.agents')!
  const act = async (event: Record<string, unknown>, signal: AbortSignal = new AbortController().signal): Promise<unknown> => {
    const current = pane()
    const context = { surfaceId: current.id, operationId: 'agents-test', source: current.source, revision: current.revision, signal, report: vi.fn() } as unknown as MayflyUiEventContext
    return current.definition.onEvent!.action!({ pagePath: [], ...event } as unknown as MayflyUiActionEvent, context)
  }
  const open = (id: string) => act({ kind: 'selection-accept', controlId: 'agents-list', selectedIds: [id] })
  const key = (actionId: string, id: string) => act({ kind: 'activate', controlId: actionId, actionId, inputs: { selections: [{ pagePath: [], controlId: 'agents-list', selectedIds: [id] }] } })
  const summaryText = (): string => {
    const summary = pane().summary
    const spans: { readonly text: string }[] = []
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      const record = value as { readonly kind?: string, readonly spans?: { readonly text: string }[] }
      if (record.kind === 'rich-text') spans.push(...record.spans!)
      for (const child of Object.values(value)) walk(child)
    }
    walk(summary?.node)
    return spans.map(span => span.text).join('')
  }
  return {
    ...harness, base, selected, facts, conversations, tick, screen, listChildren, pane, act, open, key, summaryText, resident, catalog, timing, identity,
    pushProjection(session: unknown, key: string) { projectionListener?.(session, key, undefined) },
  }
}

describe('mayfly-status-agents', () => {
  it('registers a views pane at priority 11 with no item until a subagent is spawned', async () => {
    const harness = await bootAgents()
    expect(harness.pane().definition).toMatchObject({ placement: 'views', priority: 11 })
    expect(harness.pane().summary).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
    expect(harness.ctx.mayflyPanes.list().some(candidate => candidate.id === 'mayfly.view.agents')).toBe(false)
  })

  it('shows a subagent from the moment its call starts, follows its activation, and keeps the item once it settles', async () => {
    const harness = await bootAgents()
    const spawn = call('review', { startedAt: Date.now() })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [spawn] })
    expect(harness.summaryText()).toMatch(/^● agents 0\/1/u)
    expect(harness.tick.subscribers).toBe(1)
    harness.catalog.push(entry('review', 'continuable', 'task of review'))
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [{ ...spawn, result: done(activation('review'), Date.now() + 41_000) }] })
    harness.facts.setChildren([child('review', { phase: 'completed', endedAt: Date.now() })])
    expect(harness.summaryText()).toMatch(/^✓ agents 1\/1/u)
    expect(harness.tick.subscribers).toBe(0)
    harness.facts.setFacts({ turn: 2, active: false })
    expect(harness.summaryText()).toMatch(/^✓ agents 1\/1/u)
    await harness.dispose()
  })

  it('follows the child facts and the exact Agent, and starts a new conversation for another Agent', async () => {
    const harness = await bootAgents({ resident: ['child-1'] })
    harness.catalog.push(entry('child-1', 'continuable', 'task of audit'))
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done(activation('child-1')) })] })
    harness.facts.setChildren([child('child-1', { inputTokens: 2_048, outputTokens: 0 })])
    expect(JSON.stringify(harness.pane().node)).toContain('↑2k')
    harness.facts.setChildren([child('child-1', { phase: 'failed', endedAt: Date.now() })])
    expect(harness.summaryText()).toMatch(/^✕ agents 1\/1/u)
    harness.facts.switchTo(fakeAgent([]) as unknown as Agent)
    expect(harness.pane().summary).toBeNull()
    expect(harness.pane().node).toBeNull()
    await harness.dispose()
    expect(harness.facts.listenerCount()).toBe(0)
  })

  it('keeps only the calls its own conversation made, since a side conversation inherits its parent log', async () => {
    const harness = await bootAgents({ isOwnSeq: seq => seq === 2 })
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('inherited', { seq: 1, startedAt: Date.now() }), call('own', { seq: 2, startedAt: Date.now() })] })
    expect(harness.summaryText()).toMatch(/^● agents 0\/1/u)
    expect(JSON.stringify(harness.pane().node)).toContain('"id":"own"')
    expect(JSON.stringify(harness.pane().node)).not.toContain('"id":"inherited"')
    await harness.dispose()
  })

  it('opens a linked local child as /agents does, and returns to the view when it closes', async () => {
    const harness = await bootAgents({ resident: ['child-1'] })
    harness.catalog.push(entry('child-1', 'continuable', 'label child-1'))
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done(activation('child-1')) })] })
    harness.facts.setChildren([child('child-1')])
    expect(await harness.open('audit')).toEqual({ kind: 'completed' })
    expect(harness.screen.leaveViews).toHaveBeenCalledTimes(1)
    expect(harness.conversations.service.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'subagent', sessionId: 'child-1', label: 'label child-1', mode: 'continuable' }))
    harness.conversations.close()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(harness.screen.enterViews).toHaveBeenCalledTimes(1)
    await harness.dispose()
  })

  it('refuses an unknown row, a starting call, and an external child', async () => {
    const harness = await bootAgents()
    harness.catalog.push(entry('external-1', 'external', 'remote'))
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('pending', { startedAt: Date.now() }), call('remote', { startedAt: Date.now(), result: done(activation('external-1')) })] })
    await expect(harness.open('missing')).resolves.toMatchObject({ kind: 'failed', message: 'Select a subagent first' })
    await expect(harness.open('pending')).resolves.toMatchObject({ kind: 'failed', message: 'This subagent has not started yet' })
    await expect(harness.open('remote')).resolves.toMatchObject({ kind: 'failed', message: 'This subagent cannot be opened' })
    await expect(harness.key('agents-stop', 'remote')).resolves.toMatchObject({ kind: 'failed', message: 'Only continuable subagents can be stopped' })
    expect(harness.conversations.service.open).not.toHaveBeenCalled()
    await harness.dispose()
  })

  it('stops a linked continuable child through the shared drain, remembers the user, and answers its failure', async () => {
    const harness = await bootAgents({ resident: ['child-1'] })
    harness.catalog.push(entry('child-1', 'continuable', 'task of audit'))
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done(activation('child-1')) })] })
    harness.facts.setChildren([child('child-1')])
    await expect(harness.key('agents-stop', 'audit')).resolves.toMatchObject({ kind: 'completed', feedback: { severity: 'success', message: 'stopped subagent child-1' } })
    const [, stopped, signal] = stopSubagent.mock.calls.at(-1)!
    expect(stopped).toBe('child-1')
    expect(signal).toBeInstanceOf(AbortSignal)
    harness.resident.delete('child-1')
    harness.facts.setChildren([child('child-1', { phase: 'failed', endedAt: Date.now() })])
    expect(harness.summaryText()).toMatch(/^✓ agents 1\/1/u)
    stopSubagent.mockResolvedValueOnce({ kind: 'error', text: 'Only continuable subagents can be stopped' })
    await expect(harness.key('agents-stop', 'audit')).resolves.toMatchObject({ kind: 'failed', message: 'Only continuable subagents can be stopped' })
    await harness.dispose()
  })

  it('uses the native activation lifecycle and the catalog/timing projections to republish', async () => {
    const harness = await bootAgents()
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done(activation('child-1')) })] })
    harness.catalog.push(entry('child-1', 'continuable', 'task of audit'))
    harness.pushProjection(harness.base.session, 'subagentCatalog')
    expect(JSON.stringify(harness.pane().node)).toContain('task of audit')
    harness.ctx.emit('subagent/start', { id: 'child-1' } as never)
    expect(harness.summaryText()).toMatch(/^● agents 0\/1/u)
    expect(harness.tick.subscribers).toBe(1)
    harness.ctx.emit('subagent/end', { id: 'child-1', stopReason: 'aborted' } as never)
    expect(harness.summaryText()).toMatch(/^✓ agents 1\/1/u)
    expect(harness.tick.subscribers).toBe(0)
    await harness.dispose()
  })

  it('counts a working subagent time on the shared tick and handles resident Agent changes', async () => {
    const harness = await bootAgents()
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('fg', { startedAt: T0 })] })
    expect(harness.summaryText()).toMatch(/^● agents 0\/1/u)
    harness.tick.fire(T0 + 41_000)
    expect(harness.pane().node).not.toBeNull()
    harness.facts.setChildren([child('child-1')])
    harness.catalog.push(entry('child-1', 'continuable', 'task of fg'))
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('fg', { startedAt: T0, result: done(activation('child-1')) })] })
    harness.ctx.emit('agent/disposed', {} as never)
    harness.ctx.emit('agent/created', {} as never)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    await harness.dispose()
  })

  it('republishes when the language changes, and keeps the conversation view behavior', async () => {
    const harness = await bootAgents({ resident: ['child-1'] })
    await harness.ctx.plugin({ name: 'agents-locale', apply(owner: Context) { const service = new MayflyLocaleService(owner, { systemLocale: 'en' }); owner.effect(() => () => service.dispose()) } })
    harness.catalog.push(entry('child-1', 'continuable', 'label child-1'))
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done(activation('child-1')) })] })
    harness.facts.setChildren([child('child-1')])
    expect(harness.summaryText()).toMatch(/^● agents/u)
    await harness.open('audit')
    harness.conversations.switchAway()
    harness.conversations.close()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(harness.screen.enterViews).not.toHaveBeenCalled()
    harness.ctx.mayflyLocale.setPreference('zh')
    expect(harness.summaryText()).toMatch(/^● .* 0\/1/u)
    await harness.dispose()
  })

  it('keeps going when the catalog cannot be read, and answers the native action fence', async () => {
    const harness = await bootAgents()
    harness.listChildren.mockRejectedValueOnce(new Error('catalog offline'))
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: [call('audit', { startedAt: Date.now(), result: done(activation('child-1')) })] })
    await expect(harness.open('audit')).resolves.toMatchObject({ kind: 'failed', message: 'catalog offline' })
    harness.selected.switchTo(null)
    await expect(harness.open('audit')).resolves.toMatchObject({ kind: 'failed', message: 'The agent changed; open it again' })
    await harness.dispose()
  })

  it('ignores a repeated Agent and repeated facts, and takes every call when the Agent has no session to ask', async () => {
    const harness = await bootAgents()
    harness.facts.switchTo(harness.base)
    const calls = [call('fg', { startedAt: Date.now() })]
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: calls })
    const revision = harness.pane().revision
    harness.facts.setFacts({ turn: 1, active: true, agentCalls: calls })
    expect(harness.pane().revision).toBe(revision)
    await harness.dispose()
    const bare = await bootAgents()
    ;(bare.base as unknown as { session: unknown }).session = undefined
    bare.facts.setFacts({ turn: 1, active: true, agentCalls: [call('own', { seq: 9, startedAt: Date.now() })] })
    expect(bare.summaryText()).toMatch(/^● agents 0\/1/u)
    await bare.dispose()
  })
})
