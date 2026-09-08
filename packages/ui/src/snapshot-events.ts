/** Registration-bound preparation and publication of structured UI action replies.
 * @module @ephemeral-ai/mayfly-ui/snapshot-events
 */
import { freezeWire } from './builders.ts'
import type {
  MayflyFeedback,
  MayflyPreparedUiReply,
  MayflySnapshotChange,
  MayflySnapshotUpdate,
  MayflySourceStamp,
  MayflyUiActionReply,
  MayflyUiEvent,
  MayflyUiEventContext,
  MayflyUiEventEndpoint,
  MayflyUiEventHandlers,
  MayflyUiObservationEvent,
  MayflyUiObservationReply,
  MayflyUiScope,
} from './interaction.ts'

const ID = /^[a-z0-9][a-z0-9._/-]*$/u

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
}

export function validateSource(source: unknown): asserts source is readonly MayflySourceStamp[] {
  if (!Array.isArray(source)) throw new TypeError('snapshot source must be an array')
  const seen = new Set<string>()
  for (const stamp of source) {
    record(stamp, 'source stamp')
    if (typeof stamp.resourceId !== 'string' || !ID.test(stamp.resourceId) || seen.has(stamp.resourceId)) throw new TypeError('source resourceId must be unique and valid')
    seen.add(stamp.resourceId)
    if (typeof stamp.revision === 'string' ? stamp.revision.length === 0 : typeof stamp.revision !== 'number' || !Number.isSafeInteger(stamp.revision) || stamp.revision < 0) {
      throw new TypeError('source revision must be a nonempty string or nonnegative safe integer')
    }
  }
}

export function validateScope(scope: unknown): asserts scope is MayflyUiScope {
  record(scope, 'surface scope')
  if (scope.kind === 'app') {
    if (typeof scope.targetId !== 'string' || scope.targetId.length === 0) throw new TypeError('app scope requires a targetId')
  } else if (scope.kind === 'session') {
    if (typeof scope.sessionId !== 'string' || scope.sessionId.length === 0) throw new TypeError('session scope requires a sessionId')
  } else if (scope.kind === 'panel') {
    record(scope.parent, 'panel scope parent')
    if (typeof scope.parent.kind !== 'string' || !['pane', 'overlay', 'editor-panel'].includes(scope.parent.kind) || typeof scope.parent.id !== 'string' || !ID.test(scope.parent.id)) {
      throw new TypeError('panel scope requires a valid parent surface')
    }
  } else throw new TypeError('surface scope kind is invalid')
}

export function admitSnapshotUpdate(update: MayflySnapshotUpdate = {}): MayflySnapshotUpdate {
  const admitted = freezeWire(update)
  record(admitted, 'snapshot update')
  if (Object.keys(admitted).some(key => !['reason', 'source', 'scope'].includes(key))) throw new TypeError('snapshot update contains an unknown field')
  if (admitted.reason !== undefined && admitted.reason !== 'data' && admitted.reason !== 'replace') throw new TypeError('snapshot update reason must be data or replace')
  if (admitted.source !== undefined) validateSource(admitted.source)
  if (admitted.scope !== undefined) {
    validateScope(admitted.scope)
    if (admitted.reason !== 'replace') throw new TypeError('changing surface scope requires replace')
  }
  return admitted
}

export function validateFeedback(feedback: MayflyFeedback): void {
  record(feedback, 'action feedback')
  if (typeof feedback.message !== 'string' || feedback.message.length === 0) throw new TypeError('feedback requires a message')
  if (!['info', 'success', 'warning', 'error'].includes(feedback.severity)) throw new TypeError('feedback severity is invalid')
  if (feedback.purpose !== undefined && feedback.purpose !== 'feedback' && feedback.purpose !== 'progress') throw new TypeError('feedback purpose is invalid')
  if (feedback.detail !== undefined && typeof feedback.detail !== 'string') throw new TypeError('feedback detail must be a string')
}

function isObservation(event: MayflyUiEvent): event is MayflyUiObservationEvent {
  return event.kind === 'value-change' || event.kind === 'selection-toggle' || event.kind === 'tab-change'
}

function admitReply<Node>(
  reply: void | MayflyUiActionReply<Node> | MayflyUiObservationReply,
  event: MayflyUiEvent,
  handled: boolean,
): MayflyUiActionReply<Node> | MayflyUiObservationReply | undefined {
  if (reply === undefined) {
    if (!isObservation(event) && (handled || event.kind === 'submit')) throw new TypeError('UI actions require a structured reply')
    return undefined
  }
  const admitted = freezeWire(reply)
  record(admitted, 'action reply')
  if (isObservation(event) && (!['invalid', 'failed', 'completed', 'cancelled'].includes(admitted.kind as string) || 'node' in admitted || 'source' in admitted || 'dismiss' in admitted || 'navigate' in admitted)) {
    throw new TypeError('UI observations cannot publish snapshots, navigate, or dismiss')
  }
  const action = admitted as MayflyUiActionReply<Node>
  if (action.dismiss !== undefined && typeof action.dismiss !== 'boolean') throw new TypeError('action dismissal must be a boolean')
  if (action.dismiss === true && !['accepted', 'completed', 'cancelled'].includes(action.kind)) throw new TypeError('unsuccessful actions cannot dismiss their feedback')
  if (action.navigate !== undefined && (!Array.isArray(action.navigate) || action.navigate.some(segment => segment === null || typeof segment !== 'object' || typeof segment.controlId !== 'string' || typeof segment.itemId !== 'string'))) throw new TypeError('action navigation requires a page path')
  if (admitted.feedback !== undefined) validateFeedback(admitted.feedback)
  switch (action.kind) {
    case 'accepted':
    case 'conflict':
      if (!('node' in action) || action.node === undefined) throw new TypeError('action reply requires a snapshot')
      validateSource(action.source)
      if (action.kind === 'conflict' && typeof action.message !== 'string') throw new TypeError('conflict reply requires a message')
      break
    case 'invalid':
      if (!Array.isArray(action.errors) || action.errors.length === 0) throw new TypeError('invalid reply requires field errors')
      break
    case 'failed':
      if (typeof action.message !== 'string') throw new TypeError('failed reply requires a message')
      if (action.source !== undefined) validateSource(action.source)
      if (action.acceptedFields !== undefined && (!Array.isArray(action.acceptedFields) || action.node === undefined || action.source === undefined)) throw new TypeError('partial acknowledgement requires fields, source, and a snapshot')
      break
    case 'completed':
    case 'cancelled':
      if (event.kind === 'submit' && action.kind === 'completed') throw new TypeError('form submission must acknowledge its snapshot')
      break
    default: throw new TypeError('action reply kind is invalid')
  }
  return admitted
}

/** A provider endpoint owns registration cancellation, never UI draft or busy state. */
export class UiEventEndpoint<Node> {
  private live = true
  private generation = new AbortController()
  private endpointValue: MayflyUiEventEndpoint<Node>

  constructor(
    private readonly id: string,
    private readonly handlers: MayflyUiEventHandlers<Node> | undefined,
    private readonly publishSnapshot: (node: Node, update: MayflySnapshotChange) => void,
  ) { this.endpointValue = this.bind() }

  get endpoint(): MayflyUiEventEndpoint<Node> { return this.endpointValue }

  private bind(): MayflyUiEventEndpoint<Node> {
    const generation = this.generation
    return Object.freeze({ prepare: (event: MayflyUiEvent, context: MayflyUiEventContext) => this.prepare(event, context, generation) })
  }

  private async prepare(event: MayflyUiEvent, context: MayflyUiEventContext, generation: AbortController): Promise<MayflyPreparedUiReply<Node>> {
    if (context.surfaceId !== this.id) throw new TypeError('event belongs to another surface')
    const signal = AbortSignal.any([generation.signal, context.signal])
    const current = (): boolean => this.live && !signal.aborted && generation === this.generation
    let handling = current()
    let reply: MayflyUiActionReply<Node> | undefined
    if (handling) {
      const observation = isObservation(event)
      const handler = observation ? this.handlers?.observe : this.handlers?.action
      let abort!: () => void
      const cancelled = new Promise<void>(resolve => { abort = resolve; signal.addEventListener('abort', abort, { once: true }) })
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => current() ? handler?.(freezeWire(event) as never, Object.freeze({
            ...context,
            source: freezeWire(context.source),
            signal,
            report: (feedback: MayflyFeedback): void => {
              if (!handling || !current()) return
              const admitted = freezeWire(feedback)
              validateFeedback(admitted)
              context.report(admitted)
            },
          })) : undefined),
          cancelled,
        ])
        if (current()) reply = admitReply(result, event, handler !== undefined) as MayflyUiActionReply<Node> | undefined
      } finally {
        handling = false
        signal.removeEventListener('abort', abort)
      }
    }
    let published = false
    return Object.freeze({
      reply,
      publish: (): boolean => {
        if (published || !current() || reply === undefined) return false
        published = true
        if (reply.kind === 'accepted' || (reply.kind === 'failed' && reply.acceptedFields !== undefined)) {
          this.publishSnapshot(reply.node!, {
            reason: 'ack',
            operationId: context.operationId,
            draftRevision: event.kind === 'submit' ? event.submission.draftRevision : context.revision,
            source: reply.source!,
            ...(reply.kind === 'failed' ? { acceptedFields: reply.acceptedFields! } : {}),
          })
        } else if (reply.kind === 'conflict' || (reply.kind === 'failed' && reply.node !== undefined)) {
          this.publishSnapshot(reply.node!, { reason: 'data', ...(reply.source === undefined ? {} : { source: reply.source }) })
        }
        return true
      },
    })
  }

  replace(): void {
    this.generation.abort()
    this.generation = new AbortController()
    this.endpointValue = this.bind()
  }

  dispose(): void {
    if (!this.live) return
    this.live = false
    this.generation.abort()
  }
}
