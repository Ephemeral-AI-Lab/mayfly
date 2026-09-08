/** Readonly interaction, submission, and action settlement contracts.
 * @module @ephemeral-ai/mayfly-ui/interaction
 */
import type { MayflyUiNode } from './contracts.ts'

export interface MayflyPageSegment { readonly controlId: string, readonly itemId: string }
export type MayflyPagePath = readonly MayflyPageSegment[]
export interface MayflyFormAddress { readonly pagePath: MayflyPagePath, readonly formId: string }
export interface MayflyFieldAddress extends MayflyFormAddress { readonly fieldId: string }
export interface MayflySelectionAddress { readonly pagePath: MayflyPagePath, readonly controlId: string }
export interface MayflySourceStamp { readonly resourceId: string, readonly revision: string | number }
export type MayflyUiScope =
  | { readonly kind: 'app', readonly targetId: string }
  | { readonly kind: 'session', readonly sessionId: string }
  | { readonly kind: 'panel', readonly parent: { readonly kind: 'pane' | 'overlay' | 'editor-panel', readonly id: string } }

export type MayflyFieldValue = string | number | boolean | null | readonly string[]
export interface MayflySubmittedField {
  readonly id: string
  readonly change: 'unchanged' | 'set' | 'reset'
  readonly value?: MayflyFieldValue
}
export interface MayflySubmittedForm extends MayflyFormAddress {
  readonly draftRevision: number
  readonly fields: readonly MayflySubmittedField[]
}
export interface MayflySubmission {
  readonly actionId: string
  readonly draftRevision: number
  readonly forms: readonly MayflySubmittedForm[]
  readonly source: readonly MayflySourceStamp[]
  readonly selections?: readonly (MayflySelectionAddress & { readonly selectedIds: readonly string[] })[]
}
export interface MayflyFieldError extends MayflyFieldAddress { readonly message: string }
export interface MayflyFeedback {
  readonly message: string
  readonly severity: 'info' | 'success' | 'warning' | 'error'
  readonly purpose?: 'feedback' | 'progress'
  readonly detail?: string
}
export interface MayflyFeedbackRecord extends MayflyFeedback {
  readonly id: string
  readonly owner: string
  readonly scope: MayflyUiScope
  readonly operationId?: string
  readonly state: 'active' | 'handled'
  readonly createdAt: number
  readonly visibleMs: number
}
export type MayflyUiActionReply<Node = MayflyUiNode> = (
  | { readonly kind: 'accepted', readonly node: Node, readonly source: readonly MayflySourceStamp[] }
  | { readonly kind: 'invalid', readonly errors: readonly MayflyFieldError[] }
  | { readonly kind: 'conflict', readonly node: Node, readonly source: readonly MayflySourceStamp[], readonly message: string }
  | { readonly kind: 'failed', readonly message: string, readonly node?: Node, readonly source?: readonly MayflySourceStamp[], readonly acceptedFields?: readonly MayflyFieldAddress[] }
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
) & { readonly feedback?: MayflyFeedback, readonly dismiss?: boolean, readonly navigate?: MayflyPagePath }

export interface MayflySnapshotUpdate {
  readonly reason?: 'data' | 'replace'
  readonly source?: readonly MayflySourceStamp[]
  readonly scope?: MayflyUiScope
}
export type MayflySnapshotChange =
  | MayflySnapshotUpdate
  | { readonly reason: 'ack', readonly operationId: string, readonly draftRevision: number, readonly source: readonly MayflySourceStamp[], readonly acceptedFields?: readonly MayflyFieldAddress[] }

export type MayflyUiObservationEvent = (
  | { readonly kind: 'value-change', readonly controlId: string, readonly formId: string, readonly value: MayflyFieldValue, readonly draftRevision: number }
  | { readonly kind: 'selection-toggle', readonly controlId: string, readonly selectedIds: readonly string[], readonly actionId?: string }
  | { readonly kind: 'tab-change', readonly controlId: string, readonly tabId: string }
) & { readonly pagePath: MayflyPagePath }
export type MayflyUiActionEvent = (
  | { readonly kind: 'activate', readonly controlId: string, readonly actionId: string, readonly itemId?: string, readonly inputs?: MayflySubmission }
  | { readonly kind: 'selection-accept', readonly controlId: string, readonly selectedIds: readonly string[], readonly actionId?: string }
  | { readonly kind: 'submit', readonly controlId: string, readonly submission: MayflySubmission }
  | { readonly kind: 'dismiss' }
) & { readonly pagePath: MayflyPagePath }
export type MayflyUiEvent = MayflyUiObservationEvent | MayflyUiActionEvent

export interface MayflyUiEventContext {
  readonly surfaceId: string
  readonly source: readonly MayflySourceStamp[]
  readonly signal: AbortSignal
  readonly revision: number
  readonly operationId: string
  readonly report: (feedback: MayflyFeedback) => void
}
export type MayflyUiObservationReply = (
  | { readonly kind: 'invalid', readonly errors: readonly MayflyFieldError[] }
  | { readonly kind: 'failed', readonly message: string }
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
) & {
  readonly feedback?: MayflyFeedback
  readonly node?: never
  readonly source?: never
  readonly acceptedFields?: never
  readonly dismiss?: never
  readonly navigate?: never
}
export type MayflyUiObservationHandler = (event: MayflyUiObservationEvent, context: MayflyUiEventContext) =>
  void | MayflyUiObservationReply | Promise<void | MayflyUiObservationReply>
export type MayflyUiActionHandler<Node = MayflyUiNode> = (event: MayflyUiActionEvent, context: MayflyUiEventContext) =>
  MayflyUiActionReply<Node> | Promise<MayflyUiActionReply<Node>>
export interface MayflyUiEventHandlers<Node = MayflyUiNode> {
  readonly observe?: MayflyUiObservationHandler
  readonly action?: MayflyUiActionHandler<Node>
}

/** Prepared publication remains bound to the registration that handled the event. */
export interface MayflyPreparedUiReply<Node = MayflyUiNode> {
  readonly reply: MayflyUiActionReply<Node> | undefined
  publish(): boolean
}
export interface MayflyUiEventEndpoint<Node = MayflyUiNode> {
  prepare(event: MayflyUiEvent, context: MayflyUiEventContext): Promise<MayflyPreparedUiReply<Node>>
}
