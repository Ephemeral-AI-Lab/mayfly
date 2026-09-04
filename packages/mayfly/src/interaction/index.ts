/**
 * @ephemeral-ai/mayfly/interaction — Mayfly terminal UI interaction layer
 * over Mayfly core: the bottom input editor with slash-command dispatch
 * (`mayfly-input`, pi-tui Editor behind `ctx.mayflyComponents`), the built-in
 * `/quit`, `/resume`, `/new`, `/fork`, `/sessions`, `/help`, and `/theme`
 * commands (`mayfly-commands`), the `ctx.userQuestions`
 * overlay provider (`mayfly-questions`, one tabbed questionnaire overlay per
 * request), and the interactive four-choice `approval/request` answerer
 * (`mayfly-approval`). The optional bash-mode and autocomplete enhancement
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
import z from '@deepseek-ai/schemastery'
import * as approvalPlugin from './approval-plugin.ts'
import * as agentViewStatusPlugin from './agent-view-status.ts'
import * as commandsPlugin from './commands-plugin.ts'
import * as inputPlugin from './input-plugin.ts'
import * as keysPlugin from './keys.ts'
import * as sessionTranscriptPanelPlugin from './session-transcript-panel.ts'
import * as providerOnboardingPlugin from './provider-onboarding.ts'
import * as questionsPlugin from './questions-plugin.ts'
import * as settingsPlugin from './settings.ts'
import * as terminalTitlePlugin from './terminal-title.ts'
import * as updateCheckPlugin from './updater/check.ts'
import { PromptEditorController } from './editor-instance.ts'
import { EditorPanelController } from './editor-panel-controller.ts'
import { PromptSubmitPipeline } from './prompt-submit-pipeline.ts'
import { SkillsCatalogService } from './skills-catalog.ts'
import { InteractionStateService } from './runtime-state.ts'
import { DEFAULT_SETTINGS } from './settings.ts'
import { mountInteractionLocale } from './locale.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-interaction'
/** App-owned current-Agent selection required before child interaction fibers mount. */
export const inject = ['mayflyCurrentAgent', 'skills']

/** Interaction configuration; the override identifies acceptance profiles without changing the release line. */
export interface Config {
  /** Optional profile-local identity shown in version surfaces. */
  readonly displayVersion?: string
}

/** Interaction configuration schema. */
export const Config: z<Config> = z.object({
  displayVersion: z.string(),
})

/**
 * Mount the Mayfly interaction plugins. The key batch registers first; the
 * other plugins resolve their keys against it.
 * @param ctx - plugin context.
 * @param config - interaction presentation configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  mountInteractionLocale(ctx)
  const runtimeState = new InteractionStateService(ctx, DEFAULT_SETTINGS)
  ctx.effect(() => () => runtimeState.dispose())
  const editorHost = new PromptEditorController(ctx)
  ctx.effect(() => () => editorHost.dispose())
  const editorPanels = new EditorPanelController(ctx)
  ctx.effect(() => () => editorPanels.dispose())
  const promptSubmissions = new PromptSubmitPipeline(ctx)
  ctx.effect(() => () => promptSubmissions.dispose())
  const skillsCatalog = new SkillsCatalogService(ctx)
  ctx.effect(() => () => skillsCatalog.dispose())
  ctx.plugin(keysPlugin)
  ctx.plugin(agentViewStatusPlugin)
  ctx.plugin(commandsPlugin, config)
  ctx.plugin(inputPlugin)
  ctx.plugin(sessionTranscriptPanelPlugin)
  ctx.plugin(providerOnboardingPlugin)
  ctx.plugin(questionsPlugin)
  ctx.plugin(approvalPlugin)
  ctx.plugin(terminalTitlePlugin)
  ctx.plugin(settingsPlugin)
  ctx.plugin(updateCheckPlugin)
}
