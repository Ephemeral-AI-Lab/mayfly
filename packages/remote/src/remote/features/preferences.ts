/**
 * Local theme/locale application with optional official Host persistence.
 * Live choices never depend on a Remote-local settings store.
 * @module @ephemeral-ai/mayfly/remote/features/preferences
 */

import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient } from '../../client/types.ts'
import type { RemoteFeatureContext } from './contracts.ts'
import { RemoteFeatureController, remoteErrorMessage, remoteProperty, remoteValue } from './official.ts'
import { openRemoteFeaturePanel, type RemoteMountedPanel } from './panel.ts'
import { REMOTE_LANGUAGES, remoteThemeName } from './presentation.ts'
import { REMOTE_MAYFLY_SETTINGS_REQUIREMENT, type RemoteSettingsController } from './settings.ts'

/** Theme and locale controller for one feature mount. */
export class RemotePreferencesController extends RemoteFeatureController {
  constructor(context: RemoteFeatureContext, private readonly settings: RemoteSettingsController) {
    super(context)
  }

  /** Apply Host-owned preferences to the local live presentation after attach readiness. */
  async applyHostPreferences(client: HostClient): Promise<void> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const settings = await remoteValue(client.remote.settings.describe())
      const mayfly = settings.namespaces.find((candidate: import('@deepseek-ai/dsh-api-remotes/client').SettingsNamespaceView) => candidate.ns === 'mayfly')
      if (mayfly === undefined || !operation.valid()) return
      const language = remoteProperty(mayfly.value, 'language')
      const theme = remoteProperty(mayfly.value, 'theme')
      if (typeof language === 'string' && REMOTE_LANGUAGES.some(option => option.id === language)) this.context.presentation.setLocale(language)
      if (typeof theme === 'string' && this.context.presentation.themes.some(option => option.key === theme)) await this.context.presentation.applyTheme(theme)
    } finally { operation.dispose() }
  }

  /** Restart only local presentation after a Host-owned Mayfly settings write. */
  async reloadLocalPresentation(): Promise<void> {
    await this.context.presentation.reloadTheme()
  }

  /** Open the local theme picker and persist through the official Mayfly schema when present. */
  openTheme(client = this.context.hosts.current()?.client ?? this.context.hosts.list()[0]): void {
    let mounted: RemoteMountedPanel | undefined
    mounted = openRemoteFeaturePanel(this.context, {
      title: this.context.t('Select a theme'),
      rows: this.context.presentation.themes.map(theme => ({
        id: theme.key,
        text: theme.name,
        detail: this.context.t(theme.idea),
        current: theme.key === this.context.presentation.snapshot.theme,
      })),
    }, (action, theme) => {
      if (action !== 'accept' || theme === undefined) return
      void this.applyTheme(client, theme).then(() => { mounted?.lease.close() }).catch((error: unknown) => {
        this.context.notice.set(remoteErrorMessage(error))
      })
    }, () => {})
  }

  /** Open the local language picker and persist through official settings when present. */
  openLocale(client = this.context.hosts.current()?.client ?? this.context.hosts.list()[0]): void {
    let mounted: RemoteMountedPanel | undefined
    mounted = openRemoteFeaturePanel(this.context, {
      title: this.context.t('Language'),
      rows: REMOTE_LANGUAGES.map(language => ({
        id: language.id,
        text: language.label,
        current: language.id === this.context.presentation.snapshot.locale,
      })),
    }, (action, locale) => {
      if (action !== 'accept' || locale === undefined) return
      void this.applyLocale(client, locale).then(() => { mounted?.lease.close() }).catch((error: unknown) => {
        this.context.notice.set(remoteErrorMessage(error))
      })
    }, () => {})
  }

  /** Apply one local theme immediately; persistence failure never rolls it back. */
  async applyTheme(client: HostClient | undefined, theme: string): Promise<void> {
    await this.context.presentation.applyTheme(theme)
    this.context.notice.set(this.context.t('switched to theme "{key}"', { key: remoteThemeName(theme) }))
    if (client !== undefined) await this.persist(client, 'mayfly', [{ op: 'set', path: ['theme'], value: theme }])
  }

  /** Apply one local locale immediately; persistence failure never rolls it back. */
  async applyLocale(client: HostClient | undefined, locale: string): Promise<void> {
    this.context.presentation.setLocale(locale)
    if (client === undefined) return
    await this.persist(client, 'mayfly', [{ op: 'set', path: ['language'], value: locale }], false)
    await this.persist(client, 'locale', [{ op: 'set', path: ['preference'], value: locale }], false)
  }

  /** Persist a startup or other Mayfly preference through the official schema. */
  async persistMayfly(client: HostClient, operations: readonly SettingsPathOpView[]): Promise<void> {
    await this.persist(client, 'mayfly', operations)
  }

  private async persist(
    client: HostClient,
    ns: string,
    operations: readonly SettingsPathOpView[],
    required = true,
  ): Promise<void> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const settings = await remoteValue(client.remote.settings.describe())
      const descriptor = settings.namespaces.find((candidate: import('@deepseek-ai/dsh-api-remotes/client').SettingsNamespaceView) => candidate.ns === ns)
      if (descriptor === undefined) {
        if (required || ns === 'mayfly') this.context.notice.set(ns === 'mayfly' ? REMOTE_MAYFLY_SETTINGS_REQUIREMENT : `Settings namespace "${ns}" is unavailable`)
        return
      }
      const revision = this.settings.revision(descriptor, settings.writable)
      await this.settings.mutate(client, ns, operations, revision)
    } finally { operation.dispose() }
  }
}
