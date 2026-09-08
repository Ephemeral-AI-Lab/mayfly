/**
 * @ephemeral-ai/mayfly/interaction — Mayfly terminal UI interaction layer
 * over Mayfly core: the bottom input editor with slash-command dispatch
 * (`mayfly-input`, pi-tui Editor behind `ctx.mayflyComponents`), the built-in
 * `/quit`, `/resume`, `/new`, `/fork`, `/sessions`, `/help`, and `/theme`
 * commands (`mayfly-commands`). The optional bash-mode and autocomplete enhancement
 * layer is mounted with the editor as one interaction feature, and the
 * queued-message pane with app-owned live refresh as the
 * `./pane-queue` subpath plugin (`mayfly-pane-queue`). The session-title
 * terminal mirror (`mayfly-terminal-title`, the OSC 0 window title over the
 * upstream session-title fold), the consolidated `mayfly` settings namespace
 * (`mayfly-settings`), and the
 * boot-time update check (`mayfly-update-check`). All
 * registrations are effect-bound, so unloading the fiber reverts every
 * contribution.
 *
 * @module @ephemeral-ai/mayfly/interaction
 */

import type { Context } from '@deepseek-ai/cordis'
import * as agentViewStatusPlugin from './agent-view-status.ts'
import * as commandsPlugin from './commands-plugin.ts'
import * as inputPlugin from './input-plugin.ts'
import * as keysPlugin from './keys.ts'
import * as sessionTranscriptPanelPlugin from './session-transcript-panel.ts'
import * as settingsPlugin from './settings.ts'
import * as terminalTitlePlugin from './terminal-title.ts'
import * as updateCheckPlugin from './updater/check.ts'
import { PromptEditorController } from './editor-instance.ts'
import { PromptSubmitPipeline } from './prompt-submit-pipeline.ts'
import { InteractionStateService } from './runtime-state.ts'
import { DEFAULT_SETTINGS } from './settings.ts'
import { mountInteractionLocale } from './locale.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-interaction'
/** App-owned current-Agent selection required before child interaction fibers mount. */
export const inject = ['mayflyCurrentAgent', 'skills']

/**
 * Mount the Mayfly interaction plugins. The key batch registers first; the
 * other plugins resolve their keys against it.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const runtimeState = new InteractionStateService(ctx, DEFAULT_SETTINGS)
  ctx.effect(() => () => runtimeState.dispose())
  const editorHost = new PromptEditorController(ctx)
  ctx.effect(() => () => editorHost.dispose())
  const promptSubmissions = new PromptSubmitPipeline(ctx)
  ctx.effect(() => () => promptSubmissions.dispose())
  ctx.plugin(keysPlugin)
  ctx.plugin(agentViewStatusPlugin)
  ctx.plugin(commandsPlugin)
  ctx.plugin(inputPlugin)
  ctx.plugin(sessionTranscriptPanelPlugin)
  ctx.plugin(terminalTitlePlugin)
  ctx.plugin(settingsPlugin)
  ctx.plugin(updateCheckPlugin)
}
