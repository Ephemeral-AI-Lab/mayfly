/** Decision admission refuses unrelated actions and preserves native labels and skipped answers. @module */

import { describe, expect, it } from 'vitest'
import type { MayflyFieldValue, MayflyUiActionEvent } from '@ephemeral-ai/mayfly-ui'
import { DECISION } from '../../src/app/interactions/decision-card.ts'
import { readDecision } from '../../src/app/interactions/decision-actions.ts'
import { planReviewAction, planReviewAnswer, planReviewChoices } from '../../src/app/interactions/plan-review-panel.ts'
import { questionnaireAnswer, questionnaireView } from '../../src/app/interactions/questionnaire.ts'
import type { QuestionItem } from '../../src/app/interactions/official.ts'

const t = (key: string): string => key
const action = (actionId: string, choice?: string, note: MayflyFieldValue = ''): MayflyUiActionEvent => ({
  kind: 'activate', pagePath: [], controlId: DECISION.options, actionId,
  inputs: {
    actionId, draftRevision: 0, source: [],
    forms: [{ pagePath: [], formId: DECISION.note, draftRevision: 0, fields: [{ id: DECISION.field, change: 'set', value: note }] }],
    ...choice === undefined ? {} : { selections: [{ pagePath: [], controlId: DECISION.options, selectedIds: [choice] }] },
  },
})
const question: QuestionItem = { id: 'plan', question: 'Review', intent: { kind: 'plan-review', approve: 'Start native work' }, options: [{ label: 'Stay in planning' }, { label: 'Start native work' }] }

describe('decision action admission', () => {
  it('ignores unrelated actions, missing choices and nontext notes', () => {
    expect(readDecision(action('unrelated', 'approve', 'comment'))).toBeUndefined()
    expect(readDecision(action(DECISION.choose))).toBeUndefined()
    expect(readDecision(action(DECISION.send, undefined, null))).toEqual({ action: 'send', note: '' })
    expect(readDecision({ kind: 'activate', controlId: DECISION.options, actionId: DECISION.choose, pagePath: [] })).toBeUndefined()
    expect(readDecision({ kind: 'dismiss', pagePath: [] })).toBeUndefined()
    expect(readDecision(action(DECISION.choose, 'approve', '  native comment  '))).toEqual({ action: 'choose', choice: 'approve', note: 'native comment' })
  })
})

describe('native plan-review model', () => {
  it('requires exactly two options with the native approval label, in either order', () => {
    expect(planReviewChoices({ id: question.id, question: question.question, intent: question.intent! })).toBeUndefined()
    expect(planReviewChoices({ ...question, options: [{ label: 'Start native work' }] })).toBeUndefined()
    expect(planReviewChoices({ ...question, intent: { kind: 'plan-review', approve: 'Missing approval' } })).toBeUndefined()
    expect(planReviewChoices(question)).toEqual({ approve: question.options![1], decline: question.options![0] })
    const reversed = { ...question, options: [...question.options!].reverse() }
    expect(planReviewChoices(reversed)).toEqual({ approve: reversed.options[0], decline: reversed.options[1] })
    expect(planReviewChoices({ id: question.id, question: question.question })).toBeUndefined()
  })

  it('writes only admitted explicit choices and keeps revision validation on the note field', async () => {
    const choices = planReviewChoices(question)!
    expect(planReviewAnswer(question, choices, action('external-editor'))).toBeUndefined()
    expect(planReviewAnswer(question, choices, action(DECISION.choose, 'unrelated-row'))).toBeUndefined()
    expect(planReviewAnswer(question, choices, action(DECISION.choose, 'approve'))).toEqual({ answers: [{ id: 'plan', selected: ['Start native work'] }] })
    expect(planReviewAnswer(question, choices, action(DECISION.choose, 'reject'))).toEqual({ answers: [{ id: 'plan', selected: ['Stay in planning'] }] })
    expect(planReviewAnswer(question, choices, action(DECISION.choose, 'keep'))).toBeUndefined()
    expect(planReviewAnswer(question, choices, action(DECISION.send, undefined, 'Revise this part'))).toEqual({ answers: [{ id: 'plan', selected: [], custom: 'Revise this part' }] })
    expect(await planReviewAction(action('external-editor'), t)).toBeUndefined()
    expect(await planReviewAction(action(DECISION.choose, 'approve'), t)).toBeUndefined()
    expect(await planReviewAction(action(DECISION.choose, 'keep', 'Add validation'), t)).toBeUndefined()
    expect(await planReviewAction(action(DECISION.send), t)).toEqual({ kind: 'invalid', errors: [{ pagePath: [], formId: DECISION.note, fieldId: DECISION.field, message: 'Write what to change first' }] })
  })
})

describe('questionnaire skipped-answer boundary', () => {
  it('rejects empty declarations and ignores non-submit events while retaining explicit skipped answers', () => {
    expect(() => questionnaireView([], t)).toThrow('requires at least one question')
    expect(questionnaireAnswer([question], { kind: 'dismiss', pagePath: [] })).toBeUndefined()
    expect(questionnaireAnswer([question], { kind: 'submit', pagePath: [], controlId: 'questions', submission: { actionId: 'submit', draftRevision: 0, source: [], forms: [] } })).toEqual({ answers: [{ id: 'plan', selected: [] }] })
  })
})
