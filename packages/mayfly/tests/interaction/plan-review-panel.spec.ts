/** Plan review on the decision card: approve, keep planning, reject, revision text, copy, and the long plan.
 * @module @ephemeral-ai/mayfly/tests/interaction/plan-review-panel
 */
import { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { planReviewAction, planReviewChoices } from '../../src/interaction/plan-review-panel.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { requestFixture, renderRequest, flushRequests } from './request-fixture.ts'
import type { MayflyDecisionRequest } from '../../src/core/types.ts'

const contexts: Context[] = []
afterEach(async () => {
  setClipboardTextWriter(undefined)
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }

const note = { pagePath: [], formId: 'decision.note', fieldId: 'note' }
const plan = (detail = '# Plan\n\nChange the module.'): AskUserQuestionItem => ({
  id: 'plan', question: 'Proceed?', header: 'Plan', detail,
  options: [{ label: 'Keep planning' }, { label: 'Start implementation' }],
  intent: { kind: 'plan-review', approve: 'Start implementation', callId: 'call-plan' } as never,
})
const question = plan()

/** Every plan publication the plugin made, in order. */
function plans(ctx: Context): Array<readonly MayflyDecisionRequest[]> {
  const seen: Array<readonly MayflyDecisionRequest[]> = []
  ctx.on('mayfly/decision-requests-changed', (source, requests) => { if (source === 'plan') seen.push(requests) })
  return seen
}

describe('plan review decision card', () => {
  it('is a bare card in the editor slot, and the plan stays out of it', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const entry = bench.ctx.mayflyOverlays.list().findLast(candidate => candidate.id.startsWith('mayfly.questions.'))!
    expect(entry.definition).toMatchObject({ presentation: 'editor', capturing: true, dismissal: 'discard', contentScroll: true, armMs: 300 })
    const model = bench.model()
    const renderer = renderRequest(model)
    const frame = renderer.component.render(120).join('\n')
    expect(frame).toContain('Approve and start')
    expect(frame.indexOf('Approve and start')).toBeLessThan(frame.indexOf('Keep planning…'))
    expect(frame.indexOf('Keep planning…')).toBeLessThan(frame.indexOf('Reject'))
    expect(frame).toContain('Revise')
    expect(frame).toContain('copy plan')
    expect(frame).toContain('open plan')
    expect(frame).not.toContain('Change the module.')
    model.requestClose()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
    renderer.runtime.dispose()
  })

  it('publishes the plan as the one pending plan request with its call, and an empty roster once it settles', async () => {
    const bench = await setup()
    const seen = plans(bench.ctx)
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    expect(seen.at(-1)).toEqual([{ type: 'plan', toolName: 'Plan', callId: 'call-plan' }])
    bench.model().requestClose()
    await pending
    expect(seen.at(-1)).toEqual([])
  })

  it('leaves a question without the plan intent as a plain question, with no plan publication', async () => {
    const bench = await setup()
    const seen = plans(bench.ctx)
    const plain = { id: 'choice', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }
    expect(planReviewChoices(plain)).toBeUndefined()
    const pending = bench.ctx.userQuestions.ask({ questions: [plain] })
    expect(seen).toEqual([])
    expect(bench.ctx.mayflyOverlays.list().findLast(candidate => candidate.id.startsWith('mayfly.questions.'))!.definition.dismissal).toBeUndefined()
    bench.model().requestClose()
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('chooses approve with the digit 1 and returns the declared approving label', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const renderer = renderRequest(bench.model())
    renderer.input('1')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Start implementation'] }] })
    renderer.runtime.dispose()
  })

  it('rejects with the declining label, and a note typed beside Reject is not sent', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.edit(note, 'please revise step 2')
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decision.options', selectedIds: ['reject'] })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
  })

  it('sends the typed revision as custom text on Keep planning…', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.edit(note, '  revise\nthese steps  ')
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decision.options', selectedIds: ['keep'] })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: [], custom: 'revise\nthese steps' }] })
  })

  it('sends the revision typed in the note with Enter as custom text', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    model.edit(note, 'shorter plan')
    model.invoke('send-note')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: [], custom: 'shorter plan' }] })
  })

  it('settles nothing on Keep planning… with an empty note, and asks for the revision in the note field', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    const renderer = renderRequest(model)
    model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'decision.options', selectedIds: ['keep'] })
    await flushRequests()
    expect(renderer.component.render(80).join('\n')).toContain('Write what to change first')
    model.invoke('send-note')
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id.startsWith('mayfly.questions.'))).toBe(true)
    model.requestClose()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
    renderer.runtime.dispose()
  })

  it('declines on Esc, as the card says, without throwing', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const renderer = renderRequest(bench.model())
    renderer.input('\x1b')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
    renderer.runtime.dispose()
  })

  it('copies the plan to the clipboard with c and reports success or failure', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const model = bench.model()
    const writer = vi.fn(async (_text: string) => {})
    setClipboardTextWriter(writer)
    model.invoke('copy')
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce())
    expect(writer.mock.calls[0]![0]).toBe(question.detail)
    expect(model.feedbackSnapshot().at(-1)?.message).toBe('Plan copied to clipboard')

    setClipboardTextWriter(async () => { throw new Error('no clipboard') })
    model.invoke('copy')
    await vi.waitFor(() => expect(model.feedbackSnapshot().at(-1)?.message).toBe('Plan copy failed'))
    expect(model.feedbackSnapshot().at(-1)?.severity).toBe('error')
    expect(model.disposed).toBe(false)
    model.requestClose()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
  })

  it('keeps a long plan (600+ lines) out of the card and every card row inside the width', async () => {
    const bench = await setup()
    const long = plan(Array.from({ length: 640 }, (_, index) => `- step ${String(index + 1)} with a long line of text to wrap somewhere`).join('\n'))
    const pending = bench.ctx.userQuestions.ask({ questions: [long] })
    const renderer = renderRequest(bench.model(), { columns: 40, rows: 24 })
    const rows = renderer.component.render(40)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40)
    expect(rows.join('\n')).not.toContain('step 300')
    renderer.input('1')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Start implementation'] }] })
    renderer.runtime.dispose()
  })

  it('reads a plan review only from a two-choice question whose approving label is one of its own options', () => {
    const [keep, start] = [{ label: 'Keep planning' }, { label: 'Start implementation' }]
    expect(planReviewChoices({ ...question, options: [keep, start, { label: 'Park' }] })).toBeUndefined()
    expect(planReviewChoices({ ...question, options: [keep, { label: 'Park' }] })).toBeUndefined()
    expect(planReviewChoices({ id: 'plan', question: 'Proceed?', detail: '# Plan', intent: { kind: 'plan-review', approve: 'Start implementation' } })).toBeUndefined()
    expect(planReviewChoices({ ...question, options: [start, keep] })).toEqual({ approve: start, decline: keep })
  })

  it('leaves a key that settles nothing to the card, and does not answer for it', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [question] })
    const renderer = renderRequest(bench.model())
    renderer.input('x')
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id.startsWith('mayfly.questions.'))).toBe(true)
    const unowned = await planReviewAction(question, { kind: 'activate', actionId: 'unowned', pagePath: [] } as never, text => text)
    expect(unowned).toBeUndefined()
    bench.model().requestClose()
    await expect(pending).resolves.toEqual({ answers: [{ id: 'plan', selected: ['Keep planning'] }] })
    renderer.runtime.dispose()
  })
})
