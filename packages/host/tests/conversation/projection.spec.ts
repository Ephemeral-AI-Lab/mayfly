/**
 * Decision tests for the conversation projection fold: entry assembly,
 * streaming settlement, turn bookkeeping, and retraction suppression.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  conversationProjectionDefinition,
  foldConversationProjection,
  initialConversationState,
  isSpawnToolName,
  isTurnRetraction,
  settleKey,
} from '../../src/conversation/projection.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One session event carrying only the fields the fold reads. */
function event(type: string, data: object, time = 1, seq = 1, surfaceOp?: string): SessionEvent {
  return { type, data, time, seq, ...(surfaceOp === undefined ? {} : { surfaceOp }) } as never
}

/** Fold a sequence of events over the initial state. */
function run(events: readonly SessionEvent[]): ReturnType<typeof foldConversationProjection> {
  return events.reduce((state, item) => foldConversationProjection(state, item), initialConversationState())
}

describe('conversationProjectionDefinition', () => {
  it('pins the facts-paired state version and the conversation key', () => {
    expect(conversationProjectionDefinition.stateVersion).toBe(13)
    expect(conversationProjectionDefinition.key).toBe('mayflyConversation')
  })
})

describe('settleKey', () => {
  it('spells the wire vocabulary the transcript settles steps by', () => {
    expect(settleKey(3, 12)).toBe('3:12')
  })
})

describe('isSpawnToolName', () => {
  it('recognizes the subagent-spawning tool names only', () => {
    expect(isSpawnToolName('subagent')).toBe(true)
    expect(isSpawnToolName('subagent_custom')).toBe(true)
    expect(isSpawnToolName('bash')).toBe(false)
    expect(isSpawnToolName('task')).toBe(false)
  })
})

describe('isTurnRetraction', () => {

  it('requires a replace surface op on an emptied message', () => {
    // The base carries the retraction source, so only the surface op varies.
    const retracted = { message: { content: [], source: { kind: 'mayfly-retraction' } } }
    expect(isTurnRetraction(event('developer/message', retracted, 1, 1, 'replace'))).toBe(true)
    expect(isTurnRetraction(event('developer/message', retracted, 1, 1, 'append'))).toBe(false)
    expect(isTurnRetraction(event('developer/message', retracted, 1, 1))).toBe(false)
  })

  it('requires the retraction source for developer messages and the interrupted marker for assistant ones', () => {
    expect(isTurnRetraction(event('developer/message', { message: { content: [], source: { kind: 'mayfly-retraction' } } }, 1, 1, 'replace'))).toBe(true)
    expect(isTurnRetraction(event('developer/message', { message: { content: [], source: { kind: 'user' } } }, 1, 1, 'replace'))).toBe(false)
    expect(isTurnRetraction(event('assistant/message', { message: { content: [], source: { kind: 'agent' } }, interrupted: true }, 1, 1, 'replace'))).toBe(true)
    expect(isTurnRetraction(event('assistant/message', { message: { content: [], source: { kind: 'agent' } }, interrupted: false }, 1, 1, 'replace'))).toBe(false)
  })
})

describe('foldConversationProjection', () => {
  it('returns the same reference for events it does not own', () => {
    const initial = initialConversationState()
    expect(foldConversationProjection(initial, event('session', {}))).toBe(initial)
  })

  it('opens a turn, keeps its start time, and closes it once', () => {
    const state = run([
      event('turn/start', { turn: 2 }, 100),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 200),
      // A later synthetic closer must not overwrite the recorded outcome.
      event('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'late' } } }, 300),
    ])
    const turn = state.turns.find(entry => entry.turn === 2)
    expect(turn?.startedAt).toBe(100)
    expect(turn?.endedAt).toBe(200)
    expect(turn?.outcome).toBe('completed')
    expect(state.active).toBe(false)
  })

  it('suppresses every event of a retracted turn, however late', () => {
    const retraction = event('developer/message', {
      message: { content: [], source: { kind: 'mayfly-retraction' } },
      turn: 5,
    }, 10, 10, 'replace')
    const state = run([
      event('turn/start', { turn: 5 }, 1),
      event('turn/end', { turn: 5, reason: { kind: 'completed' } }, 2),
      retraction,
      // Late replayed events from the retracted turn.
      event('turn/start', { turn: 5 }, 3),
      event('turn/end', { turn: 5, reason: { kind: 'completed' } }, 4),
    ])
    expect(state.retractedTurns).toContain(5)
    expect(state.turns.find(entry => entry.turn === 5)).toBeUndefined()
    // A late replayed closer must not re-mark the turn as ended.
    expect(state.turns).toEqual([])
  })

  it('records a user entry with its body text and no image placeholder inline', () => {
    const state = run([
      event('turn/start', { turn: 1 }),
      event('user/message', {
        turn: 1,
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'look at this' }, { type: 'image', attachment: { attachmentId: 7, mediaType: 'image/png', bytes: 2, width: 2, height: 2 } }],
      }, 1, 2, 'append'),
    ])
    const user = state.entries.find(entry => entry.kind === 'user')
    expect(user?.text).toBe('look at this')
    expect(user?.text).not.toContain('[image]')
  })

  it('appends an error entry when a run fails', () => {
    const state = run([
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'provider down' } } }, 9),
    ])
    const failed = state.entries.find(entry => entry.kind === 'error')
    expect(failed).toBeDefined()
  })
})
