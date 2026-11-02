/**
 * Single composition mount for the operations feature family: agent/tree
 * browsing, BTW, explicit retraction, per-turn changes with deliverables,
 * export, trace, stats, plugins, update checks, and the terminal title. Every
 * module registers its own slash commands into the foundation registry and
 * owns its listeners under this mount's lifetime.
 * @module @ephemeral-ai/mayfly/remote/operations-composition
 */

import type { RemoteFeatureCommandSource } from './features/commands.ts'
import type { RemoteFeatureContext } from './features.ts'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { HostClient, SessionRef } from '../client/types.ts'
import { RemoteFeatureOperation } from './features/official.ts'
import { mountRemoteAgentsOperations } from './operations/agents.ts'
import { mountRemoteBtwOperations } from './operations/btw.ts'
import { mountRemoteChangesOperations } from './operations/changes.ts'
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
} from './operations/support.ts'

/** Options owned by the integration layer mounting this composition. */
export interface RemoteOperationsCompositionOptions {
  /** Local directory owning `/export` output; only its `mayfly-exports/` child is written. */
  readonly localCwd: string
  /** BTW orchestration over the integrator's HostActions/HostRegistry pair. */
  readonly btw: RemoteOperationsOptions['btw']
  /** Show one independent side view for a forked or cold child binding. */
  readonly present?: RemoteOperationsOptions['present']
  /** Close the side view; it never touches the Host Session behind it. */
  readonly closePresent?: RemoteOperationsOptions['closePresent']
  /** Copy text through the integrator's clipboard path. */
  readonly copy?: RemoteOperationsOptions['copy']
}

/** Mounted operations composition plus its lifetime. */
export interface RemoteOperationsCompositionHandle {
  readonly commands: RemoteFeatureCommandSource
  /** Open a listed native child through the same owned side-view slot as `/agents`. */
  openChild(client: HostClient, address: SubagentAddress, signal: AbortSignal): Promise<void>
  /** Release one exact retained side view, including the BTW service lease when applicable. */
  closeChild(ref: SessionRef): void
  dispose(): void
}

const MOUNTS = [
  mountRemoteAgentsOperations,
  mountRemoteBtwOperations,
  mountRemoteRetractOperations,
  mountRemoteChangesOperations,
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
      present: (ref, binding, facts) => { presentSlot.present(ref, binding, facts) },
      closePresent: ref => { presentSlot.close(ref) },
      ...options.copy === undefined ? {} : { copy: options.copy },
    },
    presentSlot,
  }
  const disposers: Array<() => void> = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    presentSlot.close()
    presentSlot.dispose()
    for (const disposer of disposers.splice(0).reverse()) disposer()
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
    async openChild(client, address, signal) {
      const current = base.hosts.current()
      if (disposed || signal.aborted || current?.client !== client) return
      const operation = new RemoteFeatureOperation(base, client, current, signal)
      try {
        if (!operation.valid()) return
        if (address.mode === 'unknown') await client.sessions.refreshProjections(address.parentSessionId)
        if (!operation.valid()) return
        const native = client.sessions.subagentAddress(address.childSessionId) ?? address
        const parent = { host: client.key, sessionId: native.parentSessionId }
        const child = { host: client.key, sessionId: native.childSessionId }
        const lease = options.btw.retainColdSubagentView(parent, child, 'remote-agents-cold')
        await presentSlot.adopt(child, lease, () => {
          const resolved = client.sessions.subagentAddress(child.sessionId) ?? native
          const summary = client.sessions.list.getSnapshot().byId[child.sessionId]
          return { kind: 'subagent', access: resolved.mode === 'continuable' ? 'resumable' : 'readonly', address: resolved, ...summary?.displayTitle === undefined ? {} : { label: summary.displayTitle }, ...summary?.cwd === undefined ? {} : { cwd: summary.cwd } }
        }, { signal: operation.signal, isCurrent: () => operation.valid() })
      } finally { operation.dispose() }
    },
    dispose,
  }
}
