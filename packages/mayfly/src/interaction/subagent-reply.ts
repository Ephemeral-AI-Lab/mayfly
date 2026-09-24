/** Addressed child replies retain their drafts independently of the transcript renderer.
 * @module @ephemeral-ai/mayfly/interaction/subagent-reply
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { ui } from '@ephemeral-ai/mayfly-ui'
import type { MayflyAuxiliaryView } from '../app/current-agent.ts'
import { openUiOverlay } from './ui-overlay.ts'

type ChildView = Extract<MayflyAuxiliaryView, { readonly kind: 'subagent' }>
declare module '@deepseek-ai/cordis' {
  interface Events { 'mayfly/request-subagent-reply'(target: ChildView): void }
}
export const name = 'mayfly-subagent-reply'
export const inject = ['mayflyCurrentAgent', 'mayflyOverlays', 'subagents']

export function apply(ctx: Context): void {
  ctx.on('mayfly/request-subagent-reply', target => {
    const current = () => {
      const view = ctx.mayflyCurrentAgent.view()
      return view.displayed === 'auxiliary' && view.auxiliary?.kind === 'subagent'
        && view.auxiliary.sessionId === target.sessionId && view.auxiliary.parentSessionId === target.parentSessionId
        && view.auxiliary.mode === 'continuable'
    }
    if (!current()) return
    const node = (value: string) => ui.surface({ title: `Reply to ${target.label}`, chrome: 'overlay', child: ui.stack.column([
      ui.form({ id: 'reply', fields: [{ kind: 'textarea', id: 'message', label: 'Message', value }] }),
      ui.actions({ id: 'reply-actions', items: [{ id: 'send', label: 'Send', submit: [{ pagePath: [], formId: 'reply' }] }, { id: 'close', label: 'Cancel', dismiss: true }] }),
    ]) })
    let offView: (() => void) | undefined
    const handle = openUiOverlay(ctx, { id: 'mayfly.subagent.reply', title: `Reply to ${target.label}`, presentation: 'editor', capturing: true, onEvent: { action: async (event, context) => {
      if (event.kind !== 'submit') return { kind: 'completed' }
      const text = event.submission.forms[0]?.fields.find(field => field.id === 'message')?.value
      if (typeof text !== 'string' || text.trim() === '') return { kind: 'failed', message: 'Enter a message' }
      if (!current()) return { kind: 'cancelled' }
      try {
        await ctx.subagents.prompt({
          requestId: randomUUID() as SubagentPromptRequestId,
          parentSessionId: SessionId(target.parentSessionId),
          childSessionId: SessionId(target.sessionId),
          mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text }],
        }, context.signal)
        return { kind: 'accepted', node: node(text), source: [], dismiss: true }
      } catch (error) {
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
    } } }, node(''), { reopen: 'focus', onClosed: () => offView?.() })
    if (handle === undefined) return
    offView = ctx.mayflyCurrentAgent.subscribeView(() => { if (!current()) handle.close() })
  })
}
