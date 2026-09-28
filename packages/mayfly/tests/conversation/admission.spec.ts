/**
 * Identity-memoized wire admission: strict first admission, memoized
 * identities, and the conversation/facts wire views that use it.
 *
 * @module @ephemeral-ai/mayfly/conversation/tests/admission
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { everyAdmitted, identityAdmission } from '../../src/conversation/admission.ts'
import { conversationFactsProjectionDefinition, initialConversationFacts } from '../../src/conversation/facts.ts'
import { conversationProjectionDefinition, initialConversationState } from '../../src/conversation/projection.ts'
import type { ConversationEntry, ConversationFactsState } from '../../src/conversation/types.ts'

describe('identityAdmission', () => {
  it('admits objects once per identity and never memoizes a rejection', () => {
    const schema = z.object({ n: z.number() })
    let parses = 0
    const counted = schema.superRefine(() => { parses += 1 })
    const admit = identityAdmission(counted)
    const value = { n: 1 }
    expect(admit(value)).toBe(true)
    expect(admit(value)).toBe(true)
    expect(parses).toBe(1)
    const invalid = { n: 'x' }
    expect(admit(invalid)).toBe(false)
    expect(admit(invalid)).toBe(false)
    expect(admit(null)).toBe(false)
    expect(admit('text')).toBe(false)
    expect(admit({ n: 2 })).toBe(true)
    expect(parses).toBe(2)
  })

  it('admits arrays element by element', () => {
    const every = everyAdmitted(identityAdmission(z.object({ n: z.number() })))
    expect(every([{ n: 1 }, { n: 2 }])).toBe(true)
    expect(every([{ n: 1 }, { n: 'x' }])).toBe(false)
    expect(every({ length: 0 })).toBe(false)
  })
})

describe('conversation wire view', () => {
  const schema = conversationProjectionDefinition.wire.viewSchema
  const user: ConversationEntry = { kind: 'user', id: 'user:1', seq: 1, updatedSeq: 1, turn: 1, text: 'hi', images: [] }

  it('returns the view itself and rejects malformed views', () => {
    const view = conversationProjectionDefinition.wire.view({ ...initialConversationState(), entries: [user] })
    expect(schema.parse(view)).toBe(view)
    expect(schema.safeParse(null).success).toBe(false)
    expect(schema.safeParse({ ...view, streaming: 'yes' }).success).toBe(false)
    expect(schema.safeParse({ ...view, settledSteps: [1] }).success).toBe(false)
    expect(schema.safeParse({ ...view, turns: [{ turn: -1 }] }).success).toBe(false)
    expect(schema.safeParse({ ...view, entries: [{ ...user, kind: 'unknown' }] }).success).toBe(false)
    expect(schema.safeParse({ ...view, entries: 'none' }).success).toBe(false)
  })

  it('does not re-validate a retained entry', () => {
    const retained = { ...user, id: 'user:retained' }
    expect(schema.safeParse({ entries: [retained], streaming: false, settledSteps: [], turns: [] }).success).toBe(true)
    // Retained objects are immutable by contract; a test-only mutation proves the memo.
    ;(retained as { text: unknown }).text = 42
    expect(schema.safeParse({ entries: [retained], streaming: true, settledSteps: [], turns: [] }).success).toBe(true)
    expect(schema.safeParse({ entries: [{ ...retained }], streaming: true, settledSteps: [], turns: [] }).success).toBe(false)
  })
})

describe('facts wire view', () => {
  const schema = conversationFactsProjectionDefinition.wire.viewSchema
  const call = { seq: 1, turn: 1, step: 0, callId: 'c1', name: 'subagent', arguments: '{}', startedAt: 1 }

  it('memoizes spawn calls and usage while checking the remainder strictly', () => {
    const state: ConversationFactsState = { ...initialConversationFacts(), agentCalls: [call], usageByStep: { '1:0': 10 } }
    const view = conversationFactsProjectionDefinition.wire.view(state)
    expect(schema.parse(view)).toBe(view)
    expect(schema.safeParse({ ...view, usageByStep: undefined }).success).toBe(true)
    expect(schema.safeParse({ ...view, usageByStep: { '1:0': -1 } }).success).toBe(false)
    expect(schema.safeParse({ ...view, agentCalls: [{ ...call, seq: 'x' }] }).success).toBe(false)
    expect(schema.safeParse({ ...view, agentCalls: undefined }).success).toBe(false)
    expect(schema.safeParse({ ...view, phase: 'lost' }).success).toBe(false)
    expect(schema.safeParse(7).success).toBe(false)
  })
})
