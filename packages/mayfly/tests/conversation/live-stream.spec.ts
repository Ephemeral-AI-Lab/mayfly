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

/** fakeAgent sessions carry no id; drafts expose the durable session id. */
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
  const activeBaseline = {
    revision: 2,
    activeAttempt: {
      attemptId: 'baseline-attempt',
      startedAfterSeq: 0,
      turn: 4,
      step: 1,
      nextIndex: 1,
      stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['seed'] }],
    },
  } as never

  it('restores an active attempt from a compact reconnect baseline and fences indexes', () => {
    const agent = agentWithSessionId('baseline')
    const { service, frame } = boot(agent)
    service.ensure(agent, activeBaseline)
    expect(service.get(agent)).toMatchObject({ attemptId: 'baseline-attempt', revision: 2, turn: 4, step: 1, text: 'seed' })
    frame({ type: 'chunk', attemptId: 'baseline-attempt' as never, revision: 3, index: 1, time: 110, chunk: { type: 'text-delta', index: 0, text: ' more' } })
    expect(service.get(agent)?.text).toBe('seed more')
    const before = service.get(agent)
    frame({ type: 'chunk', attemptId: 'baseline-attempt' as never, revision: 4, index: 3, time: 120, chunk: { type: 'text-delta', index: 0, text: ' gap' } })
    expect(service.get(agent)).toBe(before)
  })

  it('buffers exact-Agent frames until the follow opening baseline arrives', async () => {
    const agent = agentWithSessionId('reconnect')
    const { service, frame } = boot(agent)
    let release!: () => void
    const opening = new Promise<void>(resolve => { release = resolve })
    const dispose = service.watch(agent, {
      current: () => true,
      open: async function* () {
        await opening
        yield { type: 'snapshot', header: {}, cursor: 0, records: [], hasMore: false, projections: {}, assistantStream: { revision: 0 } } as never
      },
    })
    frame({ type: 'start', attemptId: 'queued' as never, revision: 1, turn: 1, step: 0 })
    frame({ type: 'chunk', attemptId: 'queued' as never, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'replayed' } })
    expect(service.get(agent)).toBeUndefined()
    release()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(service.get(agent)?.text).toBe('replayed')
    dispose()
  })

  it('rejects stale baselines, gaps, bad terminal indexes, and preserves identity', () => {
    const agent = agentWithSessionId('fence')
    const replacement = agentWithSessionId('fence')
    const { service, frame } = boot(agent)
    service.ensure(agent, activeBaseline)
    const seeded = service.get(agent)
    service.ensure(agent, { revision: 1 })
    expect(service.get(agent)).toBe(seeded)
    frame({ type: 'chunk', attemptId: 'baseline-attempt' as never, revision: 4, index: 1, time: 1, chunk: { type: 'text-delta', index: 0, text: 'gap' } })
    expect(service.get(agent)).toBe(seeded)
    frame({ type: 'end', attemptId: 'baseline-attempt' as never, revision: 3, index: 99, outcome: { kind: 'abandoned' } })
    expect(service.get(agent)).toBe(seeded)
    frame({ type: 'chunk', attemptId: 'baseline-attempt' as never, revision: 3, index: 1, time: 1, chunk: { type: 'text-delta', index: 0, text: 'ok' } })
    expect(service.get(agent)?.text).toBe('seedok')
    const before = service.get(agent)
    service.ensure(replacement, activeBaseline)
    expect(service.get(replacement)).not.toBe(before)
  })

  it('shares watched recovery references and fences stale follow results', async () => {
    const agent = agentWithSessionId('refs')
    const { service } = boot(agent)
    let current = true
    let openCalls = 0
    const follow = { current: () => current, open: async function* () {
      openCalls += 1
      yield { type: 'snapshot', header: {}, cursor: 0, records: [], hasMore: false, projections: {}, assistantStream: activeBaseline } as never
    } }
    const first = service.watch(agent, follow)
    const second = service.watch(agent, follow)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(openCalls).toBe(1)
    first()
    expect(service.get(agent)).toBeDefined()
    current = false
    second()
    expect(service.get(agent)).toBeDefined()
  })

  it('keeps a draft when follow fails and stops retries after release', async () => {
    vi.useFakeTimers()
    try {
      const agent = agentWithSessionId('retry')
      const { service } = boot(agent)
      let calls = 0
      const dispose = service.watch(agent, { current: () => true, open: async function* () {
        calls += 1
        throw new Error('offline')
      } })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toBeGreaterThanOrEqual(2)
      dispose()
      const before = calls
      await vi.advanceTimersByTimeAsync(200)
      expect(calls).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('folds start, deltas, and boundaries into one exact-Agent draft', async () => {
    const agent = agentWithSessionId('live-main')
    const { service, frame } = boot(agent)
    const listener = vi.fn()
    service.subscribe(listener)
    const key = String(agent.session.id)
    frame({ type: 'start', attemptId: 'a1' as never, revision: 1, turn: 2, step: 1 })
    expect(service.get(agent)).toMatchObject({ sessionId: key, turn: 2, step: 1, phase: 'thinking', reasoning: '', text: '' })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 2, index: 0, time: 100, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } })
    expect(service.get(agent)).toMatchObject({ phase: 'thinking', reasoning: 'think', outputProgress: { chars: 5, initialChars: 5, startedAt: 100, updatedAt: 100 } })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 3, index: 1, time: 110, chunk: { type: 'reasoning-delta', index: 0, text: '' } })
    expect(service.get(agent)?.reasoning).toBe('think')
    // An empty text delta parks nothing either.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 4, index: 2, time: 111, chunk: { type: 'text-delta', index: 1, text: '' } })
    expect(service.get(agent)).toMatchObject({ reasoning: 'think', text: '' })
    // A reasoning block ending in the thinking phase parks the draft.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 5, index: 3, time: 120, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } } })
    expect(service.get(agent)).toMatchObject({ phase: 'waiting' })
    // Text deltas compose the answer and reset the measured progress window.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 6, index: 4, time: 130, chunk: { type: 'text-delta', index: 1, text: 'answer' } })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 7, index: 5, time: 140, chunk: { type: 'text-delta', index: 1, text: ' now' } })
    expect(service.get(agent)).toMatchObject({ phase: 'composing', text: 'answer now', outputProgress: { chars: 10, initialChars: 6, startedAt: 130 } })
    // Boundary records that are not reasoning text park the phase.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 8, index: 6, time: 150, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: 'answer now' } } })
    expect(service.get(agent)).toMatchObject({ phase: 'waiting' })
    // Reasoning resuming outside the thinking phase restarts the window.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 9, index: 7, time: 160, chunk: { type: 'reasoning-delta', index: 2, text: 'rethink' } })
    expect(service.get(agent)).toMatchObject({ phase: 'thinking', outputProgress: { chars: 7, initialChars: 7, startedAt: 160 } })
    await Promise.resolve()
    expect(listener).toHaveBeenCalled()
    expect(service.get(agentWithSessionId('other-session'))).toBeUndefined()
  })

  it('ignores non-delta chunk kinds without touching the draft', () => {
    const agent = agentWithSessionId('live-main')
    const { service, frame } = boot(agent)
    frame({ type: 'start', attemptId: 'a1' as never, revision: 1, turn: 1, step: 0 })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 2, index: 0, time: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 3, index: 1, time: 2, chunk: { type: 'tool-call-delta', index: 0, id: 'c' as never, delta: '' } })
    const before = service.get(agent)
    // block-end of reasoning while NOT thinking leaves the phase alone.
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 4, index: 2, time: 3, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } } })
    expect(service.get(agent)).toBe(before)
  })

  it('ignores chunks of an attempt it never saw start', () => {
    const agent = agentWithSessionId('live-main')
    const { service, frame } = boot(agent)
    frame({ type: 'chunk', attemptId: 'unknown' as never, revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'orphan' } })
    expect(service.get(agent)).toBeUndefined()
  })

  it('replaces the draft when a new attempt starts and clears on end', () => {
    const agent = agentWithSessionId('live-main')
    const { service, frame } = boot(agent)
    frame({ type: 'start', attemptId: 'a1' as never, revision: 1, turn: 1, step: 0 })
    frame({ type: 'chunk', attemptId: 'a1' as never, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'first' } })
    frame({ type: 'start', attemptId: 'a2' as never, revision: 3, turn: 1, step: 0 })
    expect(service.get(agent)).toMatchObject({ reasoning: '', text: '' })
    frame({ type: 'chunk', attemptId: 'a2' as never, revision: 4, index: 0, time: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'retry' } })
    frame({ type: 'end', attemptId: 'a2' as never, revision: 5, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 as never } })
    expect(service.get(agent)).toBeUndefined()
    // An abandoned end with no draft is a quiet no-op.
    frame({ type: 'end', attemptId: 'a3' as never, revision: 6, index: 0, outcome: { kind: 'abandoned' } })
    expect(service.get(agent)).toBeUndefined()
  })

  it('keeps drafts per Agent and drops them on agent disposal', () => {
    const first = agentWithSessionId('live-first')
    const second = agentWithSessionId('live-second')
    const { ctx, service } = boot(first)
    ctx.emit('agent/assistant-stream', { agent: first, frame: { type: 'start', attemptId: 'a' as never, revision: 1, turn: 1, step: 0 } } as never)
    ctx.emit('agent/assistant-stream', { agent: second, frame: { type: 'start', attemptId: 'b' as never, revision: 1, turn: 3, step: 0 } } as never)
    expect(service.get(first)).toMatchObject({ turn: 1 })
    expect(service.get(second)).toMatchObject({ turn: 3 })
    ctx.emit('agent/disposed', { agent: second } as never)
    expect(service.get(second)).toBeUndefined()
    expect(service.get(first)).toBeDefined()
  })

  it('isolates replacement Agents even when their session and attempt ids match', () => {
    const first = agentWithSessionId('shared-session')
    const second = agentWithSessionId('shared-session')
    const { ctx, service } = boot(first)
    const emit = (agent: Agent, frame: AssistantStreamFrame) => ctx.emit('agent/assistant-stream', { agent, frame } as never)
    const start = { type: 'start', attemptId: 'same' as never, revision: 1, turn: 1, step: 0 } as const
    const chunk = { type: 'chunk', attemptId: 'same' as never, revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'replacement' } } as const
    emit(first, start)
    emit(second, start)
    emit(second, chunk)
    const draft = service.get(second)
    emit(first, { ...chunk, chunk: { ...chunk.chunk, text: 'obsolete' } })
    emit(first, { ...start, revision: 3 })
    emit(first, { type: 'end', attemptId: 'same' as never, revision: 4, index: 1, outcome: { kind: 'abandoned' } })
    ctx.emit('agent/disposed', { agent: first } as never)
    emit(first, { ...start, revision: 5 })
    expect(service.get(first)).toBeUndefined()
    expect(service.get(second)).toBe(draft)
    expect(draft?.text).toBe('replacement')
  })

  it('rejects superseded attempt frames and replayed starts after settlement', () => {
    const agent = agentWithSessionId('live-main')
    const { service, frame } = boot(agent)
    frame({ type: 'start', attemptId: 'old' as never, revision: 1, turn: 1, step: 0 })
    frame({ type: 'start', attemptId: 'new' as never, revision: 2, turn: 1, step: 0 })
    const chunk = { type: 'chunk', attemptId: 'new' as never, revision: 3, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'new' } } as const
    frame(chunk)
    const draft = service.get(agent)
    frame({ ...chunk, attemptId: 'old' as never })
    frame({ ...chunk, revision: 2 })
    frame({ type: 'end', attemptId: 'old' as never, revision: 4, index: 1, outcome: { kind: 'abandoned' } })
    frame({ type: 'start', attemptId: 'old' as never, revision: 1, turn: 1, step: 0 })
    expect(service.get(agent)).toBe(draft)
    frame({ type: 'end', attemptId: 'new' as never, revision: 4, index: 1, outcome: { kind: 'abandoned' } })
    frame(chunk)
    frame({ ...chunk, revision: 5, index: 2 })
    frame({ type: 'start', attemptId: 'new' as never, revision: 6, turn: 1, step: 0 })
    expect(service.get(agent)).toBeUndefined()
  })

  it('dispose stops frame handling and subscriptions', async () => {
    const agent = agentWithSessionId('live-main')
    const { ctx, service } = boot(agent)
    const listener = vi.fn()
    const off = service.subscribe(listener)
    off()
    service.dispose()
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a' as never, revision: 1, turn: 1, step: 0 } } as never)
    expect(service.get(agent)).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })
})
