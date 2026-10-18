/** Admission rules for a `review` page: bounded rows, unique step ids, and admitted answer sources.
 * @module @ephemeral-ai/mayfly/tests/core/ui-validator-review
 */
import { describe, expect, it } from 'vitest'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { MAYFLY_UI_MAX_REVIEW_ITEMS } from '../../src/core/ui-validator-review.ts'

function accepted(value: unknown) {
  const result = validateMayflyUiNode(value)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function rejected(value: unknown): string {
  const result = validateMayflyUiNode(value)
  if (result.ok) throw new Error('expected a rejection')
  return result.message
}

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'one', label: 'One', source: { kind: 'list', pagePath: [], controlId: 'choice' }, ...over }
}

function review(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'review', id: 'review', tabsId: 'steps', items: [item()], skippedLabel: 'Skipped', submitLabel: 'Submit', submitActionId: 'submit', ...over }
}

describe('review page admission', () => {
  it('admits list and form sources and every optional field', () => {
    const node = accepted(review({
      items: [
        item(),
        item({ id: 'two', label: 'Two', source: { kind: 'form', pagePath: [], formId: 'form', fieldId: 'field' } }),
      ],
      autofocus: false,
    }))
    expect(node).toMatchObject({
      tabsId: 'steps', skippedLabel: 'Skipped', submitLabel: 'Submit', submitActionId: 'submit', autofocus: false,
      items: [
        { id: 'one', label: 'One', source: { kind: 'list', pagePath: [], controlId: 'choice' } },
        { id: 'two', label: 'Two', source: { kind: 'form', pagePath: [], formId: 'form', fieldId: 'field' } },
      ],
    })
    expect(accepted(review({ items: [item({ source: { kind: 'list', controlId: 'choice' } })] }))).toMatchObject({ items: [{ source: { pagePath: [] } }] })
  })

  it('requires the page fields and a non-empty bounded row list', () => {
    for (const key of ['tabsId', 'skippedLabel', 'submitLabel', 'submitActionId'] as const) {
      const value = { ...review() }
      delete value[key]
      expect(rejected(value)).toContain(`${key} is required`)
    }
    expect(rejected(review({ items: [] }))).toContain(`1 to ${String(MAYFLY_UI_MAX_REVIEW_ITEMS)} rows`)
    expect(rejected(review({ items: Array.from({ length: MAYFLY_UI_MAX_REVIEW_ITEMS + 1 }, (_, index) => item({ id: `i${String(index)}` })) })))
      .toContain(`1 to ${String(MAYFLY_UI_MAX_REVIEW_ITEMS)} rows`)
    expect(rejected({ ...review(), items: undefined })).toContain('.items is required')
    expect(rejected(review({ items: 'one' }))).toContain('items must be an array')
  })

  it('requires each row id, label, and source, and rejects duplicate ids', () => {
    expect(rejected(review({ items: [item({ id: undefined })] }))).toContain('items[0].id is required')
    expect(rejected(review({ items: [item({ label: undefined })] }))).toContain('items[0].label is required')
    expect(rejected(review({ items: [item({ source: undefined })] }))).toContain('items[0].source is required')
    expect(rejected(review({ items: [item(), item()] }))).toContain('duplicate ids')
    expect(rejected(review({ items: [item({ id: 'one' }), item({ id: 'one' })] }))).toContain('duplicate ids')
  })

  it('rejects a malformed source kind and missing answer addresses', () => {
    expect(rejected(review({ items: [item({ source: { kind: 'other', pagePath: [] } })] }))).toContain('.kind')
    expect(rejected(review({ items: [item({ source: { kind: 'list', pagePath: [] } })] }))).toContain('.controlId is required')
    expect(rejected(review({ items: [item({ source: { kind: 'form', pagePath: [], formId: 'form' } })] }))).toContain('needs formId and fieldId')
    expect(rejected(review({ items: [item({ source: { kind: 'form', pagePath: [], fieldId: 'field' } })] }))).toContain('needs formId and fieldId')
    expect(rejected(review({ items: [item({ source: 'list' })] }))).toContain('items[0].source')
  })

  it('rejects a malformed page segment in an answer source', () => {
    expect(rejected(review({ items: [item({ source: { kind: 'list', pagePath: 'nowhere', controlId: 'choice' } })] }))).toContain('pagePath must be an array')
    expect(rejected(review({ items: [item({ source: { kind: 'list', pagePath: [{ controlId: 'tab' }], controlId: 'choice' } })] }))).toContain('.itemId is required')
    expect(rejected(review({ items: [item({ source: { kind: 'list', pagePath: [{ itemId: 'step' }], controlId: 'choice' } })] }))).toContain('.controlId is required')
  })

  it('rejects non-boolean autofocus and malformed row text', () => {
    expect(rejected(review({ autofocus: 'yes' }))).toContain('.autofocus')
    expect(rejected(review({ items: [item({ label: 3 })] }))).toContain('items[0].label')
    expect(rejected(review({ skippedLabel: 3 }))).toContain('skippedLabel')
  })
})
