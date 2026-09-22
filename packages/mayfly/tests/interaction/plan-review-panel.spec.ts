/** Plan document decisions share the renderer and preserve native labels.
 * @module @ephemeral-ai/mayfly/tests/interaction/plan-review-panel
 */
import { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from 'vitest'
import { planReviewAnswer, planReviewChoices, planReviewView } from '../../src/interaction/plan-review-panel.ts'
import { requestFixture, renderRequest } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }
const question: AskUserQuestionItem = { id: 'plan', question: 'Proceed?', detail: '# Plan\n\nChange the module.', options: [{ label: 'Keep planning' }, { label: 'Start implementation' }], intent: { kind: 'plan-review', approve: 'Start implementation' } }
const decision = [{ controlId: 'review', itemId: 'decision' }]
const feedback = [{ controlId: 'review', itemId: 'feedback' }]

describe('shared plan review', () => {
  it('opens as a floating overlay while the questionnaire stays in the editor slot', async () => {
    const bench = await setup()
    const review = bench.ctx.userQuestions.ask({ questions: [question] })
    const entry = bench.ctx.mayflyOverlays.list().findLast(candidate => candidate.id.startsWith('mayfly.questions.'))!
    expect(entry.definition).toMatchObject({ presentation: 'overlay', width: '90%', maxHeight: '80%', dismissal: 'discard', capturing: true })
    bench.model().requestClose()
    await expect(review).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const plain = bench.ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Why?' }] })
    const plainEntry = bench.ctx.mayflyOverlays.list().findLast(candidate => candidate.id.startsWith('mayfly.questions.'))!
    expect(plainEntry.definition.presentation).toBe('editor')
    expect(plainEntry.definition.width).toBeUndefined()
    expect(plainEntry.definition.maxHeight).toBeUndefined()
    bench.model().requestClose()
    await expect(plain).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('defaults to the native declining label regardless of option order', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const renderer = renderRequest(bench.model())
    expect(renderer.component.render(80).join('\n')).toContain('Change the module.')
    expect(renderer.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'reject' })
    renderer.input('\r')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
    renderer.runtime.dispose()
  })

  it('returns the declared approving label on an explicit action', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    bench.model().invoke('approve', decision)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Start implementation'] }] })
  })

  it.each(['', '  revise\nthese steps  '])('maps revision text without trimming: %j', async reason => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.invoke('revise', decision)
    model.edit({ pagePath: feedback, formId: 'revision', fieldId: 'reason' }, reason)
    model.invoke('send-feedback', feedback)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: reason === '' ? ['Keep planning'] : [], ...reason === '' ? {} : { custom: reason } }] })
  })

  it('returns from revision before Escape cancels the native request', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.invoke('revise', decision)
    model.edit({ pagePath: feedback, formId: 'revision', fieldId: 'reason' }, 'draft')
    const renderer = renderRequest(model)
    renderer.input('\x1b')
    expect(model.activeTab({ pagePath: [], controlId: 'review' })).toBe('decision')
    expect(model.disposed).toBe(false)
    model.requestClose()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    renderer.runtime.dispose()
  })

  it('falls back to the questionnaire for a valid intent with more than two options', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [{ ...question, options: [...question.options!, { label: 'Later' }] }] })
    const model = bench.model()
    // The fallback is a single-question questionnaire: no wizard tabs, the
    // answer form mounts at the surface root.
    expect(model.activeTab({ pagePath: [], controlId: 'questions' })).toBeUndefined()
    expect(model.form({ pagePath: [], formId: 'answer', fieldId: 'selected' })).toBeDefined()
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: [] }] })
  })

  it('recognizes only a valid pair and does not guess from option positions', () => {
    expect(planReviewChoices({ id: 'q', question: 'Q' })).toBeUndefined()
    expect(planReviewChoices({ ...question, options: undefined })).toBeUndefined()
    expect(planReviewChoices({ ...question, intent: { kind: 'plan-review', approve: 'missing' } })).toBeUndefined()
    expect(planReviewChoices(question)).toEqual({ approve: question.options![1], decline: question.options![0] })
    expect(planReviewChoices({ ...question, options: question.options!.toReversed() })).toEqual({ approve: question.options![1], decline: question.options![0] })
    const choices = planReviewChoices(question)!
    expect(JSON.stringify(planReviewView({ ...question, detail: undefined }, choices, key => key))).toContain('"source":""')
    expect(planReviewAnswer(question, choices, { kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' })).toBeUndefined()
    expect(planReviewAnswer(question, choices, { kind: 'submit', submission: { actionId: 'other', source: [], forms: [] } })).toBeUndefined()
  })
})
