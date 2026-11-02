/** Shared frontend preferences, defaults, and resolved-value readers. @module */
import type { MayflyPaletteKey } from '../core/palettes.ts'
/** The user-tunable Mayfly settings (the `mayfly` settings namespace). */
export interface MayflySettings {
  /** Whether the boot update check runs at all; `false` is the offline switch. */
  readonly updateCheck: boolean
  /** The dist-tag the update check follows (`latest` by default). */
  readonly updateChannel: string
  /** The interface language; `system` follows the process locale and means none was chosen yet (the first-run guide offers the choice). */
  readonly language: 'system' | 'en' | 'zh'
  /** The default theme, applied at startup; `/theme` overrides per session. */
  readonly theme: MayflyPaletteKey | 'auto'
  /** Native Harness work-detail mode. */
  readonly transcriptView: 'compact' | 'standard' | 'detailed' | 'verbose'
  /** Completed turns kept mounted in the transcript window (mirrors transcript's DEFAULT_WINDOW_TURNS). */
  readonly windowTurns: number
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
  // Key bindings (slice 1.7): applied live by `./keys.ts`, written by the keybinding panel.
  /** User key overrides by action id, each with the label the action was listed under. */
  readonly keybindings: Readonly<Record<string, MayflyKeybindingOverride>>
  /** Hint rows lead with the key that has no Alt, for hosts that do not deliver Alt. */
  readonly preferPlainKeys: boolean
  /** Token prices per million by `provider/model` for `/stats`; they win over the built-in DeepSeek table and the models.dev catalog. */
  readonly prices: Readonly<Record<string, MayflyPrice>>
  /** CNY per USD, to show a USD price in CNY (Chinese UI) and a CNY price in USD (English UI). */
  readonly usdCnyRate: number
  /** A provider balance below this in every currency it holds is low (the `/stats` Account tab warns). */
  readonly lowBalanceCny: number
  readonly lowBalanceUsd: number
  // Presentation (slice 1.2): read by core through `core/presentation.ts`; a change reloads the live theme provider.
  /** Glyph vocabulary: `auto` follows the locale's charset; `ascii` is the one-cell fallback table. */
  readonly glyphs: 'auto' | 'unicode' | 'ascii'
  /** Weight only, no color; `NO_COLOR` turns it on whatever this says. */
  readonly monochrome: boolean
  /** Freeze every animation channel on its first frame. */
  readonly reducedMotion: boolean
  /** How much the activity row and the editor teach: `full` fills the activity row's second line with a rotating tip while no action runs, `off` leaves it blank. */
  readonly quietHints: 'full' | 'off'
  /** Whether the views of the status row list their finished items (completed todos, settled jobs) beside the live ones. */
  readonly viewHistory: boolean
  /** What a start without a session shows: the splash (mark, recent sessions) or the conversation screen. No session exists until the first message either way. */
  readonly startup: 'conversation' | 'splash'
}

/** One saved key override: the keys that replace an action's defaults, and its label for when it is not loaded. */
interface MayflyKeybindingOverride {
  readonly keys: readonly string[]
  readonly label?: string
}

/** One model's token price per million, in `currency`; a missing cache price follows the input price. */
interface MayflyPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly currency: 'USD' | 'CNY'
}

/** The resolved defaults, used until a settings service layers overrides. */
export const DEFAULT_SETTINGS: MayflySettings = {
  updateCheck: true,
  updateChannel: 'latest',
  language: 'system',
  theme: 'dark',
  transcriptView: 'standard',
  windowTurns: 15,
  expandTurns: 3,
  userFoldLines: 10,
  userFoldChars: 1000,
  editorCommand: '',
  pasteImageBackend: 'auto',
  marketIndexUrl: '',
  keybindings: {},
  preferPlainKeys: false,
  prices: {},
  usdCnyRate: 7.2,
  lowBalanceCny: 10,
  lowBalanceUsd: 1.5,
  // Presentation (slice 1.2).
  glyphs: 'auto',
  monochrome: false,
  reducedMotion: false,
  quietHints: 'full',
  viewHistory: false,
  startup: 'conversation',
}

/**
 * Read the current `mayfly` settings: the row's volatile Config cells, which
 * carry schema defaults layered with the composition base and the user
 * document, reconciled in place on every committed write.
 * @returns the resolved Mayfly settings.
 */
export function currentMayflySettings(ctx: { readonly mayflyInteractionState: { settingsSource(): MayflySettings } }): MayflySettings {
  return ctx.mayflyInteractionState.settingsSource()
}

/** Unwrap a volatile config cell, or pass an ordinary value through. */
const cell = (value: unknown): unknown =>
  typeof (value as { get?: unknown } | null | undefined)?.get === 'function' ? (value as { get(): unknown }).get() : value

/** Pick the declared `mayfly` fields out of an arbitrary resolved/config object. */
export function settingsOverrides(value: unknown): Partial<MayflySettings> {
  const out: Partial<Mutable<MayflySettings>> = {}
  if (value === null || typeof value !== 'object') return out
  for (const key of Object.keys(DEFAULT_SETTINGS) as readonly (keyof MayflySettings)[]) {
    const field = cell((value as Record<string, unknown>)[key])
    if (field !== undefined) (out as Record<string, unknown>)[key] = field
  }
  return out
}

/** Read the declared fields of an already resolved native settings value. */
export function resolveMayflySettings(value: unknown): MayflySettings {
  return { ...DEFAULT_SETTINGS, ...settingsOverrides(value) }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
