/**
 * Typed Host/Session actions routed through the official dsh Client object layer.
 * @module @ephemeral-ai/mayfly/frontend/host-actions
 */
import type {
  BeginSubmissionInput, ISessions, SessionFace, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HostClient, HostKey, SessionRef } from '../client/types.ts'
import {
  HostNotAttachedError, HostRegistry, mayflySessionReferenceSource,
} from './host-registry.ts'

/** Options for one Host Session creation, matching the official Session service. */
export type HostSessionCreateOptions = NonNullable<Parameters<ISessions['create']>[0]>

/** One logical prompt submission; its request identity is managed by HostActions. */
export interface HostPromptInput extends BeginSubmissionInput {
  /** Exact content passed to the official Session prompt method. */
  readonly content: PromptContentPart[]
  /** Cancels only acquisition/admission transport; it never cancels the remote Agent turn. */
  readonly signal?: AbortSignal
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
   * @returns the committed selection.
   */
  select(ref: SessionRef, signal?: AbortSignal): Promise<SessionRef> {
    return this.registry.select(ref, signal)
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

  /**
   * Create a Host Session once. The new identity is not selected implicitly and is never replayed on failure.
   * @param host - owning Host identity.
   * @param options - official Session creation options.
   * @returns the created or reused Host-namespaced identity.
   */
  create(host: HostKey, options?: HostSessionCreateOptions): Promise<SessionRef> {
    return this.host(host).sessions.create(options).then(sessionId => Object.freeze({ host, sessionId }))
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
      const submission = session.beginSubmission({
        mode: input.mode,
        text: input.text,
        attachments: input.attachments,
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
   * @returns the official normalized title result.
   */
  rename(ref: SessionRef, title: string): ReturnType<SessionFace['rename']> {
    return this.using(ref, undefined, session => session.rename(title))
  }

  /**
   * Execute one slash-command admission without replaying transport failures.
   * @param ref - Host-namespaced Session identity.
   * @param line - complete command line, including its leading slash.
   * @returns the official command admission result.
   */
  command(ref: SessionRef, line: string): ReturnType<SessionFace['command']> {
    return this.using(ref, undefined, session => session.command(line))
  }

  /**
   * Read the current Host command catalog while retaining the exact Session generation.
   * @param ref - Host-namespaced Session identity.
   * @returns the Host's current command descriptors.
   */
  async listCommands(ref: SessionRef): Promise<readonly { readonly name: string, readonly description: string }[]> {
    const client = this.host(ref.host)
    return await this.using(ref, undefined, async () => {
      const result = await client.remote.commands.list(ref.sessionId)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    })
  }

  /**
   * Read the Host-advertised model route used before a Session has its own selection.
   * @param host - owning Host identity.
   * @returns the default provider and model.
   */
  async defaultModel(host: HostKey): Promise<{ readonly provider: string, readonly model: string }> {
    const result = await this.host(host).remote.session.modelCatalog()
    if (!result.ok) throw new Error(result.error.message)
    return result.value.default
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
