/** Native Session routing and local command admission for the independent TUI. @module */
import { rewindCandidates } from '@ephemeral-ai/mayfly/command-panels'
import { collectRemoteSessionEvents } from './operations/support.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { HostKey, type SessionRef } from '../client/types.ts'
import { canonicalHostBaseUrl } from '../client/auth.ts'
import type { HostClient } from '../client/types.ts'
import { HostActions } from '../frontend/host-actions.ts'
import { RemoteBtwService } from '../frontend/btw.ts'
import { HostRegistry } from '../frontend/host-registry.ts'
import type { RemoteConversationModelSource, RemotePresentationFacts } from '../transcript/remote-model.ts'
import type { RemoteNotice } from './notice.ts'
import type { RemoteAppPanels } from './interactions/plain-panels.ts'
import type { RemoteSessionsBrowser } from './features/sessions.ts'
import type { RemoteFeatureCommandDefinition } from './features/commands.ts'
import { remoteCommandCatalog } from './command-catalog.ts'
import { remoteSessionInformation, REMOTE_SESSION_INFO_KEYS } from './session-information.ts'

export { FRONTEND_COMMANDS } from './command-catalog.ts'

/** A displayed native side selection supplied by the presentation owner. */
export interface RemoteAppView {
  readonly ref: SessionRef
  readonly access: 'interactive' | 'resumable' | 'readonly'
  readonly presentation: RemotePresentationFacts
  readonly binding?: SessionBinding
}

/**
 * The one prompt `/init` sends. It asks for the same four findings and the same
 * single-file output the in-process TUI asks for, so both frontends produce a
 * comparable AGENTS.md instead of two personal styles of summary.
 */
const INIT_PROMPT = [
  'Please explore the current project directory and analyze the codebase.',
  '',
  'Specifically:',
  '1. Identify the key configuration files and the technology stack (languages, frameworks, package manager).',
  '2. Understand the build process, the test setup, and how to run them.',
  '3. Map how the code is organized: the main modules and what each owns.',
  '4. Note project-specific development conventions: code style, testing strategy, anything unusual.',
  '',
  'Then write your findings to the AGENTS.md file in the project root, aimed at AI coding agents who know nothing about the project. If AGENTS.md already exists, read it first and carry forward whatever is still accurate — rewrite it into one coherent, up-to-date file rather than appending. Compose it from what you can verify in the repository, without assumptions or generalizations, and write it in the natural language the project\'s own comments and documentation mainly use.',
].join('\n')

/**
 * Turn a Host session-split failure into the one sentence a user can act on.
 * The Host rejects a fork with `fork-unavailable` when the Session has no
 * completed turn to cut at, which is the common case for a new Session and says
 * nothing useful on its own.
 */
function describeSessionSplitFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('fork-unavailable')) {
    return 'Nothing to fork yet: this Session has no completed turn. Send a prompt and retry.'
  }
  return message
}

/** Local command and Session router for the independent HTTP/WebSocket frontend. */
export class RemoteApp {
  readonly registry: HostRegistry
  readonly actions: HostActions
  /** Independent BTW side-question orchestration over this app's actions and registry. */
  readonly btw: RemoteBtwService

  private readonly endpoints = new Map<HostKey, string>()
  private readonly topologyListeners = new Set<() => void>()
  private activeHost: HostKey | undefined
  private defaultModelGeneration = 0
  private attachmentWait: AbortController | undefined
  private readonly hostVersions = new WeakMap<HostClient, {
    readonly generation: number
    readonly pending: Promise<string | undefined>
  }>()
  private selectionGeneration = 0
  private disposed = false
  private creating: {
    readonly host: HostKey
    readonly client: HostClient
    readonly selectionGeneration: number
    readonly connectionGeneration: number
    readonly promise: Promise<SessionRef>
  } | undefined
  private pendingPlan = false
  private pendingPlanExplicit = false
  private pendingPreset: string | undefined
  private newGeneration = 0
  private planPreparation: {
    readonly ref: SessionRef
    readonly client: HostClient
    readonly binding: NonNullable<HostRegistry['currentReference']>['binding']
    readonly selectionGeneration: number
    readonly connectionGeneration: number
    readonly active: boolean
    promise?: Promise<void>
  } | undefined

  /** Sessionless plan preference; the first created Session consumes it once. */
  readonly startupPlan = {
    pending: (): boolean => this.pendingPlan,
    set: (active: boolean): void => {
      const changed = active !== this.pendingPlan
      this.pendingPlan = active
      this.pendingPlanExplicit = true
      if (changed) this.publishTopology()
    },
  }

  constructor(
    private readonly conversation: RemoteConversationModelSource,
    private readonly notice: RemoteNotice,
    private readonly panels: RemoteAppPanels,
    attach?: (key: HostKey, startupUrl: string) => HostClient | Promise<HostClient>,
    private readonly cwd = process.cwd(),
    private readonly sessionsBrowser?: RemoteSessionsBrowser,
    private readonly displayedView?: () => RemoteAppView | undefined,
    private readonly featureCommands: () => readonly RemoteFeatureCommandDefinition[] = () => [],
    private readonly subscribeDisplayedView?: (listener: () => void) => () => void,
    private readonly displayPrimary?: () => void,
  ) {
    this.registry = new HostRegistry(async (key) => {
      const startupUrl = this.endpoints.get(key)
      if (startupUrl === undefined) throw new Error(`No endpoint registered for Host "${key}"`)
      if (attach !== undefined) return attach(key, startupUrl)
      const { attachMayflyHostClient } = await import('./host-composition.ts')
      return attachMayflyHostClient(key, startupUrl)
    })
    this.actions = new HostActions(this.registry)
    this.btw = new RemoteBtwService(this.actions, this.registry)
  }

  /** Observe committed Host attach/detach and Session selection changes without owning them. */
  subscribeTopology(listener: () => void): () => void {
    this.topologyListeners.add(listener)
    return () => this.topologyListeners.delete(listener)
  }

  /** Retire local selection and continuations without cancelling any Host work. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.defaultModelGeneration += 1
    this.attachmentWait?.abort()
    this.clearSession()
    this.topologyListeners.clear()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Mayfly frontend is disposed')
  }

  /** Selected Host for Session-independent configuration and the empty start view. */
  get activeClient(): HostClient | undefined {
    const key = this.displayedView?.()?.ref.host ?? this.registry.current?.host ?? this.activeHost ?? this.registry.list()[0]?.key
    return key === undefined ? undefined : this.registry.get(key)
  }

  async attach(startupUrl: string, hostId?: string, signal?: AbortSignal): Promise<HostClient> {
    this.assertActive()
    signal?.throwIfAborted()
    const url = new URL(startupUrl)
    // Credentials and query parameters identify authentication, not the Host.
    // Scheme and mount path do identify distinct backends behind one authority.
    const key = hostId === undefined
      ? HostKey(canonicalHostBaseUrl(url).href)
      : HostKey(hostId)
    const generation = ++this.defaultModelGeneration
    this.attachmentWait?.abort()
    const waiting = new AbortController()
    this.attachmentWait = waiting
    const previous = this.registry.get(key)
    this.endpoints.set(key, startupUrl)
    const client = await this.registry.attach(key)
    if (this.disposed) {
      await this.registry.detach(key)
      throw new Error('Mayfly frontend is disposed')
    }
    if (signal?.aborted === true) {
      if (generation === this.defaultModelGeneration && previous !== client && this.registry.get(key) === client) await this.registry.detach(key)
      signal.throwIfAborted()
    }
    // The native inventory includes full management metadata. Warm this read
    // during startup so the local version panel does not wait for it on Enter.
    void this.harnessVersion(client).catch(() => {})
    if (generation === this.defaultModelGeneration) {
      if (this.activeHost !== undefined && this.activeHost !== key
        && this.registry.current === undefined && this.displayedView?.() === undefined) this.clearSession()
      this.activeHost = key
    }
    this.publishTopology()
    const owner = (): boolean => !this.disposed && signal?.aborted !== true && generation === this.defaultModelGeneration
      && this.registry.get(key) === client
    const ready = await this.waitForConnection(client, signal === undefined ? waiting.signal : AbortSignal.any([waiting.signal, signal])).catch(error => {
      if (owner()) throw error
      return false
    }).finally(() => { if (this.attachmentWait === waiting) this.attachmentWait = undefined })
    const connection = client.state.getSnapshot().generation
    const current = (): boolean => owner() && client.state.getSnapshot().generation === connection
    // Native connection establishment replaces any earlier Session-list pull.
    // Join that generation's refresh only after its opening callbacks ran.
    const result = ready && owner() ? await Promise.all([client.sessions.refresh(), this.actions.modelCatalog(key)]).catch(error => {
      if (current()) throw error
      return undefined
    }) : undefined
    if (current() && result !== undefined) {
      const catalog = result[1]
      if (!catalog.ok) throw catalog.error
      this.conversation.setModelCatalog(key, catalog.value)
      this.conversation.setDefaultModel(catalog.value.default)
    }
    if (signal?.aborted === true && generation === this.defaultModelGeneration && previous !== client && this.registry.get(key) === client) {
      await this.registry.detach(key)
      if (this.activeHost === key) this.activeHost = undefined
      this.publishTopology()
    }
    return client
  }

  private async waitForConnection(client: HostClient, signal: AbortSignal): Promise<boolean> {
    let check!: () => void
    const ready = new Promise<boolean>((resolve, reject) => {
      check = (): void => {
        if (signal.aborted) { resolve(false); return }
        const state = client.state.getSnapshot()
        if (state.status === 'authentication-required' || state.status === 'failed') { reject(state.error); return }
        if (state.status === 'detached') { reject(new Error('Host Client is detached')); return }
        if (client.connection.generation.getSnapshot() !== undefined) resolve(true)
      }
    })
    const offGeneration = client.connection.generation.subscribe(check)
    const offState = client.state.subscribe(check)
    signal.addEventListener('abort', check, { once: true })
    try { check(); return await ready }
    finally { signal.removeEventListener('abort', check); offGeneration(); offState() }
  }

  async selectOrCreate(sessionId?: string, cwd = this.cwd, signal?: AbortSignal): Promise<SessionRef> {
    this.assertActive()
    signal?.throwIfAborted()
    const generation = ++this.selectionGeneration
    const host = this.requireHost()
    const client = this.registry.get(host)!
    const connection = client.state.getSnapshot().generation
    const view = this.displayedView?.()
    const previousBinding = this.registry.currentReference?.binding
    const current = (): boolean => !this.disposed && signal?.aborted !== true && generation === this.selectionGeneration
      && this.registry.get(host) === client && client.state.getSnapshot().generation === connection
    const ref = sessionId === undefined
      ? await this.actions.create(host, { cwd, ...this.pendingPreset === undefined ? {} : { agentPreset: this.pendingPreset } }).catch(error => {
        if (!current()) throw new Error('Session selection was superseded')
        throw error
      })
      : { host, sessionId: SessionId(sessionId) }
    if (!current()) throw new Error('Session selection was superseded')
    const admit = (): boolean => {
      const nextView = this.displayedView?.()
      return current() && this.registry.currentReference?.binding === previousBinding
        && view?.binding === nextView?.binding && view?.ref.host === nextView?.ref.host
        && view?.ref.sessionId === nextView?.ref.sessionId && view?.access === nextView?.access
    }
    await this.actions.select(ref, signal, admit).catch(error => {
      if (!admit()) throw new Error('Session selection was superseded')
      throw error
    })
    if (!current()) throw new Error('Session selection was superseded')
    this.activeHost = ref.host
    const binding = this.registry.currentReference?.binding
    if (binding === undefined) throw new Error('Selected Session has no Client binding')
    const summary = this.registry.get(ref.host)?.sessions.list.getSnapshot().byId[ref.sessionId]
    this.conversation.attach(binding, { ref, cwd: summary?.cwd ?? (sessionId === undefined ? cwd : '') })
    this.planPreparation = sessionId === undefined && this.pendingPlanExplicit ? {
      ref, binding, client: this.registry.get(ref.host)!, selectionGeneration: generation,
      connectionGeneration: this.registry.get(ref.host)!.state.getSnapshot().generation,
      active: this.pendingPlan,
    } : undefined
    this.pendingPlan = false
    this.pendingPlanExplicit = false
    this.pendingPreset = undefined
    this.publishTopology()
    return ref
  }

  /** Admit the first prompt into one shared creation, leaving startup sessionless. */
  ensureSession(cwd = this.cwd, signal?: AbortSignal): Promise<SessionRef> {
    if (this.disposed) return Promise.reject(new Error('Mayfly frontend is disposed'))
    if (signal?.aborted === true) return Promise.reject(signal.reason)
    const displayed = this.displayedView?.()
    if (displayed !== undefined) {
      if (displayed.access === 'readonly') return Promise.reject(new Error('This conversation is read-only'))
      return Promise.resolve(displayed.ref)
    }
    const current = this.registry.current
    if (current !== undefined) return Promise.resolve(current)
    const host = this.requireHost()
    const client = this.registry.get(host)!
    const connectionGeneration = client.state.getSnapshot().generation
    if (this.creating?.host === host && this.creating.client === client
      && this.creating.selectionGeneration === this.selectionGeneration
      && this.creating.connectionGeneration === connectionGeneration) return this.creating.promise
    const promise = this.selectOrCreate(undefined, cwd, signal)
    const creating = { host, client, selectionGeneration: this.selectionGeneration, connectionGeneration, promise }
    this.creating = creating
    void promise.finally(() => {
      if (this.creating === creating) this.creating = undefined
    }).catch(() => {})
    return promise
  }

  /** Finish one initial mode write; an explicit plan command supersedes an unstarted startup selection. */
  async preparePrompt(ref: SessionRef, signal?: AbortSignal, intent?: 'plan'): Promise<void> {
    this.assertActive()
    signal?.throwIfAborted()
    const displayed = this.displayedView?.()
    const current = displayed?.ref ?? this.registry.current
    if (displayed?.access === 'readonly') throw new Error('This conversation is read-only')
    if (current?.host !== ref.host || current.sessionId !== ref.sessionId) {
      throw new Error('Session selection was superseded')
    }
    const preparation = this.planPreparation
    if (preparation === undefined || preparation.ref.host !== ref.host || preparation.ref.sessionId !== ref.sessionId) return
    const isCurrent = (): boolean => this.planPreparation === preparation
      && this.selectionGeneration === preparation.selectionGeneration
      && this.registry.get(ref.host) === preparation.client
      && this.registry.currentReference?.binding === preparation.binding
      && preparation.client.state.getSnapshot().generation === preparation.connectionGeneration
    if (!isCurrent()) throw new Error('Session selection was superseded')
    if (intent === 'plan' && preparation.promise === undefined) {
      this.planPreparation = undefined
      return
    }
    preparation.promise ??= (async () => {
      const result = await preparation.binding.session.command(preparation.active ? '/plan' : '/plan off')
      if (!isCurrent()) throw new Error('Session selection was superseded')
      if (!result.ok) throw new Error(result.error.message)
      if (!result.value.matched) throw new Error('This Host does not provide the plan command; no prompt was sent')
    })()
    await preparation.promise
    signal?.throwIfAborted()
    if (!isCurrent()) throw new Error('Session selection was superseded')
  }

  /** Return to the empty start view without creating or stopping a Host Session. */
  clearSession(): void {
    this.selectionGeneration += 1
    this.creating = undefined
    this.planPreparation = undefined
    this.pendingPlan = false
    this.pendingPlanExplicit = false
    this.pendingPreset = undefined
    this.registry.clearSelection()
    this.conversation.attach(null)
    this.publishTopology()
  }

  private publishTopology(): void {
    for (const listener of this.topologyListeners) listener()
  }

  async execute(text: string, signal?: AbortSignal): Promise<{ readonly exit: boolean }> {
    this.assertActive()
    signal?.throwIfAborted()
    if (!text.startsWith('/')) {
      const ref = await this.ensureSession(this.cwd, signal)
      const { current } = this.captureSelection(signal)
      await this.preparePrompt(ref, signal).catch(error => { if (current()) throw error })
      if (!current()) return { exit: false }
      const result = await this.actions.prompt(ref, {
        mode: 'queue',
        text,
        attachments: [],
        content: [{ type: 'text', text }],
        ...signal === undefined ? {} : { signal },
        isCurrent: current,
      }).catch(error => { if (current()) throw error; return undefined })
      if (current() && result !== undefined && !result.ok) this.notice.set(result.error.message, 'error')
      return { exit: false }
    }

    const separator = text.search(/\s/u)
    const name = (separator === -1 ? text.slice(1) : text.slice(1, separator)).toLowerCase()
    const input = separator === -1 ? '' : text.slice(separator).trim()
    if (name === 'quit' || name === 'q' || name === 'exit') return { exit: true }
    if (name === 'new' || name === 'clear') {
      const request = ++this.newGeneration
      if (input !== '') {
        const client = this.activeClient
        if (client === undefined) throw new Error('Attach a Host before selecting a Session')
        const connection = client.state.getSnapshot().generation
        const generation = this.selectionGeneration
        const view = this.displayedView?.()
        const current = (): boolean => {
          const nextView = this.displayedView?.()
          return !this.disposed && signal?.aborted !== true && request === this.newGeneration
            && generation === this.selectionGeneration && this.activeClient === client
            && client.state.getSnapshot().generation === connection && nextView?.binding === view?.binding
            && nextView?.ref.host === view?.ref.host && nextView?.ref.sessionId === view?.ref.sessionId && nextView?.access === view?.access
        }
        const roster = await client.remote.agentPresets.list().catch(error => { if (current()) throw error; return undefined })
        if (!current() || roster === undefined) return { exit: false }
        if (!roster.ok) throw new Error(roster.error.message)
        if (!roster.value.presets.some(preset => preset.id === input && preset.broken === undefined)) throw new Error(`unknown agent preset ${input}`)
      }
      this.clearSession()
      this.pendingPreset = input === '' ? undefined : input
      this.notice.set('starting a new session', 'info')
      return { exit: false }
    }
    if (name === 'sessions' || name === 'resume') {
      if (input !== '') {
        this.notice.set(`resuming session ${input}`, 'info')
        await this.selectOrCreate(input, this.cwd, signal)
      } else {
        if (this.sessionsBrowser === undefined) {
          this.notice.set('Session browsing is unavailable in this composition', 'error')
          return { exit: false }
        }
        const host = this.requireHost()
        const client = this.registry.get(host)!
        const connection = client.state.getSnapshot().generation
        const selected = this.registry.current
        const isCurrent = (): boolean => {
          const current = this.registry.current
          return !this.disposed && signal?.aborted !== true && this.activeClient === client && client.state.getSnapshot().generation === connection
            && selected?.host === current?.host && selected?.sessionId === current?.sessionId
        }
        this.sessionsBrowser.open(client, this.registry.current, (sessionId) => {
          if (!isCurrent()) return
          void this.selectOrCreate(sessionId, this.cwd, signal).catch((error: unknown) => {
            if (isCurrent()) this.notice.set(error instanceof Error ? error.message : String(error), 'error')
          })
        }, signal)
      }
      return { exit: false }
    }
    if (name === 'rename') {
      await this.rename(input, signal)
      return { exit: false }
    }
    if (name === 'fork') {
      const { ref, binding, current } = this.captureSelection(signal)
      if (binding.session.getSnapshot().running) { this.notice.set('cannot fork while the agent is running', 'error'); return { exit: false } }
      this.notice.set('forking the current session', 'info')
      // A fork needs a completed turn to cut at, which an empty or entirely
      // failed Session never has; report that instead of failing the submit.
      const child = await this.actions.fork(ref, {})
        .catch((error: unknown) => {
          if (current()) this.notice.set(describeSessionSplitFailure(error), 'error')
          return undefined
        })
      if (child === undefined || !current()) return { exit: false }
      await this.selectOrCreate(child.sessionId, this.cwd, signal).catch(error => {
        if (!(error instanceof Error) || (!error.message.includes('superseded') && error.name !== 'HostOperationSupersededError')) throw error
      })
      return { exit: false }
    }
    if (name === 'rewind') {
      await this.rewind(signal)
      return { exit: false }
    }
    if (name === 'init') {
      const ref = await this.ensureSession(this.cwd, signal)
      signal?.throwIfAborted()
      const { binding, current } = this.captureSelection(signal)
      if (binding.session.getSnapshot().running) { this.notice.set('cannot run /init while the agent is running', 'error'); return { exit: false } }
      await this.preparePrompt(ref, signal).catch(error => { if (current()) throw error })
      if (!current()) return { exit: false }
      if (binding.session.getSnapshot().running) { this.notice.set('cannot run /init while the agent is running', 'error'); return { exit: false } }
      const result = await this.actions.prompt(ref, {
        mode: 'queue',
        text: INIT_PROMPT,
        attachments: [],
        content: [{ type: 'text', text: INIT_PROMPT }],
        ...signal === undefined ? {} : { signal },
        isCurrent: () => {
          if (current() && binding.session.getSnapshot().running) throw new Error('cannot run /init while the agent is running')
          return current()
        },
      }).catch(error => { if (current()) throw error; return undefined })
      if (current() && result !== undefined) this.notice.set(result.ok ? 'analyzing the codebase to write AGENTS.md' : result.error.message, result.ok ? 'info' : 'error')
      return { exit: false }
    }
    if (name === 'host') {
      const current = this.registry.current?.host
      const hosts = this.registry.list().map(client => client.key === current ? `${client.key} *` : client.key)
      this.notice.set(hosts.length === 0 ? 'No attached Hosts' : hosts.join(' | '))
      return { exit: false }
    }
    if (name === 'detach') {
      const host = this.activeClient?.key
      if (host !== undefined) {
        this.selectionGeneration += 1
        this.creating = undefined
        this.planPreparation = undefined
        this.defaultModelGeneration += 1
        this.attachmentWait?.abort()
        this.conversation.setModelCatalog(host, undefined)
        this.conversation.setDefaultModel(undefined)
        this.conversation.attach(null)
        const detaching = this.registry.detach(host)
        if (this.activeHost === host) this.activeHost = undefined
        this.publishTopology()
        const generation = this.selectionGeneration
        const current = (): boolean => !this.disposed && signal?.aborted !== true && generation === this.selectionGeneration && this.registry.get(host) === undefined
        await detaching.catch(error => { if (current()) throw error })
        if (current()) this.notice.set(`Detached ${host}`)
      }
      return { exit: false }
    }
    if (name === 'attach') {
      if (input === '') throw new Error('Usage: /attach <host-url>')
      await this.attach(input, undefined, signal).catch(error => { if (!this.disposed && signal?.aborted !== true) throw error })
      return { exit: false }
    }
    if (name === 'help') {
      const view = this.displayedView?.()
      const current = view?.ref ?? this.registry.current
      const client = this.activeClient
      const connection = client?.state.getSnapshot().generation
      const selectedBinding = this.registry.currentReference?.binding
      const generation = this.selectionGeneration
      const writable = current !== undefined && view?.access !== 'readonly'
      const isCurrent = (): boolean => {
        const nextView = this.displayedView?.()
        const next = nextView?.ref ?? this.registry.current
        return !this.disposed && signal?.aborted !== true && client === this.activeClient && connection === client?.state.getSnapshot().generation
          && generation === this.selectionGeneration && selectedBinding === this.registry.currentReference?.binding
          && current?.host === next?.host && current?.sessionId === next?.sessionId
          && view?.access === nextView?.access
      }
      const commands = writable ? await this.actions.listCommands(current).catch(error => {
        if (isCurrent()) throw error
        return []
      }) : []
      if (isCurrent()) this.panels.showHelp(remoteCommandCatalog(writable, this.featureCommands(), commands))
      return { exit: false }
    }
    if (name === 'host-status') {
      this.panels.showStatus(this.displayedView?.()?.presentation ?? this.conversation.presentation())
      return { exit: false }
    }
    if (name === 'context') {
      const ref = this.requireSelection()
      const view = this.displayedView?.()
      const binding = view === undefined ? this.registry.currentReference?.binding : view.binding
      if (binding === undefined) throw new Error('The selected conversation has no native Client binding')
      const client = this.registry.get(ref.host)!
      const generation = this.selectionGeneration
      const connection = client.state.getSnapshot().generation
      const isCurrent = (): boolean => {
        const currentView = this.displayedView?.()
        const current = currentView?.ref ?? this.registry.current
        const currentBinding = currentView === undefined ? this.registry.currentReference?.binding : currentView.binding
        return !this.disposed && signal?.aborted !== true && this.selectionGeneration === generation && this.registry.get(ref.host) === client
          && client.state.getSnapshot().generation === connection && binding === currentBinding
          && current?.host === ref.host && current.sessionId === ref.sessionId
      }
      this.panels.showContext({
        read: () => isCurrent() ? remoteSessionInformation(binding, this.displayedView?.()?.presentation ?? this.conversation.presentation()) : undefined,
        subscribe: listener => {
          const disposers = [this.subscribeTopology(listener), client.state.subscribe(listener), binding.session.subscribe(listener),
            ...REMOTE_SESSION_INFO_KEYS.map(key => binding.session.projections.faceOf(key).subscribe(listener))]
          const offDisplayed = this.subscribeDisplayedView?.(listener)
          if (offDisplayed !== undefined) disposers.push(offDisplayed)
          signal?.addEventListener('abort', listener, { once: true })
          return () => { signal?.removeEventListener('abort', listener); for (const dispose of disposers) dispose() }
        },
      })
      return { exit: false }
    }
    if (name === 'changelog') {
      this.panels.showChangelog()
      return { exit: false }
    }
    if (name === 'version') {
      const client = this.activeClient
      const generation = client?.state.getSnapshot().generation
      const isCurrent = (): boolean => !this.disposed && signal?.aborted !== true && this.activeClient === client && generation === client?.state.getSnapshot().generation
      const pending = client === undefined ? undefined : this.harnessVersion(client)
      // Consume the startup read once; another /version refreshes the native
      // inventory instead of retaining a stale package version indefinitely.
      if (client !== undefined) this.hostVersions.delete(client)
      const harness = await pending?.catch(error => {
        if (isCurrent()) throw error
        return undefined
      })
      if (!isCurrent()) return { exit: false }
      this.panels.showVersion(harness)
      return { exit: false }
    }

    const { ref, current } = this.captureSelection(signal)
    const result = await this.actions.command(ref, text, current, signal).catch(error => { if (current()) throw error; return undefined })
    if (current() && result !== undefined) {
      if (!result.ok) this.notice.set(result.error.message, 'error')
      else if (!result.value.matched) this.notice.set(`unknown command: ${text}`, 'error')
    }
    return { exit: false }
  }

  private harnessVersion(client: HostClient): Promise<string | undefined> {
    const generation = client.state.getSnapshot().generation
    const cached = this.hostVersions.get(client)
    if (cached?.generation === generation) return cached.pending
    const pending = client.remote.pluginManager.listBundles().then(result => {
      if (!result.ok) throw new Error(result.error.message)
      return result.value.find(bundle => bundle.name === '@deepseek-ai/dsh-base')?.version
    })
    const entry = { generation, pending }
    this.hostVersions.set(client, entry)
    void pending.catch(() => {
      if (this.hostVersions.get(client) === entry) this.hostVersions.delete(client)
    })
    return pending
  }

  async cancel(): Promise<void> {
    const view = this.displayedView?.()
    if (view?.access === 'readonly') return
    const ref = view?.ref ?? this.registry.current
    if (ref === undefined) return
    const result = await this.actions.cancel(ref)
    if (!result.ok) this.notice.set(result.error.message, 'error')
  }

  private requireHost(): HostKey {
    const current = this.displayedView?.()?.ref.host ?? this.activeHost ?? this.registry.current?.host ?? this.registry.list()[0]?.key
    if (current === undefined) throw new Error('Attach a Host before selecting a Session')
    return current
  }

  private async rename(input: string, signal?: AbortSignal): Promise<void> {
    const { ref, binding, client, current } = this.captureSelection(signal)
    const save = async (title: string): Promise<string | undefined> => {
      if (!current()) return undefined
      try {
        const result = await this.actions.rename(ref, title, current)
        if (!current()) return undefined
        if (!result.ok) throw new Error(result.error.message)
        return result.value.title
      } catch (error) { if (current()) throw error; return undefined }
    }
    if (input !== '') {
      try {
        const title = await save(input)
        if (current()) this.notice.set(`renamed session to ${title}`, 'info')
      } catch (error) { if (current()) this.notice.set(error instanceof Error ? error.message : String(error), 'error') }
      return
    }
    const title = binding.session.projections.faceOf('title').getSnapshot()
    this.panels.showRename(typeof title === 'string' ? title : '', async value => { await save(value) }, current, listener => {
      const off = [this.subscribeTopology(listener), client.state.subscribe(listener)]
      const displayed = this.subscribeDisplayedView?.(listener)
      if (displayed !== undefined) off.push(displayed)
      signal?.addEventListener('abort', listener, { once: true })
      return () => { signal?.removeEventListener('abort', listener); for (const stop of off) stop() }
    })
  }

  private captureSelection(signal?: AbortSignal) {
    const ref = this.requireSelection()
    const view = this.displayedView?.()
    const binding = view === undefined ? this.registry.currentReference?.binding : view.binding
    if (binding === undefined) throw new Error('The selected conversation has no native Client binding')
    const client = this.registry.get(ref.host)!
    const generation = this.selectionGeneration
    const connection = client.state.getSnapshot().generation
    const current = (): boolean => {
      const nextView = this.displayedView?.()
      const next = nextView?.ref ?? this.registry.current
      const nextBinding = nextView === undefined ? this.registry.currentReference?.binding : nextView.binding
      return signal?.aborted !== true && !this.disposed && generation === this.selectionGeneration && this.registry.get(ref.host) === client
        && client.state.getSnapshot().generation === connection && nextBinding === binding
        && next?.host === ref.host && next.sessionId === ref.sessionId && nextView?.access === view?.access
    }
    return { ref, binding, client, current }
  }

  private async rewind(signal?: AbortSignal): Promise<void> {
    const ref = this.registry.current
    const binding = this.registry.currentReference?.binding
    if (ref === undefined || binding === undefined) throw new Error('no active session')
    this.displayPrimary?.()
    const client = this.registry.get(ref.host)!
    const connection = client.state.getSnapshot().generation
    const generation = this.selectionGeneration
    const current = (): boolean => !this.disposed && signal?.aborted !== true && generation === this.selectionGeneration
      && this.registry.currentReference?.binding === binding
      && this.registry.get(ref.host) === client && client.state.getSnapshot().generation === connection
    const choose = async (atSeq: number): Promise<void> => {
      if (!current()) return
      if (binding.session.getSnapshot().running) { this.notice.set('cannot rewind while the agent is running', 'error'); return }
      const child = await this.actions.fork(ref, { atSeq }).catch((error: unknown) => {
        if (current()) this.notice.set(describeSessionSplitFailure(error), 'error')
        return undefined
      })
      if (child === undefined || !current()) return
      await this.selectOrCreate(child.sessionId, this.cwd, signal)
    }
    if (binding.session.getSnapshot().running) { this.notice.set('cannot rewind while the agent is running', 'error'); return }
    const lifetime = new AbortController()
    const invalidate = (): void => { if (!current()) lifetime.abort() }
    const offApp = this.subscribeTopology(invalidate)
    const offConnection = client.state.subscribe(invalidate)
    signal?.addEventListener('abort', invalidate, { once: true })
    try {
      const events = await collectRemoteSessionEvents(client, { address: { kind: 'session', sessionId: ref.sessionId }, signal: lifetime.signal })
      if (!current()) return
      const candidates = rewindCandidates(events)
      if (candidates.length === 0) { this.notice.set('no user turns to rewind', 'info'); return }
      this.panels.showRewind?.(candidates, choose, current, invalidatePanel => {
        const off = this.subscribeTopology(invalidatePanel)
        const offState = client.state.subscribe(invalidatePanel)
        signal?.addEventListener('abort', invalidatePanel, { once: true })
        return () => { signal?.removeEventListener('abort', invalidatePanel); off(); offState() }
      })
    } catch (error) {
      if (current()) throw error
    } finally { signal?.removeEventListener('abort', invalidate); offApp(); offConnection() }
  }

  private requireSelection(): SessionRef {
    const view = this.displayedView?.()
    if (view?.access === 'readonly') throw new Error('This conversation is read-only')
    const current = view?.ref ?? this.registry.current
    if (current === undefined) throw new Error('Select or create a Session before prompting')
    return current
  }
}
