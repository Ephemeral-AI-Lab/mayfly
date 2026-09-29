/** Empty-editor guidance derived from displayed conversation access and input state.
 * @module @ephemeral-ai/mayfly/interaction/placeholder
 */
import type { Context } from '@deepseek-ai/cordis'
import { hasRunningAgentWork } from '../app/agent-interrupt.ts'
import { currentMayflySettings } from './settings.ts'
import { interactionTranslator } from './locale.ts'

export function promptPlaceholder(ctx: Context): readonly string[] | undefined {
  const setting = currentMayflySettings(ctx).keyHints
  if (setting === 'off') return undefined
  const t = interactionTranslator(ctx)
  const view = ctx.mayflyConversations.displayed()
  if (view?.access === 'readonly') return [t('Read-only conversation')]
  if (view?.kind !== 'primary' && view?.access === 'resumable') return [t('Reply to {name} — sending resumes it', { name: view.label }), t('Reply to {name}', { name: view.label })]
  if (ctx.mayflyInteractionState.draft.getStashedInputMode() === 'bash') return [t('Run a shell command')]
  const agent = ctx.mayflyCurrentAgent.current()
  const message = view?.kind === 'btw' ? t('Continue the side question')
    : view?.kind === 'subagent' ? t('Message {name}', { name: view.label })
      : agent !== null && hasRunningAgentWork(ctx, agent) ? t('Type a follow-up to queue it') : t('Ask anything')
  if (setting === 'minimal') return [message]
  const mainIdle = view?.kind === 'primary' && (agent === null || !hasRunningAgentWork(ctx, agent))
  const suffixes = mainIdle
    ? [t('/ commands'), t('@ files'), t('# skills'), t('! shell')]
    : [t('@ files'), t('# skills')]
  return Array.from({ length: suffixes.length + 1 }, (_, index) => [message, ...suffixes.slice(0, suffixes.length - index)].join(' · '))
}
