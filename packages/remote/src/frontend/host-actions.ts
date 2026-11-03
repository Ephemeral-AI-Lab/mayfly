/**
 * Typed Host/Session actions routed through the official dsh Client object layer.
 * @module @ephemeral-ai/mayfly/frontend/host-actions
 */
import type {
  BeginSubmissionInput, ISessions, SessionFace, SessionReference, SessionSearchResultItem, SessionTarget,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  ClientRemote, ModelSelection, RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { CreateGoalRequest, EditGoalRequest, GoalRef } from '@deepseek-ai/dsh-goal/client'
import type { HostClient, HostKey, SessionRef } from '../client/types.ts'
import {
  HostNotAttachedError, HostRegistry, mayflySessionReferenceSource,
  type HostViewLease, type HostViewRole,
} from './host-registry.ts'

/** Options for one Host Session creation, matching the official Session service. */
export type HostSessionCreateOptions = NonNullable<Parameters<ISessions['create']>[0]>

/** One logical prompt submission; its request identity is managed by HostActions. */
export interface HostPromptInput extends BeginSubmissionInput {
  /** Exact content passed to the official Session prompt method. */
  readonly content: PromptContentPart[]
  /** Cancels only acquisition/admission transport; it never cancels the remote Agent turn. */
  readonly signal?: AbortSignal
  /** Exact local owner admission fence, checked after official reference acquisition. */
  readonly isCurrent?: () => boolean
}

/** Options for forking an exact source Session through ClientSessions. */
export type HostSessionForkOptions = Omit<Parameters<ISessions['fork']>[0], 'sessionId'>

/** One Host-namespaced Session content-search result. */
export interface HostSessionSearchItem extends SessionSearchResultItem {
  readonly ref: SessionRef
}

/** Bounded Host Session search response. */
export interface HostSessionSearchValue {
  readonly items: HostSessionSearchItem[]
  readonly hasMore: boolean
}

/** Routes navigation and Session behavior through Host-namespaced official references. */
export class HostActions {
  /** @param registry - owner of attached Hosts and current Session selection. */
  constructor(private readonly registry: HostRegistry) {}

  /** Current committed selection from the registry. */
  get current(): SessionRef | undefined {
    return this.registry.current
  }

  /** Borrowed registry-owned current reference; callers must not release it. */
  get currentReference(): SessionReference | undefined {
    return this.registry.currentReference
  }

  /**
   * Read the official Session catalog for one Host without copying its state.
   * @param host - owning Host identity.
   * @returns the Host's live observable catalog.
   */
  sessionList(host: HostKey): ISessions['list'] {
    return this.host(host).sessions.list
  }

  /**
   * Select and retain one Host/Session pair through the registry.
   * @param ref - Host-namespaced Session identity.
   * @param signal - optional acquisition cancellation, not Agent cancellation.
   * @param isCurrent - optional exact owner checked before committing the acquired selection.
   * @returns the committed selection.
   */
  select(ref: SessionRef, signal?: AbortSignal, isCurrent?: () => boolean): Promise<SessionRef> {
    return this.registry.select(ref, signal, isCurrent)
  }

  /**
   * Acquire an independent official Session reference for a view or operation.
   * @param ref - Host-namespaced Session identity.
   * @param signal - optional cancellation of the initial-open wait.
   * @returns an owned reference; the caller must release it exactly through its official lifecycle.
   */
  retain(ref: SessionRef, signal?: AbortSignal): SessionReference {
    return this.host(ref.host).sessions.retain(ref.sessionId, {
      source: mayflySessionReferenceSource,
      signal,
    })
  }

  /** Retain an independent view-role binding without changing the primary selection. */
  retainView(ref: SessionRef, role: HostViewRole, target: SessionTarget = ref.sessionId): HostViewLease {
    return this.registry.retainView(ref, role, target)
  }

  /** Force-close one view role, invalidating its leases without affecting other Sessions or roles. */
  closeView(ref: SessionRef, role: HostViewRole): void {
    this.registry.closeView({ ref, role })
  }

  /**
   * Create a Host Session once. The new identity is not selected implicitly and is never replayed on failure.
   * @param host - owning Host identity.
   * @param options - official Session creation options.
   * @returns the created or reused Host-namespaced identity.
   */
  create(host: HostKey, options?: HostSessionCreateOptions): Promise<SessionRef> {
    return this.host(host).sessions.create(options).then(sessionId => Object.freeze({ host, sessionId }))
  }

  /** Refresh one Host's official Session catalog without creating a parallel list. */
  refresh(host: HostKey): Promise<void> {
    return this.host(host).sessions.refresh()
  }

  /** Retry the official projection read for one Session without opening its conversation. */
  refreshProjections(ref: SessionRef): Promise<void> {
    return this.host(ref.host).sessions.refreshProjections(ref.sessionId)
  }

  /**
   * Search one Host's message index and namespace every result with that Host.
   * @param ref - any identity on the Host to search.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for a superseded search.
   * @returns the official bounded result with Host-safe identities.
   */
  async search(ref: SessionRef, query: string, signal: AbortSignal): Promise<RemoteResult<HostSessionSearchValue>> {
    const result = await this.host(ref.host).sessions.search(query, signal)
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        hasMore: result.value.hasMore,
        items: result.value.items.map(item => ({ ...item, ref: Object.freeze({ host: ref.host, sessionId: item.sessionId }) })),
      },
    }
  }

  /** Fork an exact source prefix once; the child is catalogued but not selected implicitly. */
  fork(ref: SessionRef, options: HostSessionForkOptions = {}): Promise<SessionRef> {
    return this.host(ref.host).sessions.fork({ ...options, sessionId: ref.sessionId })
      .then(sessionId => Object.freeze({ host: ref.host, sessionId }))
  }

  /**
   * Submit one prompt with one stable requestId from beginSubmission. A transport
   * abort only affects admission; this method neither calls Agent cancel nor retries the write.
   * @param ref - Host-namespaced Session identity.
   * @param input - official echo data, exact prompt content, delivery mode, and optional transport signal.
   * @returns the official prompt admission result.
   */
  prompt(ref: SessionRef, input: HostPromptInput): ReturnType<SessionFace['prompt']> {
    return this.using(ref, input.signal, async session => {
      if (input.isCurrent?.() === false) throw new Error('Session prompt was superseded')
      const submission = session.beginSubmission({
        mode: input.mode,
        text: input.text,
        attachments: input.attachments,
        ...(input.onAccept === undefined ? {} : { onAccept: input.onAccept }),
        ...(input.onRetire === undefined ? {} : { onRetire: input.onRetire }),
      })
      try {
        return await session.prompt(input.content, input.mode, input.signal, submission.requestId)
      } catch (error) {
        submission.abandon()
        throw error
      }
    })
  }

  /** Steer the running turn once through the official prompt admission path. */
  steer(ref: SessionRef, input: Omit<HostPromptInput, 'mode'>): ReturnType<SessionFace['prompt']> {
    return this.prompt(ref, { ...input, mode: 'steer' })
  }

  /** Apply one edit, remove, or steer action to a pending official Inbox occurrence. */
  updateQueue(
    ref: SessionRef,
    itemId: Parameters<SessionFace['updateQueue']>[0],
    action: Parameters<SessionFace['updateQueue']>[1],
  ): ReturnType<SessionFace['updateQueue']> {
    return this.using(ref, undefined, session => session.updateQueue(itemId, action))
  }

  /** Resolve authenticated, Host-issued image bytes through the exact Session permission scope. */
  readAttachment(
    ref: SessionRef,
    attachment: Parameters<SessionFace['readAttachment']>[0],
  ): ReturnType<SessionFace['readAttachment']> {
    return this.using(ref, undefined, session => session.readAttachment(attachment))
  }

  /** Select the provider, model, and optional reasoning effort for one exact Session. */
  selectModel(ref: SessionRef, selection: ModelSelection): ReturnType<ClientRemote['session']['selectModel']> {
    const client = this.host(ref.host)
    return this.using(ref, undefined, () => client.remote.session.selectModel({
      sessionId: ref.sessionId,
      ...selection,
    }))
  }

  /**
   * Explicitly cancel the running Agent turn once; queued work follows official Host semantics.
   * @param ref - Host-namespaced Session identity.
   * @returns the official cancellation result.
   */
  cancel(ref: SessionRef): ReturnType<SessionFace['cancel']> {
    return this.using(ref, undefined, session => session.cancel())
  }

  /**
   * Rename a Session once without replaying transport failures.
   * @param ref - Host-namespaced Session identity.
   * @param title - requested user title.
   * @param isCurrent - optional owner admission fence, rechecked after native reference acquisition.
   * @returns the official normalized title result.
   */
  rename(ref: SessionRef, title: string, isCurrent?: () => boolean): ReturnType<SessionFace['rename']> {
    return this.using(ref, undefined, session => {
      if (isCurrent?.() === false) throw new Error('The current session changed; run /rename again')
      return session.rename(title)
    })
  }

  /**
   * Execute one slash-command admission without replaying transport failures.
   * @param ref - Host-namespaced Session identity.
   * @param line - complete command line, including its leading slash.
   * @returns the official command admission result.
   */
  command(ref: SessionRef, line: string, isCurrent?: () => boolean, signal?: AbortSignal): ReturnType<SessionFace['command']> {
    return this.using(ref, signal, session => {
      if (isCurrent?.() === false) throw new Error('Session command was superseded')
      return session.command(line)
    })
  }

  /** Read the official command catalog with its structured failure branch intact. */
  commandCatalog(ref: SessionRef): ReturnType<ClientRemote['commands']['list']> {
    const client = this.host(ref.host)
    return this.using(ref, undefined, () => client.remote.commands.list(ref.sessionId))
  }

  /** Read command descriptors for the current minimal command panel. */
  async listCommands(ref: SessionRef): Promise<readonly { readonly name: string, readonly description: string }[]> {
    const result = await this.commandCatalog(ref)
    if (!result.ok) throw result.error
    return result.value
  }

  /** Read the complete official model catalog and its per-provider failures. */
  modelCatalog(host: HostKey): ReturnType<ClientRemote['session']['modelCatalog']> {
    return this.host(host).remote.session.modelCatalog()
  }

  /** Read the Host-advertised model route used before a Session has its own selection. */
  async defaultModel(host: HostKey): Promise<{ readonly provider: string, readonly model: string, readonly reasoningEffort?: string }> {
    const result = await this.modelCatalog(host)
    if (!result.ok) throw result.error
    return result.value.default
  }

  /** Read the current Goal through the official goals namespace. */
  goal(ref: SessionRef): ReturnType<ClientRemote['goals']['get']> {
    const client = this.host(ref.host)
    return this.using(ref, undefined, () => client.remote.goals.get(ref.sessionId))
  }

  /** Create a Goal through the official goals namespace. */
  createGoal(ref: SessionRef, request: CreateGoalRequest): ReturnType<ClientRemote['goals']['create']> {
    const client = this.host(ref.host)
    return this.using(ref, undefined, () => client.remote.goals.create(ref.sessionId, request))
  }

  /** Edit one exact Goal revision through the official goals namespace. */
  editGoal(ref: SessionRef, goal: GoalRef, request: EditGoalRequest): ReturnType<ClientRemote['goals']['edit']> {
    const client = this.host(ref.host)
    return this.using(ref, undefined, () => client.remote.goals.edit(ref.sessionId, goal, request))
  }

  /** Pause one exact Goal revision through the official goals namespace. */
  pauseGoal(ref: SessionRef, goal: GoalRef): ReturnType<ClientRemote['goals']['pause']> {
    const client = this.host(ref.host)
    return this.using(ref, undefined, () => client.remote.goals.pause(ref.sessionId, goal))
  }

  /** Resume one exact Goal revision through the official goals namespace. */
  resumeGoal(ref: SessionRef, goal: GoalRef): ReturnType<ClientRemote['goals']['resume']> {
    const client = this.host(ref.host)
    return this.using(ref, undefined, () => client.remote.goals.resume(ref.sessionId, goal))
  }

  /** Complete one exact Goal revision through the official goals namespace. */
  completeGoal(ref: SessionRef, goal: GoalRef): ReturnType<ClientRemote['goals']['complete']> {
    const client = this.host(ref.host)
    return this.using(ref, undefined, () => client.remote.goals.complete(ref.sessionId, goal))
  }

  /** Clear one exact Goal revision through the official goals namespace. */
  clearGoal(ref: SessionRef, goal: GoalRef): ReturnType<ClientRemote['goals']['clear']> {
    const client = this.host(ref.host)
    return this.using(ref, undefined, () => client.remote.goals.clear(ref.sessionId, goal))
  }

  /** List human-invocable Skills for the exact Session composition. */
  listSkills(ref: SessionRef, signal?: AbortSignal): ReturnType<ClientRemote['skills']['list']> {
    const client = this.host(ref.host)
    return this.using(ref, signal, () => client.remote.skills.list({ sessionId: ref.sessionId }, signal))
  }

  /** Search Host file references through the exact Session permission scope. */
  listFileReferences(ref: SessionRef, query: string, signal?: AbortSignal): ReturnType<ClientRemote['fileReferences']['list']> {
    const client = this.host(ref.host)
    return this.using(ref, signal, () => client.remote.fileReferences.list(ref.sessionId, query, signal))
  }

  /**
   * Extend the official Session history window.
   * @param ref - Host-namespaced Session identity.
   * @returns completion of the official history operation.
   */
  loadOlder(ref: SessionRef): Promise<void> {
    return this.using(ref, undefined, session => session.loadOlder())
  }

  /**
   * Page official Session history through an event sequence.
   * @param ref - Host-namespaced Session identity.
   * @param seq - inclusive target event sequence.
   * @returns completion of the official history operation.
   */
  loadThrough(ref: SessionRef, seq: Parameters<SessionFace['loadThrough']>[0]): Promise<void> {
    return this.using(ref, undefined, session => session.loadThrough(seq))
  }

  private host(key: HostKey): HostClient {
    const client = this.registry.get(key)
    if (client === undefined) throw new HostNotAttachedError(key)
    return client
  }

  private using<T>(
    ref: SessionRef,
    signal: AbortSignal | undefined,
    operation: (session: SessionFace) => T | Promise<T>,
  ): Promise<T> {
    return this.host(ref.host).sessions.using(ref.sessionId, {
      source: mayflySessionReferenceSource,
      signal,
    }, reference => operation(reference.binding.session))
  }
}
