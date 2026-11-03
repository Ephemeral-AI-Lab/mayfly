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
