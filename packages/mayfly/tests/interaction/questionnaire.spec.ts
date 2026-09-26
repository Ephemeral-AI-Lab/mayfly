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
// A single-question prompt mounts its one page at the surface root, so those
// tests address it through [] rather than the wizard tab path.
const field = (id: string, fieldId: string, pagePath = path(id)) => ({ pagePath, formId: 'answer', fieldId })
const options = (id: string, pagePath = path(id)) => ({ pagePath, controlId: 'options' })
const accept = (id: string, ids: readonly string[], pagePath = path(id)) =>
  ({ kind: 'selection-accept' as const, pagePath, controlId: 'options', selectedIds: ids })

describe('shared questionnaire', () => {
  it('advances on Enter, switches pages with Alt+arrows, and restores the list row on revisit', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [
      { id: 'one', question: 'Pick one', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
      { id: 'two', question: 'Pick two', options: [{ label: 'Gamma' }] },
    ] })
    const model = bench.model()
    const renderer = renderRequest(model)
    renderer.component.render(80)
    expect(model.focus).toMatchObject({ pagePath: path('one'), controlId: 'options', itemId: '0' })
    renderer.input('\x1b[B')
    renderer.input('\r')
    expect(model.choice(options('one'))!.selectedIds).toEqual(['1'])
    expect(model.activeTab({ pagePath: [], controlId: 'questions' })).toBe('two')
    expect(model.completedSteps({ pagePath: [], controlId: 'questions' })).toEqual(['one'])
    expect(renderer.component.render(80).join('\n')).toContain('✓ Q1')
    expect(model.focus).toMatchObject({ pagePath: path('two'), controlId: 'options', itemId: '0' })
    // The surface renderer recompiles on every model revision, restoring the model's focus.
    const recompiled = () => renderRequest(model, undefined, renderer.runtime)
    recompiled().input('\x1b[1;3D')
    expect(model.activeTab({ pagePath: [], controlId: 'questions' })).toBe('one')
    expect(model.focus).toMatchObject({ pagePath: path('one'), controlId: 'options', itemId: '1' })
    recompiled().input('\x1b[1;3C')
    expect(model.activeTab({ pagePath: [], controlId: 'questions' })).toBe('two')
    expect(recompiled().component.render(80).join('\n').match(/Submit answers/gu)).toHaveLength(1)
    renderer.runtime.dispose()
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'one', selected: ['Beta'] }, { id: 'two', selected: [] }] })
  })

  it('submits from the last question list on Enter', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [
      { id: 'one', question: 'Pick one', options: [{ label: 'Alpha' }] },
      { id: 'two', question: 'Pick two', options: [{ label: 'Beta' }, { label: 'Gamma' }] },
    ] })
    const model = bench.model()
    model.emit(accept('one', ['0']))
    model.emit(accept('two', ['1']))
    await expect(pending).resolves.toEqual({ answers: [{ id: 'one', selected: ['Alpha'] }, { id: 'two', selected: ['Gamma'] }] })
    expect(model.disposed).toBe(true)
  })

  it('invalidates a completed step when its choice or custom answer changes', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [
      { id: 'one', question: 'Pick one', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
      { id: 'two', question: 'Why?' },
    ] })
    const completed = vi.fn()
    void pending.then(completed)
    const model = bench.model()
    model.emit(accept('one', ['1']))
    expect(model.activeTab({ pagePath: [], controlId: 'questions' })).toBe('two')
    expect(model.completedSteps({ pagePath: [], controlId: 'questions' })).toEqual(['one'])
    model.edit(field('two', 'custom'), 'because')
    model.invoke('previous', path('two'))
    expect(model.choice(options('one'))!.selectedIds).toEqual(['1'])
    model.updateChoice(options('one'), { kind: 'select', ids: ['0'] })
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
    model.updateChoice(options('q', []), { kind: 'select', ids: multiSelect ? ['1', '0'] : ['1'] })
    model.edit(field('q', 'custom', []), '  custom\ntext  ')
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
    model.updateChoice(options('q'), { kind: 'select', ids: ['0'] })
    model.updateChoice(options('q'), { kind: 'select', ids: [] })
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: [] }, { id: 's', selected: [] }, { id: 'text', selected: [] }] })
  })

  it('submits the answers on Enter in the answer field and keeps Alt+Enter for newlines', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Answer?' }] })
    const model = bench.model()
    model.focusControl({ pagePath: [], controlId: 'custom' })
    const renderer = renderRequest(model)
    renderer.component.render(80)
    renderer.input('text')
    renderer.input('\x1b\r')
    renderer.input('more')
    renderer.input('\r')
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'q', custom: 'text\nmore' }] })
    renderer.runtime.dispose()
  })

  it('can withdraw a prior single choice through the trailing No selection row', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Pick', options: [{ label: 'A' }] }] })
    const model = bench.model()
    model.updateChoice(options('q', []), { kind: 'select', ids: ['0'] })
    model.updateChoice(options('q', []), { kind: 'select', ids: ['none'] })
    expect(model.choice(options('q', []))!.selectedIds).toEqual(['none'])
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: [] }] })
  })

  it('submits an all-text wizard without selection targets', async () => {
    const bench = await setup()
    const pending = bench.ctx.userQuestions.ask({ questions: [{ id: 'one', question: 'First?' }, { id: 'two', question: 'Second?' }] })
    const model = bench.model()
    model.edit(field('two', 'custom'), 'answer')
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'one', selected: [] }, { id: 'two', selected: [], custom: 'answer' }] })
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
    model.updateChoice(options('q', []), { kind: 'select', ids: ['0'] })
    questions[0]!.options[0]!.label = 'Changed'
    questions[0]!.id = 'different'
    model.invoke('submit-answers')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q', selected: ['Original'] }] })
  })
})
