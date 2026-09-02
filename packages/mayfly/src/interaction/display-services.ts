/**
 * The lazily-resolved Mayfly display services the panel-mounting commands
 * share. Extracted so `./commands-plugin.ts` and `./model-commands.ts`
 * resolve the same quartet without a circular import; the commands never
 * inject these services (a command handler's fiber must not become a theme
 * dependent — `/theme` would dispose it mid-swap).
 *
 * @module @ephemeral-ai/mayfly/interaction/display-services
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Resolve the screen, component factory, theme, and keymap services.
 * @param ctx - plugin context.
 * @returns the four services plus the theme's color table, or `undefined` when any is missing.
 */
export function displayServices(ctx: Context) {
  const screen = ctx.get('mayflyScreen')
  const components = ctx.get('mayflyComponents')
  const theme = ctx.get('mayflyTheme')
  const keymap = ctx.get('mayflyKeymap')
  if (screen === undefined || components === undefined || theme === undefined || keymap === undefined) {
    return undefined
  }
  return { screen, components, theme, colors: theme.colors, keymap }
}
