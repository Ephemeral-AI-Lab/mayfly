/** Plan document decisions share the renderer and preserve native labels.
 * @module @ephemeral-ai/mayfly/tests/interaction/plan-review-panel
 */
import { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setClipboardOsc52Emitter, setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { planDocumentNode } from '../../src/interaction/plan-document.ts'
import { planReviewAction, planReviewAnswer, planReviewChoices, planReviewControls } from '../../src/interaction/plan-review-panel.ts'
import { requestFixture, renderRequest, flushRequests } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => {
  setClipboardTextWriter(undefined)
  setClipboardOsc52Emitter(undefined)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }
const question: AskUserQuestionItem = { id: 'plan', question: 'Proceed?', detail: '# Plan\n\nChange the module.', options: [{ label: 'Keep planning' }, { label: 'Start implementation' }], intent: { kind: 'plan-review', approve: 'Start implementation' } }
const choices = { approve: question.options![1]!, decline: question.options![0]! }

describe('shared plan review', () => {
  it('mounts the plan document into the content flow while controls stay in the editor slot', async () => {
    const bench = await setup()
    const review = bench.ctx.userQuestions.ask({ questions: [question] })
    const entry = bench.ctx.mayflyOverlays.list().findLast(candidate => candidate.id.startsWith('mayfly.questions.'))!
    expect(entry.definition).toMatchObject({ presentation: 'editor', dismissal: 'discard', capturing: true, contentScroll: true })
    expect(entry.definition.width).toBeUndefined()
    expect(entry.definition.maxHeight).toBeUndefined()
    const document = bench.screen.slotTargets.get('local.mayfly.questions.1.document')
    expect(document).toBeDefined()
    expect(document!.render(80).join('\n')).toContain('Change the module.')
    expect(bench.screen.followCount).toBeGreaterThan(0)
    bench.model().requestClose()
    await expect(review).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await flushRequests()
    expect(bench.screen.children.some(child => child.render(80).join('\n').includes('Change the module.'))).toBe(false)
    const plain = bench.ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Why?' }] })
    const plainEntry = bench.ctx.mayflyOverlays.list().findLast(candidate => candidate.id.startsWith('mayfly.questions.'))!
    expect(plainEntry.definition.presentation).toBe('editor')
    expect(bench.screen.slotTargets.has('local.mayfly.questions.2.document')).toBe(false)
    bench.model().requestClose()
    await expect(plain).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('defaults to the native declining label regardless of option order', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const renderer = renderRequest(bench.model())
    expect(renderer.component.render(80).join('\n')).not.toContain('Change the module.')
    expect(renderer.focusTarget!.captureFocusIdentity?.()).toMatchObject({ controlId: 'decision', itemId: 'reject' })
    renderer.input('\r')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
    renderer.runtime.dispose()
  })

  it('returns the declared approving label on an explicit selection', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    bench.model().emit({ kind: 'selection-accept', pagePath: [], controlId: 'decision', selectedIds: ['approve'] })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Start implementation'] }] })
  })

  it('swaps in the feedback input on Other and submits the typed revision', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decision', selectedIds: ['other'] })
    await vi.waitFor(() => expect(model.form({ pagePath: [], formId: 'revision', fieldId: 'reason' })).toBeDefined())
    model.edit({ pagePath: [], formId: 'revision', fieldId: 'reason' }, '  revise\nthese steps  ')
    model.invoke('send-feedback', [])
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: [], custom: '  revise\nthese steps  ' }] })
  })

  it('restores the decision controls on back and on an empty submission', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decision', selectedIds: ['other'] })
    await vi.waitFor(() => expect(model.form({ pagePath: [], formId: 'revision', fieldId: 'reason' })).toBeDefined())
    model.invoke('back', [])
    await vi.waitFor(() => expect(model.form({ pagePath: [], formId: 'revision', fieldId: 'reason' })).toBeUndefined())
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decision', selectedIds: ['other'] })
    await vi.waitFor(() => expect(model.form({ pagePath: [], formId: 'revision', fieldId: 'reason' })).toBeDefined())
    model.invoke('send-feedback', [])
    await vi.waitFor(() => expect(model.form({ pagePath: [], formId: 'revision', fieldId: 'reason' })).toBeUndefined())
    expect(model.disposed).toBe(false)
    model.requestClose()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('swaps in the feedback input through the Other accelerator', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.emit({ kind: 'activate', pagePath: [], controlId: 'other-plan', actionId: 'other-plan' })
    await vi.waitFor(() => expect(model.form({ pagePath: [], formId: 'revision', fieldId: 'reason' })).toBeDefined())
    expect(model.disposed).toBe(false)
    model.requestClose()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('cancels the native request when Escape dismisses the feedback input', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.emit({ kind: 'activate', pagePath: [], controlId: 'other-plan', actionId: 'other-plan' })
    await vi.waitFor(() => expect(model.form({ pagePath: [], formId: 'revision', fieldId: 'reason' })).toBeDefined())
    model.requestClose()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('copies the plan markdown without settling the request', async () => {
    const copied: string[] = []
    setClipboardOsc52Emitter(() => false)
    setClipboardTextWriter(async text => { copied.push(text) })
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.emit({ kind: 'activate', pagePath: [], controlId: 'copy-plan', actionId: 'copy-plan' })
    await vi.waitFor(() => expect(model.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'success' })])))
    expect(copied).toEqual(['# Plan\n\nChange the module.'])
    expect(model.disposed).toBe(false)
    model.requestClose()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('reports a copy failure and keeps the request open', async () => {
    setClipboardOsc52Emitter(() => false)
    setClipboardTextWriter(async () => { throw new Error('no clipboard') })
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.emit({ kind: 'activate', pagePath: [], controlId: 'copy-plan', actionId: 'copy-plan' })
    await vi.waitFor(() => expect(model.feedbackSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error' })])))
    expect(model.disposed).toBe(false)
    model.requestClose()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('falls back to the questionnaire for a valid intent with more than two options', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [{ ...question, options: [...question.options!, { label: 'Later' }] }] })
    const model = bench.model()
    // The fallback is a single-question questionnaire: no wizard tabs, the
    // answer form mounts at the surface root, and no document slot mounts.
    expect(model.activeTab({ pagePath: [], controlId: 'questions' })).toBeUndefined()
    expect(model.form({ pagePath: [], formId: 'answer', fieldId: 'selected' })).toBeDefined()
    expect(bench.screen.slotTargets.has('local.mayfly.questions.1.document')).toBe(false)
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: [] }] })
  })

  it('recognizes only a valid pair and does not guess from option positions', () => {
    expect(planReviewChoices({ id: 'q', question: 'Q' })).toBeUndefined()
    expect(planReviewChoices({ ...question, options: undefined })).toBeUndefined()
    expect(planReviewChoices({ ...question, intent: { kind: 'plan-review', approve: 'missing' } })).toBeUndefined()
    expect(planReviewChoices(question)).toEqual({ approve: question.options![1], decline: question.options![0] })
    expect(planReviewChoices({ ...question, options: question.options!.toReversed() })).toEqual({ approve: question.options![1], decline: question.options![0] })
    expect(JSON.stringify(planDocumentNode({ ...question, detail: undefined }, key => key))).toContain('"source":""')
    expect(JSON.stringify(planReviewControls(question, choices, key => key))).toContain('"numbered":"focus"')
    expect(JSON.stringify(planReviewControls(question, choices, key => key))).toContain('"label":"Start implementation"')
    expect(JSON.stringify(planReviewControls(question, choices, key => key))).toContain('"label":"Other"')
    const described = planReviewChoices({ ...question, options: [{ label: 'Keep planning', description: 'stay' }, { label: 'Start implementation', description: 'go' }] })!
    expect(JSON.stringify(planReviewControls(question, described, key => key))).toContain('"detail":"go"')
    expect(planReviewAnswer(question, choices, { kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' })).toBeUndefined()
    expect(planReviewAnswer(question, choices, { kind: 'submit', submission: { actionId: 'other', source: [], forms: [] } })).toBeUndefined()
    const read = (value: unknown) => ({ kind: 'activate' as const, pagePath: [], controlId: 'send-feedback', actionId: 'send-feedback', inputs: { actionId: 'send-feedback', draftRevision: 0, source: [], forms: [{ pagePath: [], formId: 'revision', draftRevision: 0, fields: [{ id: 'reason', change: 'set' as const, value }] }] } })
    expect(planReviewAnswer(question, choices, read('redo this'))).toEqual({ answers: [{ id: 'plan', selected: [], custom: 'redo this' }] })
    expect(planReviewAnswer(question, choices, read(42))).toBeUndefined()
    expect(planReviewAnswer(question, choices, read(''))).toBeUndefined()
    expect(planReviewAnswer(question, choices, read(undefined))).toBeUndefined()
  })

  it('copies an empty detail, stringifies non-Error failures, and ignores unrelated events', async () => {
    const copied: string[] = []
    setClipboardOsc52Emitter(() => false)
    setClipboardTextWriter(async text => { copied.push(text) })
    expect(await planReviewAction({ id: 'p', question: 'P' }, choices, { kind: 'activate', pagePath: [], controlId: 'x', actionId: 'copy-plan' }, key => key)).toMatchObject({ kind: 'completed' })
    expect(copied).toEqual([''])
    setClipboardTextWriter(() => Promise.reject('gone'))
    expect(await planReviewAction(question, choices, { kind: 'activate', pagePath: [], controlId: 'x', actionId: 'copy-plan' }, key => key)).toMatchObject({ kind: 'completed', feedback: { severity: 'error', detail: 'gone' } })
    expect(await planReviewAction(question, choices, { kind: 'selection-accept', pagePath: [], controlId: 'decision', selectedIds: [] }, key => key)).toBeUndefined()
    expect(await planReviewAction(question, choices, { kind: 'dismiss', pagePath: [] }, key => key)).toBeUndefined()
  })
})
