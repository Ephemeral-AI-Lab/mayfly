/**
 * BTW fork, addressed-child prompting, and independent cold-view orchestration.
 * @module @ephemeral-ai/mayfly/frontend/btw
 */
import { randomUUID } from 'node:crypto'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  ModelSelection, RemoteFailure, RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SubagentPromptReceipt, SubagentPromptRequest } from '@deepseek-ai/dsh-subagent/client'
import type { SessionRef } from '../client/types.ts'
import type { HostActions, HostSessionForkOptions } from './host-actions.ts'
import type { HostRegistry } from './host-registry.ts'
import type { HostViewLease, HostViewRole } from './host-registry.ts'
import type { RemotePresentationSelection } from './session-facts.ts'

/**
 * The official fork failure, recognized structurally. The class lives in the
 * lexical Client page bundle, which this Node process may not import: the
 * handoff loader evaluates it behind a module table, so a statically imported
 * copy would also be a different class identity. Its stable `name` and
 * `rpcError` fields are the contract the Client publishes.
 */
function forkFailureOf(error: unknown): RemoteFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (Reflect.get(error, 'name') !== 'SessionForkError') return undefined
  const rpcError = Reflect.get(error, 'rpcError')
  return typeof rpcError === 'object' && rpcError !== null ? rpcError as RemoteFailure : undefined
}

/** Input for one ordinary forked side question. */
export interface RemoteBtwAskOptions extends Pick<HostSessionForkOptions, 'atSeq' | 'allowMigration'> {
  readonly signal?: AbortSignal
}

/** Successfully opened BTW view and its independent presentation selection. */
export interface RemoteBtwSession {
  readonly parent: SessionRef
  readonly child: SessionRef
  readonly view: HostViewLease
  readonly selection: RemotePresentationSelection
}

/** A newer BTW request or owner disposal superseded an asynchronous operation. */
export class RemoteBtwSupersededError extends Error {
  override readonly name = 'RemoteBtwSupersededError'
}

/** A required parent fact is unavailable through official Client projections. */
export class RemoteBtwPreconditionError extends Error {
  override readonly name = 'RemoteBtwPreconditionError'

  constructor(readonly parent: SessionRef, readonly reason: 'model-unavailable' | 'history-floor-unavailable') {
    super(`BTW parent "${parent.sessionId}" ${reason === 'model-unavailable' ? 'has no official model route' : 'has no official inherited history floor'}`)
  }
}

/** The official catalog cannot resolve an exact cold child without borrowing another Agent. */
export class RemoteColdSubagentResolutionError extends Error {
  override readonly name = 'RemoteColdSubagentResolutionError'

  constructor(readonly parent: SessionRef, readonly child: SessionRef) {
    super(`Cold child "${child.sessionId}" has no official exact-parent read-only resolution`)
  }
}

/** An addressed continuation lacks the required exact direct-parent continuable address. */
export class RemoteSubagentAddressError extends Error {
  override readonly name = 'RemoteSubagentAddressError'

  constructor(readonly parent: SessionRef, readonly child: SessionRef) {
    super(`Child "${child.sessionId}" is not a continuable direct child of "${parent.sessionId}"`)
  }
}

/** Input for one addressed continuable-child prompt. */
export interface RemoteSubagentPromptInput {
  readonly content: SubagentPromptRequest['content']
  readonly delivery: 'queue' | 'steer'
  readonly clientTimeZone?: string
  readonly signal?: AbortSignal
}

interface ActiveBtw {
  readonly parent: SessionRef
  readonly child: SessionRef
  readonly lease: HostViewLease
}

/** Owns one BTW view while leaving parent, displayed, and cold bindings independent. */
export class RemoteBtwService {
  private active: ActiveBtw | undefined
  private pending: AbortController | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(
    private readonly actions: HostActions,
    private readonly registry: HostRegistry,
  ) {}

  /** Return the currently displayed BTW identities, if one is open. */
  current(): { readonly parent: SessionRef, readonly child: SessionRef } | undefined {
    return this.active === undefined ? undefined : { parent: this.active.parent, child: this.active.child }
  }

  /**
   * Fork the parent once, clear inherited pending Inbox rows, reapply its model,
   * and only then ask the question through the ordinary child Session prompt.
   */
  ask(parent: SessionRef, question: string, options: RemoteBtwAskOptions = {}): Promise<RemoteResult<RemoteBtwSession>> {
    if (question.trim() === '') return Promise.reject(new Error('BTW question must not be empty'))
    if (this.disposed) return Promise.reject(new RemoteBtwSupersededError('BTW service is disposed'))
    this.pending?.abort(new RemoteBtwSupersededError('BTW request was replaced'))
    const previous = this.active
    this.active = undefined
    previous?.lease.release()
    const controller = new AbortController()
    this.pending = controller
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
    const operation = this.tail.then(() => this.execute(parent, question, options, signal))
    this.tail = operation.catch(() => undefined)
    const settled = (): void => {
      if (this.pending === controller) this.pending = undefined
    }
    void operation.then(settled, settled)
    return operation
  }

  /** Prompt an addressed continuable child through remote.subagents.prompt, never ordinary parent routing. */
  promptSubagent(
    parent: SessionRef,
    child: SessionRef,
    input: RemoteSubagentPromptInput,
  ): Promise<RemoteResult<SubagentPromptReceipt>> {
    if (parent.host !== child.host) throw new Error('Subagent parent and child must belong to the same Host')
    const client = this.registry.get(parent.host)
    if (client === undefined) throw new RemoteSubagentAddressError(parent, child)
    const address = client.sessions.subagentAddress(child.sessionId)
    if (address === undefined || address.parentSessionId !== parent.sessionId || address.mode !== 'continuable') {
      throw new RemoteSubagentAddressError(parent, child)
    }
    return client.remote.subagents.prompt({
      requestId: randomUUID() as SessionRequestId,
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      mode: 'continuable',
      delivery: input.delivery,
      content: input.content,
      ...(input.clientTimeZone === undefined ? {} : { clientTimeZone: input.clientTimeZone }),
    }, input.signal)
  }

  /** Resolve only an officially catalogued exact-parent cold child; never borrow its parent's binding. */
  retainColdSubagentView(parent: SessionRef, child: SessionRef, role: HostViewRole = 'cold'): HostViewLease {
    if (parent.host !== child.host) throw new RemoteColdSubagentResolutionError(parent, child)
    const client = this.registry.get(parent.host)
    const address = client?.sessions.subagentAddress(child.sessionId)
    if (address === undefined || address.parentSessionId !== parent.sessionId) {
      throw new RemoteColdSubagentResolutionError(parent, child)
    }
    return this.actions.retainView(child, role, address)
  }

  /** Reacquire a listed ordinary BTW fork without retaining its former display or changing the primary. */
  retainBtwView(child: SessionRef, role: HostViewRole = 'btw-retained'): HostViewLease {
    return this.actions.retainView(child, role)
  }

  /** Close only the displayed BTW lease; the Host Session and its work remain untouched. */
  close(): void {
    this.pending?.abort(new RemoteBtwSupersededError('BTW view was closed'))
    this.pending = undefined
    const active = this.active
    this.active = undefined
    active?.lease.release()
  }

  /** Abort pending work, release the active lease, and await stale continuations. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.tail
      return
    }
    this.disposed = true
    this.close()
    await this.tail
  }

  private async execute(
    parent: SessionRef,
    question: string,
    options: RemoteBtwAskOptions,
    signal: AbortSignal,
  ): Promise<RemoteResult<RemoteBtwSession>> {
    const parentLease = this.actions.retainView(parent, 'btw-parent')
    let childLease: HostViewLease | undefined
    try {
      await parentLease.ready
      this.assertCurrent(signal)
      const binding = parentLease.reference.binding
      const model = readModelSelection(binding.session.projections.faceOf('modelSelection').getSnapshot())
      const cwd = readWorkingDirectory(binding.session.projections.faceOf('workingDirectory').getSnapshot())
        ?? this.registry.get(parent.host)?.sessions.list.getSnapshot().byId[parent.sessionId]?.cwd
        ?? ''
      const historyFloorSeq = options.atSeq ?? latestCompletedSeq(binding.eventSource.getSnapshot().entries)
      if (model === undefined) throw new RemoteBtwPreconditionError(parent, 'model-unavailable')
      let child: SessionRef
      try {
        child = await this.actions.fork(parent, {
          ...(options.atSeq === undefined ? {} : { atSeq: options.atSeq }),
          ...(options.allowMigration === undefined ? {} : { allowMigration: options.allowMigration }),
        })
      } catch (error) {
        const failure = forkFailureOf(error)
        if (failure !== undefined) return { ok: false, error: failure }
        throw error
      }
      this.assertCurrent(signal)
      if (historyFloorSeq === undefined) throw new RemoteBtwPreconditionError(parent, 'history-floor-unavailable')
      const selected = await this.actions.selectModel(child, model)
      if (!selected.ok) return selected
      this.assertCurrent(signal)
      childLease = this.actions.retainView(child, 'btw')
      await childLease.ready
      this.assertCurrent(signal)
      const queueFailure = await this.clearInheritedQueue(child, childLease, () => { this.assertCurrent(signal) })
      if (queueFailure !== undefined) return { ok: false, error: queueFailure }
      this.assertCurrent(signal)
      const prompted = await this.actions.prompt(child, {
        mode: 'queue',
        text: question,
        attachments: [],
        content: [{ type: 'text', text: question }],
        signal,
      })
      if (!prompted.ok) return prompted
      this.assertCurrent(signal)
      const lease = childLease
      this.active = { parent, child, lease }
      return {
        ok: true,
        value: {
          parent,
          child,
          view: lease,
          selection: {
            ref: child,
            cwd,
            historyFloorSeq,
          },
        },
      }
    } finally {
      parentLease.release()
      if (this.active?.lease !== childLease) childLease?.release()
    }
  }

  private async clearInheritedQueue(
    child: SessionRef,
    lease: HostViewLease,
    assertCurrent: () => void,
  ): Promise<RemoteFailure | undefined> {
    const inbox = lease.reference.binding.session.projections.faceOf('inbox').getSnapshot()
    for (const id of readInboxIds(inbox)) {
      assertCurrent()
      const result = await this.actions.updateQueue(child, id, { kind: 'remove' })
      assertCurrent()
      if (!result.ok) return result.error
    }
    return undefined
  }

  private assertCurrent(signal: AbortSignal): void {
    // Replacement, close, and disposal abort the exact pending owner before any continuation resumes.
    signal.throwIfAborted()
  }
}

function readModelSelection(value: unknown): ModelSelection | undefined {
  if (!isRecord(value)) return undefined
  return readModelRoute(value['next']) ?? readModelRoute(value['lastUsed'])
}

function readModelRoute(value: unknown): ModelSelection | undefined {
  if (!isRecord(value) || typeof value['provider'] !== 'string' || typeof value['model'] !== 'string') return undefined
  return {
    provider: value['provider'],
    model: value['model'],
    ...(typeof value['reasoningEffort'] === 'string' ? { reasoningEffort: value['reasoningEffort'] } : {}),
  }
}

function readWorkingDirectory(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function latestCompletedSeq(entries: readonly { readonly type: string, readonly event: { readonly type: string, readonly seq: number } }[]): number | undefined {
  return entries.findLast(entry => entry.type === 'event' && entry.event.type === 'turn/end')?.event.seq
}

function readInboxIds(inbox: unknown): ReturnType<typeof MessageId>[] {
  if (!isRecord(inbox)) return []
  return [...readInboxLane(inbox['next-turn']), ...readInboxLane(inbox['next-step'])]
}

function readInboxLane(value: unknown): ReturnType<typeof MessageId>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(candidate => {
    if (!isRecord(candidate) || typeof candidate['id'] !== 'string') throw new Error('Host Inbox row has no MessageId')
    return [MessageId(candidate['id'])]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
