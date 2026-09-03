/**
 * @ephemeral-ai/mayfly/core — Mayfly terminal UI core: the tree's only
 * `@earendil-works/pi-tui` adapter. Loading the plugin probes the terminal
 * background (OSC 11, before raw mode), starts the alternate-screen renderer
 * over `ProcessTerminal`, and registers the `mayflyScreen`, `mayflyKeymap`,
 * `mayflyTerminalInfo`, and `mayflyComponents` services; `mayflyTheme` is
 * provided separately by the `mayfly-theme-dark` subpath plugin. A global key
 * dispatcher mounted as a TUI input listener consumes handler-carrying key
 * actions before focus routing. Unloading stops the terminal and restores
 * its state.
 *
 * @module @ephemeral-ai/mayfly/core
 */

import type { Context } from '@deepseek-ai/cordis'
import { MayflyComponentsService } from './components.ts'
import { MayflyKeymapService } from './keymap.ts'
import { MayflyScreenService } from './screen.ts'
import { MayflyTerminalInfoService } from './terminal-info.ts'
import { startMayflyTerminal } from './terminal.ts'
import { mountMayflySurfaceRenderer } from './surface-renderer.ts'
import { contextHintTranslator, mountContextHintLocale } from './context-hint-locale.ts'
import { ThemeModelService } from '../frontend/index.ts'

export { MayflyComponentsService, type MayflyComponentsDeps } from './components.ts'
export { GutterComponent } from './gutter.ts'
export { MayflyKeymapError, MayflyKeymapService } from './keymap.ts'
export { MayflyScreenService } from './screen.ts'
export {
  PLUGIN_VIEW_MAX_CHARS,
  PLUGIN_VIEW_MAX_DEPTH,
  paintPluginTone,
  sanitizePluginText,
  summarizePluginView,
} from './plugin-view.ts'
export {
  MayflyTerminalInfoService,
  PROBE_TIMEOUT_MS,
  backgroundFromRgb,
  probeTerminalBackground,
  type MayflyProbeProcess,
} from './terminal-info.ts'
export { createTerminalRelease } from './terminal.ts'
export { alignDiffLines, diffChangeCounts, paintDiffRows, DIFF_ALIGN_MAX_ROWS, CTX_EDGE_ROWS, type DiffOp, type DiffPaintColors } from './diff-align.ts'
export { visibleWidth } from './width.ts'
export {
  compileMayflyEditorShellNode,
  compileMayflyStatusNode,
  compileMayflyUiNode,
  type MayflyCompiledEditorShell,
  type MayflyEditorShellComponent,
  type MayflyCompiledStatus,
  type MayflyEditorShellRenderOptions,
  type MayflyEditorShellRenderResult,
  type MayflyCompiledUi,
  type MayflyEditorShellCompileResult,
  type MayflyEditorShellCompilerOptions,
  type MayflyStatusCompileFailure,
  type MayflyStatusCompileResult,
  type MayflyStatusCompilerOptions,
  type MayflyStatusComponent,
  type MayflyStatusRenderResult,
  type MayflyUiCompileFailure,
  type MayflyUiCompileResult,
  type MayflyUiCompilerOptions,
  type MayflyUiViewport,
} from './ui-compiler.ts'
export {
  MAYFLY_UI_MAX_COLLECTION,
  MAYFLY_UI_MAX_DEPTH,
  MAYFLY_UI_MAX_NODES,
  MAYFLY_UI_MAX_TEXT,
  validateMayflyEditorShellNode,
  validateMayflyStatusNode,
  validateMayflyUiNode,
} from './ui-validator.ts'
export type {
  MayflyEditorShellNode,
  MayflyUiErrorCode,
  MayflyValidationResult,
} from './ui-contracts.ts'
export {
  TITLE_MAX_CHARS,
  buildClipboardOsc52,
  buildTitleOsc0,
  emitClipboardOsc52,
  sanitizeTitleText,
  type MayflyEscapeProcess,
} from './terminal-escape.ts'
export type {
  MayflyAutocompleteItem,
  MayflyAutocompleteProvider,
  MayflyAutocompleteSuggestions,
  MayflyColorFn,
  MayflyComponent,
  MayflyComponents,
  MayflyEditor,
  MayflyEditorOptions,
  MayflyEditorSubmitAttempt,
  MayflyFocusable,
  MayflyFocusIdentity,
  MayflyImage,
  MayflyImageOptions,
  MayflyKeyAction,
  MayflyKeymap,
  MayflyMarkdown,
  MayflyMarkdownOptions,
  MayflyOverlayAnchor,
  MayflyOverlayHandle,
  MayflyOverlayOptions,
  MayflyOverlaySize,
  MayflyOverlayUnfocusOptions,
  MayflyRgbColor,
  MayflyScreen,
  MayflyScreenSlot,
  MayflySelectItem,
  MayflySelectList,
  MayflySelectListOptions,
  MayflySemanticColors,
  MayflySettingItem,
  MayflySettingsList,
  MayflySettingsListOptions,
  MayflyTerminalInfo,
  MayflyTheme,
  MayflyTopRuleOptions,
} from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-core'

/**
 * Probe the terminal, start it, and mount the L1 services. `mayflyKeymap`
 * instantiates directly (see below); the remaining services are class
 * plugins on their own fibers, so unloading this plugin unregisters all of
 * them; the effect stops the terminal last. `mayflyComponents` mounts as a
 * sub-plugin injecting `mayflyTheme`: while no theme provider is loaded the
 * sub-plugin waits, and a provider swap rebuilds the factory through
 * Cordis reload semantics.
 * @param ctx - plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.plugin(ThemeModelService)
  const runtime = await startMayflyTerminal(undefined, undefined, (scheme) => {
    ctx.emit('mayfly/terminal-theme-changed', scheme)
  }, undefined, 'alternate', { stdout: process.stdout, stderr: process.stderr })
  mountContextHintLocale(ctx, runtime.requestRender)
  // The keymap instantiates directly instead of as a class plugin so the
  // dispatcher below can close over the instance: the runtime predates the
  // service, and the Context proxy rejects service access without an inject
  // declaration — which a self-provided service cannot carry. Registration
  // is still effect-bound, so unloading reverts it.
  const keymap = new MayflyKeymapService(ctx)
  // The global key dispatcher consumes handler-carrying actions before
  // focus routing; wiring it here because the runtime predates the keymap.
  ctx.effect(() =>
    runtime.tui.addInputListener(data => (keymap.dispatch(data) ? { consume: true } : undefined)),
  )
  ctx.plugin(MayflyTerminalInfoService, { background: runtime.background, kittyKeyboard: runtime.kittyKeyboard })
  ctx.plugin(MayflyScreenService, runtime)
  ctx.plugin({
    name: 'mayfly-components',
    inject: ['mayflyTheme'],
    apply(subCtx: Context) {
      subCtx.plugin(MayflyComponentsService, { theme: subCtx.mayflyTheme, tui: runtime.tui })
    },
  })
  ctx.plugin({
    name: 'mayfly-surface-renderer',
    inject: ['mayflyPanes', 'mayflyOverlays', 'mayflyComponents', 'mayflyTheme', 'mayflyKeymap'],
    apply(subCtx: Context) {
      mountMayflySurfaceRenderer(subCtx as Parameters<typeof mountMayflySurfaceRenderer>[0], runtime, contextHintTranslator(ctx))
    },
  })
  ctx.effect(() => () => runtime.stop())
}
