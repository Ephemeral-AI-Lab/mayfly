/** The language and theme the first-run guide's first step offers, and how a choice is applied and stored.
 *
 * The guide opens on a first install (nothing connected), and always offers both, preselected with what is set now (the
 * live language, the current theme). Each switch applies to the live session and persists (`mayfly.language`,
 * `mayfly.theme`, and `locale.preference` where a host lists it).
 *
 * @module @ephemeral-ai/mayfly/interaction/onboarding-language
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { PALETTE_KEYS } from '../core/palettes.ts'
import { applyTheme } from './theme-switch.ts'
import { currentMayflySettings } from './settings.ts'

/** Languages the guide offers; labels stay in their own language. */
export const LANGUAGES = [{ id: 'en', label: 'English' }, { id: 'zh', label: '简体中文' }] as const
/** Persistable default themes, in the order `/theme` lists them: the built-in palettes, then `auto`. */
export const THEMES = [...PALETTE_KEYS, 'auto'] as const

/** What a start without a session shows; the first-run guide offers both. */
export const STARTUPS = ['conversation', 'splash'] as const

export type Language = typeof LANGUAGES[number]['id']
export type Startup = typeof STARTUPS[number]
export type ThemeKey = typeof THEMES[number]

/** The language and theme the guide starts on: the live ones (a stored choice included), else English and dark. */
export function initialChoice(ctx: Context): { readonly language: Language, readonly theme: ThemeKey, readonly startup: Startup } {
  /* the stored default theme: the live one may not be applied yet when the guide opens */
  const stored = currentMayflySettings(ctx).theme
  const current = ctx.get('mayflyInteractionState')?.currentThemeKey
  return { language: ctx.get('mayflyLocale')?.locale === 'zh' ? 'zh' : 'en', theme: THEMES.find(key => key === stored && stored !== 'dark') ?? THEMES.find(key => key === current) ?? 'dark', startup: currentMayflySettings(ctx).startup }
}

/** Persist one namespace write; a failed or read-only store leaves the live choice in place. */
export async function persist(ctx: Context, ns: string, operation: SettingsPathOp): Promise<void> {
  const settings = ctx.get('settings')
  const entry = settings?.describe().find(item => String(item.ns) === ns)
  if (settings === undefined || !settings.writable || entry === undefined) return
  try { await settings.mutate(ns, [operation], entry.revision) } catch (error) { ctx.logger.warn(`could not persist ${ns} setting: ${String(error)}`) }
}

/** Persist what the start shows; it is read at the next start and needs no live apply. */
export async function commitStartup(ctx: Context, startup: Startup): Promise<void> {
  await persist(ctx, 'mayfly', { op: 'set', path: ['startup'], value: startup })
}

/**
 * Apply a choice to the live session at once (the language, and the theme through the same swap `/theme` makes), then
 * persist it. A store that cannot be written (read-only, or pinned by an overlay) leaves the live choice in place.
 */
export async function commitLanguage(ctx: Context, language: Language, theme: ThemeKey): Promise<void> {
  ctx.get('mayflyLocale')?.setPreference(language)
  const state = ctx.get('mayflyInteractionState')
  if (state !== undefined && state.currentThemeKey !== theme) {
    const result = await applyTheme(ctx, theme)
    if (result.kind === 'success') state.lastAppliedTheme = theme
    else ctx.logger.warn(result.text ?? `could not apply theme "${theme}"`)
  }
  await persist(ctx, 'mayfly', { op: 'set', path: ['language'], value: language })
  await persist(ctx, 'mayfly', { op: 'set', path: ['theme'], value: theme })
  /* a host that carries the shared namespace (the web app) follows the choice too */
  await persist(ctx, 'locale', { op: 'set', path: ['preference'], value: language })
}
