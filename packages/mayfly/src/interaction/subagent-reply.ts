/** Addressed child replies retain their drafts independently of the transcript renderer.
 * @module @ephemeral-ai/mayfly/interaction/subagent-reply
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { openUiOverlay } from './ui-overlay.ts'
import { interactionTranslator } from './locale.ts'

export const name = 'mayfly-subagent-reply'
export const inject = ['mayflyCurrentAgent', 'mayflyOverlays', 'subagents']

export function apply(ctx: Context): void {
  ctx.on('mayfly/request-subagent-reply', target => {
    const t = interactionTranslator(ctx)
    const primary = ctx.mayflyCurrentAgent.primary()
    const initial = ctx.mayflyCurrentAgent.view()
    const live = initial.auxiliary?.access === 'interactive' ? ctx.mayflyCurrentAgent.current() : undefined
    const current = () => {
      const view = ctx.mayflyCurrentAgent.view()
      return view.displayed === 'auxiliary' && view.auxiliary?.kind === 'subagent'
        && view.auxiliary.sessionId === target.sessionId && view.auxiliary.parentSessionId === target.parentSessionId
        && view.auxiliary.mode === 'continuable'
        && ctx.mayflyCurrentAgent.primary() === primary
        && (live === undefined || ctx.mayflyCurrentAgent.current() === live)
    }
    if (!current()) return
    const node = (value: string, delivery: 'queue' | 'steer' = 'queue') => ui.surface({ title: t('Reply to {name}', { name: target.label }), chrome: 'overlay', child: ui.stack.column([
      ui.form({ id: 'reply', fields: [
        { kind: 'textarea', id: 'message', label: t('Message'), value },
        { kind: 'select', id: 'delivery', label: t('Delivery'), value: delivery, options: [
          { id: 'queue', label: t('Queue'), detail: t('Process after the current turn') },
          { id: 'steer', label: t('Steer'), detail: t('Process at the next step boundary') },
        ] },
      ] }),
      ...(initial.auxiliary?.access === 'resumable' ? [ui.text(t('Sending resumes this member. Browsing and drafting do not.'), { tone: 'muted' })] : []),
      ui.actions({ id: 'reply-actions', items: [{ id: 'send', label: t('Send'), submit: [{ pagePath: [], formId: 'reply' }] }, { id: 'close', label: t('Cancel'), dismiss: true }] }),
    ]) })
    let offView: (() => void) | undefined
    const handle = openUiOverlay(ctx, { id: 'mayfly.subagent.reply', title: t('Reply to {name}', { name: target.label }), presentation: 'editor', capturing: true, onEvent: { action: async (event, context) => {
      if (event.kind !== 'submit') return { kind: 'completed' }
      const text = event.submission.forms[0]?.fields.find(field => field.id === 'message')?.value
      if (typeof text !== 'string' || text.trim() === '') return { kind: 'failed', message: t('Enter a message') }
      const delivery = event.submission.forms[0]?.fields.find(field => field.id === 'delivery')?.value ?? 'queue'
      if (delivery !== 'queue' && delivery !== 'steer') return { kind: 'failed', message: t('Choose Queue or Steer') }
      if (!current()) return { kind: 'cancelled' }
      try {
        await ctx.subagents.prompt({
          requestId: randomUUID() as SubagentPromptRequestId,
          parentSessionId: SessionId(target.parentSessionId),
          childSessionId: SessionId(target.sessionId),
          mode: 'continuable', delivery, content: [{ type: 'text', text }],
        }, context.signal)
        return { kind: 'accepted', node: node(text, delivery), source: [], dismiss: true }
      } catch (error) {
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
    } } }, node(''), { reopen: 'focus', onClosed: () => offView?.() })
    if (handle === undefined) return
    offView = ctx.mayflyCurrentAgent.subscribeView(() => { if (!current()) handle.close() })
  })
}
