/** Renderer-neutral Mayfly frontend services and models.
 * @module @ephemeral-ai/mayfly/frontend
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MayflyLocaleService } from './locale.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../core/ui-interaction-state.ts'
import * as providerCommands from '../interaction/provider-commands.ts'
import * as providerOnboarding from '../interaction/provider-onboarding.ts'
import * as questions from '../interaction/questions-plugin.ts'
import * as approval from '../interaction/approval-plugin.ts'
import * as settingsCommand from '../interaction/settings-command.ts'
import * as presetCommand from '../interaction/preset-commands.ts'
import * as toolsCommand from '../interaction/tools-commands.ts'
import * as mcpCommand from '../interaction/mcp-commands.ts'
import * as sessionInformation from '../interaction/session-commands.ts'
import * as skillsCatalog from '../interaction/skills-catalog.ts'
import * as skillsCommand from '../interaction/skills-command.ts'

export * from './models.ts'
export * from './theme.ts'
export * from './locale.ts'

export const name = 'mayfly-frontend'
export interface Config { readonly displayVersion?: string }
export const Config: z<Config> = z.object({ displayVersion: z.string() })

/** Mount stable interaction ownership and its independent consumer Fibers. */
export function apply(ctx: Context, config: Config = {}): void {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const service = new MayflyLocaleService(ctx, { systemLocale: locale })
  ctx.effect(() => () => service.dispose())
  const interaction = new UiInteractionService(ctx)
  ctx.effect(() => () => interaction.dispose())
  mountUiRegistryObservers(ctx)
  ctx.plugin(providerCommands)
  ctx.plugin(providerOnboarding)
  ctx.plugin(questions)
  ctx.plugin(approval)
  ctx.plugin(settingsCommand)
  ctx.plugin(presetCommand)
  ctx.plugin(toolsCommand)
  ctx.plugin(mcpCommand)
  ctx.plugin(sessionInformation, config)
  ctx.plugin(skillsCatalog)
  ctx.plugin(skillsCommand)
}
