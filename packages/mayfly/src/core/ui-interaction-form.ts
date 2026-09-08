/** Shared immutable form drafts, validation, conflict reconciliation, and submissions.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-form
 */
import { freezeWire } from '@ephemeral-ai/mayfly-ui'
import type { MayflyFieldError, MayflyFieldValue, MayflyFormAddress, MayflyFormField, MayflyFormNode, MayflySubmittedField, MayflySubmittedForm } from '@ephemeral-ai/mayfly-ui'
import { createChoiceState, reconcileChoice, reduceChoice, type UiChoiceIntent, type UiChoiceState } from './ui-interaction-choice.ts'

export interface UiFieldState {
  readonly definition: MayflyFormField
  readonly baseline: MayflyFieldValue
  readonly baselineOrigin: 'inherited' | 'explicit'
  readonly value: MayflyFieldValue
  readonly change: MayflySubmittedField['change']
  readonly revision: number
  readonly conflict: boolean
  readonly error?: string
  readonly picker?: UiChoiceState
}

export interface UiFormState {
  readonly address: MayflyFormAddress
  readonly definition: MayflyFormNode
  readonly fields: Readonly<Record<string, UiFieldState>>
  readonly draftRevision: number
  readonly schemaRevision: number
  readonly pending?: { readonly operationId: string, readonly draftRevision: number, readonly schemaRevision: number }
}

export type UiFormIntent =
  | { readonly kind: 'begin-picker', readonly fieldId: string }
  | { readonly kind: 'picker', readonly fieldId: string, readonly intent: UiChoiceIntent }
  | { readonly kind: 'finish-picker', readonly fieldId: string, readonly cancel: boolean }
  | { readonly kind: 'edit', readonly fieldId: string, readonly value: MayflyFieldValue }
  | { readonly kind: 'reset', readonly fieldId: string }
  | { readonly kind: 'resolve-conflict', readonly fieldId: string, readonly choice: 'latest' | 'draft' }
  | { readonly kind: 'validated', readonly fieldId: string, readonly revision: number, readonly error?: string }
  | { readonly kind: 'submit', readonly operationId: string }
  | { readonly kind: 'release', readonly operationId: string }
  | { readonly kind: 'invalid', readonly operationId: string, readonly errors: readonly MayflyFieldError[] }
  | { readonly kind: 'ack', readonly operationId: string, readonly draftRevision: number, readonly definition: MayflyFormNode }
  | { readonly kind: 'ack-fields', readonly operationId: string, readonly draftRevision: number, readonly definition: MayflyFormNode, readonly fieldIds: readonly string[] }

export function formAddressKey(address: MayflyFormAddress): string {
  return JSON.stringify([address.pagePath.map(segment => [segment.controlId, segment.itemId]), address.formId])
}

export function equalFieldValue(left: MayflyFieldValue, right: MayflyFieldValue): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return left === right
  return left.length === right.length && left.every(id => right.includes(id))
}

function draftValue(field: MayflyFormField, value: MayflyFieldValue): MayflyFieldValue {
  return field.kind === 'number' ? value === null ? '' : String(value) : value
}

function fieldState(definition: MayflyFormField): UiFieldState {
  return {
    definition,
    baseline: definition.value,
    baselineOrigin: definition.origin ?? 'explicit',
    value: draftValue(definition, definition.value),
    change: 'unchanged', revision: 0, conflict: false,
    ...(definition.error === undefined ? {} : { error: definition.error }),
  }
}

function fieldChoice(definition: Extract<MayflyFormField, { readonly kind: 'select' | 'multiselect' }>, value: MayflyFieldValue) {
  return {
    kind: 'list' as const, role: 'choose' as const, id: definition.id,
    mode: definition.kind === 'multiselect' ? 'multiple' as const : 'single' as const,
    selectedIds: Array.isArray(value) ? value : typeof value === 'string' ? [value] : [],
    items: definition.options,
    minSelected: definition.kind === 'multiselect' ? definition.minSelected ?? (definition.required === true ? 1 : 0) : definition.required === true ? 1 : 0,
    ...(definition.kind === 'multiselect' && definition.maxSelected !== undefined ? { maxSelected: definition.maxSelected } : {}),
  }
}

export function createFormState(address: MayflyFormAddress, definition: MayflyFormNode): UiFormState {
  if (address.formId !== definition.id) throw new TypeError('form address does not match its definition')
  const fields: Record<string, UiFieldState> = {}
  for (const field of definition.fields) {
    if (Object.hasOwn(fields, field.id)) throw new TypeError(`duplicate form field: ${field.id}`)
    Object.defineProperty(fields, field.id, { value: fieldState(field), enumerable: true, writable: true, configurable: true })
  }
  return freezeWire({ address, definition, fields, draftRevision: 0, schemaRevision: 0 })
}

function fieldSchema(field: MayflyFormField): string {
  const constraints = field.kind === 'number' ? [field.min, field.max, field.step]
    : field.kind === 'multiselect' ? [field.minSelected, field.maxSelected]
      : field.kind === 'select' || field.kind === 'toggle' ? [] : [field.minLength, field.maxLength]
  const options = 'options' in field
    ? field.options.map(option => [option.id, option.disabled === true] as const).toSorted((a, b) => a[0].localeCompare(b[0])) : []
  return JSON.stringify([field.kind, field.required === true, field.disabled === true, field.resetValue !== undefined, field.resetValue, constraints, options])
}

export function reconcileForm(state: UiFormState, definition: MayflyFormNode): UiFormState {
  if (definition === state.definition) return state
  if (definition.id !== state.address.formId) throw new TypeError('form replacement requires the same address')
  const admitted = createFormState(state.address, definition)
  let draftChanged = false
  let schemaChanged = state.definition.submitActionId !== definition.submitActionId || state.definition.cancelActionId !== definition.cancelActionId
    || state.definition.fields.length !== definition.fields.length
  const fields = Object.fromEntries(definition.fields.map(field => {
    const previous = state.fields[field.id]
    if (previous === undefined || previous.definition.kind !== field.kind) {
      schemaChanged = true
      draftChanged = true
      return [field.id, admitted.fields[field.id]!]
    }
    const changedSchema = fieldSchema(previous.definition) !== fieldSchema(field)
    schemaChanged ||= changedSchema
    const sourceChanged = !equalFieldValue(previous.baseline, field.value) || previous.baselineOrigin !== (field.origin ?? 'explicit')
    if (previous.change === 'unchanged' && previous.picker?.dirty !== true) {
      draftChanged ||= sourceChanged || changedSchema
      return [field.id, {
        ...admitted.fields[field.id]!, revision: previous.revision + Number(sourceChanged || changedSchema),
        ...(!sourceChanged && !changedSchema && previous.error !== undefined ? { error: previous.error } : {}),
        ...(previous.picker === undefined ? {} : { picker: reconcileChoice(previous.picker, fieldChoice(field as Extract<MayflyFormField, { readonly kind: 'select' | 'multiselect' }>, field.value)) }),
      }]
    }
    const { error: previousError, ...withoutError } = previous
    return [field.id, {
      ...withoutError, definition: field, conflict: sourceChanged,
      revision: previous.revision + Number(changedSchema),
      ...(!changedSchema && previousError !== undefined ? { error: previousError } : {}),
      ...(previous.picker === undefined ? {} : { picker: reconcileChoice(previous.picker, fieldChoice(field as Extract<MayflyFormField, { readonly kind: 'select' | 'multiselect' }>, previous.value)) }),
    }]
  }))
  return freezeWire({
    ...state, definition, fields,
    draftRevision: state.draftRevision + Number(draftChanged || schemaChanged),
    schemaRevision: state.schemaRevision + Number(schemaChanged),
  })
}

export function formDirty(state: UiFormState): boolean {
  return Object.values(state.fields).some(field => field.change !== 'unchanged')
}

function fieldChange(field: UiFieldState, value: MayflyFieldValue, reset: boolean): MayflySubmittedField['change'] {
  if (reset) return field.baselineOrigin === 'inherited' && equalFieldValue(value, draftValue(field.definition, field.baseline)) ? 'unchanged' : 'reset'
  if (field.definition.kind === 'secret' && value === '') return 'unchanged'
  return field.baselineOrigin === 'explicit' && equalFieldValue(value, draftValue(field.definition, field.baseline)) ? 'unchanged' : 'set'
}

function validDraft(field: MayflyFormField, value: MayflyFieldValue): boolean {
  switch (field.kind) {
    case 'toggle': return typeof value === 'boolean'
    case 'select': return value === null || typeof value === 'string'
    case 'multiselect': return Array.isArray(value) && value.every(id => typeof id === 'string') && new Set(value).size === value.length
    default: return typeof value === 'string'
  }
}

function changeField(state: UiFormState, id: string, next: UiFieldState): UiFormState {
  return freezeWire({ ...state, fields: { ...state.fields, [id]: next }, draftRevision: state.draftRevision + 1 })
}

function release(state: UiFormState): UiFormState {
  const { pending: _pending, ...next } = state
  return next
}

export function reduceForm(state: UiFormState, intent: UiFormIntent): UiFormState {
  if (intent.kind === 'submit') {
    if (state.pending !== undefined || validateForm(state).length > 0) return state
    return freezeWire({ ...state, pending: { operationId: intent.operationId, draftRevision: state.draftRevision, schemaRevision: state.schemaRevision } })
  }
  if (intent.kind === 'release' || intent.kind === 'ack' || intent.kind === 'ack-fields' || intent.kind === 'invalid') {
    if (state.pending?.operationId !== intent.operationId) return state
    if (intent.kind === 'ack' || intent.kind === 'ack-fields') {
      if (state.pending.draftRevision !== intent.draftRevision || state.pending.schemaRevision !== state.schemaRevision) return state
      const acknowledged = createFormState(state.address, intent.definition)
      if (intent.kind === 'ack-fields') {
        const reconciled = reconcileForm(state, intent.definition)
        const fields = { ...reconciled.fields }
        for (const id of intent.fieldIds) {
          if (!Object.hasOwn(acknowledged.fields, id)) throw new TypeError('acknowledgement addresses an unknown field')
          fields[id] = acknowledged.fields[id]!
        }
        return freezeWire({ ...reconciled, fields, draftRevision: reconciled.draftRevision + 1 })
      }
      return freezeWire({ ...acknowledged, draftRevision: state.draftRevision + 1, schemaRevision: state.schemaRevision })
    }
    if (intent.kind === 'release') return freezeWire(release(state))
    const fields = { ...state.fields }
    for (const error of intent.errors) {
      if (formAddressKey(error) !== formAddressKey(state.address) || !Object.hasOwn(fields, error.fieldId)) throw new TypeError('field error addresses an unknown field')
      fields[error.fieldId] = { ...fields[error.fieldId]!, error: error.message }
    }
    return freezeWire({ ...release(state), fields })
  }
  const field = Object.hasOwn(state.fields, intent.fieldId) ? state.fields[intent.fieldId] : undefined
  if (field === undefined) return state
  if (intent.kind === 'validated') {
    if (field.revision !== intent.revision) return state
    const { error: _error, ...clean } = field
    return freezeWire({ ...state, fields: { ...state.fields, [intent.fieldId]: { ...clean, ...(intent.error === undefined ? {} : { error: intent.error }) } } })
  }
  if (state.pending !== undefined || field.definition.disabled === true) return state
  if (intent.kind === 'begin-picker') {
    if (field.picker !== undefined || !('options' in field.definition)) return state
    const picker = createChoiceState(fieldChoice(field.definition, field.value))
    return freezeWire({ ...state, fields: { ...state.fields, [intent.fieldId]: { ...field, picker } } })
  }
  if (intent.kind === 'picker') {
    if (field.picker === undefined) return state
    return freezeWire({ ...state, fields: { ...state.fields, [intent.fieldId]: { ...field, picker: reduceChoice(field.picker, intent.intent) } } })
  }
  if (intent.kind === 'finish-picker') {
    if (field.picker === undefined) return state
    const { picker, ...closed } = field
    if (intent.cancel) return changeField(state, intent.fieldId, closed)
    const value = field.definition.kind === 'multiselect' ? picker.selectedIds : picker.selectedIds[0] ?? null
    const { error: _error, ...clean } = closed
    return changeField(state, intent.fieldId, { ...clean, value, change: fieldChange(field, value, false), revision: field.revision + Number(!equalFieldValue(field.value, value)) })
  }
  if (intent.kind === 'resolve-conflict') {
    if (!field.conflict) return state
    const next = { ...fieldState(field.definition), revision: field.revision + 1 }
    if (intent.choice === 'draft') {
      next.value = field.value
      next.change = fieldChange(next, field.value, field.change === 'reset')
    }
    return changeField(state, intent.fieldId, next)
  }
  if (intent.kind === 'reset' && field.definition.resetValue === undefined) return state
  const value = intent.kind === 'reset' ? draftValue(field.definition, field.definition.resetValue!) : intent.value
  if (!validDraft(field.definition, value)) throw new TypeError('draft value does not match the field kind')
  const change = fieldChange(field, value, intent.kind === 'reset')
  if (equalFieldValue(field.value, value) && field.change === change) return state
  const { error: _error, ...clean } = field
  return changeField(state, intent.fieldId, { ...clean, value, change, revision: field.revision + 1 })
}

function fieldError(field: UiFieldState): string | undefined {
  const definition = field.definition
  if (definition.disabled === true) return undefined
  if (field.conflict) return 'Resolve the changed value before saving'
  const value = field.value
  if (definition.required === true && (value === '' || value === null || (Array.isArray(value) && value.length === 0))) {
    return 'A value is required'
  }
  if (definition.kind === 'number') {
    if (value === '') return undefined
    const number = Number(value)
    if (!Number.isFinite(number)) return 'Enter a finite number'
    if (definition.min !== undefined && number < definition.min) return `Minimum: ${definition.min}`
    if (definition.max !== undefined && number > definition.max) return `Maximum: ${definition.max}`
    if (definition.step !== undefined) {
      const steps = (number - (definition.min ?? 0)) / definition.step
      if (Math.abs(steps - Math.round(steps)) > 1e-9 * Math.max(1, Math.abs(steps))) return `Step: ${definition.step}`
    }
  } else if (definition.kind === 'select' || definition.kind === 'multiselect') {
    const selected = Array.isArray(value) ? value : value === null ? [] : [String(value)]
    if (selected.some(id => !definition.options.some(option => option.id === id && option.disabled !== true))) return 'A selected option is unavailable'
    if (definition.kind === 'multiselect') {
      if (selected.length < (definition.minSelected ?? 0)) return `Select at least ${definition.minSelected} options`
      if (definition.maxSelected !== undefined && selected.length > definition.maxSelected) return `Select at most ${definition.maxSelected} options`
    }
  } else if (definition.kind !== 'toggle') {
    const length = Array.from(String(value)).length
    if (definition.minLength !== undefined && length < definition.minLength) return `Minimum length: ${definition.minLength}`
    if (definition.maxLength !== undefined && length > definition.maxLength) return `Maximum length: ${definition.maxLength}`
  }
  return field.error
}

export function validateForm(state: UiFormState): readonly MayflyFieldError[] {
  return freezeWire(Object.entries(state.fields).flatMap(([fieldId, field]) => {
    const message = fieldError(field)
    return message === undefined ? [] : [{ ...state.address, fieldId, message }]
  }))
}

export function submitForm(state: UiFormState): MayflySubmittedForm {
  if (validateForm(state).length > 0) throw new TypeError('cannot submit an invalid form')
  return freezeWire({
    ...state.address,
    draftRevision: state.draftRevision,
    fields: Object.entries(state.fields).map(([id, field]): MayflySubmittedField => {
      if (field.definition.kind === 'secret' && field.change === 'unchanged') return { id, change: 'unchanged' }
      const value = field.definition.kind === 'number' ? field.value === '' ? null : Number(field.value) : field.value
      return { id, change: field.change, value }
    }),
  })
}

/** Diagnostics exclude sensitive values and expose no editor or effect binding. */
export function inspectForm(state: UiFormState) {
  return freezeWire({
    address: state.address,
    draftRevision: state.draftRevision,
    dirty: formDirty(state),
    pending: state.pending !== undefined,
    fields: Object.entries(state.fields).map(([id, field]) => ({
      id, kind: field.definition.kind, change: field.change, conflict: field.conflict,
      ...(field.definition.kind === 'secret' ? {} : { value: field.value }),
    })),
  })
}
