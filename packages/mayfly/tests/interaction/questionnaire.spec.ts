/** Wizard draft ownership and native single/multiple/custom answer semantics.
 * @module @ephemeral-ai/mayfly/tests/interaction/questionnaire
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { questionnaireAnswer, questionnaireView } from '../../src/interaction/questionnaire.ts'
import { requestFixture, renderRequest, flushRequests } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = new Context(); contexts.push(ctx); return requestFixture(ctx) }
const path = (id: string) => [{ controlId: 'questions', itemId: id }]
const field = (id: string, fieldId: string) => ({ pagePath: path(id), formId: 'answer', fieldId })

describe('shared questionnaire', () => {
  it('keeps each question draft and invalidates a completed step when revisited and edited', async () => {
    const bench = await setup()
    const questions = [{ id: 'one', question: 'Pick one', options: [{ label: 'Alpha' }, { label: 'Beta' }] }, { id: 'two', question: 'Why?' }]
    const pending = bench.ctx.userQuestions.ask({ questions })
    const completed = vi.fn()
    void pending.then(completed)
    const model = bench.model()
    model.edit(field('one', 'selected'), '1')
    model.invoke('next', path('one'))
    expect(model.activeTab({ pagePath: [], controlId: 'questions' })).toBe('two')
    expect(model.completedSteps({ pagePath: [], controlId: 'questions' })).toEqual(['one'])
    const renderer = renderRequest(model)
    expect(renderer.component.render(80).join('\n')).toContain('✓ Q1')
    renderer.runtime.dispose()
    model.edit(field('two', 'custom'), 'because')
    model.invoke('previous', path('two'))
    expect(model.form(field('one', 'selected'))!.fields.selected!.value).toBe('1')
    model.edit(field('one', 'selected'), '0')
    expect(model.completedSteps({ pagePath: [], controlId: 'questions' })).toEqual([])
    model.activateTab({ pagePath: [], controlId: 'questions' }, 'two')
    await flushRequests()
    expect(completed).not.toHaveBeenCalled()
    model.invoke('submit-answers')
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'one', selected: ['Alpha'] }, { id: 'two', selected: [], custom: 'because' }] })
    expect(completed).toHaveBeenCalledOnce()
  })

  it.each([false, true])('maps stable option IDs to native labels with Other, multiSelect=%s', async multiSelect => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Pick', options: [{ label: '原始 A' }, { label: 'Original B' }], multiSelect }] })
    const model = bench.model()
    model.edit(field('q', 'selected'), multiSelect ? ['1', '0'] : '1')
    model.edit(field('q', 'custom'), '  custom\ntext  ')
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: multiSelect ? ['原始 A', 'Original B'] : [], custom: '  custom\ntext  ' }] })
  })

  it('preserves explicit empty answers and never substitutes the picker cursor', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [
      { id: 'q', question: 'Pick', options: [{ label: 'A' }], multiSelect: true },
      { id: 's', question: 'Single', options: [{ label: 'B' }] },
      { id: 'text', question: 'Why?' },
    ] })
    const model = bench.model()
    model.edit(field('q', 'selected'), ['0'])
    model.edit(field('q', 'selected'), [])
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: [] }, { id: 's', selected: [] }, { id: 'text', selected: [] }] })
  })

  it('has no per-field Enter submission and survives compiler reconstruction at the last question', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Answer?' }] })
    const model = bench.model()
    model.focusControl({ pagePath: path('q'), controlId: 'custom' })
    let renderer = renderRequest(model)
    renderer.component.render(80)
    renderer.input('text')
    renderer.input('\r')
    await flushRequests()
    expect(model.disposed).toBe(false)
    renderer.runtime.dispose()
    renderer = renderRequest(model)
    expect(renderer.component.render(80).join('\n')).toContain('text')
    model.invoke('submit-answers')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'q', custom: 'text\n' }] })
    renderer.runtime.dispose()
  })

  it('can withdraw a prior single choice through the ordinary picker', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }] }] })
    const model = bench.model()
    model.edit(field('q', 'selected'), '0')
    model.focusControl({ pagePath: path('q'), controlId: 'selected' })
    const renderer = renderRequest(model)
    renderer.input('\r')
    renderer.input('\x1b[A')
    renderer.input('\r')
    expect(model.form(field('q', 'selected'))!.fields.selected!.value).toBe('none')
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
    renderer.runtime.dispose()
  })

  it('rejects missing question data and ignores observation events', () => {
    expect(() => questionnaireView([], key => key)).toThrow('at least one question')
    expect(questionnaireAnswer([], { kind: 'tab-change', pagePath: [], controlId: 'questions', tabId: 'one' })).toBeUndefined()
    expect(() => questionnaireAnswer([{ id: 'one', question: 'One' }], { kind: 'submit', pagePath: [], controlId: 'answer', submission: { actionId: 'submit-answers', draftRevision: 0, forms: [], source: [] } })).toThrow('missing')
  })

  it('retains the request option labels even when the caller mutates its original question object', async () => {
    const bench = await setup()
    const questions = [{ id: 'q', question: 'Pick', options: [{ label: 'Original' }] }]
    const pending = bench.ctx.userQuestions.ask({ questions })
    const model = bench.model()
    model.edit(field('q', 'selected'), '0')
    questions[0]!.options[0]!.label = 'Changed'
    questions[0]!.id = 'different'
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: ['Original'] }] })
  })
})
