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
 * The plugin also owns the persisted default theme: the initial apply is
 * gated on Agent attach — when `mayflyCurrentAgent.current()` is non-null the
 * swap runs at apply (the app publishes that snapshot only after `boot()`
 * returns, so disposing the baseline theme fiber can never race the loader's
 * activation assertion), otherwise the first attach notification arms it;
 * session-less headless hosts never swap — there is no UI to paint. After the
 * attach the plugin re-reads on every `settings/document-updated` commit of
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
import { applyTheme } from './theme-switch.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** The consolidated Mayfly settings source became readable in this tree. */
    'mayfly/settings-source-ready'(value: unknown): void
  }
}

/** The user-tunable Mayfly settings (the `mayfly` settings namespace). */
export interface MayflySettings {
  /** Whether the boot update check runs at all; `false` is the offline switch. */
  readonly updateCheck: boolean
  /** The dist-tag the update check follows (`latest` by default). */
  readonly updateChannel: string
  /** The default theme, applied at startup; `/theme` overrides per session. */
  readonly theme: 'dark' | 'light' | 'ocean' | 'paper' | 'auto'
  /** Whether thinking blocks start collapsed. */
  readonly collapseThinking: boolean
  /** Whether tool output starts collapsed (ctrl+o toggles in the session). */
  readonly collapseToolCalls: boolean
  /** Completed turns kept mounted in the transcript window (mirrors transcript's DEFAULT_WINDOW_TURNS). */
  readonly windowTurns: number
  /** Recent steps of a turn keeping their cards before step folding (mirrors DEFAULT_RECENT_STEPS_RETENTION). */
  readonly recentStepsRetention: number
  /** Turns the Ctrl-O expansion toggle reaches back (mirrors transcript's EXPAND_TURNS). */
  readonly expandTurns: number
  /** Lines of a user message before it folds (mirrors DEFAULT_USER_FOLD_LINES). */
  readonly userFoldLines: number
  /** Characters of a user message before it folds (mirrors DEFAULT_USER_FOLD_CHARS). */
  readonly userFoldChars: number
  /** External editor command overriding `$VISUAL`/`$EDITOR`; empty follows the environment. */
  readonly editorCommand: string
  /** Linux clipboard backend for image paste; `auto` probes the session (the plugin config stands when the user layer never sets this). */
  readonly pasteImageBackend: 'auto' | 'wayland' | 'x11'
  /** Plugin marketplace index URL; empty uses the official dsh-plugins chain. */
  readonly marketIndexUrl: string
}

/** The settings schema; defaults double as the composition base. */
export const Config = z.object({
  updateCheck: z.boolean().default(true).volatile(),
  updateChannel: z.string().default('latest').volatile(),
  theme: z.union([z.const('dark'), z.const('light'), z.const('ocean'), z.const('paper'), z.const('auto')]).default('dark').volatile(),
  collapseThinking: z.boolean().default(true).volatile(),
  collapseToolCalls: z.boolean().default(true).volatile(),
  windowTurns: z.number().step(1).min(1).default(15).volatile(),
  recentStepsRetention: z.number().step(1).min(1).default(30).volatile(),
  expandTurns: z.number().step(1).min(1).default(3).volatile(),
  userFoldLines: z.number().step(1).min(1).default(10).volatile(),
  userFoldChars: z.number().step(1).min(1).default(1000).volatile(),
  editorCommand: z.string().default('').volatile(),
  pasteImageBackend: z.union([z.const('auto'), z.const('wayland'), z.const('x11')]).default('auto').volatile(),
  marketIndexUrl: z.string().default('').volatile(),
})

/** The resolved defaults, used until a settings service layers overrides. */
export const DEFAULT_SETTINGS: MayflySettings = {
  updateCheck: true,
  updateChannel: 'latest',
  theme: 'dark',
  collapseThinking: true,
  collapseToolCalls: true,
  windowTurns: 15,
  recentStepsRetention: 30,
  expandTurns: 3,
  userFoldLines: 10,
  userFoldChars: 1000,
  editorCommand: '',
  pasteImageBackend: 'auto',
  marketIndexUrl: '',
}

/** Stable Cordis plugin name. */
export const name = 'mayfly-settings'
/** Runtime state and session boundary required by the settings owner. */
export const inject = ['mayflyInteractionState', 'mayflyCurrentAgent']

/**
 * Read the current `mayfly` settings: the row's volatile Config cells, which
 * carry schema defaults layered with the composition base and the user
 * document, reconciled in place on every committed write.
 * @returns the resolved Mayfly settings.
 */
export function currentMayflySettings(ctx: Context): MayflySettings {
  return ctx.mayflyInteractionState.settingsSource()
}

/** Unwrap a volatile config cell, or pass an ordinary value through. */
const cell = (value: unknown): unknown =>
  typeof (value as { get?: unknown } | null | undefined)?.get === 'function' ? (value as { get(): unknown }).get() : value

/** Pick the declared `mayfly` fields out of an arbitrary resolved/config object. */
function pick(value: unknown): Partial<MayflySettings> {
  const out: Partial<Mutable<MayflySettings>> = {}
  if (value === null || typeof value !== 'object') return out
  for (const key of Object.keys(DEFAULT_SETTINGS) as readonly (keyof MayflySettings)[]) {
    const field = cell((value as Record<string, unknown>)[key])
    if (field !== undefined) (out as Record<string, unknown>)[key] = field
  }
  return out
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

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
  /* v8 ignore next 1 -- a fiber unload landing inside the swap's awaits is
     a shutdown race no spec can stage deterministically */
  if (isUnloaded()) return
  if (result.kind === 'success') {
    state.lastAppliedTheme = theme
  } else {
    /* v8 ignore next 1 -- the swap's error results always carry text */
    ctx.logger.warn(result.text ?? `could not apply theme "${theme}"`)
  }
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
    ...pick(ctx.fiber.config),
    ...pick(ctx.get('settings')?.describe().find(entry => String(entry.ns) === 'mayfly')?.value),
  })
  ctx.emit('mayfly/settings-source-ready', ctx.mayflyInteractionState.settingsSource())
  // Swaps serialize through this chain (the theme-auto precedent): a commit
  // landing mid-swap re-reads the persisted theme after the in-flight apply
  // settles instead of comparing against a stale `lastAppliedTheme` and
  // dropping the update.
  let swap: Promise<void> = Promise.resolve()
  const sync = (): void => {
    /* v8 ignore next 1 -- the defensive catch; syncTheme never rejects */
    swap = swap.then(() => syncTheme(ctx, () => unloaded)).catch(() => {})
  }
  // `settings/document-updated` commits landing before the first attach need
  // no follow: the attach-time sync reads the current value.
  let attached = ctx.mayflyCurrentAgent.current() !== null
  ctx.on('settings/document-updated', (ns) => {
    if (String(ns) !== 'mayfly' || !attached) return
    sync()
  })
  // Session attach is the post-boot signal (the terminal-title precedent):
  // the app publishes the first non-null reader snapshot only after boot()
  // returns, so the swap can never race the loader's entry-activation
  // assertion. An already-attached session skips the wait.
  const registration = ctx.mayflyCurrentAgent.subscribe((agent) => {
    if (attached || agent === null) return
    attached = true
    sync()
  })
  ctx.effect(() => registration)
  if (attached) sync()
}
