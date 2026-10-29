/**
 * Assembly for the models/providers/account/onboarding/settings/permissions
 * feature family. The foundation adds one manifest entry and supplies account
 * transport I/O; shared app/runtime/panels remain untouched.
 * @module @ephemeral-ai/mayfly/remote/features/configuration
 */

import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import type { HostClient } from '../../client/types.ts'
import { RemoteAccountController } from './account.ts'
import { REMOTE_CONFIGURATION_LOCALE } from './locale.ts'
import type {
  RemoteFeatureAdapters,
  RemoteFeatureContext,
  RemoteLocalPresentation,
} from './contracts.ts'
import { RemoteModelsController, type RemoteModelCatalogDetails } from './models.ts'
import { RemoteOnboardingController } from './onboarding.ts'
import { RemotePermissionsController, type RemotePermissionCatalogDetails } from './permissions.ts'
import { RemotePreferencesController } from './preferences.ts'
import { CordisRemoteLocalPresentation } from './presentation.ts'
import { RemoteAgentPresetsController } from './presets.ts'
import { RemoteProvidersController } from './providers.ts'
import { RemoteSettingsController } from './settings.ts'

/** Foundation context before the optional local presentation adapter is installed. */
export type RemoteConfigurationMountContext = Omit<RemoteFeatureContext, 'presentation'> & {
  readonly presentation?: RemoteLocalPresentation
}

/** Optional focused Host detail adapters under active DTO development. */
export interface RemoteConfigurationAdapters extends RemoteFeatureAdapters {
  readonly modelDetails?: RemoteModelCatalogDetails
  readonly permissionDetails?: RemotePermissionCatalogDetails
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
  const releaseLocale = base.ctx.effect(() => base.ctx.mayflyLocale.register('remote-configuration', REMOTE_CONFIGURATION_LOCALE))
  const context: RemoteFeatureContext = {
    ...base,
    t: memoizedLocaleTranslator(base.ctx, 'remote-configuration').translate,
    presentation,
  }
  const settings = new RemoteSettingsController(context)
  const models = new RemoteModelsController(context, adapters.modelDetails)
  const account = new RemoteAccountController(context, adapters.accountIO, adapters.clientVersion)
  const providers = new RemoteProvidersController(context, client => account.open(client))
  const permissions = new RemotePermissionsController(context, settings, adapters.permissionDetails)
  const preferences = new RemotePreferencesController(context, settings)
  const presets = new RemoteAgentPresetsController(context, settings)
  const onboarding = new RemoteOnboardingController(context, providers, account, settings, permissions, preferences, models)
  const attached = new Set<HostClient>()
  const reconcile = (): void => {
    for (const client of context.hosts.list()) {
      if (attached.has(client)) continue
      attached.add(client)
      void onboarding.onReady(client)
    }
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
