/**
 * Remote-local theme and locale presentation. Host persistence stays with the
 * official settings namespace; this module owns only live Cordis presentation.
 * @module @ephemeral-ai/mayfly/app/features/presentation
 */

import type { Context } from '@deepseek-ai/cordis'

import type { Config as BuiltinThemeConfig } from '../../core/theme-builtin.ts'
import type { Config as CustomThemeConfig } from '../../core/theme-custom.ts'
import type { RemoteFeatureContext, RemoteLocalPresentation, RemoteThemeOption } from './contracts.ts'

/** Language choices migrated from the Mayfly onboarding presentation. */
export const REMOTE_LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '简体中文' },
] as const

/** Startup choices persisted by the Host-owned Mayfly settings schema. */
export const REMOTE_STARTUPS = ['conversation', 'splash'] as const

/** Built-in palette names and picker copy migrated out of the legacy interaction layer. */
export const REMOTE_THEMES: readonly RemoteThemeOption[] = [
  { key: 'dark', name: 'Mayfly Dark', idea: 'the default violet', dark: true },
  { key: 'tide', name: 'Tide', idea: 'deep water, an aqua brand', dark: true },
  { key: 'dusk', name: 'Dusk', idea: 'warm plum, an orchid brand', dark: true },
  { key: 'graphite', name: 'Graphite', idea: 'neutral greys, a cobalt brand', dark: true },
  { key: 'obsidian', name: 'Obsidian', idea: 'high contrast on black', dark: true },
  { key: 'catppuccin-mocha', name: 'Catppuccin Mocha', idea: 'soothing pastels, mauve', dark: true },
  { key: 'catppuccin-macchiato', name: 'Catppuccin Macchiato', idea: 'pastels, a shade lighter', dark: true },
  { key: 'catppuccin-frappe', name: 'Catppuccin Frappé', idea: 'muted pastels on slate', dark: true },
  { key: 'dracula', name: 'Dracula', idea: 'purple and pink on charcoal', dark: true },
  { key: 'everforest-dark', name: 'Everforest Dark', idea: 'a forest at dusk, soft greens', dark: true },
  { key: 'gruvbox-dark', name: 'Gruvbox Dark', idea: 'retro groove, warm and earthy', dark: true },
  { key: 'kanagawa-wave', name: 'Kanagawa Wave', idea: "Hokusai's wave, ink and indigo", dark: true },
  { key: 'nord', name: 'Nord', idea: 'arctic frost on polar night', dark: true },
  { key: 'one-dark', name: 'One Dark', idea: "Atom's One, blue and purple on slate", dark: true },
  { key: 'rose-pine', name: 'Rosé Pine', idea: 'iris and rose, soho vibes', dark: true },
  { key: 'rose-pine-moon', name: 'Rosé Pine Moon', idea: 'iris and rose, under the moon', dark: true },
  { key: 'solarized-dark', name: 'Solarized Dark', idea: 'the classic, deep teal', dark: true },
  { key: 'tokyo-night', name: 'Tokyo Night', idea: 'downtown Tokyo at night', dark: true },
  { key: 'tokyo-night-storm', name: 'Tokyo Night Storm', idea: 'the same city, a stormier blue', dark: true },
  { key: 'light', name: 'Mayfly Light', idea: 'the default on white', dark: false },
  { key: 'linen', name: 'Linen', idea: 'ink on paper', dark: false },
  { key: 'mist', name: 'Mist', idea: 'teal on a pale blue-white', dark: false },
  { key: 'heather', name: 'Heather', idea: 'lilac-grey, a plum brand', dark: false },
  { key: 'porcelain', name: 'Porcelain', idea: 'high contrast on white', dark: false },
  { key: 'catppuccin-latte', name: 'Catppuccin Latte', idea: 'pastels on cream', dark: false },
  { key: 'everforest-light', name: 'Everforest Light', idea: 'the forest by day', dark: false },
  { key: 'gruvbox-light', name: 'Gruvbox Light', idea: 'retro groove on cream', dark: false },
  { key: 'kanagawa-lotus', name: 'Kanagawa Lotus', idea: 'the lotus, ink on rice paper', dark: false },
  { key: 'one-light', name: 'One Light', idea: "Atom's One, on white", dark: false },
  { key: 'rose-pine-dawn', name: 'Rosé Pine Dawn', idea: 'iris and rose on parchment', dark: false },
  { key: 'solarized-light', name: 'Solarized Light', idea: 'the classic, on beige', dark: false },
  { key: 'tokyo-night-day', name: 'Tokyo Night Day', idea: 'the city by day, blue ink on grey', dark: false },
  { key: 'auto', name: 'Auto', idea: 'Mayfly Dark or Light, as the terminal', dark: true },
]

/** Resolve the plugin module and config for one local built-in theme. */
async function themeTarget(key: string, custom?: CustomThemeConfig): Promise<{ readonly module: Parameters<Context['plugin']>[0], readonly config?: BuiltinThemeConfig | CustomThemeConfig }> {
  if (key === 'custom') return { module: await import('../../core/theme-custom.ts'), ...custom === undefined ? {} : { config: custom } }
  if (key === 'dark') return { module: await import('../../core/theme-dark.ts') }
  if (key === 'auto') return { module: await import('../../core/theme-auto.ts') }
  const module = await import('../../core/theme-builtin.ts')
  return { module, config: { palette: key as BuiltinThemeConfig['palette'] } }
}

/** Live local adapter backed by public Mayfly frontend and theme entry points. */
export class CordisRemoteLocalPresentation implements RemoteLocalPresentation {
  readonly themes = REMOTE_THEMES
  private readonly listeners = new Set<() => void>()
  private readonly offLocale: () => void
  private applying = Promise.resolve()
  private customTheme: CustomThemeConfig | undefined
  private disposed = false

  constructor(private readonly context: Pick<RemoteFeatureContext, 'ctx' | 'subscribeLocale'>) {
    this.offLocale = context.subscribeLocale(() => { for (const listener of this.listeners) listener() })
  }

  get snapshot(): { readonly locale: string, readonly theme: string } {
    return {
      locale: this.context.ctx.get('mayflyLocale')?.snapshot.locale ?? 'en',
      theme: this.context.ctx.get('mayflyInteractionState')?.currentThemeKey ?? 'dark',
    }
  }

  setLocale(locale: string): void {
    if (this.disposed) return
    if (!REMOTE_LANGUAGES.some(language => language.id === locale)) throw new Error(`Unknown locale "${locale}"`)
    this.context.ctx.get('mayflyLocale')?.setPreference(locale as 'en' | 'zh')
  }

  /** Serialize provider swaps so a stale theme cannot replace a newer choice. */
  applyTheme(theme: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (!REMOTE_THEMES.some(option => option.key === theme)) return Promise.reject(new Error(`Unknown theme "${theme}"`))
    this.applying = this.applying.catch(() => {}).then(() => this.swapTheme(theme))
    return this.applying
  }

  /** Load a Frontend-local palette through the same native custom provider as rc.2. */
  applyCustomTheme(path: string, base = 'dark'): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const custom = { path, base } as CustomThemeConfig
    this.applying = this.applying.catch(() => {}).then(() => this.swapTheme('custom', custom))
    return this.applying
  }

  /** Restart only the local provider; Remote panel/form models retain their drafts. */
  async reloadTheme(): Promise<void> {
    if (this.disposed) return
    this.applying = this.applying.catch(() => {}).then(() => this.restartTheme())
    await this.applying
  }

  private async restartTheme(): Promise<void> {
    if (this.disposed) return
    const current = this.context.ctx.get('mayflyInteractionState')?.currentThemeKey ?? 'dark'
    const target = await themeTarget(current, this.customTheme)
    if (this.disposed) return
    const runtime = this.context.ctx.registry.get(target.module)
    if (runtime === undefined) return
    await Promise.all([...runtime.fibers].map(fiber => fiber.restart()))
    if (!this.disposed) for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offLocale()
    this.listeners.clear()
  }

  private async swapTheme(theme: string, custom?: CustomThemeConfig): Promise<void> {
    if (this.disposed) return
    const state = this.context.ctx.get('mayflyInteractionState')
    if ((state?.currentThemeKey ?? 'dark') === theme && theme !== 'custom') return
    const current = state?.currentThemeKey ?? 'dark'
    const previous = await themeTarget(current, this.customTheme)
    const next = await themeTarget(theme, custom)
    if (this.disposed) return
    // Dispose each live Fiber once and await that call. registry.delete()
    // starts disposal itself; calling dispose() again does not join its work.
    const runtime = this.context.ctx.registry.get(previous.module)
    if (runtime !== undefined) await Promise.all([...runtime.fibers].map(fiber => fiber.dispose()))
    if (this.disposed) return
    try {
      const fiber = await (next.config === undefined ? this.context.ctx.plugin(next.module) : this.context.ctx.plugin(next.module, next.config))
      if (this.disposed) { await fiber.dispose(); return }
      this.customTheme = theme === 'custom' ? custom : undefined
      if (state !== undefined) state.currentThemeKey = theme
    } catch (error) {
      if (this.disposed) return
      const fallback = await themeTarget('dark')
      if (this.disposed) return
      const fiber = await this.context.ctx.plugin(fallback.module)
      if (this.disposed) { await fiber.dispose(); return }
      this.customTheme = undefined
      if (state !== undefined) state.currentThemeKey = 'dark'
      throw error
    }
    for (const listener of this.listeners) listener()
  }
}
