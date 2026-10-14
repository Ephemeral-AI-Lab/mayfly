/**
 * Admission rules for the `slider` node. The validator hands this module its primitives, so each rule reads like the
 * ones beside it and the arm in `ui-validator.ts` stays one call. A slider is a handful of short levels, so every text
 * is a one-row label and the level count is small.
 *
 * @module @ephemeral-ai/mayfly/core/ui-validator-slider
 */
import type { MayflySliderLevel } from '@ephemeral-ai/mayfly-ui'
import type { AdmissionHelpers } from './ui-validator-content.ts'

/** Maximum levels in one slider. */
export const MAYFLY_UI_MAX_SLIDER_LEVELS = 12
/** Maximum characters in a slider caption or hint label. */
export const MAYFLY_UI_MAX_SLIDER_LABEL = 24

type Fields = Record<string, unknown>

/** The validator's primitives plus its object guard. */
export interface SliderAdmissionHelpers<State> extends AdmissionHelpers {
  /** The validator's own object guard: a plain object, read once, with no cycle. */
  enter<Value>(value: unknown, path: string, state: State, visit: (object: Fields) => Value): Value
}

function present<Value>(key: string, value: Value | undefined): Fields {
  return value === undefined ? {} : { [key]: value }
}

function shortText(h: AdmissionHelpers, value: unknown, path: string): string {
  const result = h.label(value, path)
  if (result.length > MAYFLY_UI_MAX_SLIDER_LABEL) h.invalid(`${path} must be at most ${String(MAYFLY_UI_MAX_SLIDER_LABEL)} characters`)
  return result
}

function levels<State>(h: SliderAdmissionHelpers<State>, value: unknown, path: string, state: State): readonly MayflySliderLevel[] {
  const list = h.collection(value, path)
  if (list.length === 0 || list.length > MAYFLY_UI_MAX_SLIDER_LEVELS) h.invalid(`${path} must hold 1 to ${String(MAYFLY_UI_MAX_SLIDER_LEVELS)} levels`)
  const admitted = list.map((item, index): MayflySliderLevel => h.enter(item, `${path}[${String(index)}]`, state, object => {
    const at = `${path}[${String(index)}]`
    const id = h.own(object, 'id', at)
    const label = h.own(object, 'label', at)
    if (id === undefined) h.invalid(`${at}.id is required`)
    if (label === undefined) h.invalid(`${at}.label is required`)
    const disabled = h.own(object, 'disabled', at)
    const reason = h.own(object, 'disabledReason', at)
    return {
      id: h.identifier(id, `${at}.id`),
      label: h.label(label, `${at}.label`),
      ...present('disabled', disabled === undefined ? undefined : h.boolean(disabled, `${at}.disabled`)),
      ...present('disabledReason', reason === undefined ? undefined : h.label(reason, `${at}.disabledReason`)),
    }
  }))
  if (new Set(admitted.map(level => level.id)).size !== admitted.length) h.invalid(`${path} contains duplicate ids`)
  return admitted
}

/**
 * Everything a slider carries beyond its `kind` and `id`. The arm reserves the control id; this module bounds the rest.
 * @returns the admitted fields (`levels` included).
 */
export function admitSliderFields<State>(h: SliderAdmissionHelpers<State>, object: Fields, path: string, state: State): Fields & { readonly levels: readonly MayflySliderLevel[] } {
  const levelList = h.own(object, 'levels', path)
  if (levelList === undefined) h.invalid(`${path}.levels is required`)
  const admitted = levels(h, levelList, `${path}.levels`, state)
  const known = (id: unknown, at: string): string => {
    const identifier = h.identifier(id, at)
    if (!admitted.some(level => level.id === identifier)) h.invalid(`${at} must name one of the levels`)
    return identifier
  }
  const selected = h.own(object, 'selectedId', path)
  const inherited = h.own(object, 'inheritedId', path)
  const start = h.own(object, 'startCaption', path)
  const end = h.own(object, 'endCaption', path)
  const hint = h.own(object, 'hintLabel', path)
  const autofocus = h.own(object, 'autofocus', path)
  return {
    levels: admitted,
    ...present('selectedId', selected === undefined ? undefined : known(selected, `${path}.selectedId`)),
    ...present('inheritedId', inherited === undefined ? undefined : known(inherited, `${path}.inheritedId`)),
    ...present('startCaption', start === undefined ? undefined : shortText(h, start, `${path}.startCaption`)),
    ...present('endCaption', end === undefined ? undefined : shortText(h, end, `${path}.endCaption`)),
    ...present('hintLabel', hint === undefined ? undefined : shortText(h, hint, `${path}.hintLabel`)),
    ...present('autofocus', autofocus === undefined ? undefined : h.boolean(autofocus, `${path}.autofocus`)),
  }
}
