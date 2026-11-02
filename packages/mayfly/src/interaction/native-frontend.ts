/** Native Harness consumers for the in-process reference composition.
 * @module @ephemeral-ai/mayfly/interaction/native-frontend
 */
import type { Context } from '@deepseek-ai/cordis'
import * as providerCommands from './provider-commands.ts'
import * as providerOnboarding from './provider-onboarding.ts'
import * as questions from './questions-plugin.ts'
import * as approval from './approval-plugin.ts'
import * as settingsCommand from './settings-command.ts'
import * as presetCommand from './preset-commands.ts'
import * as toolsCommand from './tools-commands.ts'
import * as mcpCommand from './mcp-commands.ts'
import * as sessionInformation from './session-commands.ts'
import * as statsCommand from './stats-command.ts'
import * as skillsCatalog from './skills-catalog.ts'
import * as skillsCommand from './skills-command.ts'
import { LiveAssistantStreamService } from '../conversation/live-stream.ts'
import { SessionFactsService } from '../transcript/session-facts.ts'
import * as assistantStreamRecovery from '../frontend/assistant-stream.ts'

/** Native consumers are isolated from the independent renderer entry. */
export const name = 'mayfly-native-frontend'

/** Mount native service adapters beneath their reference composition owner. */
export function apply(ctx: Context): void {
  const liveStream = new LiveAssistantStreamService(ctx)
  ctx.effect(() => () => liveStream.dispose())
  ctx.plugin(assistantStreamRecovery)
  ctx.plugin({
    name: 'mayfly-session-facts',
    inject: ['mayflyLiveAssistantStream', 'mayflyCurrentAgent', 'sessionProjections', 'sessions', 'agents', 'mayflyConversationReady'],
    apply(owner: Context) {
      const facts = new SessionFactsService(owner, owner.mayflyLiveAssistantStream)
      owner.effect(() => () => facts.dispose())
    },
  })
  ctx.plugin(providerCommands)
  ctx.plugin(providerOnboarding)
  ctx.plugin(questions)
  ctx.plugin(approval)
  ctx.plugin(settingsCommand)
  ctx.plugin(presetCommand)
  ctx.plugin(toolsCommand)
  ctx.plugin(mcpCommand)
  ctx.plugin(sessionInformation)
  ctx.plugin(statsCommand)
  ctx.plugin(skillsCatalog)
  ctx.plugin(skillsCommand)
}
