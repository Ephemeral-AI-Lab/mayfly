/**
 * Exact-selection Remote approval waterfalls, allowances, and rejection steering.
 * @module @ephemeral-ai/mayfly/remote/interactions/approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { decisionArmMs, type MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { DecisionCard } from './decision-card.ts'
import { readDecision } from './decision-actions.ts'
import type { ApprovalOutcome, ApprovalRequest } from './official.ts'
import { requestOverlay, type RemoteRequestOverlay } from './request-overlay.ts'
import { isRemoteFeatureSelection } from './selection.ts'

const DELEGATE = Symbol('remote approval delegates')

interface ApprovalAnswer {
  readonly outcome: ApprovalOutcome
  readonly session?: boolean
  readonly reason?: string
}

interface ApprovalEntry {
  readonly client: HostClient
  readonly ref: SessionRef
  readonly request: ApprovalRequest
  readonly next: () => Promise<ApprovalOutcome>
  readonly requestKey?: string
  readonly resolve: (outcome: ApprovalOutcome | Promise<ApprovalOutcome>) => void
  readonly reject: (error: unknown) => void
  binding?: SessionBinding
  overlay?: RemoteRequestOverlay<ApprovalAnswer | typeof DELEGATE>
  onAbort?: () => void
  settled: boolean
}

function card(request: ApprovalRequest, queue: string | undefined, t: MayflyTranslate) {
  return DecisionCard({
    title: t('Decide'),
    ...queue === undefined ? {} : { queue },
    options: [
      { id: 'allow-once', label: t('Allow once') },
      { id: 'allow-session', label: t('Allow {tool} for this session', { tool: request.toolName }) },
      { id: 'reject', label: t('Reject') },
    ],
    note: { label: t('Feedback'), placeholder: t('type to explain…') },
    keys: [],
  })
}

function answer(event: Parameters<typeof readDecision>[0]): ApprovalAnswer | undefined {
  const read = readDecision(event)
  if (read === undefined) return undefined
  if (read.action === 'send') return read.note === '' ? undefined : { outcome: 'rejected', reason: read.note }
  if (read.choice === 'allow-once') return { outcome: 'allowed-once' }
  if (read.choice === 'allow-session') return { outcome: 'allowed-once', session: true }
  return { outcome: 'rejected', ...read.note === '' ? {} : { reason: read.note } }
}

class RemoteApprovalController {
  private readonly listeners = new Map<HostClient, () => void>()
  private readonly allowances = new WeakMap<HostClient, Map<string, Set<string>>>()
  private readonly requestKeys = new WeakMap<HostClient, Set<string>>()
  private readonly entries: ApprovalEntry[] = []
  private active: ApprovalEntry | undefined
  private readonly offTopology: () => void
  private sequence = 0
  private disposed = false

  constructor(private readonly options: RemoteFeatureContext) {
    this.reconcile()
    this.offTopology = this.options.hosts.subscribe(this.reconcile)
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.offTopology()
    for (const dispose of this.listeners.values()) dispose()
    this.listeners.clear()
    for (const entry of [...this.entries]) this.settle(entry, DELEGATE)
  }

  private readonly reconcile = (): void => {
    if (this.disposed) return
    const attached = new Set(this.options.hosts.list())
    for (const [client, dispose] of this.listeners) {
      if (attached.has(client)) continue
      dispose()
      this.listeners.delete(client)
      this.allowances.delete(client)
      this.requestKeys.delete(client)
    }
    for (const entry of [...this.entries]) {
      if (!attached.has(entry.client) || !this.isCurrent(entry)) this.settle(entry, DELEGATE)
    }
    for (const client of attached) {
      if (this.listeners.has(client)) continue
      const controller = this
      const dispose = client.remote.$on('approval/request', function (this: Context, request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) {
        const sessionId = client.sessions.scopeOf(this)
        return controller.receive(client, sessionId, request, next)
      })
      this.listeners.set(client, dispose)
    }
    this.startNext()
  }

  private receive(
    client: HostClient,
    sessionId: SessionId | undefined,
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (sessionId === undefined || request.toolName.trim() === '') return next()
    const ref: SessionRef = { host: client.key, sessionId }
    if (!isRemoteFeatureSelection(this.options.hosts.current(), client, ref)) return next()
    if (request.signal?.aborted) return Promise.resolve<ApprovalOutcome>('cancelled')
    if (this.allowed(client, sessionId, request.toolName)) return Promise.resolve<ApprovalOutcome>('allowed-once')
    const requestKey = request.callId === undefined ? undefined : `${String(sessionId)}:${String(request.callId)}`
    const keys = this.requestKeys.get(client) ?? new Set<string>()
    if (requestKey !== undefined) {
      if (keys.has(requestKey)) return next()
      keys.add(requestKey)
      this.requestKeys.set(client, keys)
    }
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const entry: ApprovalEntry = {
        client, ref, request, next, ...requestKey === undefined ? {} : { requestKey }, resolve, reject, settled: false,
      }
      this.entries.push(entry)
      entry.onAbort = () => this.settle(entry, 'cancelled')
      request.signal?.addEventListener('abort', entry.onAbort, { once: true })
      this.active?.overlay?.refresh()
      this.startNext()
    })
  }

  private startNext(): void {
    if (this.disposed || this.active !== undefined) return
    const entry = this.entries[0]
    if (entry === undefined || entry.settled) return
    if (!this.isCurrent(entry) || entry.request.signal?.aborted) {
      this.settle(entry, entry.request.signal?.aborted ? 'cancelled' : DELEGATE)
      return
    }
    const current = this.options.hosts.current()
    if (!isRemoteFeatureSelection(current, entry.client, entry.ref)) {
      this.settle(entry, DELEGATE)
      return
    }
    entry.binding = current.binding
    this.active = entry
    const id = `remote.approval.${String(++this.sequence)}`
    entry.overlay = requestOverlay<ApprovalAnswer | typeof DELEGATE>(this.options.ctx, {
      id,
      title: () => this.options.t('Approve {tool}?', { tool: entry.request.toolName }),
      scope: { kind: 'session', sessionId: entry.ref.sessionId },
      isCurrent: () => this.isCurrent(entry),
      subscribeLocale: this.options.subscribeLocale,
      dismissal: 'discard',
      bare: true,
      contentScroll: true,
      armMs: decisionArmMs,
      ...entry.request.signal === undefined ? {} : { signal: entry.request.signal },
      view: () => card(entry.request, this.entries.length > 1 ? this.options.t('{index} of {total} waiting', { index: 1, total: this.entries.length }) : undefined, this.options.t),
      answer,
      accepted: result => {
        if (result === DELEGATE) return
        if (result.session === true) this.allow(entry.client, entry.ref.sessionId, entry.request.toolName)
        if (result.reason !== undefined) this.steer(entry, result.reason)
      },
      cancelled: reason => {
        if (reason === 'dismiss') return { outcome: 'rejected' as const }
        if (reason === 'abort') return { outcome: 'cancelled' as const }
        return DELEGATE
      },
    })
    void entry.overlay.result.then(
      result => this.settle(entry, result === DELEGATE ? DELEGATE : result.outcome),
      () => this.settle(entry, 'unavailable'),
    )
  }

  private settle(entry: ApprovalEntry, outcome: ApprovalOutcome | typeof DELEGATE): void {
    if (entry.settled) return
    entry.settled = true
    const index = this.entries.indexOf(entry)
    if (index >= 0) this.entries.splice(index, 1)
    if (this.active === entry) this.active = undefined
    if (entry.requestKey !== undefined) this.requestKeys.get(entry.client)?.delete(entry.requestKey)
    if (entry.onAbort !== undefined) entry.request.signal?.removeEventListener('abort', entry.onAbort)
    entry.overlay?.cancel()
    try {
      entry.resolve(outcome === DELEGATE ? entry.next() : outcome)
    } catch (error) {
      entry.reject(error)
    }
    this.startNext()
  }

  private isCurrent(entry: ApprovalEntry): boolean {
    return !this.disposed
      && this.options.hosts.list().includes(entry.client)
      && isRemoteFeatureSelection(this.options.hosts.current(), entry.client, entry.ref)
  }

  private allowed(client: HostClient, sessionId: SessionId, tool: string): boolean {
    return this.allowances.get(client)?.get(String(sessionId))?.has(tool) === true
  }

  private allow(client: HostClient, sessionId: SessionId, tool: string): void {
    const sessions = this.allowances.get(client) ?? new Map<string, Set<string>>()
    const tools = sessions.get(String(sessionId)) ?? new Set<string>()
    tools.add(tool)
    sessions.set(String(sessionId), tools)
    this.allowances.set(client, sessions)
  }

  private steer(entry: ApprovalEntry, reason: string): void {
    const binding = entry.binding
    if (binding === undefined) return
    const text = `User rejected ${entry.request.toolName}: ${reason}`
    void binding.session.prompt([{ type: 'text', text }], 'steer').then(result => {
      if (!result.ok && this.isCurrent(entry)) this.options.notice.set(result.error.message)
    }).catch((error: unknown) => {
      if (this.isCurrent(entry)) this.options.notice.set(error instanceof Error ? error.message : String(error))
    })
  }
}

/** Mount per-Host approval listeners and delegate every pending request on teardown. */
export function mountApprovalInteractions(options: RemoteFeatureContext): () => void {
  const controller = new RemoteApprovalController(options)
  return controller.dispose
}
