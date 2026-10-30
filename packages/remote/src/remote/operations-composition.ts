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

/** Mount every operations module over one shared presented-view slot. */
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
      present: (ref, binding) => { presentSlot.present(ref, binding) },
      closePresent: () => { presentSlot.close() },
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
    for (const disposer of disposers.splice(0).reverse()) disposer()
  }
  try {
    for (const mount of MOUNTS) disposers.push(mount(context))
  } catch (error) {
    dispose()
    throw error
  }
  return { commands: base.commands, dispose }
}
