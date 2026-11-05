/** Native activity authority, older-Host projection fallbacks, and reference status counters. @module */
import { describe, expect, it } from 'vitest'
import type { ConversationFacts, ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { deriveRemoteActivity, remoteCompactElapsedMs, remoteFlightLabel, remoteOutputCounter, remoteOutputRate } from '../../src/app/status/activity.ts'

const session = (running: boolean) => ({ running }) as SessionSnapshot
const projection = (entries: readonly unknown[], turns: readonly unknown[] = [{ turn: 1, startedAt: 100 }], streaming = true) => ({ entries, turns, streaming }) as ConversationProjection
const progress = { startedAt: 100, updatedAt: 1100, initialChars: 4, chars: 84 }
const facts = (extra: Readonly<Record<string, unknown>> = {}) => ({ active: true, phase: 'waiting', turn: 3, flowDownChars: 80, ...extra }) as ConversationFacts

describe('Remote native activity facts', () => {
  it.each([
    [false, 'tool', 'idle'], [true, 'waiting', 'diving'], [true, 'thinking', 'thinking'], [true, 'composing', 'writing'], [true, 'tool', 'tool'],
  ] as const)('uses native facts %s/%s before Session.running and fallback transcript', (active, phase, expected) => {
    expect(deriveRemoteActivity(projection([], [{ turn: 9 }]), session(!active), facts({ active, phase }))).toEqual({ active, phase: expected, turn: 3, flowDownChars: 80, inFlight: [] })
  })

  it('keeps native request progress, tool details/preparation, timestamps and settlement facts exact', () => {
    const input = facts({ turnStartedAt: 50, outputProgress: progress, runOutcome: 'completed', inFlight: [{ callId: 'read', name: 'read', detail: 'file.txt', preparing: true }, { callId: 'bash', name: 'bash' }] })
    expect(deriveRemoteActivity(undefined, undefined, input)).toEqual({
      active: true, phase: 'diving', turn: 3, flowDownChars: 80, turnStartedAt: 50, outputProgress: progress, latestOutcome: 'completed',
      inFlight: [{ callId: 'read', name: 'read', detail: 'file.txt', preparing: true }, { callId: 'bash', name: 'bash', preparing: false }],
    })
  })

  it('stays idle without a native running fact and counts only the current turn assistant output', () => {
    expect(deriveRemoteActivity(undefined, undefined)).toEqual({ active: false, phase: 'idle', turn: 0, flowDownChars: 0, inFlight: [] })
    expect(deriveRemoteActivity(projection([{ kind: 'assistant', turn: 1, text: 'old turn' }, { kind: 'assistant', turn: 2, text: 'hello' }, { kind: 'thinking', turn: 2, text: 'private' }], [{ turn: 2, outcome: 'completed', endedAt: 100 }], false), session(false))).toMatchObject({ active: false, phase: 'idle', turn: 2, flowDownChars: 5, latestOutcome: 'completed' })
    expect(deriveRemoteActivity(projection([], []), session(true))).toMatchObject({ active: true, phase: 'diving', turn: 0 })
    expect(deriveRemoteActivity(projection([], [{ turn: 1 }], false), session(false))).toMatchObject({ active: false })
    expect(deriveRemoteActivity(projection([], [{ turn: 1 }], true), undefined)).toMatchObject({ active: true, phase: 'diving' })
  })

  it('maps actual unsettled tools and omits settled/todo records without inventing a tool detail', () => {
    const value = deriveRemoteActivity(projection([
      { kind: 'tool', turn: 1, callId: 'settled', name: 'read', result: {}, arguments: '{}' },
      { kind: 'tool', turn: 1, callId: 'todo', name: 'todo_write', channel: 'todo', arguments: '{}' },
      { kind: 'tool', turn: 1, callId: 'read', name: 'read', arguments: '  {\n "path": "你好.txt"\n }  ' },
      { kind: 'tool', turn: 1, callId: 'empty', name: 'bash', arguments: ' ' },
    ]), session(true))
    expect(value.phase).toBe('tool')
    expect(value.inFlight).toEqual([{ callId: 'read', name: 'read', detail: ' { "path": "你好.txt" } ', preparing: false }, { callId: 'empty', name: 'bash', preparing: false }])
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
})
