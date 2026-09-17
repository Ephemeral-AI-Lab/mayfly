/**
 * The `/theme` command and the provider swap behind it. The command knows
 * the six core theme subpath plugins (dark/light/ocean/paper/auto/custom) and switches
 * by disposing the live provider's fibers — `ctx.registry.delete` keys
 * runtimes by plugin callback identity, and the loader-loaded baseline
 * `mayfly-theme-dark` row resolves to the same module this file statically
 * imports, so one registry record covers both — then mounting the
 * replacement through `ctx.plugin`. Dependents reload through Cordis
 * semantics (transcript and input rebuild; the input draft survives through
 * `./draft-stash.ts`). A failed mount best-effort restores the built-in
 * dark palette so the UI is never left without a theme.
 *
 * @module @ephemeral-ai/mayfly/interaction/theme-switch
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { ui } from '@ephemeral-ai/mayfly-ui'
import * as themeAuto from '../core/theme-auto.ts'
import * as themeCustom from '../core/theme-custom.ts'
import * as themeDark from '../core/theme-dark.ts'
import * as themeLight from '../core/theme-light.ts'
import * as themeOcean from '../core/theme-ocean.ts'
import * as themePaper from '../core/theme-paper.ts'
import { interactionTranslator } from './locale.ts'
import { CURRENT_MARK } from './symbols.ts'
import { openUiOverlay } from './ui-overlay.ts'

/** Usage text returned for malformed `/theme` invocations. */
const USAGE = 'usage: /theme [dark|light|ocean|paper|auto|custom <path> [dark|light|ocean|paper]]'

/** One switchable theme provider: the command-facing key and the plugin module. */
interface ThemeTarget {
  readonly key: string
  readonly module: Plugin
}

/** The baseline provider, also the fallback restored after a failed mount. */
const DARK: ThemeTarget = { key: 'dark', module: themeDark }

/** The built-in palettes, switchable without extra config. */
const BUILTIN: ReadonlyMap<string, ThemeTarget> = new Map([
  ['dark', DARK],
  ['light', { key: 'light', module: themeLight }],
  ['ocean', { key: 'ocean', module: themeOcean }],
  ['paper', { key: 'paper', module: themePaper }],
  ['auto', { key: 'auto', module: themeAuto }],
])

/** The file-backed palette, switched with a path (and optional base) config. */
const CUSTOM: ThemeTarget = { key: 'custom', module: themeCustom }

/** Theme keys in listing order. */
const KNOWN_KEYS = ['dark', 'light', 'ocean', 'paper', 'auto', 'custom'] as const

/**
 * The bare `/theme` picker: a choose-list overlay over the known keys with
 * the live row carrying the shared `← current` badge (the same vocabulary
 * as the session picker). Selecting a row swaps the provider; the `custom`
 * row only flashes the usage hint since it needs a path argument. The
 * registration lives on the commands fiber, which does not inject
 * `mayflyTheme`, so the picker survives the swap it triggers.
 * @param ctx - plugin context.
 * @returns the command outcome.
 */
function openThemePicker(ctx: Context): CommandResult {
  const t = interactionTranslator(ctx)
  const current = ctx.mayflyInteractionState.currentThemeKey
  openUiOverlay(ctx, {
    id: 'mayfly.theme', title: t('Select a theme'), presentation: 'editor', capturing: true, dismissal: 'discard',
    scope: { kind: 'app', targetId: 'theme' },
    onEvent: { action: async event => {
      if (event.kind !== 'selection-accept') return { kind: 'completed' }
      const key = event.selectedIds[0]
      if (key === undefined || key === ctx.mayflyInteractionState.currentThemeKey) return { kind: 'completed', dismiss: true }
      if (key === 'custom') return { kind: 'completed', feedback: { severity: 'info', message: USAGE } }
      const target = BUILTIN.get(key)
      if (target === undefined) return { kind: 'failed', message: t('unknown theme "{key}"', { key }) }
      const result = await switchTheme(ctx, target)
      if (result.kind === 'error') return { kind: 'failed', message: result.text }
      /* v8 ignore next -- switchTheme success always carries the "switched to" text */
      return { kind: 'completed', dismiss: true, ...(result.text === undefined ? {} : { feedback: { severity: 'success' as const, message: result.text } }) }
    } },
  }, ui.surface({ chrome: 'overlay', title: t('Select a theme'), child: ui.list({
    id: 'themes', role: 'choose', selectedIds: [current],
    items: KNOWN_KEYS.map(key => ({
      id: key, label: key,
      ...(key === current ? { badge: CURRENT_MARK } : {}),
      ...(key === 'custom' ? { detail: USAGE } : {}),
    })),
  }) }), { reopen: 'replace' })
  return { kind: 'success' }
}

/**
 * Swap the live provider for `next`: dispose every fiber of the current
 * module, then mount the replacement. A mount failure restores dark.
 * @param ctx - plugin context.
 * @param next - the theme to activate.
 * @param config - the custom-theme config; omitted for built-ins.
 * @returns the command outcome.
 */
async function switchTheme(ctx: Context, next: ThemeTarget, config?: themeCustom.Config): Promise<CommandResult> {
  const current = ctx.mayflyInteractionState.currentThemeKey === 'custom'
    ? CUSTOM
    : BUILTIN.get(ctx.mayflyInteractionState.currentThemeKey) ?? DARK
  const runtime = ctx.registry.delete(current.module)
  // delete() removes the runtime record and starts disposal; awaiting each
  // fiber settles it before the remount (a second mayflyTheme registration
  // while the previous provider lives is rejected). dispose() is
  // single-shot, so re-awaiting an in-flight disposal is safe.
  if (runtime !== undefined) {
    await Promise.all([...runtime.fibers].map(fiber => fiber.dispose()))
  }
  try {
    await (config === undefined ? ctx.plugin(next.module) : ctx.plugin(next.module, config))
  } catch (error) {
    ctx.mayflyInteractionState.currentThemeKey = DARK.key
    // A restore failure propagates and settles as a command error.
    await ctx.plugin(themeDark)
    return {
      kind: 'error',
      /* v8 ignore next -- mount failures are Error instances (config validation or service conflicts) */
      text: `failed to apply theme "${next.key}": ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  ctx.mayflyInteractionState.currentThemeKey = next.key
  return { kind: 'success', text: `switched to theme "${next.key}"` }
}

/** Apply a built-in theme by key for the persisted settings default. */
export async function applyTheme(ctx: Context, key: string): Promise<CommandResult> {
  const target = BUILTIN.get(key)
  if (target === undefined) {
    return { kind: 'error', text: `unknown theme "${key}" (known: ${[...BUILTIN.keys()].join(', ')})` }
  }
  return switchTheme(ctx, target)
}

/**
 * Register the `/theme` command on `ctx.commands`.
 * @param ctx - plugin context carrying the command registry.
 * @returns the registration disposer.
 */
export function registerThemeCommand(ctx: Context): () => void {
  return ctx.commands.register({
    name: 'theme',
    description: 'Switch the color theme',
    input: { hint: '[dark|light|ocean|paper|auto|custom <path> [dark|light|ocean|paper]]' },
    handler: async (invocation): Promise<CommandResult> => {
      const trimmed = invocation.rawInput.trim()
      const args = trimmed.length === 0 ? [] : trimmed.split(/\s+/)
      const name = args.shift()
      if (name === undefined) return openThemePicker(ctx)
      const builtin = BUILTIN.get(name)
      if (builtin !== undefined) {
        if (args.length > 0) return { kind: 'error', text: USAGE }
        return switchTheme(ctx, builtin)
      }
      if (name === 'custom') {
        const path = args.shift()
        const base = args.shift()
        if (path === undefined || args.length > 0) return { kind: 'error', text: USAGE }
        // The base reaches theme-custom's Config schema unvalidated: an
        // invalid value fails the mount, and switchTheme restores dark.
        return switchTheme(ctx, CUSTOM, { path, base: base ?? 'dark' } as themeCustom.Config)
      }
      return { kind: 'error', text: USAGE }
    },
  })
}
