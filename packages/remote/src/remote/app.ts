import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type SessionRef } from '../client/types.ts'
import type { HostClient } from '../client/types.ts'
import { HostActions } from '../frontend/host-actions.ts'
import { RemoteBtwService } from '../frontend/btw.ts'
import { HostRegistry } from '../frontend/host-registry.ts'
import type { RemoteConversationModelSource } from '../transcript/remote-model.ts'
import type { RemoteNotice } from './notice.ts'
import type { RemoteAppPanels, RemoteCommandDescriptor } from './interactions/plain-panels.ts'

export const FRONTEND_COMMANDS = [
  { name: 'quit', description: 'Exit Mayfly (/q, /exit)' },
  { name: 'new', description: 'Start a new Session (/clear)' },
  { name: 'sessions', description: 'List Sessions, or resume by id (/resume)' },
  { name: 'rename', description: 'Rename the current Session: /rename <title>' },
  { name: 'fork', description: 'Fork the current Session and switch to the child: /fork [atSeq]' },
  { name: 'rewind', description: 'Fork the Session at an event and switch to it: /rewind <seq>' },
  { name: 'host', description: 'List attached Hosts' },
  { name: 'attach', description: 'Attach a Host URL' },
  { name: 'detach', description: 'Detach the current Host without stopping it' },
  { name: 'skills', description: 'List available skills' },
  { name: 'help', description: 'Show local and Host commands' },
  { name: 'status', description: 'Show current Session facts' },
  { name: 'version', description: 'Show the Mayfly version' },
  { name: 'init', description: 'Analyze the codebase and write AGENTS.md' },
] satisfies readonly RemoteCommandDescriptor[]

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
  private selectionGeneration = 0
  private creating: Promise<SessionRef> | undefined

  constructor(
    private readonly conversation: RemoteConversationModelSource,
    private readonly notice: RemoteNotice,
    private readonly panels: RemoteAppPanels,
    attach?: (key: HostKey, startupUrl: string) => HostClient | Promise<HostClient>,
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
    this.activeHost = key
    this.publishTopology()
    const [, defaultModel] = await Promise.all([client.sessions.refresh(), this.actions.defaultModel(key)])
    if (generation === this.defaultModelGeneration) this.conversation.setDefaultModel(defaultModel)
    return client
  }

  async selectOrCreate(sessionId?: string, cwd = process.cwd()): Promise<SessionRef> {
    const generation = ++this.selectionGeneration
    const host = this.requireHost()
    const ref = sessionId === undefined
      ? await this.actions.create(host, { cwd })
      : { host, sessionId: SessionId(sessionId) }
    if (generation !== this.selectionGeneration) throw new Error('Session selection was superseded')
    await this.actions.select(ref)
    if (generation !== this.selectionGeneration) throw new Error('Session selection was superseded')
    this.activeHost = ref.host
    this.publishTopology()
    const binding = this.registry.currentReference?.binding
    if (binding === undefined) throw new Error('Selected Session has no Client binding')
    const summary = this.registry.get(ref.host)?.sessions.list.getSnapshot().byId[ref.sessionId]
    this.conversation.attach(binding, { ref, cwd: summary?.cwd ?? (sessionId === undefined ? cwd : '') })
    return ref
  }

  /** Admit the first prompt into one shared creation, leaving startup sessionless. */
  ensureSession(cwd = process.cwd()): Promise<SessionRef> {
    const current = this.registry.current
    if (current !== undefined) return Promise.resolve(current)
    if (this.creating !== undefined) return this.creating
    const creating = this.selectOrCreate(undefined, cwd)
    this.creating = creating
    void creating.finally(() => {
      if (this.creating === creating) this.creating = undefined
    }).catch(() => {})
    return creating
  }

  /** Return to the empty start view without creating or stopping a Host Session. */
  clearSession(): void {
    this.selectionGeneration += 1
    this.creating = undefined
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
      return { exit: false }
    }
    if (name === 'sessions' || name === 'resume') {
      if (input !== '') {
        this.notice.set(`Resuming Session ${input}`)
        await this.selectOrCreate(input)
      } else {
        const host = this.requireHost()
        const catalog = this.actions.sessionList(host).getSnapshot()
        const sessions = catalog.ids.flatMap((id) => {
          const summary = catalog.byId[id]
          return summary === undefined ? [] : [summary]
        })
        this.panels.showSessions(sessions, this.registry.current, (sessionId) => {
          void this.selectOrCreate(sessionId).catch((error: unknown) => {
            this.notice.set(error instanceof Error ? error.message : String(error))
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
      const ref = this.requireSelection()
      if (input === '') {
        this.notice.set('/rewind <seq> forks this Session at that event and switches to the child')
        return { exit: false }
      }
      const atSeq = Number(input)
      if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('Usage: /rewind <seq>')
      const child = await this.actions.fork(ref, { atSeq })
        .catch((error: unknown) => {
          this.notice.set(describeSessionSplitFailure(error))
          return undefined
        })
      if (child === undefined) return { exit: false }
      this.notice.set(`Rewound into ${child.sessionId} at ${input}`)
      await this.selectOrCreate(child.sessionId)
      return { exit: false }
    }
    if (name === 'init') {
      const ref = await this.ensureSession()
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
      const host = this.registry.current?.host ?? this.registry.list()[0]?.key
      if (host !== undefined) {
        this.selectionGeneration += 1
        this.creating = undefined
        this.defaultModelGeneration += 1
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
      const current = this.registry.current
      const commands = current === undefined ? [] : await this.actions.listCommands(current)
      this.panels.showHelp([...FRONTEND_COMMANDS, ...commands])
      return { exit: false }
    }
    if (name === 'status') {
      this.panels.showStatus(this.conversation.presentation())
      return { exit: false }
    }
    if (name === 'version') {
      this.panels.showVersion()
      return { exit: false }
    }

    const result = await this.actions.command(this.requireSelection(), text)
    if (!result.ok) this.notice.set(result.error.message)
    else if (!result.value.matched) this.notice.set(`Unknown command: ${text}`)
    return { exit: false }
  }

  async cancel(): Promise<void> {
    const ref = this.registry.current
    if (ref === undefined) return
    const result = await this.actions.cancel(ref)
    if (!result.ok) this.notice.set(result.error.message)
  }

  private requireHost(): HostKey {
    const current = this.activeHost ?? this.registry.current?.host ?? this.registry.list()[0]?.key
    if (current === undefined) throw new Error('Attach a Host before selecting a Session')
    return current
  }

  private requireSelection(): SessionRef {
    const current = this.registry.current
    if (current === undefined) throw new Error('Select or create a Session before prompting')
    return current
  }
}
