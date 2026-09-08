/** Native question cancellation, scope authority, and frontend lifetime.
 * @module @ephemeral-ai/mayfly/tests/interaction/questions-plugin
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestFixture } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }
const questions = [{ id: 'q', question: 'Why?' }]

describe('native questions provider', () => {
  it('distinguishes human dismissal, dirty dismissal confirmation, and native abort', async () => {
    const bench = await setup()
    const first = bench.ctx.userQuestions.ask({ questions })
    bench.model().requestClose()
    await expect(first).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const second = bench.ctx.userQuestions.ask({ questions })
    const model = bench.model()
    model.edit({ pagePath: [{ controlId: 'questions', itemId: 'q' }], formId: 'answer', fieldId: 'custom' }, 'draft')
    model.requestClose()
    expect(model.decisionNode).toBeDefined()
    model.answerDecision(false)
    expect(model.disposed).toBe(false)
    model.requestClose()
    model.answerDecision(true)
    await expect(second).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const abort = new AbortController()
    const third = bench.ctx.userQuestions.ask({ questions, signal: abort.signal })
    abort.abort()
    await expect(third).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await expect(bench.ctx.userQuestions.ask({ questions, signal: abort.signal })).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('claims unscoped requests and delegates requests for another exact Agent', async () => {
    const bench = await setup()
    const fallback = vi.fn(async () => ({ answers: [] }))
    bench.ctx.on('user-questions/request', fallback)
    await expect(bench.ctx.userQuestions.ask({ questions, agent: bench.other })).resolves.toEqual({ answers: [] })
    expect(fallback).toHaveBeenCalledOnce()
    const own = bench.ctx.userQuestions.ask({ questions, agent: bench.agent })
    expect(bench.model().scope).toEqual({ kind: 'session', sessionId: bench.agent.id })
    bench.model().invoke('submit-answers')
    await expect(own).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
    expect(fallback).toHaveBeenCalledOnce()
  })

  it('keeps separate simultaneous requests and closes only the withdrawn instance', async () => {
    const bench = await setup()
    const abort = new AbortController()
    const first = bench.ctx.userQuestions.ask({ questions, signal: abort.signal })
    const old = bench.model()
    const second = bench.ctx.userQuestions.ask({ questions })
    const current = bench.model()
    expect(current.instanceId).not.toBe(old.instanceId)
    abort.abort()
    await expect(first).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(current.disposed).toBe(false)
    current.invoke('submit-answers')
    await expect(second).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
  })

  it.each(['agent-change', 'frontend-unload', 'app-unload'] as const)('withdraws scoped requests after %s', async mode => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions, agent: bench.agent })
    const result = expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const model = bench.model()
    if (mode === 'agent-change') bench.ctx.mayflyCurrentAgent.select(bench.other)
    else await (mode === 'frontend-unload' ? bench.front : bench.app).dispose()
    await result
    model.invoke('submit-answers')
    expect(model.disposed).toBe(true)
  })

  it('does not let submission resolve a request aborted before its ack is published', async () => {
    const bench = await setup()
    const abort = new AbortController()
    const pending = bench.ctx.userQuestions.ask({ questions, signal: abort.signal })
    bench.model().invoke('submit-answers')
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })
})
