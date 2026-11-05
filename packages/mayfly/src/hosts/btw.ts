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
import { mayflyHostRemote } from './host-mount.ts'

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

/** Neither the source projection nor the native Host default supplies a model route. */
export class RemoteBtwPreconditionError extends Error {
  override readonly name = 'RemoteBtwPreconditionError'

  readonly reason = 'model-unavailable'

  constructor(readonly parent: SessionRef) {
    super(`BTW parent "${parent.sessionId}" has no official model route`)
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

interface PendingBtw {
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly leases: Set<HostViewLease>
}

/** Abort a local wait without altering the admitted Host operation or another view lease. */
function waitForBtw<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    // Observe both outcomes even after retirement so late native failures are handled.
    void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort() }
  })
}

/** Owns one BTW view while leaving parent, displayed, and cold bindings independent. */
export class RemoteBtwService {
  private active: ActiveBtw | undefined
  private pending: PendingBtw | undefined
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
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    this.pending?.controller.abort(new RemoteBtwSupersededError('BTW request was replaced'))
    const previous = this.active
    this.active = undefined
    previous?.lease.release()
    const controller = new AbortController()
    const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal])
    const pending: PendingBtw = { controller, signal, leases: new Set() }
    this.pending = pending
    const release = (): void => { for (const lease of pending.leases) lease.release(); pending.leases.clear() }
    signal.addEventListener('abort', release, { once: true })
    const operation = this.tail.then(() => this.execute(parent, question, options, pending))
    this.tail = operation.catch(() => undefined)
    const settled = (): void => {
      signal.removeEventListener('abort', release)
      release()
      if (this.pending === pending) this.pending = undefined
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

  /** Close the pending or displayed view and report whether one existed; Host work keeps its own lifetime. */
  close(): boolean {
    const existed = this.pending !== undefined || this.active !== undefined
    this.pending?.controller.abort(new RemoteBtwSupersededError('BTW view was closed'))
    this.pending = undefined
    const active = this.active
    this.active = undefined
    active?.lease.release()
    return existed
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
    pending: PendingBtw,
  ): Promise<RemoteResult<RemoteBtwSession>> {
    const { signal } = pending
    this.assertCurrent(signal)
    const parentLease = this.actions.retainView(parent, 'btw-parent')
    pending.leases.add(parentLease)
    let childLease: HostViewLease | undefined
    try {
      const client = this.registry.get(parent.host)!
      const generation = client.state.getSnapshot().generation
      const binding = await waitForBtw(parentLease.ready, signal)
      const assertCurrent = (): void => {
        this.assertCurrent(signal)
        if (this.registry.get(parent.host) !== client || client.state.getSnapshot().generation !== generation || parentLease.reference.binding !== binding) {
          throw new RemoteBtwSupersededError('BTW parent binding was replaced')
        }
      }
      assertCurrent()
      let model = readModelSelection(binding.session.projections.faceOf('modelSelection').getSnapshot())
      const cwd = readWorkingDirectory(binding.session.projections.faceOf('workingDirectory').getSnapshot())
        ?? client.sessions.list.getSnapshot().byId[parent.sessionId]?.cwd
        ?? ''
      if (model === undefined) {
        const fallback = await mayflyHostRemote(client).defaultModel({ operation: 'read' }, signal)
        assertCurrent()
        if (!fallback.ok) return fallback
        model = readModelRoute(fallback.value)
      }
      if (model === undefined) throw new RemoteBtwPreconditionError(parent)
      const forked = await mayflyHostRemote(client).btwFork({
        sessionId: parent.sessionId,
        ...(options.atSeq === undefined ? {} : { atSeq: options.atSeq }),
        ...(options.allowMigration === undefined ? {} : { allowMigration: options.allowMigration }),
      }, signal)
      assertCurrent()
      if (!forked.ok) return forked
      const child: SessionRef = Object.freeze({ host: parent.host, sessionId: forked.value.sessionId })
      const historyFloorSeq = forked.value.historyFloorSeq
      // Focused Host methods do not publish ClientSessions' local create/fork
      // placeholder. A refresh may join a pull started before the Host fork;
      // in that case one subsequent pull must discover the actual child.
      await this.actions.refresh(parent.host)
      assertCurrent()
      if (client.sessions.list.getSnapshot().byId[child.sessionId] === undefined) {
        await this.actions.refresh(parent.host)
        assertCurrent()
      }
      if (client.sessions.list.getSnapshot().byId[child.sessionId] === undefined) {
        throw new Error(`BTW child "${child.sessionId}" is absent from the official Session catalog`)
      }
      const selected = await this.actions.selectModel(child, model)
      assertCurrent()
      if (!selected.ok) return selected
      childLease = this.actions.retainView(child, 'btw')
      pending.leases.add(childLease)
      await waitForBtw(childLease.ready, signal)
      assertCurrent()
      const queueFailure = await this.clearInheritedQueue(child, childLease, () => { assertCurrent() })
      if (queueFailure !== undefined) return { ok: false, error: queueFailure }
      assertCurrent()
      const prompted = await this.actions.prompt(child, {
        mode: 'queue',
        text: question,
        attachments: [],
        content: [{ type: 'text', text: question }],
        signal,
      })
      assertCurrent()
      if (!prompted.ok) return prompted
      const lease = childLease
      pending.leases.delete(lease)
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
            ...(historyFloorSeq === undefined ? {} : { historyFloorSeq }),
          },
        },
      }
    } finally {
      pending.leases.delete(parentLease)
      parentLease.release()
      if (childLease !== undefined) {
        pending.leases.delete(childLease)
        if (this.active?.lease !== childLease) childLease.release()
      }
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
