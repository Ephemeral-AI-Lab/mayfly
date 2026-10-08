/**
 * Admission rules for the `prompt` node (roadmap slice 1.9b). The validator hands this module its primitives, so each
 * rule reads like the ones beside it and the arm in `ui-validator.ts` stays one call. A draft, a recalled message, and a
 * placeholder ladder are bounded separately from the tree's text budget, because a prompt legitimately carries what a
 * user typed or pasted.
 *
 * @module @ephemeral-ai/mayfly/core/ui-validator-prompt
 */
import type { MayflyPromptNode, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import type { AdmissionHelpers } from './ui-validator-content.ts'

/** Maximum characters of a prompt's draft, recalled messages, and reset, summed over one tree. */
export const MAYFLY_UI_MAX_PROMPT_TEXT = 100_000
/** Maximum tokens in one prompt. */
export const MAYFLY_UI_MAX_PROMPT_TOKENS = 50
/** Maximum characters in a token's id, label, and size. */
export const MAYFLY_UI_MAX_PROMPT_TOKEN_TEXT = 64
/** Maximum characters in a prompt's symbol. */
export const MAYFLY_UI_MAX_PROMPT_SYMBOL = 8
/** Maximum characters in a prompt's short labels (`recallLabel`, `submitLabel`). */
export const MAYFLY_UI_MAX_PROMPT_LABEL = 24
/** Maximum placeholder variants, and characters in one. */
export const MAYFLY_UI_MAX_PROMPT_PLACEHOLDERS = 8
export const MAYFLY_UI_MAX_PROMPT_PLACEHOLDER_TEXT = 200

type Fields = Record<string, unknown>

/** The validator's primitives plus the prompt's own text budget. */
export interface PromptAdmissionHelpers<State> extends AdmissionHelpers<State> {
  /** A string charged to the prompt-text budget and stripped of terminal controls. */
  draftText(value: unknown, path: string, state: State): string
  /** The validator's own object guard: a plain object, read once, with no cycle. */
  enter<Value>(value: unknown, path: string, state: State, visit: (object: Fields) => Value): Value
}

const TONES = ['default', 'muted', 'primary', 'accent', 'user', 'success', 'warning', 'danger'] as const

function present<Value>(key: string, value: Value | undefined): Fields {
  return value === undefined ? {} : { [key]: value }
}

function shortText<State>(h: PromptAdmissionHelpers<State>, value: unknown, path: string, state: State, maximum: number): string {
  const result = h.text(value, path, state)
  if (result.length > maximum) h.invalid(`${path} must be at most ${String(maximum)} characters`)
  return result
}

function required<State>(h: PromptAdmissionHelpers<State>, object: Fields, key: string, path: string): unknown {
  const value = h.own(object, key, path)
  if (value === undefined) h.invalid(`${path}.${key} is required`)
  return value
}

function unique<State>(h: PromptAdmissionHelpers<State>, ids: readonly string[], path: string): void {
  if (new Set(ids).size !== ids.length) h.invalid(`${path} contains duplicate ids`)
}

function tokens<State>(h: PromptAdmissionHelpers<State>, value: unknown, path: string, state: State): MayflyPromptNode['tokens'] {
  const list = h.collection(value, path)
  if (list.length > MAYFLY_UI_MAX_PROMPT_TOKENS) h.invalid(`${path} exceeds ${String(MAYFLY_UI_MAX_PROMPT_TOKENS)} tokens`)
  const admitted = list.map((item, index) => h.enter(item, `${path}[${String(index)}]`, state, object => {
    const at = `${path}[${String(index)}]`
    const id = shortText(h, required(h, object, 'id', at), `${at}.id`, state, MAYFLY_UI_MAX_PROMPT_TOKEN_TEXT)
    if (id.trim().length === 0) h.invalid(`${at}.id must not be empty`)
    const size = h.own(object, 'size', at)
    return {
      id,
      label: shortText(h, required(h, object, 'label', at), `${at}.label`, state, MAYFLY_UI_MAX_PROMPT_TOKEN_TEXT),
      ...present('size', size === undefined ? undefined : shortText(h, size, `${at}.size`, state, MAYFLY_UI_MAX_PROMPT_TOKEN_TEXT)),
    }
  }))
  unique(h, admitted.map(token => token.id), path)
  return admitted
}

function recall<State>(h: PromptAdmissionHelpers<State>, value: unknown, path: string, state: State): MayflyPromptNode['recall'] {
  return h.collection(value, path).map((item, index) => h.enter(item, `${path}[${String(index)}]`, state, object => {
    const at = `${path}[${String(index)}]`
    return {
      kind: h.enumeration(required(h, object, 'kind', at), ['queued', 'history'] as const, `${at}.kind`),
      text: h.draftText(required(h, object, 'text', at), `${at}.text`, state),
    }
  }))
}

function placeholder<State>(h: PromptAdmissionHelpers<State>, value: unknown, path: string, state: State): string | readonly string[] {
  const one = (item: unknown, at: string): string => shortText(h, item, at, state, MAYFLY_UI_MAX_PROMPT_PLACEHOLDER_TEXT)
  if (typeof value === 'string') return one(value, path)
  const variants = h.collection(value, path).map((item, index) => one(item, `${path}[${String(index)}]`))
  if (variants.length === 0 || variants.length > MAYFLY_UI_MAX_PROMPT_PLACEHOLDERS) h.invalid(`${path} must hold 1 to ${String(MAYFLY_UI_MAX_PROMPT_PLACEHOLDERS)} variants`)
  return variants
}

function completions<State>(h: PromptAdmissionHelpers<State>, value: unknown, path: string, state: State): NonNullable<MayflyPromptNode['completions']> {
  return h.enter(value, path, state, object => completionRows(h, object, path, state))
}

function completionRows<State>(h: PromptAdmissionHelpers<State>, object: Fields, path: string, state: State): NonNullable<MayflyPromptNode['completions']> {
  const items = h.collection(required(h, object, 'items', path), `${path}.items`).map((item, index) => h.enter(item, `${path}.items[${String(index)}]`, state, fields => {
    const at = `${path}.items[${String(index)}]`
    const detail = h.own(fields, 'detail', at)
    const right = h.own(fields, 'right', at)
    return {
      id: h.text(required(h, fields, 'id', at), `${at}.id`, state),
      label: h.text(required(h, fields, 'label', at), `${at}.label`, state),
      ...present('detail', detail === undefined ? undefined : h.text(detail, `${at}.detail`, state)),
      ...present('right', right === undefined ? undefined : h.text(right, `${at}.right`, state)),
    }
  }))
  unique(h, items.map(item => item.id), `${path}.items`)
  if (items.some(item => item.id.trim().length === 0)) h.invalid(`${path}.items id must not be empty`)
  return { items }
}

/**
 * Everything a prompt carries beyond its `kind` and `id`. The arm reserves the control id; this module bounds the rest.
 * @returns the admitted optional fields.
 */
export function admitPromptFields<State>(h: PromptAdmissionHelpers<State>, object: Fields, path: string, state: State): Fields {
  const symbol = h.own(object, 'symbol', path)
  const symbolTone = h.own(object, 'symbolTone', path)
  const value = h.own(object, 'value', path)
  const tokenList = h.own(object, 'tokens', path)
  const recallList = h.own(object, 'recall', path)
  const recallLabel = h.own(object, 'recallLabel', path)
  const ghost = h.own(object, 'placeholder', path)
  const completionList = h.own(object, 'completions', path)
  const reset = h.own(object, 'reset', path)
  const submitLabel = h.own(object, 'submitLabel', path)
  const autofocus = h.own(object, 'autofocus', path)
  let resetEntry: { readonly rev: number, readonly value: string } | undefined
  if (reset !== undefined) {
    resetEntry = h.enter(reset, `${path}.reset`, state, fields => ({
      rev: h.finiteInteger(required(h, fields, 'rev', `${path}.reset`), `${path}.reset.rev`),
      value: h.draftText(required(h, fields, 'value', `${path}.reset`), `${path}.reset.value`, state),
    }))
  }
  return {
    ...present('symbol', symbol === undefined ? undefined : shortText(h, symbol, `${path}.symbol`, state, MAYFLY_UI_MAX_PROMPT_SYMBOL)),
    ...present('symbolTone', symbolTone === undefined ? undefined : h.enumeration<MayflyTone>(symbolTone, TONES, `${path}.symbolTone`)),
    ...present('value', value === undefined ? undefined : h.draftText(value, `${path}.value`, state)),
    ...present('tokens', tokenList === undefined ? undefined : tokens(h, tokenList, `${path}.tokens`, state)),
    ...present('recall', recallList === undefined ? undefined : recall(h, recallList, `${path}.recall`, state)),
    ...present('recallLabel', recallLabel === undefined ? undefined : shortText(h, recallLabel, `${path}.recallLabel`, state, MAYFLY_UI_MAX_PROMPT_LABEL)),
    ...present('placeholder', ghost === undefined ? undefined : placeholder(h, ghost, `${path}.placeholder`, state)),
    ...present('completions', completionList === undefined ? undefined : completions(h, completionList, `${path}.completions`, state)),
    ...present('reset', resetEntry),
    ...present('submitLabel', submitLabel === undefined ? undefined : shortText(h, submitLabel, `${path}.submitLabel`, state, MAYFLY_UI_MAX_PROMPT_LABEL)),
    ...present('autofocus', autofocus === undefined ? undefined : h.boolean(autofocus, `${path}.autofocus`)),
  }
}
