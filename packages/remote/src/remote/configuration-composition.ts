/**
 * Single composition mount for the configuration feature family: local account
 * I/O, focused Host DTO adapters, the feature assembly, and its slash-command
 * surface registered into the foundation command registry.
 * @module @ephemeral-ai/mayfly/remote/configuration-composition
 */

import type { HostClient } from '../client/types.ts'
import type { RemoteFeatureCommandSource } from './features/commands.ts'
import { RemoteAccountNodeIO } from './features/configuration-account.ts'
import { RemoteConfigurationHost } from './features/configuration-host.ts'
import {
  createRemoteConfigurationFeatures,
  type RemoteConfigurationMountContext,
} from './features/configuration.ts'
import { remoteClientVersion } from './features/version.ts'

/** Options owned by the integration layer mounting this composition. */
export interface RemoteConfigurationCompositionOptions {
  /** Frontend version reported to the account service; empty is refused. */
  readonly clientVersion: string
  /**
   * External settings-document editor owned by the integrator; it receives the
   * current document content and resolves with the edited content, or with
   * undefined when the user cancelled, in which case nothing is written.
   */
  readonly edit?: (client: HostClient, content: string, signal: AbortSignal) => Promise<string | undefined>
  /** Optional clipboard hook preferred over the Remote process's own tools. */
  readonly copy?: (text: string) => Promise<void>
}

/** Mounted configuration composition plus its lifetime. */
export interface RemoteConfigurationCompositionHandle {
  readonly commands: RemoteFeatureCommandSource
  dispose(): void
}

/** Read this package's version for the account client metadata. */
export { remoteClientVersion }

/** Mount the configuration family and register its local slash commands. */
export function mountRemoteConfigurationComposition(
  base: RemoteConfigurationMountContext,
  options: RemoteConfigurationCompositionOptions,
): RemoteConfigurationCompositionHandle {
  if (options.clientVersion.trim() === '') throw new Error('clientVersion must not be empty')
  const accountIO = new RemoteAccountNodeIO(options.copy)
  const host = new RemoteConfigurationHost(base.hosts)
  const features = createRemoteConfigurationFeatures(base, {
    accountIO,
    clientVersion: options.clientVersion,
    host,
    ...options.edit === undefined ? {} : { settingsEdit: options.edit },
  })
  const currentClient = (): HostClient | undefined =>
    base.hosts.current()?.client ?? base.hosts.active?.() ?? base.hosts.list()[0]
  const usage = (name: string): Error => new Error(`Usage: /${name}`)
  const unregister = [
    base.commands.register({
      name: 'model',
      description: 'Switch the model (no argument opens the picker)',
      input: { hint: '[name]' },
      execute: async rawInput => {
        await features.models.open(rawInput)
      },
    }),
    base.commands.register({
      name: 'effort', aliases: ['thinking'],
      description: 'Switch the thinking effort of the current model', input: { hint: '[level]' },
      execute: async rawInput => { await features.models.effort(rawInput) },
    }),
    base.commands.register({
      name: 'providers',
      hidden: true,
      description: 'Configure model providers, OAuth sign-in, and credentials',
      execute: async rawInput => {
        const client = currentClient()
        if (client === undefined) return
        const input = rawInput.trim()
        if (input === 'add') { await features.providers.openAdd(client); return }
        if (input.startsWith('edit ')) { await features.providers.openEditor(client, input.slice(5).trim()); return }
        if (input !== '') throw usage('provider')
        await features.providers.open(client)
      },
    }),
    base.commands.register({
      name: 'account',
      description: 'Open the DeepSeek account panel',
      execute: async rawInput => {
        if (rawInput.trim() !== '') throw usage('account')
        const client = currentClient()
        if (client !== undefined) await features.account.open(client)
      },
    }),
    base.commands.register({
      name: 'settings',
      description: 'Browse settings namespaces and edit the settings document',
      execute: async rawInput => {
        if (rawInput.trim() !== '') throw usage('settings')
        await features.settings.open()
      },
    }),
    base.commands.register({
      name: 'permissions',
      description: 'Switch the permission preset for the session or by default',
      execute: async rawInput => {
        if (rawInput.trim() !== '') throw usage('permissions')
        await features.permissions.open()
      },
    }),
    base.commands.register({
      name: 'presets',
      hidden: true,
      description: 'Switch the agent preset for the session or by default',
      execute: async rawInput => {
        if (rawInput.trim() !== '') throw usage('presets')
        await features.presets.open()
      },
    }),
    base.commands.register({
      name: 'theme',
      description: 'Choose the interface theme',
      input: { hint: '[theme]' },
      execute: async rawInput => {
        const theme = rawInput.trim()
        if (theme === '') { features.preferences.openTheme(); return }
        await features.preferences.applyTheme(currentClient(), theme)
      },
    }),
    base.commands.register({
      name: 'language',
      description: 'Choose the interface language',
      input: { hint: '[en|zh]' },
      execute: async rawInput => {
        const locale = rawInput.trim()
        if (locale === '') { features.preferences.openLocale(); return }
        await features.preferences.applyLocale(currentClient(), locale)
      },
    }),
    base.commands.register({
      name: 'onboarding',
      description: 'Run the first-run setup guide',
      execute: rawInput => {
        if (rawInput.trim() !== '') throw usage('onboarding')
        const client = currentClient()
        if (client !== undefined) features.onboarding.open(client)
      },
    }),
  ]
  let disposed = false
  return {
    commands: base.commands,
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of unregister.splice(0).reverse()) off()
      features.dispose()
      accountIO.dispose()
    },
  }
}
