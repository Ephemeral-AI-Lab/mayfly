/**
 * Composition of the delivered editor feature controller with actual Client and local adapters.
 * @module @ephemeral-ai/mayfly/remote/editor-composition
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import type {
  MayflyComponents,
  MayflyEditor,
  MayflyKeymap,
  MayflyScreen,
  MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'
import type { HostClient } from '../client/types.ts'
import type { RemoteApp } from './app.ts'
import { FRONTEND_COMMANDS, remoteCommandCatalog } from './command-catalog.ts'
import { attachEditorFeatures } from './editor/index.ts'
import type {
  EditorFeatureController,
  EditorFeatureOptions,
  EditorFeatureSession,
  EditorHostFiles,
  EditorLocalAdapter,
} from './editor/types.ts'
import type { RemoteFeatureCommandSource } from './features/commands.ts'
import type { RemoteNotice } from './notice.ts'
import type { RemoteFeatureSelection } from './features/contracts.ts'

/** Generic ownership of the attached editor features and their lifecycle subscriptions. */
export interface EditorCompositionHandle {
  readonly controller: EditorFeatureController
  dispose(): void
}

interface EditorCompositionOptions {
  readonly ctx: Context
  readonly app: RemoteApp
  readonly editor: MayflyEditor
  readonly screen: MayflyScreen
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly keymap: MayflyKeymap
  readonly notice: RemoteNotice
  readonly localCwd: string
  readonly exit: () => void | Promise<void>
  /** Restore focus through the owning dock so its frame and status remain visible. */
  readonly focusEditor?: () => void
  readonly startupKey?: (data: string, text: string) => boolean
  /** Feature-owned slash-command contributions routed before Host command dispatch. */
  readonly featureCommands?: RemoteFeatureCommandSource | undefined
  /** Borrow the exact displayed binding; native SessionFace performs addressed child routing. */
  readonly selection?: () => (RemoteFeatureSelection & { readonly access: 'interactive' | 'resumable' | 'readonly' }) | undefined
  readonly subscribeSelection?: (listener: () => void) => () => void
}

/** Attach editor features once and fence their selection, reconnect, and local process lifetimes. */
export function mountEditorComposition(options: EditorCompositionOptions): EditorCompositionHandle {
  let generation = 0
  let disposed = false
  const session = (): EditorFeatureSession | undefined => {
    if (options.selection !== undefined) {
      const current = options.selection()
      return current === undefined ? undefined : { ref: current.ref, client: current.client, session: current.binding.session, generation, access: current.access }
    }
    const ref = options.app.registry.current
    const reference = options.app.registry.currentReference
    if (ref === undefined || reference === undefined) return undefined
    const client = options.app.registry.get(ref.host)
    if (client === undefined) return undefined
    return { ref, client, session: reference.binding.session, generation }
  }
  const fileClient = (sessionId: SessionId, signal: AbortSignal | undefined): HostClient => {
    signal?.throwIfAborted()
    return requireSession(session(), sessionId)
  }
  const files: EditorHostFiles = {
    stat: (sessionId, path, signal) => workspaceFiles(fileClient(sessionId, signal)).stat(sessionId, path, signal),
    readBytes: (sessionId, path, signal) => workspaceFiles(fileClient(sessionId, signal)).readBytes(sessionId, path, {}, signal),
    openWorkspacePath: (path, signal) => {
      signal.throwIfAborted()
      return openWorkspacePath(requireSelection(session()).session, path, signal)
    },
  }
  const local: EditorLocalAdapter = {
    cwd: () => options.localCwd,
    list: () => remoteCommandCatalog(session() !== undefined && session()?.access !== 'readonly', options.featureCommands?.list() ?? []),
    async execute(invocation) {
      // A live Session's plan command owns its native ordered attachments and
      // actual success/refusal; sessionless mode intent stays with the feature.
      if (invocation.name === 'plan' && invocation.session !== undefined) return { kind: 'unhandled' }
      if (invocation.attachments.length > 0) {
        return { kind: 'error', text: `/${invocation.name} does not accept attachments; no command was sent` }
      }
      if (invocation.name === 'skills') {
        await controller.openSkills()
        return { kind: 'success' }
      }
      if (!FRONTEND_COMMANDS.some(command => command.name === invocation.name)
        && await options.featureCommands?.execute(invocation.name, invocation.rawInput, invocation.signal) === true) {
        return { kind: 'success' }
      }
      const result = await options.app.execute(invocation.line)
      return { kind: 'success', exit: result.exit }
    },
    exit: options.exit,
  }
  const featureOptions: EditorFeatureOptions = {
    ctx: options.ctx,
    editor: options.editor,
    screen: options.screen,
    components: options.components,
    colors: options.colors,
    keymap: options.keymap,
    ...options.focusEditor === undefined ? {} : { focusEditor: options.focusEditor },
    ...options.startupKey === undefined ? {} : { startupKey: options.startupKey },
    session,
    async ensureSession() {
      await options.app.ensureSession(options.localCwd)
      return requireSelection(session())
    },
    preparePrompt: (selected, signal, intent) => options.app.preparePrompt(selected.ref, signal, intent),
    notice: options.notice,
    upload: (sessionId, data, name, signal) => fileClient(sessionId, signal).fileUpload.upload(sessionId, data, name, signal),
    files,
    local,
  }
  const controller = attachEditorFeatures(featureOptions)
  const connectionListeners = new Map<HostClient, () => void>()
  const connectionGenerations = new Map<HostClient, number>()
  const syncConnections = (): void => {
    const attached = new Set(options.app.registry.list())
    for (const [client, dispose] of connectionListeners) {
      if (attached.has(client)) continue
      dispose()
      connectionListeners.delete(client)
      connectionGenerations.delete(client)
    }
    for (const client of attached) {
      if (connectionListeners.has(client)) continue
      connectionGenerations.set(client, client.state.getSnapshot().generation)
      let active = true
      const stop = client.state.subscribe(() => {
        if (!active) return
        const snapshot = client.state.getSnapshot()
        if (connectionGenerations.get(client) === snapshot.generation) return
        connectionGenerations.set(client, snapshot.generation)
        generation += 1
        controller.hostReconnected()
      })
      connectionListeners.set(client, () => { active = false; stop() })
    }
  }
  const offTopology = options.app.subscribeTopology(() => {
    if (disposed) return
    generation += 1
    syncConnections()
    controller.selectionChanged()
  })
  const offSelection = options.subscribeSelection?.(() => {
    if (disposed) return
    generation += 1
    controller.selectionChanged()
  })
  syncConnections()
  return {
    controller,
    dispose() {
      if (disposed) return
      disposed = true
      offTopology()
      offSelection?.()
      for (const dispose of connectionListeners.values()) dispose()
      connectionListeners.clear()
      connectionGenerations.clear()
      controller.dispose()
    },
  }
}

function requireSession(selected: EditorFeatureSession | undefined, sessionId: SessionId): HostClient {
  const current = requireSelection(selected)
  if (current.ref.sessionId !== sessionId) throw new Error('The selected Session changed before the file operation')
  return current.client
}

function requireSelection(selected: EditorFeatureSession | undefined): EditorFeatureSession {
  if (selected === undefined) throw new Error('Select or create a Session before using Host files')
  return selected
}

interface OfficialWorkspaceFiles {
  stat(sessionId: SessionId, path: string, signal: AbortSignal): ReturnType<EditorHostFiles['stat']>
  readBytes(sessionId: SessionId, path: string, options: Readonly<Record<string, never>>, signal: AbortSignal): ReturnType<EditorHostFiles['readBytes']>
}

function workspaceFiles(client: HostClient): OfficialWorkspaceFiles {
  return (client.remote as HostClient['remote'] & { readonly workspaceFiles: OfficialWorkspaceFiles }).workspaceFiles
}

function openWorkspacePath(
  session: EditorFeatureSession['session'],
  path: string,
  signal: AbortSignal,
): ReturnType<EditorHostFiles['openWorkspacePath']> {
  const official = session as EditorFeatureSession['session'] & {
    openWorkspacePath(path: string, signal: AbortSignal): ReturnType<EditorHostFiles['openWorkspacePath']>
  }
  return official.openWorkspacePath(path, signal)
}
