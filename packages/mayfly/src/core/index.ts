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
import { MayflyTerminalInfoService, backgroundFromRgb, probeTerminalBackground } from './terminal-info.ts'
import { startMayflyTerminal, type MayflyTerminalRuntime } from './terminal.ts'
import { mountMayflySurfaceRenderer } from './surface-renderer.ts'
import { contextHintTranslator, mountContextHintLocale } from './context-hint-locale.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-core'

/**
 * Probe the terminal, start it, and mount the L1 services. `mayflyKeymap`
 * instantiates directly (see below); the remaining services are class
 * plugins on their own fibers, so unloading this plugin unregisters all of
 * them. The terminal's owner effect is registered before the probe and its
 * restore is awaited by the unload; the plugin's other disposables run
 * concurrently with it and tolerate a stopping runtime. `mayflyComponents`
 * mounts as a sub-plugin injecting `mayflyTheme`: while no theme provider is
 * loaded the sub-plugin waits, and a provider swap rebuilds the factory
 * through Cordis reload semantics.
 * @param ctx - plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  // The terminal's owner is registered before the probe acquires anything.
  // Terminal restore starts first at unload and is awaited by the Fiber; the
  // Fiber's children dispose concurrently with it and must tolerate a
  // stopping runtime — a stopped TUI ignores late requestRender calls.
  let runtime: MayflyTerminalRuntime | undefined
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    return runtime?.stop()
  })
  const background = backgroundFromRgb(await probeTerminalBackground())
  // Unloaded during the probe: nothing was started, nothing to stop.
  if (disposed) return
  runtime = startMayflyTerminal(undefined, {
    background,
    onSchemeChange: (scheme) => {
      ctx.emit('mayfly/terminal-theme-changed', scheme)
    },
    screenMode: 'alternate',
    ambientOutput: { stdout: process.stdout, stderr: process.stderr },
  })
  mountContextHintLocale(ctx, runtime.requestRender)
  // The keymap instantiates directly instead of as a class plugin so the
  // dispatcher below can close over the instance: the runtime predates the
  // service, and the Context proxy rejects service access without an inject
  // declaration — which a self-provided service cannot carry. Registration
  // is still effect-bound, so unloading reverts it.
  const keymap = new MayflyKeymapService(ctx)
  // A rebind or the plain-key preference changes hints on screen: repaint them at once.
  ctx.effect(() => keymap.subscribe(() => runtime.requestRender()))
  ctx.plugin(MayflyTerminalInfoService, { background: runtime.background, kittyKeyboard: runtime.kittyKeyboard })
  ctx.plugin(MayflyScreenService, runtime)
  ctx.plugin({
    name: 'mayfly-global-key-dispatcher',
    inject: ['mayflyScreen'],
    apply(owner: Context) {
      owner.effect(() => runtime.tui.addInputListener((data) => {
        // The first F2-F5 press, wherever focus is, tells the keymap the host may not deliver Alt.
        keymap.notePlainKey(data)
        return owner.mayflyScreen.capturesInput === true || !keymap.dispatch(data) ? undefined : { consume: true }
      }))
    },
  })
  ctx.plugin({
    name: 'mayfly-components',
    inject: ['mayflyTheme'],
    apply(subCtx: Context) {
      subCtx.plugin(MayflyComponentsService, { theme: subCtx.mayflyTheme, tui: runtime.tui })
    },
  })
  ctx.plugin({
    name: 'mayfly-surface-renderer',
    inject: ['mayflyUiInteraction', 'mayflyScreen', 'mayflyComponents', 'mayflyTheme', 'mayflyKeymap'],
    apply(subCtx: Context) {
      mountMayflySurfaceRenderer(subCtx as Parameters<typeof mountMayflySurfaceRenderer>[0], runtime, contextHintTranslator(ctx), subCtx.get('mayflyUiImages'))
    },
  })
}
