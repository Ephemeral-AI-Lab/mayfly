/** Live assistant-stream draft folding over transient agent frames.
 * @module @ephemeral-ai/mayfly/tests/conversation/live-stream
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveAssistantStreamService } from '../../src/conversation/live-stream.ts'
import { fakeAgent } from '../transcript/status-fakes.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

/** fakeAgent sessions carry no id; the draft store keys by session id. */
function agentWithSessionId(id: string): Agent {
  const agent = fakeAgent([])
  ;(agent.session as { id?: string }).id = id
  return agent as unknown as Agent
}

function boot(agent: Agent = agentWithSessionId('live-boot')): { ctx: Context, service: LiveAssistantStreamService, frame: (value: AssistantStreamFrame) => void, disposed: (value: Agent) => void } {
  const ctx = new Context()
  contexts.push(ctx)
  const service = new LiveAssistantStreamService(ctx)
  const frame = (value: AssistantStreamFrame): void => { ctx.emit('agent/assistant-stream', { agent, frame: value } as never) }
  const disposed = (value: Agent): void => { ctx.emit('agent/disposed', { agent: value } as never) }
  return { ctx, service, frame, disposed }
}

describe('LiveAssistantStreamService', () => {
  it('folds start, deltas, and boundaries into one per-session draft', () => {
    const agent = agentWithSessionId('live-main')
    const { service, frame } = boot(agent)
    const listener = vi.fn()
    service.subscribe(listener)
    const key = String(agent.session.id)
    frame({ type: 'start', attemptId: 'a1' as never, revision: 1, turn: 2, step: 1 })
    expect(service.get(key)).toMatchObject({ sessionId: key, turn: 2, step: 1, phase: 'thinking', reasoning: '', text: '' })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 0, time: 100, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } })
    expect(service.get(key)).toMatchObject({ phase: 'thinking', reasoning: 'think', outputProgress: { chars: 5, initialChars: 5, startedAt: 100, updatedAt: 100 } })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 1, time: 110, chunk: { type: 'reasoning-delta', index: 0, text: '' } })
    expect(service.get(key)?.reasoning).toBe('think')
    // An empty text delta parks nothing either.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 2, time: 111, chunk: { type: 'text-delta', index: 1, text: '' } })
    expect(service.get(key)).toMatchObject({ reasoning: 'think', text: '' })
    // A reasoning block ending in the thinking phase parks the draft.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 2, time: 120, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } } })
    expect(service.get(key)).toMatchObject({ phase: 'waiting' })
    // Text deltas compose the answer and reset the measured progress window.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 3, time: 130, chunk: { type: 'text-delta', index: 1, text: 'answer' } })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 4, time: 140, chunk: { type: 'text-delta', index: 1, text: ' now' } })
    expect(service.get(key)).toMatchObject({ phase: 'composing', text: 'answer now', outputProgress: { chars: 10, initialChars: 6, startedAt: 130 } })
    // Boundary records that are not reasoning text park the phase.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 5, time: 150, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'answer now' } } })
    expect(service.get(key)).toMatchObject({ phase: 'waiting' })
    // Reasoning resuming outside the thinking phase restarts the window.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 6, time: 160, chunk: { type: 'reasoning-delta', index: 2, text: 'rethink' } })
    expect(service.get(key)).toMatchObject({ phase: 'thinking', outputProgress: { chars: 7, initialChars: 7, startedAt: 160 } })
    expect(listener).toHaveBeenCalled()
    expect(service.get('other-session')).toBeUndefined()
  })

  it('ignores non-delta chunk kinds without touching the draft', () => {
    const agent = agentWithSessionId('live-main')
    const { service, frame } = boot(agent)
    frame({ type: 'start', attemptId: 'a1' as never, revision: 1, turn: 1, step: 0 })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 0, time: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 1, time: 2, chunk: { type: 'tool-call-delta', index: 0, id: 'c' as never, delta: '' } })
    const before = service.get(String(agent.session.id))
    // block-end of reasoning while NOT thinking leaves the phase alone.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 2, time: 3, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } } })
    expect(service.get(String(agent.session.id))).toBe(before)
  })

  it('ignores chunks of an attempt it never saw start', () => {
    const agent = agentWithSessionId('live-main')
    const { service, frame } = boot(agent)
    frame({ type: 'chunk', attemptId: 'unknown' as never, revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'orphan' } })
    expect(service.get(String(agent.session.id))).toBeUndefined()
  })

  it('replaces the draft when a new attempt starts and clears on end', () => {
    const agent = agentWithSessionId('live-main')
    const { service, frame } = boot(agent)
    frame({ type: 'start', attemptId: 'a1' as never, revision: 1, turn: 1, step: 0 })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'first' } })
    frame({ type: 'start', attemptId: 'a2' as never, revision: 2, turn: 1, step: 0 })
    expect(service.get(String(agent.session.id))).toMatchObject({ reasoning: '', text: '' })
    frame({ type: 'chunk', attemptId: 'a2' as never, revision: 2, index: 0, time: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'retry' } })
    frame({ type: 'end', attemptId: 'a2' as never, revision: 2, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 as never } })
    expect(service.get(String(agent.session.id))).toBeUndefined()
    // An abandoned end with no draft is a quiet no-op.
    frame({ type: 'end', attemptId: 'a3' as never, revision: 3, index: 0, outcome: { kind: 'abandoned' } })
    expect(service.get(String(agent.session.id))).toBeUndefined()
  })

  it('keeps drafts per session and drops them on agent disposal', () => {
    const first = agentWithSessionId('live-first')
    const second = agentWithSessionId('live-second')
    const { ctx, service } = boot(first)
    ctx.emit('agent/assistant-stream', { agent: first, frame: { type: 'start', attemptId: 'a' as never, revision: 1, turn: 1, step: 0 } } as never)
    ctx.emit('agent/assistant-stream', { agent: second, frame: { type: 'start', attemptId: 'b' as never, revision: 1, turn: 3, step: 0 } } as never)
    expect(service.get(String(first.session.id))).toMatchObject({ turn: 1 })
    expect(service.get(String(second.session.id))).toMatchObject({ turn: 3 })
    ctx.emit('agent/disposed', { agent: second } as never)
    expect(service.get(String(second.session.id))).toBeUndefined()
    expect(service.get(String(first.session.id))).toBeDefined()
  })

  it('dispose stops frame handling and subscriptions', async () => {
    const agent = agentWithSessionId('live-main')
    const { ctx, service } = boot(agent)
    const listener = vi.fn()
    const off = service.subscribe(listener)
    off()
    service.dispose()
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a' as never, revision: 1, turn: 1, step: 0 } } as never)
    expect(service.get(String(agent.session.id))).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })
})
