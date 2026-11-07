/** Native activity authority, older-Host projection fallbacks, and reference status counters. @module */
import { describe, expect, it } from 'vitest'
import type { ConversationFacts, ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { deriveRemoteActivity, preparingAnnouncer, remoteCompactElapsedMs, remoteFlightDetail, remoteFlightLabel, remoteOutputCounter, remoteOutputRate } from '../../src/app/status/activity.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import type { TranscriptModel } from '../../src/frontend/models.ts'

const session = (running: boolean) => ({ running }) as SessionSnapshot
const projection = (entries: readonly unknown[], turns: readonly unknown[] = [{ turn: 1, startedAt: 100 }], streaming = true) => ({ entries, turns, streaming }) as ConversationProjection
const progress = { startedAt: 100, updatedAt: 1100, initialChars: 4, chars: 84 }
const facts = (extra: Readonly<Record<string, unknown>> = {}) => ({ active: true, phase: 'waiting', turn: 3, flowDownChars: 80, agentCalls: [], ...extra }) as ConversationFacts

describe('Remote native activity facts', () => {
  it.each([
    [false, 'tool', 'idle'], [true, 'waiting', 'diving'], [true, 'thinking', 'thinking'], [true, 'composing', 'writing'], [true, 'tool', 'tool'],
  ] as const)('uses native facts %s/%s before Session.running and fallback transcript', (active, phase, expected) => {
    expect(deriveRemoteActivity(projection([], [{ turn: 9 }]), session(!active), facts({ active, phase }))).toEqual({ active, phase: expected, turn: 3, flowDownChars: 80, inFlight: [] })
  })

  it('keeps native request progress, call times and settlement facts exact', () => {
    const input = facts({ turnStartedAt: 50, outputProgress: progress, runOutcome: 'completed', inFlight: [{ callId: 'read', name: 'read', startedAt: 60 }, { callId: 'bash', name: 'bash', startedAt: 70 }] })
    expect(deriveRemoteActivity(undefined, undefined, input)).toEqual({
      active: true, phase: 'diving', turn: 3, flowDownChars: 80, turnStartedAt: 50, outputProgress: progress, latestOutcome: 'completed',
      inFlight: [{ callId: 'read', name: 'read', startedAt: 60, preparing: false }, { callId: 'bash', name: 'bash', startedAt: 70, preparing: false }],
    })
  })

  it('stays idle without a native running fact and counts only the current turn assistant output', () => {
    expect(deriveRemoteActivity(undefined, undefined)).toEqual({ active: false, phase: 'idle', turn: 0, flowDownChars: 0, inFlight: [] })
    expect(deriveRemoteActivity(projection([{ kind: 'assistant', turn: 1, text: 'old turn' }, { kind: 'assistant', turn: 2, text: 'hello' }, { kind: 'thinking', turn: 2, text: 'private' }], [{ turn: 2, outcome: 'completed', endedAt: 100 }], false), session(false))).toMatchObject({ active: false, phase: 'idle', turn: 2, flowDownChars: 5, latestOutcome: 'completed' })
    expect(deriveRemoteActivity(projection([], []), session(true))).toMatchObject({ active: true, phase: 'diving', turn: 0 })
    expect(deriveRemoteActivity(projection([], [{ turn: 1 }], false), session(false))).toMatchObject({ active: false })
    expect(deriveRemoteActivity(projection([], [{ turn: 1 }], true), undefined)).toMatchObject({ active: true, phase: 'diving' })
  })

  it('maps actual unsettled tools and omits settled/todo records', () => {
    const value = deriveRemoteActivity(projection([
      { kind: 'tool', turn: 1, callId: 'settled', name: 'read', result: {}, arguments: '{}' },
      { kind: 'tool', turn: 1, callId: 'todo', name: 'todo_write', channel: 'todo', arguments: '{}' },
      { kind: 'tool', turn: 1, callId: 'read', name: 'read', arguments: '{}', startedAt: 5 },
      { kind: 'tool', turn: 1, callId: 'empty', name: 'bash', arguments: ' ', startedAt: 6 },
    ]), session(true))
    expect(value.phase).toBe('tool')
    expect(value.inFlight).toEqual([{ callId: 'read', name: 'read', startedAt: 5, preparing: false }, { callId: 'empty', name: 'bash', startedAt: 6, preparing: false }])
  })

  it('uses the latest native stream lane and carries only actual thinking progress', () => {
    expect(deriveRemoteActivity(projection([{ kind: 'assistant', turn: 1, text: 'writing', streaming: true }]), session(true))).toMatchObject({ phase: 'writing', flowDownChars: 7, turnStartedAt: 100 })
    expect(deriveRemoteActivity(projection([{ kind: 'thinking', turn: 1, text: 'reasoning', streaming: true, outputProgress: progress }]), session(true))).toMatchObject({ phase: 'thinking', outputProgress: progress })
    expect(deriveRemoteActivity(projection([{ kind: 'thinking', turn: 1, text: 'reasoning', streaming: true }]), session(true))).not.toHaveProperty('outputProgress')
    expect(deriveRemoteActivity(projection([{ kind: 'assistant', turn: 1, text: 'settled', streaming: false }]), session(true))).toMatchObject({ phase: 'diving' })
  })
})

describe('Remote reference activity labels and counters', () => {
  it.each([[-1, '0s'], [59_999, '59s'], [60_000, '1m 0s'], [3_599_000, '59m 59s'], [3_600_000, '1h 0m 0s'], [3_661_000, '1h 1m 1s']])('formats elapsed %s as %s', (ms, text) => { expect(remoteCompactElapsedMs(ms as number)).toBe(text) })
  it('reports output tokens and current native rates only after a measurable interval', () => {
    expect(remoteOutputCounter(3)).toBe('')
    expect(remoteOutputCounter(80)).toBe('↓20')
    expect(remoteOutputRate(undefined, 1200)).toBe('')
    expect(remoteOutputRate(progress, 3101)).toBe('')
    expect(remoteOutputRate({ ...progress, updatedAt: 200 }, 200)).toBe('')
    expect(remoteOutputRate(progress, 1200)).toBe('20 tok/s')
  })
  it('retains native tool labels, generic calls, preparation and mixed-tool counts', () => {
    const call = (name: string, preparing = false) => ({ callId: name, name, preparing })
    expect(remoteFlightLabel([])).toEqual({ key: 'Deep diving' })
    expect(remoteFlightLabel([call('read')])).toEqual({ key: 'Reading files' })
    expect(remoteFlightLabel([call('read', true)])).toEqual({ key: 'Preparing to read files' })
    expect(remoteFlightLabel([call('external_tool')])).toEqual({ key: 'Calling tools' })
    expect(remoteFlightLabel([call('external_tool', true)])).toEqual({ key: 'Preparing tool calls' })
    expect(remoteFlightLabel([call('read'), call('bash')])).toEqual({ key: 'Running {count} tools', values: { count: 2 } })
    expect(remoteFlightLabel([call('read', true), call('bash', true)])).toEqual({ key: 'Preparing {count} tool calls', values: { count: 2 } })
  })
  it('shares a label across a category, however the tools differ, and says the server of MCP calls', () => {
    const call = (name: string, preparing = false) => ({ callId: name, name, preparing })
    expect(remoteFlightLabel([call('grep'), call('glob')])).toEqual({ key: 'Searching code' })
    expect(remoteFlightLabel([call('subagent')])).toEqual({ key: 'Coordinating subagents' })
    expect(remoteFlightLabel([call('mcp__github__a'), call('mcp__github__b')])).toEqual({ key: 'Calling {server}', values: { server: 'github' } })
    expect(remoteFlightLabel([call('mcp__github__a', true)])).toEqual({ key: 'Preparing to call {server}', values: { server: 'github' } })
    expect(remoteFlightLabel([call('mcp__github__a'), call('mcp__linear__a')])).toEqual({ key: 'Running {count} tools', values: { count: 2 } })
    expect(remoteFlightLabel([call('mcp__cut')])).toEqual({ key: 'Calling tools' })
  })
  it('counts a spawn until the Harness answers it, in the current turn only', () => {
    const agentCalls = [
      { turn: 3, callId: 'live', name: 'subagent', startedAt: 9 },
      { turn: 3, callId: 'answered', name: 'subagent', startedAt: 8, result: { text: 'x', isError: false, endedAt: 9 } },
      { turn: 2, callId: 'older', name: 'subagent', startedAt: 1 },
    ]
    expect(deriveRemoteActivity(undefined, undefined, facts({ agentCalls })).inFlight).toEqual([{ callId: 'live', name: 'subagent', startedAt: 9, preparing: false }])
  })
  it('adds how many of one tool fly and how old the oldest is, and under the row the names of different tools', () => {
    const t = interpolateLocaleMessage
    const call = (name: string, startedAt?: number) => ({ callId: name, name, preparing: startedAt === undefined, ...startedAt === undefined ? {} : { startedAt } })
    expect(remoteFlightDetail([call('read', 0)], 60_000, t)).toEqual({ tail: [] })
    expect(remoteFlightDetail([call('read', 55_000), call('read', 56_000)], 60_000, t)).toEqual({ tail: ['2 in flight'] })
    expect(remoteFlightDetail([call('read', 40_000), call('read', 56_000)], 60_000, t)).toEqual({ tail: ['2 in flight', 'oldest 20s'] })
    expect(remoteFlightDetail([call('read'), call('read')], 60_000, t)).toEqual({ tail: ['2 in flight'] })
    expect(remoteFlightDetail([call('read', 40_000), call('mcp__github__get_issue', 56_000)], 60_000, t)).toEqual({ tail: ['oldest 20s'], info: 'Read · github › get_issue' })
    expect(remoteFlightDetail([call('mcp__cut'), call('web_search'), call('bash'), call('grep'), call('glob')], 60_000, t)).toEqual({ tail: [], info: 'cut · WebSearch · Bash +2 more' })
  })
  it('announces the calls being prepared only when that set changes, however many chunks publish', () => {
    const calls: unknown[] = []
    const announce = preparingAnnouncer(value => calls.push(value))
    const tool = (callId: string, characters?: number) => ({ kind: 'transcript-tool', callId, name: 'write', ...characters === undefined ? {} : { preparing: { characters } } })
    const model = (...entries: readonly unknown[]) => ({ live: { entries } }) as unknown as TranscriptModel
    announce({} as TranscriptModel)
    announce(model({ kind: 'transcript-thinking' }, tool('settled')))
    expect(calls).toEqual([])
    announce(model(tool('a', 1)))
    announce(model(tool('a', 2)))
    expect(calls).toEqual([[{ callId: 'a', name: 'write' }]])
    announce(model(tool('a', 3), tool('b', 1)))
    announce({} as TranscriptModel)
    expect(calls.slice(1)).toEqual([[{ callId: 'a', name: 'write' }, { callId: 'b', name: 'write' }], []])
  })
})
