import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey, type SessionRef } from '../client/types.ts'
import type { HostClient } from '../client/types.ts'
import { HostActions } from '../frontend/host-actions.ts'
import { HostRegistry } from '../frontend/host-registry.ts'
import type { RemoteConversationModelSource } from '../transcript/remote-model.ts'
import type { RemoteNotice } from './notice.ts'
import type { RemoteAppPanels, RemoteCommandDescriptor } from './interactions/plain-panels.ts'

const FRONTEND_COMMANDS = [
  { name: 'quit', description: 'Exit Mayfly (/q, /exit)' },
  { name: 'new', description: 'Start a new Session (/clear)' },
  { name: 'sessions', description: 'List Sessions, or resume by id (/resume)' },
  { name: 'host', description: 'List attached Hosts' },
  { name: 'attach', description: 'Attach a Host URL, then create a Session' },
  { name: 'detach', description: 'Detach the current Host without stopping it' },
  { name: 'help', description: 'Show local and Host commands' },
  { name: 'status', description: 'Show current Session facts' },
  { name: 'version', description: 'Show the Mayfly version' },
] satisfies readonly RemoteCommandDescriptor[]

/** Local command and Session router for the independent HTTP/WebSocket frontend. */
export class RemoteApp {
  readonly registry: HostRegistry
  readonly actions: HostActions

  private readonly endpoints = new Map<HostKey, string>()
  private readonly topologyListeners = new Set<() => void>()
  private activeHost: HostKey | undefined
  private defaultModelGeneration = 0

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
      const { createHostClient } = await import('../client/host-client.ts')
      return createHostClient({ key, startupUrl })
    })
    this.actions = new HostActions(this.registry)
  }

  /** Observe committed Host attach/detach and Session selection changes without owning them. */
  subscribeTopology(listener: () => void): () => void {
    this.topologyListeners.add(listener)
    return () => this.topologyListeners.delete(listener)
  }

  async attach(startupUrl: string, hostId?: string): Promise<HostClient> {
    const url = new URL(startupUrl)
    const key = hostId === undefined
      ? HostKey(`${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`)
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
    const host = this.requireHost()
    const ref = sessionId === undefined
      ? await this.actions.create(host, { cwd })
      : { host, sessionId: SessionId(sessionId) }
    await this.actions.select(ref)
    this.activeHost = ref.host
    this.publishTopology()
    const binding = this.registry.currentReference?.binding
    if (binding === undefined) throw new Error('Selected Session has no Client binding')
    const summary = this.registry.get(ref.host)?.sessions.list.getSnapshot().byId[ref.sessionId]
    this.conversation.attach(binding, { ref, cwd: summary?.cwd ?? (sessionId === undefined ? cwd : '') })
    return ref
  }

  private publishTopology(): void {
    for (const listener of this.topologyListeners) listener()
  }

  async execute(text: string): Promise<{ readonly exit: boolean }> {
    if (!text.startsWith('/')) {
      const ref = this.requireSelection()
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
      await this.selectOrCreate()
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
    if (name === 'host') {
      const current = this.registry.current?.host
      const hosts = this.registry.list().map(client => client.key === current ? `${client.key} *` : client.key)
      this.notice.set(hosts.length === 0 ? 'No attached Hosts' : hosts.join(' | '))
      return { exit: false }
    }
    if (name === 'detach') {
      const host = this.registry.current?.host ?? this.registry.list()[0]?.key
      if (host !== undefined) {
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
      await this.selectOrCreate()
      return { exit: false }
    }
    if (name === 'help') {
      const commands = await this.actions.listCommands(this.requireSelection())
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
