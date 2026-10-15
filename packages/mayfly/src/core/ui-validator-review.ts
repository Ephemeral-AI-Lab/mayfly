/**
 * Admission rules for the `review` node. The validator hands this module its primitives, so each rule reads like the
 * ones beside it and the arm in `ui-validator.ts` stays one call. A review page lists the steps of one wizard, so the
 * row count is small and every text is a one-row label.
 *
 * @module @ephemeral-ai/mayfly/core/ui-validator-review
 */
import type { MayflyPagePath, MayflyPageSegment, MayflyReviewItem, MayflyReviewNode } from '@ephemeral-ai/mayfly-ui'
import type { AdmissionHelpers } from './ui-validator-content.ts'

/** Maximum rows on one review page. */
export const MAYFLY_UI_MAX_REVIEW_ITEMS = 32

type Fields = Record<string, unknown>

/** The validator's primitives plus its object guard and page-segment admission. */
export interface ReviewAdmissionHelpers<State> extends AdmissionHelpers {
  enter<Value>(value: unknown, path: string, state: State, visit: (object: Fields) => Value): Value
  pageSegment(value: unknown, path: string, state: State): MayflyPageSegment
}

function pagePath<State>(h: ReviewAdmissionHelpers<State>, value: unknown, path: string, state: State): MayflyPagePath {
  return h.collection(value, path).map((segment, index) => h.pageSegment(segment, `${path}[${String(index)}]`, state))
}

function item<State>(h: ReviewAdmissionHelpers<State>, value: unknown, path: string, state: State): MayflyReviewItem {
  return h.enter(value, path, state, object => {
    const id = h.own(object, 'id', path)
    const label = h.own(object, 'label', path)
    const source = h.own(object, 'source', path)
    if (id === undefined) h.invalid(`${path}.id is required`)
    if (label === undefined) h.invalid(`${path}.label is required`)
    if (source === undefined) h.invalid(`${path}.source is required`)
    const admittedSource = h.enter(source, `${path}.source`, state, fields => {
      const at = `${path}.source`
      const kind = h.enumeration(h.own(fields, 'kind', at), ['list', 'form'] as const, `${at}.kind`)
      const where = pagePath(h, h.own(fields, 'pagePath', at) ?? [], `${at}.pagePath`, state)
      if (kind === 'list') {
        const controlId = h.own(fields, 'controlId', at)
        if (controlId === undefined) h.invalid(`${at}.controlId is required`)
        return { kind, pagePath: where, controlId: h.identifier(controlId, `${at}.controlId`) } as const
      }
      const formId = h.own(fields, 'formId', at)
      const fieldId = h.own(fields, 'fieldId', at)
      if (formId === undefined || fieldId === undefined) h.invalid(`${at} needs formId and fieldId`)
      return { kind, pagePath: where, formId: h.identifier(formId, `${at}.formId`), fieldId: h.identifier(fieldId, `${at}.fieldId`) } as const
    })
    return { id: h.identifier(id, `${path}.id`), label: h.label(label, `${path}.label`), source: admittedSource }
  })
}

/**
 * Everything a review carries beyond its `kind` and `id`.
 * @returns the admitted fields (`items` included).
 */
export function admitReviewFields<State>(h: ReviewAdmissionHelpers<State>, object: Fields, path: string, state: State): Omit<MayflyReviewNode, 'kind' | 'id'> {
  const required = (key: string): unknown => {
    const value = h.own(object, key, path)
    if (value === undefined) h.invalid(`${path}.${key} is required`)
    return value
  }
  const list = h.collection(required('items'), `${path}.items`)
  if (list.length === 0 || list.length > MAYFLY_UI_MAX_REVIEW_ITEMS) h.invalid(`${path}.items must hold 1 to ${String(MAYFLY_UI_MAX_REVIEW_ITEMS)} rows`)
  const items = list.map((entry, index) => item(h, entry, `${path}.items[${String(index)}]`, state))
  if (new Set(items.map(row => row.id)).size !== items.length) h.invalid(`${path}.items contains duplicate ids`)
  const autofocus = h.own(object, 'autofocus', path)
  return {
    items,
    tabsId: h.identifier(required('tabsId'), `${path}.tabsId`),
    skippedLabel: h.label(required('skippedLabel'), `${path}.skippedLabel`),
    submitLabel: h.label(required('submitLabel'), `${path}.submitLabel`),
    submitActionId: h.identifier(required('submitActionId'), `${path}.submitActionId`),
    ...autofocus === undefined ? {} : { autofocus: h.boolean(autofocus, `${path}.autofocus`) },
  }
}
