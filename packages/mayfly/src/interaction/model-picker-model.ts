/** Native model catalog facts consumed by the shared UI selection controls.
 * @module @ephemeral-ai/mayfly/interaction/model-picker-model
 */
export interface ModelPickerItem {
  readonly provider: string
  readonly providerLabel: string
  readonly id: string
  readonly name: string
  readonly contextWindow?: number | undefined
  readonly efforts?: readonly string[] | undefined
  readonly defaultEffort?: string | undefined
}

export function formatContextWindow(tokens: number): string {
  if (tokens < 1024) return `${tokens}`
  const units = ['k', 'm', 'g']
  let value = tokens
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const text = Number.isInteger(value) || value >= 10 ? `${Math.round(value)}` : value.toFixed(1)
  return `${text}${units[unit]}`
}
