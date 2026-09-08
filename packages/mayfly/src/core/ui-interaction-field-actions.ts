/** Shared field reset, explicit override, and conflict decisions.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-field-actions
 */
import type { UiFormIntent, UiFormState } from './ui-interaction-form.ts'

export interface UiFieldAction { readonly id: string, readonly label: string, readonly intent: UiFormIntent }

export function fieldActions(form: UiFormState | undefined, fieldId: string): readonly UiFieldAction[] {
  const field = form?.fields[fieldId]
  if (field === undefined || field.definition.disabled || form?.pending !== undefined) return []
  if (field.conflict) return [
    { id: 'source', label: 'Use current value', intent: { kind: 'resolve-conflict', fieldId, choice: 'latest' } },
    { id: 'draft', label: 'Keep my changes', intent: { kind: 'resolve-conflict', fieldId, choice: 'draft' } },
  ]
  if (field.change === 'reset' || field.definition.origin !== undefined && field.change === 'unchanged' && field.baselineOrigin === 'inherited') return [
    { id: 'override', label: 'Set override', intent: { kind: 'edit', fieldId, value: field.value } },
  ]
  return field.definition.resetValue === undefined ? [] : [
    { id: 'reset', label: 'Use inherited value', intent: { kind: 'reset', fieldId } },
  ]
}
