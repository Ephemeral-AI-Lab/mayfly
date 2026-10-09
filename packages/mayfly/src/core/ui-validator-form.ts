/**
 * Admission rules for the optional form-field properties of slice 1.6: `help` and `group` on every field, and `pattern`,
 * `patternMessage`, and `suggestions` on the text fields. The validator hands this module its primitives, so the arms
 * in `ui-validator.ts` stay one call each.
 *
 * @module @ephemeral-ai/mayfly/core/ui-validator-form
 */

import type { AdmissionHelpers } from './ui-validator-content.ts'

type Fields = Record<string, unknown>

/** The longest `pattern` source, in characters. */
export const PATTERN_SOURCE_MAX = 256

/** The most `suggestions` one field offers. */
export const SUGGESTIONS_MAX = 64

/** The flags every `pattern` compiles with: Unicode-aware, so `\p{L}` works and a stray escape is an error. */
export const PATTERN_FLAGS = 'u'

function present<Value>(key: string, value: Value | undefined): Fields {
  return value === undefined ? {} : { [key]: value }
}

/** Compiles an admitted `pattern`; a source that does not compile never reaches the renderer. */
export function compilePattern(source: string): RegExp | undefined {
  try {
    return new RegExp(source, PATTERN_FLAGS)
  } catch {
    return undefined
  }
}

/** Admitted field definitions are immutable, so each one compiles its `pattern` at most once. */
const matchers = new WeakMap<object, RegExp | undefined>()

/** The matcher of an admitted field's `pattern`. */
export function patternMatcher(field: { readonly pattern?: string }): RegExp | undefined {
  if (field.pattern === undefined) return undefined
  if (!matchers.has(field)) matchers.set(field, compilePattern(field.pattern))
  return matchers.get(field)
}

/** A field's `help` and `group`, each a non-empty line of text. */
export function admitFieldPresentation<State>(h: AdmissionHelpers<State>, object: Fields, path: string, state: State): Fields {
  const line = (key: 'help' | 'group'): string | undefined => {
    const value = h.own(object, key, path)
    if (value === undefined) return undefined
    const result = h.text(value, `${path}.${key}`, state)
    if (result.trim().length === 0) h.invalid(`${path}.${key} must not be empty`)
    return result
  }
  return { ...present('help', line('help')), ...present('group', line('group')) }
}

/** A text field's `pattern` (a regular expression of at most 256 characters), `patternMessage`, and `suggestions`. */
export function admitTextRules<State>(h: AdmissionHelpers<State>, object: Fields, path: string, state: State): Fields {
  const patternValue = h.own(object, 'pattern', path)
  const messageValue = h.own(object, 'patternMessage', path)
  const suggestionsValue = h.own(object, 'suggestions', path)
  let pattern: string | undefined
  if (patternValue !== undefined) {
    pattern = h.text(patternValue, `${path}.pattern`, state)
    if (pattern.length > PATTERN_SOURCE_MAX) h.invalid(`${path}.pattern must be at most ${String(PATTERN_SOURCE_MAX)} characters`)
    if (compilePattern(pattern) === undefined) h.invalid(`${path}.pattern is not a valid regular expression`)
  }
  const patternMessage = messageValue === undefined ? undefined : h.text(messageValue, `${path}.patternMessage`, state)
  if (patternMessage !== undefined && pattern === undefined) h.invalid(`${path}.patternMessage needs a pattern`)
  let suggestions: readonly string[] | undefined
  if (suggestionsValue !== undefined) {
    suggestions = h.collection(suggestionsValue, `${path}.suggestions`).map((item, index) => h.text(item, `${path}.suggestions[${String(index)}]`, state))
    if (suggestions.length > SUGGESTIONS_MAX) h.invalid(`${path}.suggestions must have at most ${String(SUGGESTIONS_MAX)} entries`)
    if (suggestions.some(item => item.length === 0 || item.includes('\n'))) h.invalid(`${path}.suggestions entries must be single non-empty lines`)
  }
  return { ...present('pattern', pattern), ...present('patternMessage', patternMessage), ...present('suggestions', suggestions) }
}
