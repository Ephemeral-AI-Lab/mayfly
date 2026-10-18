/** Native question cancellation, scope authority, and frontend lifetime.
 * @module @ephemeral-ai/mayfly/tests/interaction/questions-plugin
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { MayflyDecisionRequest } from '../../src/core/types.ts'
import { setExternalEditorLauncher } from '../../src/interaction/external-editor.ts'
import { requestFixture, flushRequests } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  setExternalEditorLauncher(undefined)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }
const questions = [{ id: 'q', question: 'Why?' }]
const plan: AskUserQuestionItem = { id: 'plan', question: 'Proceed?', header: 'Plan', detail: '# Plan', options: [{ label: 'Keep planning' }, { label: 'Start implementation' }], intent: { kind: 'plan-review', approve: 'Start implementation' } }

/** Every plan publication of the questions plugin, in order. */
function plans(ctx: Context): Array<readonly MayflyDecisionRequest[]> {
  const seen: Array<readonly MayflyDecisionRequest[]> = []
  ctx.on('mayfly/decision-requests-changed', (source, requests) => { if (source === 'plan') seen.push(requests) })
  return seen
}

describe('native questions provider', () => {
  it('distinguishes human dismissal, dirty dismissal confirmation, and native abort', async () => {
    const bench = await setup()
    const first = bench.ctx.userQuestions.ask({ questions })
    bench.model().requestClose()
    await expect(first).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const second = bench.ctx.userQuestions.ask({ questions })
    const model = bench.model()
    model.updateChoice({ pagePath: [], controlId: 'options' }, { kind: 'input', id: 'other', text: 'draft' })
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
    bench.model().invoke('questions.next.q')
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
    current.invoke('questions.next.q')
    await expect(second).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
  })

  it.each(['agent-change', 'frontend-unload', 'app-unload'] as const)('withdraws scoped requests after %s', async mode => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions, agent: bench.agent })
    const result = expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    const model = bench.model()
    if (mode === 'agent-change') bench.ctx.mayflyConversations.selectPrimary(bench.other)
    else await (mode === 'frontend-unload' ? bench.front : bench.app).dispose()
    await result
    model.invoke('questions.next.q')
    expect(model.disposed).toBe(true)
  })

  it('does not let submission resolve a request aborted before its ack is published', async () => {
    const bench = await setup()
    const abort = new AbortController()
    const pending = bench.ctx.userQuestions.ask({ questions, signal: abort.signal })
    bench.model().invoke('questions.next.q')
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it.each(['agent-change', 'frontend-unload', 'app-unload', 'abort'] as const)('withdraws a plan review after %s and publishes an empty plan roster', async mode => {
    const bench = await setup()
    const seen = plans(bench.ctx)
    const abort = new AbortController()
    const pending = bench.ctx.userQuestions.ask({ questions: [plan], agent: bench.agent, signal: abort.signal })
    const result = expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(seen.at(-1)!.map(request => request.type)).toEqual(['plan'])
    const model = bench.model()
    if (mode === 'agent-change') bench.ctx.mayflyConversations.selectPrimary(bench.other)
    else if (mode === 'abort') abort.abort()
    else await (mode === 'frontend-unload' ? bench.front : bench.app).dispose()
    await result
    expect(seen.at(-1)).toEqual([])
    expect(model.disposed).toBe(true)
  })

  it('declines a plan review on Esc and clears its plan publication', async () => {
    const bench = await setup()
    const seen = plans(bench.ctx)
    const pending = bench.ctx.userQuestions.ask({ questions: [plan] })
    expect(seen.at(-1)).toEqual([{ type: 'plan', toolName: 'Plan' }])
    bench.model().requestClose()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
    expect(seen.at(-1)).toEqual([])
  })

  it('keeps a multi-question request a plain questionnaire even when one of them carries the plan intent', async () => {
    const bench = await setup()
    const seen = plans(bench.ctx)
    const pending = bench.ctx.userQuestions.ask({ questions: [plan, { id: 'r', question: 'How?' }] })
    expect(seen).toEqual([])
    expect(bench.ctx.mayflyOverlays.list().findLast(candidate => candidate.id.startsWith('mayfly.questions.'))!.definition.dismissal).toBeUndefined()
    bench.model().activateTab({ pagePath: [], controlId: 'questions' }, 'questions.review')
    bench.model().invoke('questions.submit', [{ controlId: 'questions', itemId: 'questions.review' }])
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: [] }, { id: 'r', selected: [] }] })
  })

  it('names a plan publication without a header after the plan itself', async () => {
    const bench = await setup()
    const seen = plans(bench.ctx)
    const headless: AskUserQuestionItem = { id: 'plan', question: 'Proceed?', detail: '# Plan', options: [{ label: 'Keep planning' }, { label: 'Start implementation' }], intent: { kind: 'plan-review', approve: 'Start implementation' } }
    const pending = bench.ctx.userQuestions.ask({ questions: [headless] })
    expect(seen.at(-1)).toEqual([{ type: 'plan', toolName: 'plan' }])
    bench.model().requestClose()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
  })

  it('opens the plan document in the external editor from the card and keeps the review open', async () => {
    vi.stubEnv('VISUAL', 'my-editor --wait')
    const launcher = vi.fn(async (_text: string, _command: string): Promise<string | undefined> => undefined)
    setExternalEditorLauncher(launcher)
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [plan] })
    bench.model().emit({ kind: 'activate', actionId: 'open', controlId: 'actions', pagePath: [] })
    await flushRequests()
    expect(launcher).toHaveBeenCalledWith('# Plan', 'my-editor --wait')
    expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id.startsWith('mayfly.questions.'))).toBe(true)
    bench.model().requestClose()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
  })
})

it('routes a non-open plan action through the review action handler', async () => {
  const bench = await setup()
  const pending = bench.ctx.userQuestions.ask({ questions: [plan] })
  // Copy is not the editor key: the card's own action handler keeps the review open.
  bench.model().emit({ kind: 'activate', actionId: 'copy', controlId: 'actions', pagePath: [] })
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id.startsWith('mayfly.questions.'))).toBe(true)
  bench.model().requestClose()
  await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
})

it('publishes a call-id plan without a header and runs its auxiliary actions', async () => {
  const bench = await setup()
  const seen = plans(bench.ctx)
  const { header: _header, ...headerless } = plan
  const withCall: AskUserQuestionItem = {
    ...headerless,
    intent: { kind: 'plan-review', approve: 'Start implementation', callId: 'call-9' as never },
  }
  const pending = bench.ctx.userQuestions.ask({ questions: [withCall] })
  await flushRequests()
  expect(seen.at(-1)).toEqual([{ type: 'plan', toolName: 'plan', callId: 'call-9' }])
  const entry = bench.ctx.mayflyOverlays.list().find(candidate => candidate.id.startsWith('mayfly.questions.'))!
  const reply = await entry.definition.onEvent!.action!(
    { kind: 'activate', actionId: 'copy', controlId: 'actions', pagePath: [] },
    { signal: new AbortController().signal } as never,
  )
  expect(reply).toMatchObject({ kind: 'completed' })
  bench.model().requestClose()
  await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
})

