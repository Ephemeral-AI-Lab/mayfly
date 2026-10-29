/** Pure Mayfly settings schema for the official Host settings owner. @module @ephemeral-ai/mayfly-host/settings */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

const THEME_KEYS = [
  'dark', 'tide', 'dusk', 'graphite', 'obsidian', 'catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe',
  'dracula', 'everforest-dark', 'gruvbox-dark', 'kanagawa-wave', 'nord', 'one-dark', 'rose-pine', 'rose-pine-moon',
  'solarized-dark', 'tokyo-night', 'tokyo-night-storm', 'light', 'linen', 'mist', 'heather', 'porcelain',
  'catppuccin-latte', 'everforest-light', 'gruvbox-light', 'kanagawa-lotus', 'one-light', 'rose-pine-dawn',
  'solarized-light', 'tokyo-night-day',
] as const

const THEME = z.union([
  ...THEME_KEYS.map(key => z.const(key)),
  z.const('auto'),
  z.transform(z.string(), () => 'dark' as const),
])
const PRICES = z.dict(z.object({
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
  currency: z.union([z.const('USD'), z.const('CNY')]).default('USD'),
}))
const KEYBINDINGS = z.dict(z.object({ keys: z.array(z.string()).default([]), label: z.string() }))

/** Complete volatile Mayfly preference schema; presentation application stays TUI-local. */
export const Config: z<Record<string, unknown>> = z.object({
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
  glyphs: z.union([z.const('auto'), z.const('unicode'), z.const('ascii')]).default('auto').volatile(),
  monochrome: z.boolean().default(false).volatile(),
  reducedMotion: z.boolean().default(false).volatile(),
  quietHints: z.union([z.const('full'), z.const('off')]).default('full').volatile(),
  viewHistory: z.boolean().default(false).volatile(),
  startup: z.union([z.const('conversation'), z.const('splash')]).default('conversation').volatile(),
})

export const name = 'mayfly-settings'
export const inject = ['settings']

/** Enable the ordinary generated settings page without applying presentation in Host. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.settings.configure({ auto: true }, ctx.fiber))
}
