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
import type {} from '../app/conversation-views.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A reply form sent a message it was seeded with from the editor draft. */
    'mayfly/subagent-reply-sent'(draft: string): void
  }
}

export const name = 'mayfly-subagent-reply'
export const inject = ['mayflyConversations', 'mayflyCurrentAgent', 'mayflyOverlays', 'subagents']

export function apply(ctx: Context): void {
  ctx.on('mayfly/request-subagent-reply', (target, draft) => {
    const t = interactionTranslator(ctx)
    const primary = ctx.mayflyCurrentAgent.primary()
    const initial = ctx.mayflyConversations.displayed()
    const live = initial?.access === 'interactive' ? ctx.mayflyCurrentAgent.current() : undefined
    const current = () => {
      const view = ctx.mayflyConversations.displayed()
      return view?.kind === 'subagent'
        && view.sessionId === target.sessionId && view.parentSessionId === target.parentSessionId
        && view.mode === 'continuable'
        && ctx.mayflyCurrentAgent.primary() === primary
        && (live === undefined || ctx.mayflyCurrentAgent.current() === live)
    }
    if (!current()) return
    const node = (value: string, delivery: 'queue' | 'steer' = 'queue') => ui.surface({ title: t('Reply to {name}', { name: target.label }), chrome: 'overlay', child: ui.stack.column([
      ui.form({ id: 'reply', enterSubmits: 'send', fields: [
        { kind: 'textarea', id: 'message', label: t('Message'), value },
        { kind: 'select', id: 'delivery', label: t('Delivery'), value: delivery, options: [
          { id: 'queue', label: t('Queue'), detail: t('Process after the current turn') },
          { id: 'steer', label: t('Steer'), detail: t('Process at the next step boundary') },
        ] },
      ] }),
      ...(initial?.access === 'resumable' ? [ui.text(t('Sending resumes this member. Browsing and drafting do not.'), { tone: 'muted' })] : []),
      ui.actions({ id: 'reply-actions', reveal: 'focus', items: [{ id: 'send', label: t('Send'), submit: [{ pagePath: [], formId: 'reply' }] }, { id: 'close', label: t('Cancel'), dismiss: true }] }),
    ]) })
    let offView: (() => void) | undefined
    let offAgent: (() => void) | undefined
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
        if (draft !== undefined) ctx.emit('mayfly/subagent-reply-sent', draft)
        return { kind: 'accepted', node: node(text, delivery), source: [], dismiss: true }
      } catch (error) {
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
    } } }, node(draft ?? ''), { reopen: 'focus', onClosed: () => { offView?.(); offAgent?.() } })
    if (handle === undefined) return
    // The displayed conversation or its exact Agent (a same-id replacement) may change.
    offView = ctx.mayflyConversations.subscribe(() => { if (!current()) handle.close() })
    offAgent = ctx.mayflyCurrentAgent.subscribe(() => { if (!current()) handle.close() })
  })
}
