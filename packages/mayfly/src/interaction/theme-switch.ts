/**
 * The `/theme` command and the provider swap behind it. The command knows
 * the ten built-in palettes of `core/palettes.ts` (the default through
 * `mayfly-theme-dark`, the rest through `mayfly-theme-builtin` with the palette
 * in its config), `auto`, and `custom`, and switches by disposing the live
 * provider's fibers — `ctx.registry.delete` keys
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
import { PALETTES, paletteOf } from '../core/palettes.ts'
import * as themeAuto from '../core/theme-auto.ts'
import * as themeBuiltin from '../core/theme-builtin.ts'
import * as themeCustom from '../core/theme-custom.ts'
import * as themeDark from '../core/theme-dark.ts'
import { interactionTranslator } from './locale.ts'
import { themeGroup, themeIdea, themeName } from './theme-names.ts'
import { openUiOverlay } from './ui-overlay.ts'

/** Usage text returned for malformed `/theme` invocations; bare `/theme` lists every theme with its key. */
const USAGE = 'usage: /theme [<theme>|auto|custom <path> [<base theme>]]'

/** One switchable theme provider: the command-facing key, its display name, the plugin module, and its config. */
interface ThemeTarget {
  readonly key: string
  readonly name: string
  readonly module: Plugin
  readonly config?: themeBuiltin.Config | themeCustom.Config
}

/** The baseline provider, also the fallback restored after a failed mount. */
const DARK: ThemeTarget = { key: 'dark', name: paletteOf('dark').name, module: themeDark }

/** The built-in palettes in picker order (dark terminals first, then light), then `auto`; all switchable without a path. */
const BUILTIN: ReadonlyMap<string, ThemeTarget> = new Map([
  ...PALETTES.map(palette => [palette.key, palette.key === DARK.key
    ? DARK
    : { key: palette.key, name: palette.name, module: themeBuiltin, config: { palette: palette.key } }] as const),
  ['auto', { key: 'auto', name: 'Auto', module: themeAuto }],
])

/** The file-backed palette, switched with a path (and optional base) config. */
const CUSTOM: ThemeTarget = { key: 'custom', name: 'Custom', module: themeCustom }


/**
 * The bare `/theme` picker: a choose-list overlay over the built-in themes with
 * the live row in the theme color with a `✓` (spec §2.2), the same vocabulary
 * as every picker. Selecting a row swaps the provider; `custom` is not listed
 * because it needs a path argument (`/theme custom <path>`). The
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
      const target = BUILTIN.get(key)
      if (target === undefined) return { kind: 'failed', message: t('unknown theme "{key}"', { key }) }
      const result = await switchTheme(ctx, target)
      if (result.kind === 'error') return { kind: 'failed', message: result.text }
      /* switchTheme success always carries the "switched to" text */
      return { kind: 'completed', dismiss: true, ...(result.text === undefined ? {} : { feedback: { severity: 'success' as const, message: result.text } }) }
    } },
  }, ui.surface({ chrome: 'overlay', title: t('Select a theme'), child: ui.list({
    id: 'themes', role: 'choose', selectedIds: BUILTIN.has(current) ? [current] : [],
    // Grouped by the terminal a palette is drawn for; `auto` sits apart under a blank row. `custom` needs a file path,
    // so only `/theme custom <path>` reaches it.
    items: [...BUILTIN.values()].map(target => ({
      id: target.key, label: themeName(target.key, t), detail: themeIdea(target.key, t), group: themeGroup(target.key, t),
      ...(target.key === current ? { current: true } : {}),
    })),
  }) }), { reopen: 'replace' })
  return { kind: 'success' }
}

/**
 * Swap the live provider for `next`: dispose every fiber of the current
 * module, then mount the replacement. A mount failure restores dark.
 * @param ctx - plugin context.
 * @param next - the theme to activate, with its config when it takes one.
 * @returns the command outcome.
 */
async function switchTheme(ctx: Context, next: ThemeTarget): Promise<CommandResult> {
  const t = interactionTranslator(ctx)
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
    await (next.config === undefined ? ctx.plugin(next.module) : ctx.plugin(next.module, next.config))
  } catch (error) {
    ctx.mayflyInteractionState.currentThemeKey = DARK.key
    // A restore failure propagates and settles as a command error.
    await ctx.plugin(themeDark)
    return {
      kind: 'error',
      /* mount failures are Error instances (config validation or service conflicts) */
      text: t('failed to apply theme "{key}": {error}', { key: next.key, error: error instanceof Error ? error.message : String(error) }),
    }
  }
  ctx.mayflyInteractionState.currentThemeKey = next.key
  return { kind: 'success', text: t('switched to theme "{key}"', { key: themeName(next.key, t) }) }
}

/**
 * Restart the live theme provider with its current config. Every consumer rebuilds through Cordis reload semantics,
 * exactly as for a `/theme` switch, which is how a presentation change (glyphs, monochrome, reduced motion) reaches
 * every painter and retires every cached row.
 * @param ctx - plugin context.
 */
export async function reloadTheme(ctx: Context): Promise<void> {
  const key = ctx.mayflyInteractionState.currentThemeKey
  const target = key === CUSTOM.key ? CUSTOM : BUILTIN.get(key) ?? DARK
  const runtime = ctx.registry.get(target.module)
  if (runtime === undefined) return
  await Promise.all([...runtime.fibers].map(fiber => fiber.restart()))
}

/** Apply a built-in theme by key for the persisted settings default. */
export async function applyTheme(ctx: Context, key: string): Promise<CommandResult> {
  const t = interactionTranslator(ctx)
  const target = BUILTIN.get(key)
  if (target === undefined) {
    return { kind: 'error', text: t('unknown theme "{key}" (known: {known})', { key, known: [...BUILTIN.keys()].join(', ') }) }
  }
  return switchTheme(ctx, target)
}

/**
 * Register the `/theme` command on `ctx.commands`.
 * @param ctx - plugin context carrying the command registry.
 * @returns the registration disposer.
 */
export function registerThemeCommand(ctx: Context): () => void {
  const t = interactionTranslator(ctx)
  return ctx.commands.register({
    name: 'theme',
    description: 'Switch the color theme',
    input: { hint: '[<theme>|auto|custom <path> [<base theme>]]' },
    handler: async (invocation): Promise<CommandResult> => {
      const trimmed = invocation.rawInput.trim()
      const args = trimmed.length === 0 ? [] : trimmed.split(/\s+/)
      const name = args.shift()
      if (name === undefined) return openThemePicker(ctx)
      const builtin = BUILTIN.get(name)
      if (builtin !== undefined) {
        if (args.length > 0) return { kind: 'error', text: t(USAGE) }
        return switchTheme(ctx, builtin)
      }
      if (name === 'custom') {
        const path = args.shift()
        const base = args.shift()
        if (path === undefined || args.length > 0) return { kind: 'error', text: t(USAGE) }
        // The base reaches theme-custom's Config schema unvalidated: an
        // invalid value fails the mount, and switchTheme restores dark.
        return switchTheme(ctx, { ...CUSTOM, config: { path, base: base ?? 'dark' } as themeCustom.Config })
      }
      return { kind: 'error', text: t(USAGE) }
    },
  })
}
