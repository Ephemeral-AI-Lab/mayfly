/** `/rename`: an explicit user name for the current session through the
 * native session controller. Harness records it as a user-owned
 * `session/title`, which pins the name against automatic titling.
 * @module @ephemeral-ai/mayfly/interaction/rename-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-title/types'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { interactionTranslator } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'

const RENAME_FORM = 'session-rename'

/**
 * Register `/rename [<name>]`: a name argument renames the current session
 * directly; a bare command opens a one-field form prefilled with the
 * current name.
 * @param ctx - plugin context carrying the command registry, the session
 *   controller, projections, current-Agent selection, and overlays.
 * @returns the command disposer.
 */
export function registerRenameCommand(ctx: Context): () => void {
  const t = interactionTranslator(ctx)
  const rename = async (agent: Agent, title: string): Promise<CommandResult> => {
    try {
      const accepted = await ctx.sessionController.rename({ sessionId: agent.id, title })
      return { kind: 'success', text: t('renamed session to {title}', { title: accepted.title }) }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }
  return ctx.commands.register({
    name: 'rename',
    description: 'Rename the current session (no name opens an editor)',
    input: { hint: '[<name>]' },
    handler: async invocation => {
      const agent = invocation.agent
      if (ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'error', text: t('no session is live yet') }
      const title = invocation.rawInput.trim()
      if (title !== '') return rename(agent, title)
      const currentTitle = ctx.sessionProjections.snapshot(agent.session, ['title']).values.title ?? ''
      openUiOverlay(ctx, {
        id: 'mayfly.rename',
        title: t('Rename session'),
        presentation: 'editor',
        capturing: true,
        scope: { kind: 'session', sessionId: String(agent.id) },
        onEvent: { action: async event => {
          if (event.kind !== 'activate' || event.actionId !== 'save') return { kind: 'completed' }
          const value = event.inputs?.forms[0]?.fields.find(field => field.id === 'title')?.value
          if (typeof value !== 'string' || value.trim() === '') return { kind: 'failed', message: t('Enter a session name') }
          if (ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'failed', message: t('The current session changed; run /rename again') }
          const result = await rename(agent, value.trim())
          return result.kind === 'error' ? { kind: 'failed', message: result.text } : { kind: 'completed', dismiss: true }
        } },
      }, ui.surface({ title: t('Rename session'), chrome: 'overlay', child: ui.stack.column([
        ui.form({ id: RENAME_FORM, fields: [{ kind: 'input', id: 'title', label: t('Session name'), value: currentTitle }] }),
        ui.actions({ id: 'rename-actions', items: [
          { id: 'save', label: t('Rename'), read: [{ pagePath: [], formId: RENAME_FORM }] },
          { id: 'close', label: t('Cancel'), dismiss: true },
        ] }),
      ]) }), { reopen: 'focus' })
      return { kind: 'success' }
    },
  })
}
