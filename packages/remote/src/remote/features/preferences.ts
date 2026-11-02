/**
 * Local theme/locale application with optional official Host persistence.
 * Live choices never depend on a Remote-local settings store.
 * @module @ephemeral-ai/mayfly/remote/features/preferences
 */

import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient } from '../../client/types.ts'
import { resolveMayflySettings } from '@ephemeral-ai/mayfly/settings'
import { themeGroup, themeIdea, themeName } from '@ephemeral-ai/mayfly/configuration-panels'
import { mountInteractionLocale } from '@ephemeral-ai/mayfly/editor-presentation'
import { memoizedLocaleTranslator } from '@ephemeral-ai/mayfly/frontend'
import { panel, ui, type MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureContext } from './contracts.ts'
import { RemoteFeatureController, remoteErrorMessage, remoteProperty, remoteValue } from './official.ts'
import { openRemoteBrowser } from '../panels/browser.ts'
import { REMOTE_LANGUAGES, remoteThemeName } from './presentation.ts'
import { REMOTE_MAYFLY_SETTINGS_REQUIREMENT, type RemoteSettingsController } from './settings.ts'

/** Theme and locale controller for one feature mount. */
export class RemotePreferencesController extends RemoteFeatureController {
  private readGeneration = 0
  private readonly lifetime = new AbortController()
  private readonly referenceTranslate: MayflyTranslate
  constructor(context: RemoteFeatureContext, private readonly settings: RemoteSettingsController) {
    super(context)
    mountInteractionLocale(context.ctx)
    this.referenceTranslate = memoizedLocaleTranslator(context.ctx, 'interaction').translate
  }

  /** Apply Host-owned preferences to the local live presentation after attach readiness. */
  async applyHostPreferences(client: HostClient): Promise<void> {
    if (!this.isActive(client)) return
    const generation = ++this.readGeneration
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const settings = await remoteValue(client.remote.settings.describe())
      const mayfly = settings.namespaces.find((candidate: import('@deepseek-ai/dsh-api-remotes/client').SettingsNamespaceView) => candidate.ns === 'mayfly')
      if (mayfly === undefined || !operation.valid() || generation !== this.readGeneration || !this.isActive(client)) return
      const state = this.context.ctx.get('mayflyInteractionState')
      const resolved = resolveMayflySettings(mayfly.value)
      const previous = state?.settingsSource()
      if (state !== undefined) {
        state.settingsSource = () => resolved
        this.context.ctx.emit('mayfly/settings-source-ready', resolved)
      }
      const keymap = this.context.ctx.get('mayflyKeymap')
      keymap?.setPreferPlain(resolved.preferPlainKeys)
      keymap?.applyOverrides(resolved.keybindings)
      const language = remoteProperty(mayfly.value, 'language')
      const theme = remoteProperty(mayfly.value, 'theme')
      if (typeof language === 'string' && REMOTE_LANGUAGES.some(option => option.id === language)) this.context.presentation.setLocale(language)
      const themeChanged = typeof theme === 'string' && theme !== this.context.presentation.snapshot.theme
      if (typeof theme === 'string' && this.context.presentation.themes.some(option => option.key === theme)) await this.context.presentation.applyTheme(theme)
      if (!operation.valid() || generation !== this.readGeneration || !this.isActive(client)) return
      if (!themeChanged && previous !== undefined && (previous.glyphs !== resolved.glyphs || previous.monochrome !== resolved.monochrome || previous.reducedMotion !== resolved.reducedMotion)) await this.context.presentation.reloadTheme()
    } finally { operation.dispose() }
  }

  override dispose(): void {
    this.readGeneration += 1
    this.lifetime.abort()
    super.dispose()
  }

  /** Restart only local presentation after a Host-owned Mayfly settings write. */
  async reloadLocalPresentation(): Promise<void> {
    await this.context.presentation.reloadTheme()
  }

  /** Open the local theme picker and persist through the official Mayfly schema when present. */
  openTheme(client = this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0]): void {
    if (this.lifetime.signal.aborted) return
    const operation = client === undefined ? undefined : this.hostOperation(client, this.lifetime.signal)
    if (client !== undefined && operation === undefined) return
    const signal = operation?.signal ?? this.lifetime.signal
    const current = () => !signal.aborted && (operation === undefined || operation.valid())
    const t = this.referenceTranslate
    let offPresentation: (() => void) | undefined
    const mounted = openRemoteBrowser(this.context, {
      id: 'mayfly.theme', scope: { kind: 'app', targetId: 'theme' }, signal, isCurrent: current,
      view: () => panel({ title: t('Select a theme'), escapeLabel: 'close', body: ui.list({
        id: 'themes', role: 'choose', selectedIds: [this.context.presentation.snapshot.theme],
        items: this.context.presentation.themes.map(theme => ({
          id: theme.key, label: themeName(theme.key, t), detail: themeIdea(theme.key, t), group: themeGroup(theme.key, t),
          ...theme.key === this.context.presentation.snapshot.theme ? { current: true } : {},
        })),
      }) }),
      action: async (event, context) => {
        if (event.kind !== 'selection-accept' || event.controlId !== 'themes') return { kind: 'completed' }
        if (context.signal.aborted || !current()) return { kind: 'cancelled' }
        const theme = event.selectedIds[0]
        if (theme === this.context.presentation.snapshot.theme) return { kind: 'completed', dismiss: true }
        if (theme === undefined || !this.context.presentation.themes.some(option => option.key === theme)) return { kind: 'failed', message: t('unknown theme "{key}"', { key: theme ?? '' }) }
        try { await this.applyTheme(client, theme, context.signal); return current() && !context.signal.aborted ? { kind: 'completed', dismiss: true } : { kind: 'cancelled', dismiss: true } }
        catch (error) { return { kind: 'failed', message: remoteErrorMessage(error) } }
      },
      onClosed: () => { offPresentation?.(); operation?.dispose() },
    })
    operation?.onDispose(() => { mounted.close() })
    offPresentation = this.context.presentation.subscribe(() => { mounted.refresh() })
    if (mounted.closed) offPresentation()
  }

  /** Open the local language picker and persist through official settings when present. */
  openLocale(client = this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0]): void {
    if (this.lifetime.signal.aborted) return
    const operation = client === undefined ? undefined : this.hostOperation(client, this.lifetime.signal)
    if (client !== undefined && operation === undefined) return
    const signal = operation?.signal ?? this.lifetime.signal
    const current = () => !signal.aborted && (operation === undefined || operation.valid())
    const mounted = openRemoteBrowser(this.context, {
      id: 'mayfly.language', scope: { kind: 'app', targetId: 'language' }, signal, isCurrent: current,
      view: () => panel({ title: this.referenceTranslate('Language'), escapeLabel: 'close', body: ui.list({
        id: 'languages', role: 'choose', selectedIds: [this.context.presentation.snapshot.locale],
        items: REMOTE_LANGUAGES.map(language => ({ ...language, ...language.id === this.context.presentation.snapshot.locale ? { current: true } : {} })),
      }) }),
      action: async (event, context) => {
        if (event.kind !== 'selection-accept' || event.controlId !== 'languages') return { kind: 'completed' }
        if (context.signal.aborted || !current()) return { kind: 'cancelled' }
        const locale = event.selectedIds[0]
        if (!REMOTE_LANGUAGES.some(option => option.id === locale)) return { kind: 'failed', message: 'Unknown language' }
        try { await this.applyLocale(client, locale!, context.signal); return current() && !context.signal.aborted ? { kind: 'completed', dismiss: true } : { kind: 'cancelled', dismiss: true } }
        catch (error) { return { kind: 'failed', message: remoteErrorMessage(error) } }
      },
      onClosed: () => operation?.dispose(),
    })
    operation?.onDispose(() => { mounted.close() })
  }

  /** Apply one local theme immediately; persistence failure never rolls it back. */
  async applyTheme(client: HostClient | undefined, theme: string, parent?: AbortSignal): Promise<void> {
    const signal = parent === undefined ? this.lifetime.signal : AbortSignal.any([parent, this.lifetime.signal])
    const operation = client === undefined ? undefined : this.hostOperation(client, signal)
    if (signal.aborted || client !== undefined && operation === undefined) return
    try {
      await this.context.presentation.applyTheme(theme)
      if (signal.aborted || operation !== undefined && !operation.valid()) return
      this.context.notice.set(this.context.t('switched to theme "{key}"', { key: remoteThemeName(theme) }))
      if (client !== undefined) await this.persist(client, 'mayfly', [{ op: 'set', path: ['theme'], value: theme }], true, operation?.signal)
    } finally { operation?.dispose() }
  }

  /** Apply one local locale immediately; persistence failure never rolls it back. */
  async applyLocale(client: HostClient | undefined, locale: string, parent?: AbortSignal): Promise<void> {
    const signal = parent === undefined ? this.lifetime.signal : AbortSignal.any([parent, this.lifetime.signal])
    if (signal.aborted) return
    const operation = client === undefined ? undefined : this.hostOperation(client, signal)
    if (client !== undefined && operation === undefined) return
    this.context.presentation.setLocale(locale)
    if (client === undefined) return
    try {
      await this.persist(client, 'mayfly', [{ op: 'set', path: ['language'], value: locale }], false, operation?.signal)
      if (operation?.valid()) await this.persist(client, 'locale', [{ op: 'set', path: ['preference'], value: locale }], false, operation?.signal)
    } finally { operation?.dispose() }
  }

  /** Persist a startup or other Mayfly preference through the official schema. */
  async persistMayfly(client: HostClient, operations: readonly SettingsPathOpView[]): Promise<void> {
    await this.persist(client, 'mayfly', operations)
  }

  private isActive(client: HostClient): boolean {
    return (this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0]) === client
  }

  private async persist(
    client: HostClient,
    ns: string,
    operations: readonly SettingsPathOpView[],
    required = true,
    parent?: AbortSignal,
  ): Promise<void> {
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) return
    try {
      const settings = await remoteValue(client.remote.settings.describe())
      if (!operation.valid()) return
      const descriptor = settings.namespaces.find((candidate: import('@deepseek-ai/dsh-api-remotes/client').SettingsNamespaceView) => candidate.ns === ns)
      if (descriptor === undefined) {
        if (required || ns === 'mayfly') this.context.notice.set(ns === 'mayfly' ? REMOTE_MAYFLY_SETTINGS_REQUIREMENT : `Settings namespace "${ns}" is unavailable`)
        return
      }
      const revision = this.settings.revision(descriptor, settings.writable)
      await this.settings.mutate(client, ns, operations, revision, operation.signal)
    } finally { operation.dispose() }
  }
}
