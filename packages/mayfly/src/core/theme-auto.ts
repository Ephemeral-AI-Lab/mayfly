/**
 * `mayfly-theme-auto` plugin: follows the terminal's color scheme. Mounts
 * Mayfly Dark or Mayfly Light (one brand, two backgrounds) according to the probed
 * `mayflyTerminalInfo.background` (`undefined` falls back to dark), then
 * tracks `'mayfly/terminal-theme-changed'`: when the reported scheme implies
 * the other palette, the current provider sub-fiber is disposed and a fresh
 * one is mounted, so `mayflyTheme` consumers rebuild through Cordis reload
 * semantics. Duplicate reports are ignored without a remount.
 *
 * @module @ephemeral-ai/mayfly/core/theme-auto
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { paletteColors, paletteModel } from './palettes.ts'
import { defineThemeService } from './theme-palette.ts'
// Empty type imports carry the `mayflyTerminalInfo` Context merge and the
// `mayfly/terminal-theme-changed` Events merge used below.
import type {} from './terminal-info.ts'
import type {} from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-theme-auto'

/** The probed terminal background selects the initial palette. */
export const inject = ['mayflyTerminalInfo']

const PALETTES = { dark: paletteColors('dark'), light: paletteColors('light') } as const
const MODELS = { dark: paletteModel('dark'), light: paletteModel('light') } as const

/**
 * Provide the scheme-matching built-in palette as `ctx.mayflyTheme`, swapping
 * the provider whenever the terminal reports a scheme change.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  let current: 'dark' | 'light' = ctx.mayflyTerminalInfo.background ?? 'dark'
  let fiber: Fiber = ctx.plugin(defineThemeService(PALETTES[current], MODELS[current]))
  // Swaps serialize through this chain so rapid scheme reports cannot
  // interleave a remount with the previous dispose.
  let swap: Promise<void> = Promise.resolve()
  ctx.on('mayfly/terminal-theme-changed', (scheme) => {
    if (scheme === current) return
    current = scheme
    swap = swap.then(async () => {
      // Dispose before remounting: Cordis rejects a second `mayflyTheme`
      // registration while the previous provider is still live.
      await fiber.dispose()
      fiber = ctx.plugin(defineThemeService(PALETTES[scheme], MODELS[scheme]))
      await fiber
    })
    return swap
  })
}
