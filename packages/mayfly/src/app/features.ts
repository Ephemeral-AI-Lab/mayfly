/**
 * Feature-mount contracts and the single registration manifest for independent Remote UI lanes.
 * @module @ephemeral-ai/mayfly/remote/features
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  MayflyComponents,
  MayflyScreenService,
  MayflySemanticColors,
} from '../core.ts'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { HostClient, SessionRef } from '../client/types.ts'
import { mountApprovalInteractions } from './interactions/approval.ts'
import { mountRemoteInteractionLocale } from './interactions/locale.ts'
import type { RemoteNotice } from './notice.ts'
import type { RemoteOverlayHost } from './panels.ts'
import { mountQuestionInteractions } from './interactions/questions.ts'
import { RemoteFeatureCommandRegistry, type RemoteFeatureCommandSource } from './features/commands.ts'
import { mountActivityFeature } from './features/activity.ts'
import { mountCatalogFeature } from './features/catalog.ts'
import { mountGitFeature } from './features/git.ts'
import { mountGoalFeature } from './features/goal.ts'
import { mountJobsFeature } from './features/jobs.ts'
import { mountPlanFeature } from './features/plan.ts'
import { mountScheduleFeature } from './features/schedule.ts'
import { mountTodoFeature } from './features/todo.ts'
import { mountWorkflowFeature } from './features/workflow.ts'
import { mountRemoteProductivityLocales } from './features/locales.ts'

/** Exact selected Client generation and borrowed binding, valid only while the accessor still returns it. */
export interface RemoteFeatureSelection {
  readonly ref: SessionRef
  readonly client: HostClient
  readonly binding: SessionBinding
  /** Native side-view access; omitted primary selections are interactive. */
  readonly access?: 'interactive' | 'resumable' | 'readonly'
  /** Only the primary selection announces resumed history. */
  readonly kind?: 'primary' | 'btw' | 'subagent'
}

/** Read-only topology and selection seam; HostRegistry remains the sole owner. */
export interface RemoteFeatureHosts {
  /** Selected Host even while the start view has no Session. */
  active?(): HostClient | undefined
  /** Committed Host Clients, used to mount and retire per-Host event listeners. */
  list(): readonly HostClient[]
  /** Current exact selection and binding, absent during detach or incomplete selection. */
  current(): RemoteFeatureSelection | undefined
  /** Observe Host attach/detach and Session selection commits. */
  subscribe(listener: () => void): () => void
}

/** App-owned next-Session intent, applied before the first prompt is admitted. */
export interface RemoteStartupPlan {
  pending(): boolean | undefined
  set(active: boolean): void
}

/** Shared composition available to every focused Remote feature module. */
export interface RemoteFeatureMountContext {
  readonly ctx: Context
  readonly screen: MayflyScreenService
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly overlays: RemoteOverlayHost
  readonly hosts: RemoteFeatureHosts
  /** Replace the local prompt only while the exact status action still owns it. */
  readonly editPrompt?: (text: string, current: () => boolean) => boolean
  readonly startupPlan?: RemoteStartupPlan
  readonly notice: RemoteNotice
}

/** Feature context after the manifest installs its shared locale catalog and command registry. */
export interface RemoteFeatureContext extends RemoteFeatureMountContext {
  readonly t: MayflyTranslate
  readonly subscribeLocale: (listener: () => void) => () => void
  readonly commands: RemoteFeatureCommandRegistry
}

/** One focused feature mount; its disposer owns every listener, stream, and pending panel. */
export type RemoteFeatureMount = (context: RemoteFeatureContext) => void | (() => void)

/** Mounted feature teardown plus its instance-owned local command source and shared context. */
export interface RemoteFeatureHandle {
  readonly commands: RemoteFeatureCommandSource
  /** The exact context every productive mount received, for lane compositions to join. */
  readonly context: RemoteFeatureContext
  dispose(): void
}

const MOUNTS: readonly RemoteFeatureMount[] = [
  mountApprovalInteractions,
  mountQuestionInteractions,
  mountActivityFeature,
  mountGoalFeature,
  mountTodoFeature,
  mountPlanFeature,
  mountScheduleFeature,
  mountJobsFeature,
  mountWorkflowFeature,
  mountGitFeature,
  mountCatalogFeature,
]

/** Mount the registered feature lanes without exposing their controllers to runtime composition. */
export function mountRemoteFeatures(base: RemoteFeatureMountContext): RemoteFeatureHandle {
  const commands = new RemoteFeatureCommandRegistry()
  mountRemoteProductivityLocales(base.ctx)
  const context: RemoteFeatureContext = {
    ...base,
    t: mountRemoteInteractionLocale(base.ctx),
    subscribeLocale: listener => base.ctx.mayflyLocale.subscribe(() => listener()),
    commands,
  }
  const disposers: Array<() => void> = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.splice(0).reverse()) disposer()
    commands.clear()
  }
  try {
    for (const mount of MOUNTS) {
      const disposer = mount(context)
      if (disposer !== undefined) disposers.push(disposer)
    }
  } catch (error) {
    dispose()
    throw error
  }
  return { commands, context, dispose }
}
