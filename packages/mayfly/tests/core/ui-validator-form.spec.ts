/** Admission of the optional form-field properties of slice 1.6: help, group, pattern, patternMessage, and suggestions. */
import { describe, expect, it } from 'vitest'
import { ui, type MayflyFormField, type MayflyUiNode } from '../../../ui/src/index.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { PATTERN_SOURCE_MAX, SUGGESTIONS_MAX, compilePattern, patternMatcher } from '../../src/core/ui-validator-form.ts'

const form = (...fields: unknown[]) => ({ kind: 'form', id: 'form', fields })
const field = (extra: Record<string, unknown>) => ({ kind: 'input', id: 'name', label: 'Name', value: '', ...extra })

function accepted(value: unknown): MayflyFormField {
  const result = validateMayflyUiNode(value)
  if (!result.ok) throw new Error(result.message)
  return (result.value as Extract<MayflyUiNode, { readonly kind: 'form' }>).fields[0]!
}

function rejected(value: unknown): string {
  const result = validateMayflyUiNode(value)
  if (result.ok) throw new Error('expected a rejection')
  return result.message
}

describe('help and group', () => {
  it('admits a line of help and a group on every field kind', () => {
    const options = [{ id: 'a', label: 'A' }]
    for (const base of [field({}), { kind: 'toggle', id: 'on', label: 'On', value: true }, { kind: 'number', id: 'n', label: 'N', value: 1 }, { kind: 'select', id: 's', label: 'S', value: 'a', options }, { kind: 'multiselect', id: 'm', label: 'M', value: [], options }]) {
      expect(accepted(form({ ...base, help: 'Base URL', group: 'Connection' }))).toMatchObject({ help: 'Base URL', group: 'Connection' })
    }
    expect(accepted(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'a', label: 'A', value: '', help: 'h' }] }))).toMatchObject({ help: 'h' })
  })

  it('rejects an empty or blank help or group, and anything that is not text', () => {
    expect(rejected(form(field({ help: '' })))).toContain('help must not be empty')
    expect(rejected(form(field({ group: '   ' })))).toContain('group must not be empty')
    expect(rejected(form(field({ help: 4 })))).toContain('help must be a string')
  })
})

describe('pattern, patternMessage, and suggestions', () => {
  it('admits them on the text fields', () => {
    for (const kind of ['input', 'textarea', 'secret']) {
      expect(accepted(form(field({ kind, pattern: '^https?://\\S+$', patternMessage: 'Must be a URL', suggestions: ['~/work', '~/notes'] })))).toMatchObject({ pattern: '^https?://\\S+$', patternMessage: 'Must be a URL', suggestions: ['~/work', '~/notes'] })
    }
    expect(accepted(form(field({ pattern: 'x' })))).not.toHaveProperty('patternMessage')
  })

  it('refuses a source longer than 256 characters, one that does not compile, and a message without a pattern', () => {
    expect(accepted(form(field({ pattern: 'a'.repeat(PATTERN_SOURCE_MAX) })))).toMatchObject({ pattern: 'a'.repeat(PATTERN_SOURCE_MAX) })
    expect(rejected(form(field({ pattern: 'a'.repeat(PATTERN_SOURCE_MAX + 1) })))).toContain('at most 256 characters')
    expect(rejected(form(field({ pattern: '(' })))).toContain('not a valid regular expression')
    expect(rejected(form(field({ pattern: 'a\\-b' })))).toContain('not a valid regular expression')
    expect(rejected(form(field({ patternMessage: 'bad' })))).toContain('needs a pattern')
    expect(rejected(form(field({ pattern: 'x', patternMessage: 3 })))).toContain('patternMessage must be a string')
  })

  it('bounds the suggestions to single non-empty lines', () => {
    expect(accepted(form(field({ suggestions: [] })))).toMatchObject({ suggestions: [] })
    expect(rejected(form(field({ suggestions: Array.from({ length: SUGGESTIONS_MAX + 1 }, (_, index) => `s${String(index)}`) })))).toContain('at most 64 entries')
    expect(rejected(form(field({ suggestions: [''] })))).toContain('single non-empty lines')
    expect(rejected(form(field({ suggestions: ['a\nb'] })))).toContain('single non-empty lines')
    expect(rejected(form(field({ suggestions: 'x' })))).toContain('suggestions')
    expect(rejected(form(field({ suggestions: [1] })))).toContain('suggestions[0]')
  })

  it('compiles a pattern once per field and treats one that cannot compile as no matcher', () => {
    const definition = { pattern: '^a' }
    const matcher = patternMatcher(definition)
    expect(matcher?.test('abc')).toBe(true)
    expect(patternMatcher(definition)).toBe(matcher)
    expect(patternMatcher({})).toBeUndefined()
    expect(compilePattern('(')).toBeUndefined()
    expect(patternMatcher({ pattern: '(' })).toBeUndefined()
  })
})
