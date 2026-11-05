/**
 * Single composition mount for the operations feature family: agent/tree
 * browsing, BTW, explicit retraction, recorded files and native comparisons,
 * export, trace, stats, plugins, update checks, and the terminal title. Every
 * module registers its own slash commands into the foundation registry and
 * owns its listeners under this mount's lifetime.
 * @module @ephemeral-ai/mayfly/app/operations-composition
 */

import type { RemoteFeatureCommandSource } from './features/commands.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from './features.ts'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { HostClient, SessionRef } from '../client/types.ts'
import { RemoteFeatureOperation, remoteValue } from './features/official.ts'
import { mountRemoteAgentsOperations } from './operations/agents.ts'
import { mountRemoteBtwOperations } from './operations/btw.ts'
import { mountRemoteExportOperations } from './operations/export.ts'
import { mountRemoteRetractOperations } from './operations/retract.ts'
import { mountRemoteCopyOperations } from './operations/copy.ts'
import { mountRemoteFilesOperations } from './operations/files.ts'
import { mountRemotePluginOperations } from './operations/plugins.ts'
import { mountRemotePresetOperations } from './operations/presets.ts'
import { mountRemoteProviderOperations } from './operations/providers.ts'
import { mountRemoteStatsOperations } from './operations/stats.ts'
import { mountRemoteTitleOperations } from './operations/title.ts'
import { mountRemoteTraceOperations } from './operations/trace.ts'
import {
  RemotePresentSlot,
  type RemoteOperationsContext,
  type RemoteOperationsOptions,
  type RemotePresentedViewFacts,
} from './operations/support.ts'

/** Options owned by the integration layer mounting this composition. */
export interface RemoteOperationsCompositionOptions {
  /** Local working directory for relative export paths. */
  readonly localCwd: string
  readonly primary?: RemoteOperationsOptions['primary']
  readonly showPrimary?: RemoteOperationsOptions['showPrimary']
  /** BTW orchestration over the integrator's HostActions/HostRegistry pair. */
  readonly btw: RemoteOperationsOptions['btw']
  /** Show one independent side view for a forked or cold child binding. */
  readonly present?: RemoteOperationsOptions['present']
  /** Close the side view; it never touches the Host Session behind it. */
  readonly closePresent?: RemoteOperationsOptions['closePresent']
  /** Copy text through the integrator's clipboard path. */
  readonly copy?: RemoteOperationsOptions['copy']
  /** Read native model metadata from the primary owner's current exact Host catalog. */
  readonly modelCatalog?: RemoteOperationsOptions['modelCatalog']
}

/** Mounted operations composition plus its lifetime. */
export interface RemoteOperationsCompositionHandle {
  readonly commands: RemoteFeatureCommandSource
  /** Open a listed native child through the same owned side-view slot as `/agents`. */
  openChild(client: HostClient, address: SubagentAddress, signal: AbortSignal): Promise<void>
  /** Reacquire a listed ordinary BTW fork through this same side-view lease owner. */
  openBtw(client: HostClient, ref: SessionRef, facts: RemotePresentedViewFacts, signal: AbortSignal): Promise<void>
  /** Release native bindings of listed descriptors without removing any conversation. */
  retainOnly(refs: readonly SessionRef[]): void
  /** Release one exact retained side view, including the BTW service lease when applicable. */
  closeChild(ref: SessionRef): void
  dispose(): void
}

const MOUNTS = [
  mountRemoteAgentsOperations,
  mountRemoteBtwOperations,
  mountRemoteRetractOperations,
  mountRemoteExportOperations,
  mountRemoteTraceOperations,
  mountRemoteStatsOperations,
  mountRemotePluginOperations,
  mountRemoteCopyOperations,
  mountRemoteFilesOperations,
  mountRemotePresetOperations,
  mountRemoteProviderOperations,
  mountRemoteTitleOperations,
] as const

/** Mount every operations module over one shared retained-view lease owner. */
export function mountRemoteOperationsComposition(
  base: RemoteFeatureContext,
  options: RemoteOperationsCompositionOptions,
): RemoteOperationsCompositionHandle {
  const presentSlot = new RemotePresentSlot({
    ...options.present === undefined ? {} : { present: options.present },
    ...options.closePresent === undefined ? {} : { closePresent: options.closePresent },
  })
  const context: RemoteOperationsContext = {
    base,
    options: {
      localCwd: options.localCwd,
      btw: options.btw,
      ...options.primary === undefined ? {} : { primary: options.primary },
      ...options.showPrimary === undefined ? {} : { showPrimary: options.showPrimary },
      present: (ref, binding, facts) => { presentSlot.present(ref, binding, facts) },
      closePresent: ref => { presentSlot.close(ref) },
      ...options.copy === undefined ? {} : { copy: options.copy },
      ...options.modelCatalog === undefined ? {} : { modelCatalog: options.modelCatalog },
    },
    presentSlot,
  }
  const disposers: Array<() => void> = []
  const lifetime = new AbortController()
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    lifetime.abort()
    presentSlot.close()
    presentSlot.dispose()
    for (const disposer of disposers.splice(0).reverse()) disposer()
  }
  const beginViewRead = (client: HostClient, current: RemoteFeatureSelection, signal: AbortSignal): RemoteFeatureOperation => {
    const operation = new RemoteFeatureOperation(base, client, current, AbortSignal.any([signal, lifetime.signal]))
    const invalidate = (): void => { if (!operation.valid()) operation.dispose() }
    operation.onDispose(base.hosts.subscribe(invalidate))
    operation.onDispose(client.state.subscribe(invalidate))
    return operation
  }
  try {
    for (const mount of MOUNTS) disposers.push(mount(context))
  } catch (error) {
    dispose()
    throw error
  }
  return {
    commands: base.commands,
    closeChild(ref) {
      const btw = options.btw.current()?.child
      if (btw?.host === ref.host && btw.sessionId === ref.sessionId) options.btw.close()
      presentSlot.close(ref)
    },
    retainOnly(refs) {
      presentSlot.retainOnly(refs)
      const btw = options.btw.current()?.child
      if (btw !== undefined && !refs.some(ref => ref.host === btw.host && ref.sessionId === btw.sessionId)) options.btw.close()
    },
    async openBtw(client, ref, facts, signal) {
      const current = base.hosts.current()
      if (disposed || signal.aborted || current?.client !== client || ref.host !== client.key) return
      const operation = beginViewRead(client, current, signal)
      try {
        if (!operation.valid()) return
        const lease = options.btw.retainBtwView(ref, 'remote-btw-retained')
        await presentSlot.adopt(ref, lease, () => ({ ...facts, kind: 'btw', access: 'interactive' }), { signal: operation.signal, isCurrent: () => operation.valid() })
      } catch (error) {
        if (operation.valid()) throw error
      } finally { operation.dispose() }
    },
    async openChild(client, address, signal) {
      const current = base.hosts.current()
      if (disposed || signal.aborted || current?.client !== client) return
      const operation = beginViewRead(client, current, signal)
      try {
        if (!operation.valid()) return
        if (address.mode === 'unknown') await client.sessions.refreshProjections(address.parentSessionId)
        if (!operation.valid()) return
        const native = client.sessions.subagentAddress(address.childSessionId) ?? address
        const live = native.mode === 'continuable'
          ? (await remoteValue(client.remote.session.list({}, operation.signal))).items.some(summary => summary.sessionId === native.childSessionId && summary.agentAvailable)
          : false
        if (!operation.valid()) return
        const parent = { host: client.key, sessionId: native.parentSessionId }
        const child = { host: client.key, sessionId: native.childSessionId }
        const lease = options.btw.retainColdSubagentView(parent, child, 'remote-agents-cold')
        await presentSlot.adopt(child, lease, () => {
          const resolved = client.sessions.subagentAddress(child.sessionId) ?? native
          const summary = client.sessions.list.getSnapshot().byId[child.sessionId]
          return { kind: 'subagent', access: resolved.mode === 'continuable' ? live ? 'interactive' : 'resumable' : 'readonly', address: resolved, ...summary?.displayTitle === undefined ? {} : { label: summary.displayTitle }, ...summary?.cwd === undefined ? {} : { cwd: summary.cwd } }
        }, { signal: operation.signal, isCurrent: () => operation.valid() })
      } catch (error) {
        if (operation.valid()) throw error
      } finally { operation.dispose() }
    },
    dispose,
  }
}
