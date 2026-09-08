/** Editing and external-update trajectories for the shared form reducer.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-form
 */
import { describe, expect, it } from 'vitest'
import type { MayflyFormAddress, MayflyFormField, MayflyFormNode } from '@ephemeral-ai/mayfly-ui'
import { createFormState, formAddressKey, formDirty, inspectForm, reconcileForm, reduceForm, submitForm, validateForm } from '../../src/core/ui-interaction-form.ts'

const address: MayflyFormAddress = { pagePath: [{ controlId: 'pages', itemId: 'connection' }], formId: 'config' }
const form = (fields: readonly MayflyFormField[]): MayflyFormNode => ({ kind: 'form', id: 'config', fields, submitActionId: 'save', cancelActionId: 'cancel' })
const input = (value: string, label = 'Name'): MayflyFormField => ({ kind: 'input', id: 'name', label, value })

describe('shared form editing', () => {
  it('preserves edits through equivalent snapshots and coordinates a genuine external conflict', () => {
    let state = createFormState(address, form([input('A'), { kind: 'toggle', id: 'enabled', label: 'Enabled', value: false }]))
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'B' })
    const editedRevision = state.draftRevision
    state = reconcileForm(state, form([input('A', 'Translated name'), { kind: 'toggle', id: 'enabled', label: 'Translated enabled', value: false }]))
    expect(state.draftRevision).toBe(editedRevision)
    expect(state.fields.name).toMatchObject({ value: 'B', baseline: 'A', conflict: false })
    state = reconcileForm(state, form([input('C'), { kind: 'toggle', id: 'enabled', label: 'Enabled', value: true }]))
    expect(state.fields.name).toMatchObject({ value: 'B', baseline: 'A', conflict: true, definition: { value: 'C' } })
    expect(state.fields.enabled).toMatchObject({ value: true, change: 'unchanged' })
    expect(validateForm(state)[0]).toMatchObject({ ...address, fieldId: 'name' })
    expect(() => submitForm(state)).toThrow('invalid form')
    state = reduceForm(state, { kind: 'resolve-conflict', fieldId: 'name', choice: 'draft' })
    expect(state.fields.name).toMatchObject({ value: 'B', baseline: 'C', conflict: false })
    expect(submitForm(state).fields).toEqual([
      { id: 'name', change: 'set', value: 'B' }, { id: 'enabled', change: 'unchanged', value: true },
    ])
  })

  it('adopts the latest value only through an explicit conflict decision', () => {
    let state = createFormState(address, form([input('A')]))
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'B' })
    state = reconcileForm(state, form([input('B')]))
    expect(formDirty(state)).toBe(true)
    expect(state.fields.name!.conflict).toBe(true)
    state = reduceForm(state, { kind: 'resolve-conflict', fieldId: 'name', choice: 'latest' })
    expect(formDirty(state)).toBe(false)
    expect(state.fields.name).toMatchObject({ value: 'B', baseline: 'B', conflict: false })
  })

  it('keeps same-named forms on different tab paths independent', () => {
    const second = { ...address, pagePath: [{ controlId: 'pages', itemId: 'credentials' }] }
    const states = new Map([
      [formAddressKey(address), createFormState(address, form([input('first')]))],
      [formAddressKey(second), createFormState(second, form([input('second')]))],
    ])
    states.set(formAddressKey(address), reduceForm(states.get(formAddressKey(address))!, { kind: 'edit', fieldId: 'name', value: 'edited' }))
    expect(submitForm(states.get(formAddressKey(address))!).fields[0]!.value).toBe('edited')
    expect(submitForm(states.get(formAddressKey(second))!).fields[0]!.value).toBe('second')
    expect(formAddressKey({ pagePath: [{ controlId: 'a:b', itemId: 'c' }], formId: 'd' })).not.toBe(formAddressKey({ pagePath: [{ controlId: 'a', itemId: 'b:c' }], formId: 'd' }))
  })

  it('locks a submitted form, rejects stale settlement, and retains values after failed validation', () => {
    let state = createFormState(address, form([input('A')]))
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'B' })
    const submitted = submitForm(state)
    state = reduceForm(state, { kind: 'submit', operationId: 'save' })
    expect(reduceForm(state, { kind: 'submit', operationId: 'duplicate' })).toBe(state)
    expect(reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'C' })).toBe(state)
    expect(reduceForm(state, { kind: 'release', operationId: 'other' })).toBe(state)
    expect(reduceForm(state, { kind: 'ack', operationId: 'save', draftRevision: 999, definition: form([input('C')]) })).toBe(state)
    expect(() => reduceForm(state, { kind: 'invalid', operationId: 'save', errors: [{ ...address, fieldId: 'missing', message: 'Invalid' }] })).toThrow('unknown field')
    state = reduceForm(state, { kind: 'invalid', operationId: 'save', errors: [{ ...address, fieldId: 'name', message: 'Already used' }] })
    expect(state.pending).toBeUndefined()
    expect(state.fields.name).toMatchObject({ value: 'B', error: 'Already used' })
    expect(reduceForm(state, { kind: 'submit', operationId: 'retry' })).toBe(state)
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'C' })
    state = reduceForm(state, { kind: 'submit', operationId: 'retry' })
    state = reduceForm(state, { kind: 'release', operationId: 'retry' })
    expect(state.fields.name!.value).toBe('C')
    state = reduceForm(state, { kind: 'submit', operationId: 'retry-2' })
    const revision = state.pending!.draftRevision
    state = reduceForm(state, { kind: 'ack', operationId: 'retry-2', draftRevision: revision, definition: form([input('C normalized')]) })
    expect(state.fields.name!.value).toBe('C normalized')
    expect(formDirty(state)).toBe(false)
    expect(submitted.fields[0]!.value).toBe('B')
  })

  it('does not restore removed or type-replaced fields through old acknowledgements', () => {
    let state = createFormState(address, form([input('A'), { kind: 'secret', id: 'key', label: 'Key', value: '' }]))
    state = reduceForm(state, { kind: 'edit', fieldId: 'key', value: 'sensitive' })
    state = reduceForm(state, { kind: 'submit', operationId: 'save' })
    const revision = state.pending!.draftRevision
    state = reconcileForm(state, form([{ kind: 'toggle', id: 'name', label: 'Name', value: true }]))
    expect(state.fields.key).toBeUndefined()
    expect(state.fields.name!.value).toBe(true)
    expect(reduceForm(state, { kind: 'ack', operationId: 'save', draftRevision: revision, definition: form([input('old')]) })).toBe(state)
  })

  it('invalidates delayed field validation after editing but preserves it through translation', () => {
    let state = createFormState(address, form([input('A')]))
    state = reduceForm(state, { kind: 'validated', fieldId: 'name', revision: 0, error: 'Invalid' })
    state = reconcileForm(state, form([input('A', 'New label')]))
    expect(state.fields.name!.error).toBe('Invalid')
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'B' })
    expect(reduceForm(state, { kind: 'validated', fieldId: 'name', revision: 0, error: 'Old failure' })).toBe(state)
    state = reduceForm(state, { kind: 'validated', fieldId: 'name', revision: 1, error: 'Current failure' })
    expect(validateForm(state)[0]!.message).toBe('Current failure')
    state = reduceForm(state, { kind: 'validated', fieldId: 'name', revision: 1 })
    expect(validateForm(state)).toEqual([])
  })

  it('separates inherited values, explicit overrides, and reset intent', () => {
    const definition = form([{ ...input('A'), origin: 'inherited', resetValue: 'A' }])
    let state = createFormState(address, definition)
    expect(reduceForm(state, { kind: 'reset', fieldId: 'name' })).toBe(state)
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'A' })
    expect(state.fields.name!.change).toBe('set')
    state = reconcileForm(state, form([{ ...input('A'), origin: 'explicit', resetValue: 'A' }]))
    expect(state.fields.name!.conflict).toBe(true)
    state = reduceForm(state, { kind: 'resolve-conflict', fieldId: 'name', choice: 'latest' })
    state = reduceForm(state, { kind: 'reset', fieldId: 'name' })
    expect(submitForm(state).fields[0]).toEqual({ id: 'name', change: 'reset', value: 'A' })
  })

  it('keeps secret input out of diagnostics and unchanged submission values', () => {
    let state = createFormState(address, form([{ kind: 'secret', id: 'key', label: 'Key', value: '' }]))
    expect(submitForm(state).fields).toEqual([{ id: 'key', change: 'unchanged' }])
    state = reduceForm(state, { kind: 'edit', fieldId: 'key', value: '  sensitive  ' })
    expect(submitForm(state).fields[0]!.value).toBe('  sensitive  ')
    expect(JSON.stringify(inspectForm(state))).not.toContain('sensitive')
    state = reduceForm(state, { kind: 'edit', fieldId: 'key', value: '' })
    expect(submitForm(state).fields).toEqual([{ id: 'key', change: 'unchanged' }])
  })

  it('holds numeric intermediate text and validates only complete submitted values', () => {
    let state = createFormState(address, form([{ kind: 'number', id: 'count', label: 'Count', value: null, min: 0, max: 10, step: 0.5 }]))
    expect(submitForm(state).fields[0]!.value).toBeNull()
    for (const [value, message] of [['-', 'finite'], ['-1', 'Minimum'], ['11', 'Maximum'], ['1.3', 'Step']] as const) {
      state = reduceForm(state, { kind: 'edit', fieldId: 'count', value })
      expect(state.fields.count!.value).toBe(value)
      expect(validateForm(state)[0]!.message).toContain(message)
    }
    state = reduceForm(state, { kind: 'edit', fieldId: 'count', value: '1.5' })
    expect(submitForm(state).fields[0]!.value).toBe(1.5)
  })

  it('submits the actual selected set and validates cardinality and unavailable options', () => {
    const options = [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }]
    let state = createFormState(address, form([{ kind: 'multiselect', id: 'choices', label: 'Choices', options, value: [], maxSelected: 1 }]))
    expect(submitForm(state).fields[0]!.value).toEqual([])
    state = reduceForm(state, { kind: 'edit', fieldId: 'choices', value: ['one', 'two'] })
    expect(validateForm(state)[0]!.message).toContain('at most')
    state = reduceForm(state, { kind: 'edit', fieldId: 'choices', value: ['one'] })
    const revision = state.fields.choices!.revision
    state = reconcileForm(state, form([{ kind: 'multiselect', id: 'choices', label: 'Translated', options: options.toReversed(), value: [], maxSelected: 1 }]))
    expect(state.fields.choices!.revision).toBe(revision)
    state = reconcileForm(state, form([{ kind: 'multiselect', id: 'choices', label: 'Choices', options: [{ id: 'one', label: 'One', disabled: true }], value: [], maxSelected: 1 }]))
    expect(validateForm(state)[0]!.message).toContain('unavailable')
    state = reduceForm(state, { kind: 'edit', fieldId: 'choices', value: [] })
    state = reconcileForm(state, form([{ kind: 'multiselect', id: 'choices', label: 'Choices', options, value: [], minSelected: 1 }]))
    expect(validateForm(state)[0]!.message).toContain('at least')
  })

  it('enforces field constraints without trimming text or changing disabled fields', () => {
    let state = createFormState(address, form([
      { ...input(''), required: true, minLength: 2, maxLength: 4 },
      { kind: 'select', id: 'protocol', label: 'Protocol', options: [{ id: 'http', label: 'HTTP' }], value: null },
      { kind: 'toggle', id: 'fixed', label: 'Fixed', value: false, disabled: true, required: true },
    ]))
    expect(validateForm(state)[0]!.message).toContain('required')
    expect(reduceForm(state, { kind: 'edit', fieldId: 'fixed', value: true })).toBe(state)
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'a' })
    expect(validateForm(state)[0]!.message).toContain('Minimum length')
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'abcde' })
    expect(validateForm(state)[0]!.message).toContain('Maximum length')
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: ' a ' })
    expect(submitForm(state).fields[0]!.value).toBe(' a ')
    state = reduceForm(state, { kind: 'edit', fieldId: 'protocol', value: 'http' })
    expect(validateForm(state)).toEqual([])
    expect(reduceForm(state, { kind: 'edit', fieldId: 'protocol', value: 'http' })).toBe(state)
    expect(() => reduceForm(state, { kind: 'edit', fieldId: 'name', value: false })).toThrow('field kind')
    expect(reduceForm(state, { kind: 'reset', fieldId: 'name' })).toBe(state)
    expect(reduceForm(state, { kind: 'resolve-conflict', fieldId: 'name', choice: 'latest' })).toBe(state)
    expect(reduceForm(state, { kind: 'edit', fieldId: 'constructor', value: 'bad' })).toBe(state)
  })

  it('admits independent immutable definitions and rejects conflicting addresses', () => {
    const definition = form([input('A')])
    const state = createFormState(address, definition)
    expect(state.definition).not.toBe(definition)
    expect(Object.isFrozen(state.fields.name)).toBe(true)
    expect(reconcileForm(state, state.definition)).toBe(state)
    expect(() => createFormState({ ...address, formId: 'other' }, definition)).toThrow('address')
    expect(() => reconcileForm(state, { ...definition, id: 'other' })).toThrow('address')
    expect(() => createFormState(address, form([input('A'), input('B')]))).toThrow('duplicate')
  })

  it('validates reset and live constraints for all editable value kinds', () => {
    let state = createFormState(address, form([
      { kind: 'toggle', id: 'flag', label: 'Flag', value: false },
      { kind: 'number', id: 'count', label: 'Count', value: 2, resetValue: 1, step: 0.5 },
      { kind: 'multiselect', id: 'set', label: 'Set', value: ['a', 'b'], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], required: true },
      { kind: 'select', id: 'one', label: 'One', value: null, options: [], required: true },
    ]))
    state = reduceForm(state, { kind: 'edit', fieldId: 'flag', value: true })
    state = reduceForm(state, { kind: 'reset', fieldId: 'count' })
    expect(state.fields.count!.value).toBe('1')
    expect(validateForm(state)[0]).toMatchObject({ fieldId: 'one', message: 'A value is required' })
    state = reduceForm(state, { kind: 'edit', fieldId: 'set', value: ['b', 'a'] })
    expect(state.fields.set!.change).toBe('unchanged')
    state = reduceForm(state, { kind: 'edit', fieldId: 'set', value: ['a', 'other'] })
    expect(validateForm(state)[0]!.message).toContain('unavailable')
    state = reduceForm(state, { kind: 'edit', fieldId: 'set', value: [] })
    expect(validateForm(state)[0]).toMatchObject({ fieldId: 'set', message: 'A value is required' })
    expect(() => reduceForm(state, { kind: 'edit', fieldId: 'set', value: ['a', 'a'] })).toThrow('field kind')
    expect(() => reduceForm(state, { kind: 'edit', fieldId: 'set', value: false })).toThrow('field kind')
    state = reconcileForm(state, form([
      { kind: 'toggle', id: 'flag', label: 'Flag', value: false },
      { kind: 'number', id: 'count', label: 'Count', value: 2, resetValue: 1 },
      { kind: 'input', id: 'new', label: 'New', value: '', error: 'Required' },
    ]))
    expect(state.fields.new!.error).toBe('Required')
    expect(inspectForm(state).fields.find(field => field.id === 'count')).toMatchObject({ value: '1' })
    state = reduceForm(state, { kind: 'edit', fieldId: 'new', value: 'ready' })
    state = reduceForm(state, { kind: 'validated', fieldId: 'new', revision: 1, error: 'Unavailable' })
    state = reconcileForm(state, { ...state.definition, cancelActionId: 'back' })
    expect(state.fields.new!.error).toBe('Unavailable')
  })

  it('owns picker opening, cancellation, and single or multiple settlement', () => {
    let single = createFormState(address, form([{ kind: 'select', id: 'choice', label: 'Choice', value: null, options: [{ id: 'one', label: 'One' }] }]))
    expect(reduceForm(single, { kind: 'picker', fieldId: 'choice', intent: { kind: 'focus', id: 'one' } })).toBe(single)
    expect(reduceForm(single, { kind: 'finish-picker', fieldId: 'choice', cancel: false })).toBe(single)
    single = reduceForm(single, { kind: 'begin-picker', fieldId: 'choice' })
    expect(reduceForm(single, { kind: 'begin-picker', fieldId: 'choice' })).toBe(single)
    single = reduceForm(single, { kind: 'finish-picker', fieldId: 'choice', cancel: true })
    expect(single.fields.choice!.picker).toBeUndefined()
    single = reduceForm(single, { kind: 'begin-picker', fieldId: 'choice' })
    single = reduceForm(single, { kind: 'finish-picker', fieldId: 'choice', cancel: false })
    expect(single.fields.choice!.value).toBeNull()

    let multiple = createFormState(address, form([{ kind: 'multiselect', id: 'choices', label: 'Choices', value: [], options: [{ id: 'one', label: 'One' }] }]))
    multiple = reduceForm(multiple, { kind: 'begin-picker', fieldId: 'choices' })
    multiple = reduceForm(multiple, { kind: 'picker', fieldId: 'choices', intent: { kind: 'toggle', id: 'one' } })
    multiple = reduceForm(multiple, { kind: 'finish-picker', fieldId: 'choices', cancel: false })
    expect(multiple.fields.choices!.value).toEqual(['one'])

    let constrained = createFormState(address, form([
      { kind: 'select', id: 'required-one', label: 'Required one', value: null, required: true, options: [{ id: 'one', label: 'One' }] },
      { kind: 'multiselect', id: 'required-many', label: 'Required many', value: [], required: true, maxSelected: 2, options: [{ id: 'one', label: 'One' }] },
    ]))
    constrained = reduceForm(constrained, { kind: 'begin-picker', fieldId: 'required-one' })
    constrained = reduceForm(constrained, { kind: 'begin-picker', fieldId: 'required-many' })
    expect(constrained.fields['required-one']!.picker!.definition.minSelected).toBe(1)
    expect(constrained.fields['required-many']!.picker!.definition).toMatchObject({ minSelected: 1, maxSelected: 2 })

    let reconciled = createFormState(address, form([{ kind: 'select', id: 'choice', label: 'Choice', value: 'one', options: [{ id: 'one', label: 'One' }] }]))
    reconciled = reduceForm(reconciled, { kind: 'begin-picker', fieldId: 'choice' })
    reconciled = reconcileForm(reconciled, form([{ kind: 'select', id: 'choice', label: 'Translated', value: 'one', options: [{ id: 'one', label: 'Uno' }] }]))
    expect(reconciled.fields.choice!.picker).toBeDefined()
    reconciled = reduceForm(reconciled, { kind: 'picker', fieldId: 'choice', intent: { kind: 'select', ids: [] } })
    reconciled = reconcileForm(reconciled, form([{ kind: 'select', id: 'choice', label: 'Changed', value: 'one', options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }]))
    expect(reconciled.fields.choice!.picker).toBeDefined()
  })

  it('validates steps relative to zero when no minimum is declared', () => {
    let state = createFormState(address, form([{ kind: 'number', id: 'count', label: 'Count', value: 0, step: 2 }]))
    state = reduceForm(state, { kind: 'edit', fieldId: 'count', value: '3' })
    expect(validateForm(state)[0]!.message).toBe('Step: 2')
    expect(validateForm(createFormState(address, form([{ kind: 'number', id: 'plain', label: 'Plain', value: 2 }])))).toEqual([])
  })

  it('rejects partial acknowledgements for fields outside the returned definition', () => {
    let state = createFormState(address, form([input('A')]))
    state = reduceForm(state, { kind: 'edit', fieldId: 'name', value: 'B' })
    state = reduceForm(state, { kind: 'submit', operationId: 'save' })
    expect(() => reduceForm(state, { kind: 'ack-fields', operationId: 'save', draftRevision: state.pending!.draftRevision, fieldIds: ['missing'], definition: form([input('B')]) })).toThrow('unknown field')
  })
})
