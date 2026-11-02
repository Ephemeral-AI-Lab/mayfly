/**
 * `mayfly-settings` plugin: the consolidated `mayfly` settings namespace. The
 * patch row of that name loads this module, so the row's Config schema is the
 * one `settings.describe()` projects into a form and `settings.mutate()`
 * commits against. Every field is `.volatile()` — writes reconcile through the
 * Loader into the same volatile cells this fiber holds, which is what makes
 * the whole namespace live-apply without a remount. Every consumer (the boot
 * update check, the `/settings` panel, the `/update` channel read) resolves
 * the tree-scoped {@link currentMayflySettings} source, which reads those
 * cells instead of caching a snapshot.
 *
 * The plugin also owns the persisted default theme: the initial apply waits
 * for the end of startup (`mayflySessionStart.onBooted`: the app marks it only
 * after `boot()` returns, so disposing the baseline theme fiber can never race
 * the loader's activation assertion). The screen is live from then on whether or
 * not a session exists, so the theme and language apply to the start surface.
 * After that the plugin re-reads on every `settings/document-updated` commit of
 * the `mayfly` namespace.
 * The swap goes through `./theme-switch.ts`'s `applyTheme` — the same
 * provider exchange `/theme` drives — so the command's live-provider
 * record stays honest. A session-level `/theme` pick survives unrelated
 * `mayfly` writes: the plugin records only the themes IT applied
 * (`lastAppliedTheme`), so a commit that leaves the persisted theme
 * unchanged never touches the live provider. The plugin never injects
 * `mayflyTheme` (a swap disposes every dependent fiber — injecting would
 * self-dispose mid-swap); every service read is a lazy `ctx.get`.
 *
 * @module @ephemeral-ai/mayfly/interaction/settings
 */

import type { Context } from '@deepseek-ai/cordis'
// Empty type import carries the `settings` Context merge and the
// 'settings/document-updated' Events merge this plugin subscribes to.
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
// Empty type import carries the app-owned current-Agent Context merge.
import type {} from '../app/index.ts'
import { PALETTE_KEYS } from '../core/palettes.ts'
import { DEFAULT_SETTINGS, currentMayflySettings, settingsOverrides, type MayflySettings } from '../frontend/settings.ts'
export { DEFAULT_SETTINGS, currentMayflySettings, resolveMayflySettings } from '../frontend/settings.ts'
export type { MayflySettings } from '../frontend/settings.ts'
import { resolvePresentation, samePresentation } from '../core/presentation.ts'
import { applyTheme, reloadTheme } from './theme-switch.ts'

function cell(value: unknown): unknown {
  return typeof (value as { get?: unknown } | null | undefined)?.get === 'function' ? (value as { get(): unknown }).get() : value
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** The consolidated Mayfly settings source became readable in this tree. */
    'mayfly/settings-source-ready'(value: unknown): void
  }
}

/** User token prices by `provider/model` (a dict, typed by hand so the declaration stays portable). */
const PRICES: z<Record<string, { input: number, output: number, cacheRead?: number, cacheWrite?: number, currency: 'USD' | 'CNY' }>> = z.dict(z.object({
  input: z.number().min(0).required(), output: z.number().min(0).required(), cacheRead: z.number().min(0), cacheWrite: z.number().min(0),
  currency: z.union([z.const('USD'), z.const('CNY')]).default('USD'),
}))

/** Saved key overrides by action id (a dict, typed by hand so the declaration stays portable). */
const KEYBINDINGS: z<Record<string, { keys: string[], label?: string }>> = z.dict(z.object({ keys: z.array(z.string()).default([]), label: z.string() }))

/**
 * The `mayfly.theme` values: every built-in palette and `auto`. A stored value that names no palette (one since
 * removed, such as `ocean`) reads as the default instead of failing validation, which would drop every `mayfly`
 * setting with it; the settings form lists only the palettes.
 */
const THEME: z<MayflySettings['theme']> = z.union([
  ...PALETTE_KEYS.map(key => z.const(key)),
  z.const('auto'),
  z.transform(z.string(), (): MayflySettings['theme'] => 'dark'),
])

/** The settings schema; defaults double as the composition base. */
export const Config = z.object({
  updateCheck: z.boolean().default(true).volatile(),
  updateChannel: z.string().default('latest').volatile(),
  language: z.union([z.const('system'), z.const('en'), z.const('zh')]).default('system').volatile(),
  theme: THEME.default('dark').volatile(),
  transcriptView: z.union([z.const('compact'), z.const('standard'), z.const('detailed'), z.const('verbose')]).default('standard').volatile(),
  windowTurns: z.number().step(1).min(1).default(15).volatile(),
  expandTurns: z.number().step(1).min(1).default(3).volatile(),
  userFoldLines: z.number().step(1).min(1).default(10).volatile(),
  userFoldChars: z.number().step(1).min(1).default(1000).volatile(),
  editorCommand: z.string().default('').volatile(),
  pasteImageBackend: z.union([z.const('auto'), z.const('wayland'), z.const('x11')]).default('auto').volatile(),
  marketIndexUrl: z.string().default('').volatile(),
  keybindings: KEYBINDINGS.default({}).volatile(),
  preferPlainKeys: z.boolean().default(false).volatile(),
  prices: PRICES.default({}).volatile(),
  usdCnyRate: z.number().min(0.01).default(7.2).volatile(),
  lowBalanceCny: z.number().min(0).default(10).volatile(),
  lowBalanceUsd: z.number().min(0).default(1.5).volatile(),
  // Presentation (slice 1.2).
  glyphs: z.union([z.const('auto'), z.const('unicode'), z.const('ascii')]).default('auto').volatile(),
  monochrome: z.boolean().default(false).volatile(),
  reducedMotion: z.boolean().default(false).volatile(),
  quietHints: z.union([z.const('full'), z.const('off')]).default('full').volatile(),
  viewHistory: z.boolean().default(false).volatile(),
  startup: z.union([z.const('conversation'), z.const('splash')]).default('conversation').volatile(),
})

/** Stable Cordis plugin name. */
export const name = 'mayfly-settings'
/** Runtime state and session boundary required by the settings owner. */
export const inject = ['mayflyInteractionState', 'mayflySessionStart']

/**
 * The theme this plugin last applied itself. Initialized to the baseline
 * bundle theme (`mayfly-theme-dark` is the loader-loaded patch row); a
 * session-level `/theme` pick never moves it, which is what lets unrelated
 * `mayfly` namespace writes leave the live provider alone.
 */
/**
 * Swap the live theme provider to the persisted default when it moved.
 * Records only successful swaps, so a failed mount retries on the next
 * commit instead of being treated as applied.
 * @param ctx - plugin context.
 * @param isUnloaded - the fiber's unload flag.
 */
async function syncTheme(ctx: Context, isUnloaded: () => boolean): Promise<void> {
  const state = ctx.mayflyInteractionState
  const theme = currentMayflySettings(ctx).theme
  if (theme === state.lastAppliedTheme) return
  const result = await applyTheme(ctx, theme)
  /* a fiber unload landing inside the swap's awaits is
     a shutdown race no spec can stage deterministically */
  if (isUnloaded()) return
  if (result.kind === 'success') {
    state.lastAppliedTheme = theme
  } else {
    /* the swap's error results always carry text */
    ctx.logger.warn(result.text ?? `could not apply theme "${theme}"`)
  }
}

/**
 * Rebuild the theme provider when the presentation the renderer was built for (the components service records it)
 * differs from the one the settings now ask for. Reloading the provider rebuilds every consumer, the way `/theme`
 * does, so glyphs, monochrome, and reduced motion apply live and no cache keeps rows from the previous presentation.
 * @param ctx - plugin context.
 * @param isUnloaded - the fiber's unload flag.
 */
async function syncPresentation(ctx: Context, isUnloaded: () => boolean): Promise<void> {
  /* an unload landing inside a theme swap's awaits is the shutdown race syncTheme also fences */
  if (isUnloaded()) return
  const live = ctx.get('mayflyComponents')?.presentation
  if (live === undefined || samePresentation(live, resolvePresentation(currentMayflySettings(ctx)))) return
  await reloadTheme(ctx)
}

/**
 * Follow the language the user chose: the Host-shared `locale.preference` when the host carries that namespace (the web
 * app), else `mayfly.language`. An explicit `zh`/`en` selects the live Mayfly locale; `system` or an absent value returns to
 * the process locale.
 * @param ctx - plugin context.
 */
function syncLocale(ctx: Context): void {
  const value = ctx.get('settings')?.describe().find(entry => String(entry.ns) === 'locale')?.value
  const host = cell(value !== null && typeof value === 'object' ? (value as Record<string, unknown>).preference : undefined)
  const stored = host === 'zh' || host === 'en' ? host : currentMayflySettings(ctx).language
  ctx.get('mayflyLocale')?.setPreference(stored === 'zh' || stored === 'en' ? stored : undefined)
}

/**
 * Mount the settings owner: publish the volatile-cell reader as the tree's
 * settings source, apply the persisted theme at session attach, and follow
 * later commits.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  let unloaded = false
  ctx.effect(() => () => {
    unloaded = true
  })
  // The source resolves on every call: the `mayfly` descriptor's projected
  // value when a settings service lists the row, this fiber's own resolved
  // Config while the row is still activating (or under a host that enumerates
  // no entries), and the composition defaults underneath either.
  ctx.mayflyInteractionState.settingsSource = () => ({
    ...DEFAULT_SETTINGS,
    ...settingsOverrides(ctx.fiber.config),
    ...settingsOverrides(ctx.get('settings')?.describe().find(entry => String(entry.ns) === 'mayfly')?.value),
  })
  ctx.emit('mayfly/settings-source-ready', ctx.mayflyInteractionState.settingsSource())
  // Swaps serialize through this chain (the theme-auto precedent): a commit
  // landing mid-swap re-reads the persisted theme after the in-flight apply
  // settles instead of comparing against a stale `lastAppliedTheme` and
  // dropping the update.
  let swap: Promise<void> = Promise.resolve()
  const sync = (): void => {
    /* the defensive catch; syncTheme never rejects */
    swap = swap.then(() => syncTheme(ctx, () => unloaded)).then(() => syncPresentation(ctx, () => unloaded)).catch(() => {})
  }
  // `settings/document-updated` commits landing before startup finishes need
  // no follow: the boot-time sync reads the current value.
  let attached = false
  ctx.on('settings/document-updated', (ns) => {
    if (!attached) return
    if (String(ns) === 'locale' || String(ns) === 'mayfly') syncLocale(ctx)
    if (String(ns) === 'mayfly') sync()
  })
  // The end of startup is the post-boot signal (the terminal-title precedent):
  // the app marks it only after boot() returns, so the swap can never race the
  // loader's entry-activation assertion. The screen is live from then on, with
  // or without a session, so the saved theme and language apply to it.
  ctx.effect(() => ctx.mayflySessionStart.onBooted(() => {
    attached = true
    syncLocale(ctx)
    sync()
  }))
}
