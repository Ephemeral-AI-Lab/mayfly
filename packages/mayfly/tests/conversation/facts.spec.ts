/**
 * Facts projection coverage: replay/live parity, usage and mode transitions,
 * subagent call pairing, schema validation, and Cordis lifecycle ownership.
 *
 * @module @ephemeral-ai/mayfly/conversation/tests/facts
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import * as conversation from '../../src/conversation/index.ts'
import {
  conversationFactsProjectionDefinition,
  conversationFactsSchema,
  foldConversationFacts,
  initialConversationFacts,
} from '../../src/conversation/facts.ts'

let seq = 0

function event(type: SessionEvent['type'], data: unknown, time = 1_700_000_000_000 + seq): SessionEvent {
  const result = { type, seq, time, data } as unknown as SessionEvent
  seq += 1
  return result
}

/** One `assistant/attempt` whose compact stream holds a single packed run. */
function attempt(turn: number, step: number, kind: 'reasoning' | 'text', text: string): SessionEvent {
  return event('assistant/attempt', {
    turn,
    step,
    stream: [{ type: kind === 'reasoning' ? 'reasoning-chunks' : 'text-chunks', time0: 1_700_000_000_000, index: 0, dt: [], texts: [text] }],
  })
}

function toolResult(callId: string, content: unknown[], isError = false): unknown {
  return {
    turn: 1,
    step: 0,
    message: {
      content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
    },
  }
}

describe('mayflyConversationFacts projection', () => {
  it('invalidates checkpoints after phase-local output measurements change', () => {
    expect(conversationFactsProjectionDefinition.stateVersion).toBe(3)
  })

  it('folds lifecycle, streaming, usage, todos, request metadata, and agents', () => {
    seq = 0
    let state = initialConversationFacts()
    const unchanged = foldConversationFacts(state, event('user/message', {}))
    expect(unchanged).toBe(state)
    expect(foldConversationFacts(state, event('user/message', {
      source: { kind: 'user' },
      content: [],
    }))).toBe(state)
    state = foldConversationFacts(state, event('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'image' }, { type: 'text', text: 'ship it' }],
    }))
    expect(state.promptText).toBe('ship it')
    expect(foldConversationFacts(state, event('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'ship it' }],
    }))).toBe(state)
    state = foldConversationFacts(state, event('turn/start', { turn: 1 }))
    expect(state).toMatchObject({ phase: 'waiting', active: true, turn: 1, flowDownChars: 0 })
    state = foldConversationFacts(state, event('step/start', { turn: 1, step: 0 }))
    state = foldConversationFacts(state, attempt(1, 0, 'reasoning', '  '))
    expect(state).toMatchObject({ phase: 'waiting', active: true })
    state = foldConversationFacts(state, attempt(1, 0, 'reasoning', 'think'))
    state = foldConversationFacts(state, attempt(1, 0, 'text', 'answer'))
    expect(foldConversationFacts(state, event('assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'chunk', time: 1, chunk: { type: 'finish', index: 0 } }] }))).toMatchObject({ phase: 'waiting' })
    expect(state).toMatchObject({ phase: 'composing', flowDownChars: 11 })
    expect(foldConversationFacts(state, event('assistant/message', { turn: 1, step: 0, stream: [], usage: undefined }))).toMatchObject({ phase: 'waiting', outputProgress: undefined })
    state = foldConversationFacts(state, event('assistant/message', { turn: 1, step: 0, stream: [], usage: { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3 } }))
    expect(state.contextTokens).toBe(15)
    state = foldConversationFacts(state, event('assistant/message', { turn: 1, step: 0, stream: [], usage: { inputTokens: 4 } }))
    expect(state.contextTokens).toBe(4)
    state = foldConversationFacts(state, event('request/context', { contextWindow: 32 }))
    expect(foldConversationFacts(state, event('request/context', { contextWindow: 32 }))).toBe(state)
    state = foldConversationFacts(state, event('request/header', { header: { config: { model: 'm', provider: 'p', reasoningEffort: 'high' } } }))
    state = foldConversationFacts(state, event('request/header', { header: { config: { model: 'm2', provider: 'p2' } } }))
    state = foldConversationFacts(state, event('todo/write', { todos: [{ content: 'ship', status: 'pending' }] }))
    expect(state).toMatchObject({ contextWindow: 32, model: 'm2', provider: 'p2', reasoningEffort: undefined, todos: [{ content: 'ship' }] })
    state = foldConversationFacts(state, event('tool/call', { turn: 1, step: 0, callId: 'agent-1', name: 'subagent', arguments: '{}', }, 88))
    state = foldConversationFacts(state, event('tool/call', { turn: 1, step: 0, callId: 'agent-2', name: 'subagent_fork', arguments: '{}' }, 89))
    state = foldConversationFacts(state, event('tool/call', { turn: 1, step: 0, callId: 'plain', name: 'read', arguments: '{}' }))
    expect(state).toMatchObject({ phase: 'tool', epochToolCount: 3 })
    state = foldConversationFacts(state, event('tool/result', toolResult('agent-1', [{ type: 'text', text: 'done' }, { type: 'json', value: 1 }], true), 99))
    expect(state.agentCalls[0]).toMatchObject({ callId: 'agent-1', result: { text: 'done', isError: true, endedAt: 99 } })
    state = foldConversationFacts(state, event('tool/result', toolResult('agent-1', [{ type: 'text', text: 'ok' }]), 100))
    expect(state.agentCalls[0]?.result).toMatchObject({ text: 'ok', isError: false, endedAt: 100 })
    state = foldConversationFacts(state, event('tool/result', {
      ...toolResult('agent-1', [{ type: 'text', text: 'failed' }]),
      error: { name: 'ToolError', code: 'FAILED' },
    }, 101))
    expect(state.agentCalls[0]?.result).toMatchObject({ text: 'failed', isError: true, endedAt: 101 })
    state = foldConversationFacts(state, event('tool/result', {
      turn: 1,
      step: 0,
      message: { content: [{ type: 'tool-result', toolCallId: 'agent-1', content: null }] },
    }, 102))
    expect(state.agentCalls[0]?.result).toMatchObject({ text: '', isError: false, endedAt: 102 })
    const unchangedResult = foldConversationFacts(state, event('tool/result', toolResult('missing', [{ type: 'text', text: 'ignored' }])))
    expect(unchangedResult).toBe(state)
    state = foldConversationFacts(state, event('step/end', { turn: 1, step: 0 }))
    state = foldConversationFacts(state, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect(state).toMatchObject({ phase: 'idle', active: false, turn: 1, runOutcome: 'completed' })
    state = foldConversationFacts(state, event('turn/end', { turn: 2, reason: { kind: 'interrupted' } }))
    expect(state).toMatchObject({ phase: 'idle', active: false, turn: 2, runOutcome: 'failed' })
  })

  it('folds foreign or malformed embedded streams as empty', () => {
    let state = initialConversationFacts()
    // A hand-built event may carry no stream at all; the step still advances.
    state = foldConversationFacts(state, event('assistant/message', { turn: 1, step: 0 } as never))
    expect(state).toMatchObject({ phase: 'waiting', flowDownChars: 0 })
    // A malformed packed record must not break the projection.
    state = foldConversationFacts(state, event('assistant/attempt', {
      turn: 1, step: 0, stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [0, 0], texts: ['bad'] }],
    }))
    expect(state).toMatchObject({ flowDownChars: 0 })
    // A boundary-only stream while already waiting keeps the phase.
    state = foldConversationFacts(state, event('assistant/attempt', {
      turn: 1, step: 1, stream: [{ type: 'chunk', time: 2, chunk: { type: 'finish', index: 0 } }],
    }))
    expect(state.phase).toBe('waiting')
  })

  it('guards malformed tool results and validates the wire value', () => {
    const state = initialConversationFacts()
    const legacy = { ...state }
    delete legacy.epochToolCount
    expect(foldConversationFacts(legacy, event('tool/call', {
      turn: 1, step: 0, callId: 'legacy', name: 'read', arguments: '{}',
    })).epochToolCount).toBe(1)
    expect(foldConversationFacts(legacy, event('tool/call', {
      turn: 1, step: 0, callId: 'legacy-agent', name: 'subagent', arguments: '{}',
    })).epochToolCount).toBe(1)
    expect(foldConversationFacts(state, event('tool/result', { message: { content: [] } }))).toBe(state)
    expect(foldConversationFacts(state, event('tool/result', { message: { content: [{ type: 'text', content: [] }] } }))).toBe(state)
    expect(foldConversationFacts(state, event('tool/result', { message: undefined }))).toBe(state)
    expect(foldConversationFacts(state, event('session/end-seed', {}))).toBe(state)
    expect(conversationFactsSchema.safeParse(state).success).toBe(true)
    expect(conversationFactsSchema.safeParse({ ...state, phase: 'bad' }).success).toBe(false)
    expect(conversationFactsProjectionDefinition.wire.view({ ...state, todos: [{ content: 'x', status: 'pending' }] })).toEqual({ ...state, todos: [{ content: 'x', status: 'pending' }] })
  })

  it('replays and publishes facts through the official registry, then unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('facts-spec'))
    session.append('turn/start', { turn: 2 })
    session.append('request/header', { header: { config: { model: 'replay', provider: 'mock' } } })
    const fiber = await ctx.plugin(conversation)
    expect(ctx.sessionProjections.snapshot(session).values.mayflyConversationFacts).toMatchObject({ model: 'replay', provider: 'mock', turn: 2 })
    const changed: number[] = []
    const off = ctx.sessionProjections.onChanged((target, key, _value, nextSeq) => {
      if (target === session && key === 'mayflyConversationFacts') changed.push(nextSeq)
    })
    session.append('assistant/attempt', { turn: 2, step: 0, stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['live'] }] })
    expect(changed).toEqual([2])
    off()
    await fiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values.mayflyConversationFacts).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
