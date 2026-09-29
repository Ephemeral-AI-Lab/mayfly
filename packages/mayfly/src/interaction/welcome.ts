/** First-run welcome: pick the language and theme before the connection guide.
 *
 * The welcome appears once, while the shared Host locale preference is still
 * unset. Continuing applies both choices to the live session and persists them
 * (`locale.preference`, `mayfly.theme`); once a language is stored the welcome
 * never returns.
 *
 * @module @ephemeral-ai/mayfly/interaction/welcome
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { ui, type MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator } from './locale.ts'
import { applyTheme } from './theme-switch.ts'
import { openUiOverlay } from './ui-overlay.ts'

/** The overlay id, also the readiness key for callers that wait on it. */
export const WELCOME_ID = 'mayfly.welcome'

/** Languages the welcome offers; labels stay in their own language. */
const LANGUAGES = [{ id: 'en', label: 'English' }, { id: 'zh', label: '简体中文' }] as const
/** Persistable default themes, in the order `/theme` lists them. */
const THEMES = ['dark', 'light', 'ocean', 'paper', 'auto'] as const

type Language = typeof LANGUAGES[number]['id']
type ThemeKey = typeof THEMES[number]

/** The welcome content for one initial choice. */
export function welcomeNode(t: (key: string) => string, language: Language, theme: ThemeKey): ReturnType<typeof ui.stack.column> {
  return ui.stack.column([
    ui.text(t('Pick a language and a color theme to start with. You can change both later in /settings.')),
    ui.form({ id: 'welcome', fields: [
      { kind: 'select', id: 'language', label: t('Language'), value: language, options: LANGUAGES.map(item => ({ id: item.id, label: item.label })) },
      { kind: 'select', id: 'theme', label: t('Theme'), value: theme, options: THEMES.map(key => ({ id: key, label: key })) },
    ] }),
    ui.actions({ id: 'welcome-actions', items: [
      { id: 'continue', label: t('Continue'), intent: 'primary', submit: [{ pagePath: [], formId: 'welcome' }] },
    ] }),
  ])
}

/** The Host-shared locale namespace entry, when a settings service lists it. */
function localeEntry(ctx: Context) {
  return ctx.get('settings')?.describe().find(entry => String(entry.ns) === 'locale')
}

/** Whether the welcome is due: the shared language preference has never been stored. */
export function welcomeDue(ctx: Context): boolean {
  const entry = localeEntry(ctx)
  const value = entry?.value
  const preference = value !== null && typeof value === 'object' ? (value as Record<string, unknown>).preference : undefined
  return entry !== undefined && preference === undefined && ctx.mayflyLocale.preference === undefined
}

/** Persist one namespace write; a failed or read-only store leaves the live choice in place. */
async function persist(ctx: Context, ns: string, operation: SettingsPathOp): Promise<void> {
  const settings = ctx.get('settings')
  const entry = settings?.describe().find(item => String(item.ns) === ns)
  if (settings === undefined || !settings.writable || entry === undefined) return
  try { await settings.mutate(ns, [operation], entry.revision) } catch (error) { ctx.logger.warn(`could not persist ${ns} setting: ${String(error)}`) }
}

/** Apply the welcome choices to the live session, then persist them. */
async function commit(ctx: Context, language: Language, theme: ThemeKey): Promise<void> {
  ctx.mayflyLocale.setPreference(language)
  const result = await applyTheme(ctx, theme)
  if (result.kind === 'success') ctx.mayflyInteractionState.lastAppliedTheme = theme
  await persist(ctx, 'locale', { op: 'set', path: ['preference'], value: language })
  await persist(ctx, 'mayfly', { op: 'set', path: ['theme'], value: theme })
}

/**
 * Show the welcome and settle when it closes (continued or dismissed).
 * @param ctx - Host context with the overlays service.
 * @param signal - Caller lifetime; aborting closes the overlay.
 */
export async function openWelcome(ctx: Context, signal: AbortSignal): Promise<void> {
  const t = interactionTranslator(ctx)
  const language: Language = ctx.mayflyLocale.locale === 'zh' ? 'zh' : 'en'
  const current = ctx.mayflyInteractionState.currentThemeKey
  const theme: ThemeKey = THEMES.find(key => key === current) ?? 'dark'
  await new Promise<void>(resolve => {
    const handle = openUiOverlay(ctx, {
      id: WELCOME_ID, title: t('Welcome to Mayfly'), presentation: 'editor', capturing: true,
      scope: { kind: 'app', targetId: 'welcome' },
      onEvent: { action: async (event): Promise<MayflyUiActionReply> => {
        /* v8 ignore next -- Continue is the only action and it submits the form */
        if (event.kind !== 'submit') return { kind: 'completed' }
        const fields = event.submission.forms[0]!.fields
        const chosenLanguage = LANGUAGES.find(item => item.id === fields.find(field => field.id === 'language')?.value)?.id
        const chosenTheme = THEMES.find(key => key === fields.find(field => field.id === 'theme')?.value)
        /* v8 ignore next -- the selects reject unknown options; this guards a forged submission */
        if (chosenLanguage === undefined || chosenTheme === undefined) return { kind: 'failed', message: t('Choose a language and a theme') }
        await commit(ctx, chosenLanguage, chosenTheme)
        return { kind: 'accepted', node: welcomeNode(t, chosenLanguage, chosenTheme), source: [], dismiss: true }
      } },
    }, welcomeNode(t, language, theme), { signal, reopen: 'focus', onClosed: resolve })
    if (handle === undefined) resolve()
  })
}
