/**
 * Assembly for the models/providers/account/onboarding/settings/permissions
 * feature family. The foundation adds one manifest entry and supplies account
 * transport I/O; shared app/runtime/panels remain untouched.
 * @module @ephemeral-ai/mayfly/remote/features/configuration
 */

import { interpolateLocaleMessage, memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { interactionTranslator, mountInteractionLocale } from '@ephemeral-ai/mayfly/editor-presentation'
import type { HostClient } from '../../client/types.ts'
import { RemoteAccountController } from './account.ts'
import type { RemoteConfigurationHost } from './configuration-host.ts'
import { RemoteFeatureCommandRegistry } from './commands.ts'
import { REMOTE_CONFIGURATION_LOCALE } from './locale.ts'
import type {
  RemoteFeatureAdapters,
  RemoteFeatureContext,
  RemoteLocalPresentation,
} from './contracts.ts'
import { RemoteModelsController } from './models.ts'
import { RemoteOnboardingController } from './onboarding.ts'
import { RemotePermissionsController } from './permissions.ts'
import { RemotePreferencesController } from './preferences.ts'
import { CordisRemoteLocalPresentation } from './presentation.ts'
import { RemoteAgentPresetsController } from './presets.ts'
import { RemoteProvidersController } from './providers.ts'
import { RemoteSettingsController, type RemoteSettingsEdit } from './settings.ts'
import { onRemoteSettingsDocumentUpdated } from './official.ts'

/** Foundation context before the optional local presentation adapter is installed. */
export type RemoteConfigurationMountContext = Omit<RemoteFeatureContext, 'presentation'> & {
  readonly presentation?: RemoteLocalPresentation
  readonly commands: RemoteFeatureCommandRegistry
}

/** Optional focused Host DTO adapters and the integration-owned settings editor. */
export interface RemoteConfigurationAdapters extends RemoteFeatureAdapters {
  readonly host?: RemoteConfigurationHost
  readonly settingsEdit?: RemoteSettingsEdit
}

/** Controllers exposed for foundation command routing plus their joint lifetime. */
export interface RemoteConfigurationFeatures {
  readonly models: RemoteModelsController
  readonly providers: RemoteProvidersController
  readonly account: RemoteAccountController
  readonly onboarding: RemoteOnboardingController
  readonly settings: RemoteSettingsController
  readonly permissions: RemotePermissionsController
  readonly presets: RemoteAgentPresetsController
  readonly preferences: RemotePreferencesController
  dispose(): void
}

/** Construct every controller and start once-per-Host onboarding readiness. */
export function createRemoteConfigurationFeatures(
  base: RemoteConfigurationMountContext,
  adapters: RemoteConfigurationAdapters,
): RemoteConfigurationFeatures {
  const presentation = base.presentation ?? new CordisRemoteLocalPresentation(base)
  mountInteractionLocale(base.ctx)
  const releaseLocale = base.ctx.effect(() => base.ctx.mayflyLocale.register('remote-configuration', REMOTE_CONFIGURATION_LOCALE))
  const remoteTranslate = memoizedLocaleTranslator(base.ctx, 'remote-configuration').translate
  const referenceTranslate = interactionTranslator(base.ctx)
  const context: RemoteFeatureContext = {
    ...base,
    t: (key, values) => {
      const translated = remoteTranslate(key, values)
      return translated === interpolateLocaleMessage(key, values) ? referenceTranslate(key, values) : translated
    },
    presentation,
  }
  const settings = new RemoteSettingsController(context, adapters.host, adapters.settingsEdit)
  const models = new RemoteModelsController(context, adapters.host, adapters.host)
  const account = new RemoteAccountController(context, adapters.accountIO, adapters.clientVersion)
  const providers = new RemoteProvidersController(context, client => account.open(client), adapters.host, adapters.host)
  const permissions = new RemotePermissionsController(context, settings, adapters.host)
  const preferences = new RemotePreferencesController(context, settings)
  const presets = new RemoteAgentPresetsController(context, settings)
  const onboarding = new RemoteOnboardingController(context, providers, account, settings, permissions, preferences, models)
  const attached = new Set<HostClient>()
  const preferenceListeners = new Map<HostClient, () => void>()
  let preferencesClient: HostClient | undefined
  const reconcile = (): void => {
    const clients = context.hosts.list()
    for (const client of attached) if (!clients.includes(client)) {
      attached.delete(client)
      preferenceListeners.get(client)?.()
      preferenceListeners.delete(client)
    }
    const client = context.hosts.current()?.client ?? context.hosts.active?.() ?? clients[0]
    if (client !== preferencesClient) {
      preferencesClient = client
      if (client !== undefined) void preferences.applyHostPreferences(client).catch(() => {})
    }
    if (client === undefined || attached.has(client)) return
    attached.add(client)
    const refreshPreferences = (): void => {
      if ((context.hosts.current()?.client ?? context.hosts.active?.() ?? context.hosts.list()[0]) !== client) return
      void preferences.applyHostPreferences(client).catch(() => {})
    }
    const offSettings = onRemoteSettingsDocumentUpdated(client, ns => { if (ns === 'mayfly') refreshPreferences() })
    const offState = client.state.subscribe(() => { if (client.state.getSnapshot().status === 'connected') refreshPreferences() })
    preferenceListeners.set(client, () => { offSettings(); offState() })
    void onboarding.onReady(client)
  }
  const offTopology = context.hosts.subscribe(reconcile)
  reconcile()
  let disposed = false
  return {
    models,
    providers,
    account,
    onboarding,
    settings,
    permissions,
    presets,
    preferences,
    dispose() {
      if (disposed) return
      disposed = true
      offTopology()
      for (const off of preferenceListeners.values()) off()
      preferenceListeners.clear()
      onboarding.dispose()
      presets.dispose()
      preferences.dispose()
      permissions.dispose()
      providers.dispose()
      account.dispose()
      models.dispose()
      settings.dispose()
      releaseLocale()
      if (presentation instanceof CordisRemoteLocalPresentation) presentation.dispose()
    },
  }
}

/** Single manifest-compatible mount; command routing can use createRemoteConfigurationFeatures instead. */
export function mountRemoteConfigurationFeatures(
  context: RemoteConfigurationMountContext,
  adapters: RemoteConfigurationAdapters,
): () => void {
  const features = createRemoteConfigurationFeatures(context, adapters)
  return () => { features.dispose() }
}
