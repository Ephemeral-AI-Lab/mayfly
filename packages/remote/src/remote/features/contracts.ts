/**
 * Structural feature-mount contracts mirrored from the Remote UI foundation.
 * The foundation context satisfies these types without a runtime dependency on
 * its coordinator module.
 * @module @ephemeral-ai/mayfly/remote/features/contracts
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  MayflyComponents,
  MayflyFocusable,
  MayflyOverlayOptions,
  MayflyScreenService,
  MayflySemanticColors,
} from '@ephemeral-ai/mayfly/core'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { HostClient, SessionRef } from '../../client/types.ts'
import type { RemoteNotice } from '../notice.ts'

/** Exact selected Client generation and borrowed Session binding. */
export interface RemoteFeatureSelection {
  readonly ref: SessionRef
  readonly client: HostClient
  readonly binding: SessionBinding
  /** Native access of a side view; primary callers may omit it. */
  readonly access?: 'interactive' | 'resumable' | 'readonly'
  /** Presentation kind; only primary selections announce resumed history. */
  readonly kind?: 'primary' | 'btw' | 'subagent'
}

/** Read-only attached-Host and exact-selection accessor owned by the foundation. */
export interface RemoteFeatureHosts {
  /** Selected Host even while the start view has no Session. */
  active?(): HostClient | undefined
  list(): readonly HostClient[]
  current(): RemoteFeatureSelection | undefined
  subscribe(listener: () => void): () => void
}

/** Options accepted by the feature-neutral overlay lease host. */
export interface RemoteFeatureOverlayOptions extends MayflyOverlayOptions {
  readonly onClosed?: () => void
}

/** One feature overlay generation; closing it never cancels Host work. */
export interface RemoteFeatureOverlayLease {
  readonly generation: number
  readonly closed: boolean
  close(): void
}

/** Feature-neutral overlay host supplied by the foundation. */
export interface RemoteFeatureOverlayHost {
  open(component: MayflyFocusable, options?: RemoteFeatureOverlayOptions): RemoteFeatureOverlayLease
  close(): void
}

/** Local live presentation, independent of Host-owned settings persistence. */
export interface RemoteLocalPresentationSnapshot {
  readonly locale: string
  readonly theme: string
}

/** Theme metadata shared by pickers and onboarding. */
export interface RemoteThemeOption {
  readonly key: string
  readonly name: string
  readonly idea: string
  readonly dark: boolean
}

/** Local theme/locale application; implementations preserve editor and panel drafts. */
export interface RemoteLocalPresentation {
  readonly snapshot: RemoteLocalPresentationSnapshot
  readonly themes: readonly RemoteThemeOption[]
  setLocale(locale: string): void
  applyTheme(theme: string): Promise<void>
  applyCustomTheme(path: string, base?: string): Promise<void>
  reloadTheme(): Promise<void>
  subscribe(listener: () => void): () => void
}

/** Foundation composition consumed by the configuration feature family. */
export interface RemoteFeatureContext {
  readonly ctx: Context
  readonly screen: MayflyScreenService
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly overlays: RemoteFeatureOverlayHost
  readonly hosts: RemoteFeatureHosts
  readonly notice: RemoteNotice
  readonly t: MayflyTranslate
  readonly subscribeLocale: (listener: () => void) => () => void
  readonly presentation: RemoteLocalPresentation
}

/** Browser and callback operations owned by the local Remote process. */
export interface RemoteAccountLocalIO {
  /** Configured Client transport/Host origin, including any SSH-forwarded loopback port. */
  callbackOrigin(client: HostClient): string | undefined
  openBrowser(url: string): Promise<boolean>
  copy(text: string): Promise<void>
  deliverCallback(url: URL, signal: AbortSignal): Promise<{ readonly status: number }>
}

/** Optional local integrations for one configuration feature mount. */
export interface RemoteFeatureAdapters {
  readonly accountIO: RemoteAccountLocalIO
  readonly clientVersion: string
}

/** A focused mount compatible with the foundation's registration manifest. */
export type RemoteFeatureMount = (context: RemoteFeatureContext) => void | (() => void)

/** Test the exact Client and Session identity captured by an operation. */
export function isRemoteFeatureSelection(
  current: RemoteFeatureSelection | undefined,
  client: HostClient,
  ref: SessionRef,
): current is RemoteFeatureSelection {
  return current?.client === client && current.ref.host === ref.host && current.ref.sessionId === ref.sessionId
}
