/** Native tool approvals retain FIFO ownership and use shared decisions and feedback forms.
 * @module @ephemeral-ai/mayfly/interaction/approval-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ui, type MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { interactionTranslator, mountInteractionLocale } from './locale.ts'
import { requestOverlay } from './request-overlay.ts'

export const name = 'mayfly-approval'
export const inject = ['mayflyOverlays', 'mayflyCurrentAgent']

interface ApprovalAnswer { readonly outcome: ApprovalOutcome, readonly session?: boolean, readonly reason?: string }
function view(request: ApprovalRequest, t: MayflyTranslate, locale?: string) {
  const reason = request.displayReason === undefined
    ? request.reason
    : request.displayReason[locale ?? ''] ?? request.displayReason.en
  return ui.stack.column([
    ...reason === undefined ? [] : [ui.scroll(ui.text(reason), { scrollbar: true })],
    ui.list({ id: 'decisions', role: 'choose', acceptActionId: 'decide', selectedIds: ['reject'], numbered: 'focus', items: [
      { id: 'reject', label: t('Reject') },
      { id: 'allow-once', label: t('Allow once') },
      { id: 'allow-session', label: t('Allow {tool} for this session', { tool: request.toolName }) },
    ] }),
    ui.form({ id: 'feedback-form', enterSubmits: 'send-feedback', fields: [{ kind: 'input', id: 'reason', label: t('Feedback'), value: '' }] }),
    ui.actions({ id: 'feedback-actions', reveal: 'focus', items: [
      { id: 'decide', label: t('Confirm'), submit: [{ pagePath: [], formId: 'feedback-form' }], selections: [{ pagePath: [], controlId: 'decisions' }] },
      { id: 'send-feedback', label: t('Reject with feedback'), submit: [{ pagePath: [], formId: 'feedback-form' }] },
    ] }),
  ])
}

function answer(event: MayflyUiEvent): ApprovalAnswer | undefined {
  if (event.kind !== 'submit') return undefined
  const reason = event.submission.forms[0]?.fields.find(field => field.id === 'reason')?.value
  const feedback = typeof reason === 'string' && reason.length > 0 ? { reason } : {}
  if (event.submission.actionId === 'send-feedback') return { outcome: 'rejected', ...feedback }
  if (event.submission.actionId !== 'decide') return undefined
  const actionId = event.submission.selections?.find(selection => selection.controlId === 'decisions')?.selectedIds[0]
  if (actionId === 'reject') return { outcome: 'rejected', ...feedback }
  if (actionId === 'allow-once' || actionId === 'allow-session') return { outcome: 'allowed-once', session: actionId === 'allow-session' }
  return undefined
}

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const currentAgent = ctx.mayflyCurrentAgent
  const allowances = new Map<Agent, Set<string>>()
  const queued: Array<() => void> = []
  const cancellations = new Set<() => void>()
  let active = false
  let disposed = false
  let sequence = 0
  ctx.on('approval/request', (request, next) => {
    if (currentAgent.current() !== request.agent) return next()
    if (request.signal?.aborted) return Promise.resolve<ApprovalOutcome>('cancelled')
    if (allowances.get(request.agent)?.has(request.toolName)) return Promise.resolve<ApprovalOutcome>('allowed-once')
    return new Promise<ApprovalOutcome>((resolve) => {
      let started = false
      let stop: (() => void) | undefined
      const finish = (outcome: ApprovalOutcome): void => {
        cancellations.delete(cancel)
        request.signal?.removeEventListener('abort', cancel)
        resolve(outcome)
        if (started) { active = false; queued.shift()?.() }
      }
      const cancel = (): void => {
        if (started) stop?.()
        else { queued.splice(queued.indexOf(run), 1); finish('cancelled') }
      }
      const run = (): void => {
        started = true
        active = true
        if (disposed || currentAgent.current() !== request.agent || request.signal?.aborted) { finish('cancelled'); return }
        if (allowances.get(request.agent)?.has(request.toolName)) { finish('allowed-once'); return }
        const t = interactionTranslator(ctx)
        const prompt = requestOverlay(ctx, {
          id: `mayfly.approval.${++sequence}`, title: () => t('Approve {tool}?', { tool: request.toolName }), agent: request.agent, dismissal: 'discard', escapeLabel: 'reject',
          ...request.signal === undefined ? {} : { signal: request.signal },
          view: () => view(request, t, ctx.get('mayflyLocale')?.snapshot.locale), answer,
          accepted: result => {
            if (result.session) {
              const tools = allowances.get(request.agent) ?? new Set<string>()
              tools.add(request.toolName)
              allowances.set(request.agent, tools)
            }
            if (result.reason !== undefined) request.agent.steer(createUserMessage({ content: [{ type: 'text', text: `User rejected ${request.toolName}: ${result.reason}` }], source: { kind: 'user' } }))
          },
          cancelled: reason => ({ outcome: reason === 'dismiss' ? 'rejected' : 'cancelled' } as ApprovalAnswer),
        })
        stop = prompt.cancel
        void prompt.result.then(result => finish(result.outcome), () => finish('unavailable'))
      }
      cancellations.add(cancel)
      request.signal?.addEventListener('abort', cancel, { once: true })
      if (active) queued.push(run)
      else run()
    })
  })
  /* Session allowances belong to their Agent, so switching the displayed view
     keeps them; only disposing that Agent forgets them. Requests still settle
     only while their Agent is displayed. */
  let observed = currentAgent.current()
  const offAgent = currentAgent.subscribe(agent => {
    if (agent === observed) return
    observed = agent
    for (const cancel of cancellations) cancel()
  })
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => { allowances.delete(agent) })
  ctx.effect(() => () => {
    disposed = true
    offAgent()
    offDisposed()
    for (const cancel of cancellations) cancel()
    queued.splice(0)
    allowances.clear()
  })
}
