/**
 * Local theme/locale application with optional official Host persistence.
 * Live choices never depend on a Remote-local settings store.
 * @module @ephemeral-ai/mayfly/remote/features/preferences
 */

import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient } from '../../client/types.ts'
import { resolveMayflySettings } from '../../frontend/settings.ts'
import { themeGroup, themeIdea, themeName } from '../../interaction/theme-names.ts'
import { mountInteractionLocale } from '../../interaction/locale.ts'
import { memoizedLocaleTranslator } from '../../frontend/locale.ts'
import { panel, ui, type MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { RemoteFeatureContext } from './contracts.ts'
import { RemoteFeatureController, remoteErrorMessage, remoteProperty, remoteValue } from './official.ts'
import { openRemoteBrowser } from '../panels/browser.ts'
import { REMOTE_LANGUAGES } from './presentation.ts'
import { REMOTE_MAYFLY_SETTINGS_REQUIREMENT, type RemoteSettingsController } from './settings.ts'

/** Theme and locale controller for one feature mount. */
export class RemotePreferencesController extends RemoteFeatureController {
  private readGeneration = 0
  private lastHostTheme: { readonly client: HostClient, readonly theme: string } | undefined
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
      const defaultChanged = typeof theme === 'string' && (this.lastHostTheme?.client !== client || this.lastHostTheme.theme !== theme)
      const themeChanged = defaultChanged && theme !== this.context.presentation.snapshot.theme
      if (themeChanged && this.context.presentation.themes.some(option => option.key === theme)) {
        await this.context.presentation.applyTheme(theme)
      }
      if (!operation.valid() || generation !== this.readGeneration || !this.isActive(client)) return
      if (typeof theme === 'string') this.lastHostTheme = { client, theme }
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

  /** Open the reference live theme picker independently of Host settings persistence. */
  openTheme(client = this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0], parent?: AbortSignal): void {
    if (this.lifetime.signal.aborted || parent?.aborted || this.context.ctx.mayflyOverlays.focus('mayfly.theme')) return
    const lifetime = parent === undefined ? this.lifetime.signal : AbortSignal.any([parent, this.lifetime.signal])
    const operation = client === undefined ? undefined : this.hostOperation(client, lifetime)
    if (client !== undefined && operation === undefined) return
    const signal = operation?.signal ?? lifetime
    const current = () => !signal.aborted && (operation === undefined || operation.valid())
    const t = this.referenceTranslate
    let offPresentation: (() => void) | undefined
    const mounted = openRemoteBrowser(this.context, {
      id: 'mayfly.theme', scope: { kind: 'app', targetId: 'theme' }, signal, isCurrent: current,
      view: () => panel({ title: t('Select a theme'), escapeLabel: 'close', body: ui.list({
        id: 'themes', role: 'choose', selectedIds: this.context.presentation.themes.some(theme => theme.key === this.context.presentation.snapshot.theme) ? [this.context.presentation.snapshot.theme] : [],
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
  openLocale(client = this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0], parent?: AbortSignal): void {
    if (this.lifetime.signal.aborted || parent?.aborted || this.context.ctx.mayflyOverlays.focus('mayfly.language')) return
    const lifetime = parent === undefined ? this.lifetime.signal : AbortSignal.any([parent, this.lifetime.signal])
    const operation = client === undefined ? undefined : this.hostOperation(client, lifetime)
    if (client !== undefined && operation === undefined) return
    const signal = operation?.signal ?? lifetime
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

  /** Apply one live theme; onboarding persists its chosen default explicitly. */
  async applyTheme(client: HostClient | undefined, theme: string, parent?: AbortSignal): Promise<void> {
    const signal = parent === undefined ? this.lifetime.signal : AbortSignal.any([parent, this.lifetime.signal])
    const operation = client === undefined ? undefined : this.hostOperation(client, signal)
    if (signal.aborted || client !== undefined && operation === undefined) return
    try {
      await this.context.presentation.applyTheme(theme)
      // rc.2 retires its input/overlay feedback owner during a palette swap.
      // The retained Remote editor follows the same quiet successful transition.
    } finally { operation?.dispose() }
  }

  /** Apply a Frontend-local palette file without Host settings or filesystem access. */
  async applyCustomTheme(client: HostClient | undefined, path: string, base = 'dark', parent?: AbortSignal): Promise<void> {
    const signal = parent === undefined ? this.lifetime.signal : AbortSignal.any([parent, this.lifetime.signal])
    const operation = client === undefined ? undefined : this.hostOperation(client, signal)
    if (signal.aborted || client !== undefined && operation === undefined) return
    try {
      await this.context.presentation.applyCustomTheme(path, base)
    } finally { operation?.dispose() }
  }

  /** Apply one local locale immediately; each namespace persists best effort. */
  async applyLocale(client: HostClient | undefined, locale: string, parent?: AbortSignal): Promise<void> {
    const signal = parent === undefined ? this.lifetime.signal : AbortSignal.any([parent, this.lifetime.signal])
    if (signal.aborted) return
    const operation = client === undefined ? undefined : this.hostOperation(client, signal)
    if (client !== undefined && operation === undefined) return
    try {
      this.context.presentation.setLocale(locale)
      if (client === undefined) return
      await this.persist(client, 'mayfly', [{ op: 'set', path: ['language'], value: locale }], operation?.signal)
      if (operation?.valid()) await this.persist(client, 'locale', [{ op: 'set', path: ['preference'], value: locale }], operation?.signal)
    } finally { operation?.dispose() }
  }

  /** Persist an onboarding default best effort, preserving live choices on failure. */
  async persistMayfly(client: HostClient, operations: readonly SettingsPathOpView[], parent?: AbortSignal): Promise<void> {
    await this.persist(client, 'mayfly', operations, parent)
  }

  private isActive(client: HostClient): boolean {
    return (this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0]) === client
  }

  private async persist(
    client: HostClient,
    ns: string,
    operations: readonly SettingsPathOpView[],
    parent?: AbortSignal,
  ): Promise<void> {
    const operation = this.hostOperation(client, parent)
    if (operation === undefined) return
    try {
      const settings = await remoteValue(client.remote.settings.describe())
      if (!operation.valid() || !settings.writable) return
      const descriptor = settings.namespaces.find((candidate: import('@deepseek-ai/dsh-api-remotes/client').SettingsNamespaceView) => candidate.ns === ns)
      if (descriptor === undefined) {
        if (ns === 'mayfly') this.context.notice.set(REMOTE_MAYFLY_SETTINGS_REQUIREMENT)
        return
      }
      const revision = this.settings.revision(descriptor, settings.writable)
      await this.settings.mutate(client, ns, operations, revision, operation.signal)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
    } finally { operation.dispose() }
  }
}
