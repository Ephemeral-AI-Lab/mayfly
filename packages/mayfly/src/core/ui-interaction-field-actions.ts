/** Shared field conflict decisions and the reset available to a focused field.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-field-actions
 */
import type { UiFormIntent, UiFormState } from './ui-interaction-form.ts'

export interface UiFieldAction { readonly id: string, readonly label: string, readonly intent: UiFormIntent }

/** Inline choices a field needs before it can be saved: only an authoritative-value conflict asks. */
export function fieldActions(form: UiFormState | undefined, fieldId: string): readonly UiFieldAction[] {
  const field = form?.fields[fieldId]
  if (field?.conflict !== true || field.definition.disabled || form?.pending !== undefined) return []
  return [
    { id: 'source', label: 'Use current value', intent: { kind: 'resolve-conflict', fieldId, choice: 'latest' } },
    { id: 'draft', label: 'Keep my changes', intent: { kind: 'resolve-conflict', fieldId, choice: 'draft' } },
  ]
}

/**
 * What resetting the field would do, if anything: `inherit` drops an override
 * back to the inherited value, `reset` restores the declared default. Editing
 * an inherited value creates the override, so there is no inverse operation.
 */
export function fieldReset(form: UiFormState | undefined, fieldId: string): 'inherit' | 'reset' | undefined {
  const field = form?.fields[fieldId]
  if (field === undefined || field.definition.disabled || form?.pending !== undefined || field.conflict) return undefined
  if (field.definition.resetValue === undefined || field.change === 'reset') return undefined
  if (field.change === 'unchanged' && field.baselineOrigin === 'inherited') return undefined
  return field.definition.origin === undefined ? 'reset' : 'inherit'
}
