import { rewindCandidates } from '@ephemeral-ai/mayfly/command-panels'
import { collectRemoteSessionEvents } from './operations/support.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { HostKey, type SessionRef } from '../client/types.ts'
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

/** A displayed native side selection supplied by the presentation owner. */
export interface RemoteAppView {
  readonly ref: SessionRef
  readonly access: 'interactive' | 'resumable' | 'readonly'
  readonly presentation: RemotePresentationFacts
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
  private readonly hostVersions = new WeakMap<HostClient, {
    readonly generation: number
    readonly pending: Promise<string | undefined>
  }>()
  private selectionGeneration = 0
  private creating: Promise<SessionRef> | undefined
  private pendingPlan = false
  private pendingPlanExplicit = false
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

  /** Selected Host for Session-independent configuration and the empty start view. */
  get activeClient(): HostClient | undefined {
    const key = this.displayedView?.()?.ref.host ?? this.registry.current?.host ?? this.activeHost ?? this.registry.list()[0]?.key
    return key === undefined ? undefined : this.registry.get(key)
  }

  async attach(startupUrl: string, hostId?: string): Promise<HostClient> {
    const url = new URL(startupUrl)
    // Credentials and query parameters identify authentication, not the Host.
    // Scheme and mount path do identify distinct backends behind one authority.
    const key = hostId === undefined
      ? HostKey(`${url.origin}${url.pathname.replace(/\/+$/u, '')}/`)
      : HostKey(hostId)
    const generation = ++this.defaultModelGeneration
    this.endpoints.set(key, startupUrl)
    const client = await this.registry.attach(key)
    // The native inventory includes full management metadata. Warm this read
    // during startup so the local version panel does not wait for it on Enter.
    void this.harnessVersion(client).catch(() => {})
    if (generation === this.defaultModelGeneration) this.activeHost = key
    this.publishTopology()
    const connection = client.state.getSnapshot().generation
    const current = (): boolean => generation === this.defaultModelGeneration
      && this.registry.get(key) === client && client.state.getSnapshot().generation === connection
    const result = await Promise.all([client.sessions.refresh(), this.actions.modelCatalog(key)]).catch(error => {
      if (current()) throw error
      return undefined
    })
    if (current() && result !== undefined) {
      const catalog = result[1]
      if (!catalog.ok) throw catalog.error
      this.conversation.setModelCatalog(key, catalog.value)
      this.conversation.setDefaultModel(catalog.value.default)
    }
    return client
  }

  async selectOrCreate(sessionId?: string, cwd = this.cwd): Promise<SessionRef> {
    const generation = ++this.selectionGeneration
    const host = this.requireHost()
    const ref = sessionId === undefined
      ? await this.actions.create(host, { cwd })
      : { host, sessionId: SessionId(sessionId) }
    if (generation !== this.selectionGeneration) throw new Error('Session selection was superseded')
    await this.actions.select(ref)
    if (generation !== this.selectionGeneration) throw new Error('Session selection was superseded')
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
    this.publishTopology()
    return ref
  }

  /** Admit the first prompt into one shared creation, leaving startup sessionless. */
  ensureSession(cwd = this.cwd): Promise<SessionRef> {
    if (this.creating !== undefined) return this.creating
    const displayed = this.displayedView?.()
    if (displayed !== undefined) {
      if (displayed.access === 'readonly') return Promise.reject(new Error('This conversation is read-only'))
      return Promise.resolve(displayed.ref)
    }
    const current = this.registry.current
    if (current !== undefined) return Promise.resolve(current)
    const creating = this.selectOrCreate(undefined, cwd)
    this.creating = creating
    void creating.finally(() => {
      if (this.creating === creating) this.creating = undefined
    }).catch(() => {})
    return creating
  }

  /** Finish one exact initial mode write before admitting a prompt; failed writes are never retried. */
  async preparePrompt(ref: SessionRef, signal?: AbortSignal): Promise<void> {
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
    this.registry.clearSelection()
    this.conversation.attach(null)
    this.publishTopology()
  }

  private publishTopology(): void {
    for (const listener of this.topologyListeners) listener()
  }

  async execute(text: string): Promise<{ readonly exit: boolean }> {
    if (!text.startsWith('/')) {
      const ref = await this.ensureSession()
      await this.preparePrompt(ref)
      const result = await this.actions.prompt(ref, {
        mode: 'queue',
        text,
        attachments: [],
        content: [{ type: 'text', text }],
      })
      if (!result.ok) this.notice.set(result.error.message)
      return { exit: false }
    }

    const separator = text.search(/\s/u)
    const name = (separator === -1 ? text.slice(1) : text.slice(1, separator)).toLowerCase()
    const input = separator === -1 ? '' : text.slice(separator).trim()
    if (name === 'quit' || name === 'q' || name === 'exit') return { exit: true }
    if (name === 'new' || name === 'clear') {
      this.clearSession()
      this.notice.set('starting a new session')
      return { exit: false }
    }
    if (name === 'sessions' || name === 'resume') {
      if (input !== '') {
        this.notice.set(`Resuming Session ${input}`)
        await this.selectOrCreate(input)
      } else {
        if (this.sessionsBrowser === undefined) {
          this.notice.set('Session browsing is unavailable in this composition')
          return { exit: false }
        }
        const host = this.requireHost()
        const client = this.registry.get(host)!
        const connection = client.state.getSnapshot().generation
        const selected = this.registry.current
        const isCurrent = (): boolean => {
          const current = this.registry.current
          return this.activeClient === client && client.state.getSnapshot().generation === connection
            && selected?.host === current?.host && selected?.sessionId === current?.sessionId
        }
        this.sessionsBrowser.open(client, this.registry.current, (sessionId) => {
          if (!isCurrent()) return
          void this.selectOrCreate(sessionId).catch((error: unknown) => {
            if (isCurrent()) this.notice.set(error instanceof Error ? error.message : String(error))
          })
        })
      }
      return { exit: false }
    }
    if (name === 'rename') {
      const ref = this.requireSelection()
      if (input === '') throw new Error('Usage: /rename <title>')
      const result = await this.actions.rename(ref, input)
      if (!result.ok) this.notice.set(result.error.message)
      else this.notice.set(`Renamed to ${result.value.title}`)
      return { exit: false }
    }
    if (name === 'fork') {
      const ref = this.requireSelection()
      const atSeq = input === '' ? undefined : Number(input)
      if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) {
        throw new Error('Usage: /fork [atSeq]')
      }
      // A fork needs a completed turn to cut at, which an empty or entirely
      // failed Session never has; report that instead of failing the submit.
      const child = await this.actions.fork(ref, atSeq === undefined ? {} : { atSeq })
        .catch((error: unknown) => {
          this.notice.set(describeSessionSplitFailure(error))
          return undefined
        })
      if (child === undefined) return { exit: false }
      this.notice.set(`Forked into ${child.sessionId}`)
      await this.selectOrCreate(child.sessionId)
      return { exit: false }
    }
    if (name === 'rewind') {
      await this.rewind(input)
      return { exit: false }
    }
    if (name === 'init') {
      const ref = await this.ensureSession()
      await this.preparePrompt(ref)
      const result = await this.actions.prompt(ref, {
        mode: 'queue',
        text: INIT_PROMPT,
        attachments: [],
        content: [{ type: 'text', text: INIT_PROMPT }],
      })
      this.notice.set(result.ok
        ? 'Analyzing the codebase to write AGENTS.md'
        : result.error.message)
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
        this.conversation.setModelCatalog(host, undefined)
        this.conversation.setDefaultModel(undefined)
        this.conversation.attach(null)
        const detaching = this.registry.detach(host)
        if (this.activeHost === host) this.activeHost = undefined
        this.publishTopology()
        await detaching
        this.notice.set(`Detached ${host}`)
      }
      return { exit: false }
    }
    if (name === 'attach') {
      if (input === '') throw new Error('Usage: /attach <host-url>')
      await this.attach(input)
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
        return client === this.activeClient && connection === client?.state.getSnapshot().generation
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
        return this.selectionGeneration === generation && this.registry.get(ref.host) === client
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
          return () => { for (const dispose of disposers) dispose() }
        },
      })
      return { exit: false }
    }
    if (name === 'version') {
      const client = this.activeClient
      const generation = client?.state.getSnapshot().generation
      const isCurrent = (): boolean => this.activeClient === client && generation === client?.state.getSnapshot().generation
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

    const result = await this.actions.command(this.requireSelection(), text)
    if (!result.ok) this.notice.set(result.error.message)
    else if (!result.value.matched) this.notice.set(`Unknown command: ${text}`)
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
    if (!result.ok) this.notice.set(result.error.message)
  }

  private requireHost(): HostKey {
    const current = this.activeHost ?? this.registry.current?.host ?? this.registry.list()[0]?.key
    if (current === undefined) throw new Error('Attach a Host before selecting a Session')
    return current
  }

  private async rewind(input: string): Promise<void> {
    const ref = this.registry.current
    const binding = this.registry.currentReference?.binding
    if (ref === undefined || binding === undefined) throw new Error('no active session')
    this.displayPrimary?.()
    const client = this.registry.get(ref.host)!
    const connection = client.state.getSnapshot().generation
    const generation = this.selectionGeneration
    const current = (): boolean => generation === this.selectionGeneration
      && this.registry.currentReference?.binding === binding
      && this.registry.get(ref.host) === client && client.state.getSnapshot().generation === connection
    const choose = async (atSeq: number): Promise<void> => {
      if (!current()) return
      if (binding.session.getSnapshot().running) { this.notice.set('cannot rewind while the agent is running'); return }
      const child = await this.actions.fork(ref, { atSeq }).catch((error: unknown) => {
        if (current()) this.notice.set(describeSessionSplitFailure(error))
        return undefined
      })
      if (child === undefined || !current()) return
      this.notice.set(`Rewound into ${child.sessionId} at ${String(atSeq)}`)
      await this.selectOrCreate(child.sessionId)
    }
    if (binding.session.getSnapshot().running) { this.notice.set('cannot rewind while the agent is running'); return }
    if (input !== '') {
      const atSeq = Number(input)
      if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('Usage: /rewind [seq]')
      await choose(atSeq)
      return
    }
    const lifetime = new AbortController()
    const invalidate = (): void => { if (!current()) lifetime.abort() }
    const offApp = this.subscribeTopology(invalidate)
    const offConnection = client.state.subscribe(invalidate)
    try {
      const events = await collectRemoteSessionEvents(client, { address: { kind: 'session', sessionId: ref.sessionId }, signal: lifetime.signal })
      if (!current()) return
      const candidates = rewindCandidates(events)
      if (candidates.length === 0) { this.notice.set('no user turns to rewind'); return }
      this.panels.showRewind?.(candidates, choose, current, invalidatePanel => {
        const off = this.subscribeTopology(invalidatePanel)
        const offState = client.state.subscribe(invalidatePanel)
        return () => { off(); offState() }
      })
    } catch (error) {
      if (current()) throw error
    } finally { offApp(); offConnection() }
  }

  private requireSelection(): SessionRef {
    const view = this.displayedView?.()
    if (view?.access === 'readonly') throw new Error('This conversation is read-only')
    const current = view?.ref ?? this.registry.current
    if (current === undefined) throw new Error('Select or create a Session before prompting')
    return current
  }
}
