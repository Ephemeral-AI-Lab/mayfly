/** Native baseline binding follows selection without following renderer lifetime.
 * @module @ephemeral-ai/mayfly/tests/frontend/assistant-stream
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionFollowRequest, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MayflyCurrentAgentService } from '../../src/app/current-agent.ts'
import { LiveAssistantStreamService } from '../../src/conversation/live-stream.ts'
import * as recovery from '../../src/frontend/assistant-stream.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }

function agent(id: string): Agent { return { id, session: { id, seq: 4 } } as unknown as Agent }

describe('frontend assistant stream recovery', () => {
  it('restores selected output, fences replacement, and cancels selection leases', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const first = agent('session')
    const replacement = agent('session')
    const agents = new Map([[first.id, first]])
    ctx.provide('agents', { get: (id: Agent['id']) => agents.get(id) } as never)
    const live = new LiveAssistantStreamService(ctx)
    ctx.effect(() => () => live.dispose())
    const current = new MayflyCurrentAgentService(ctx)
    const signals: AbortSignal[] = []
    const follow = vi.fn(async function* (request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
      signals.push(signal)
      expect(request).toMatchObject({ address: { kind: 'session', sessionId: 'session' }, assistantStream: true })
      yield {
        type: 'snapshot', assistantStream: { revision: 2, activeAttempt: {
          attemptId: 'active', turn: 1, step: 0, startedAfterSeq: 3, nextIndex: 1,
          stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [agents.get(first.id) === first ? 'first' : 'replacement'] }],
        } },
      } as unknown as SessionFollowFrame
    })
    ctx.provide('sessionController', { follow } as never)
    const owner = await ctx.plugin(recovery)
    current.select(first)
    await flush()
    expect(live.get(first)?.text).toBe('first')
    const calls = follow.mock.calls.length
    current.select(first)
    expect(follow).toHaveBeenCalledTimes(calls)
    agents.set(first.id, replacement)
    current.select(replacement)
    await flush()
    expect(live.get(replacement)?.text).toBe('replacement')
    expect(signals[0]!.aborted).toBe(true)
    current.select(null)
    expect(signals.at(-1)!.aborted).toBe(true)
    await owner.dispose()
  })

  it('keeps a readonly consumer optional when native recovery services are absent', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const selected = agent('partial')
    recovery.watchAssistantStream(ctx, selected)()
    const live = new LiveAssistantStreamService(ctx)
    recovery.watchAssistantStream(ctx, selected)()
    ctx.provide('agents', { get: () => selected } as never)
    recovery.watchAssistantStream(ctx, selected)()
    live.dispose()
  })
})
