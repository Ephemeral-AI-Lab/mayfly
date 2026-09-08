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
const feedbackPath = [{ controlId: 'approval', itemId: 'feedback' }]
const decisionPath = [{ controlId: 'approval', itemId: 'decision' }]

function view(request: ApprovalRequest, t: MayflyTranslate) {
  return ui.stack.column([
    ...request.reason === undefined ? [] : [ui.scroll(ui.text(request.reason), { scrollbar: true })],
    ui.tabs({ id: 'approval', activeId: 'decision', items: [{ id: 'decision', label: t('Decision') }, { id: 'feedback', label: t('Reject with feedback'), backId: 'decision' }] }),
    ui.child(ui.actions({ id: 'decisions', items: [
      { id: 'reject', label: t('Reject'), defaultFocus: true },
      { id: 'allow-once', label: t('Allow once') },
      { id: 'allow-session', label: t('Allow {tool} for this session', { tool: request.toolName }) },
      { id: 'feedback', label: t('Reject with feedback'), navigate: feedbackPath },
    ] }), { tab: decisionPath[0]! }),
    ui.child(ui.stack.column([
      ui.form({ id: 'feedback-form', fields: [{ kind: 'textarea', id: 'reason', label: t('Reason'), value: '' }] }),
      ui.actions({ id: 'feedback-actions', items: [
        { id: 'send-feedback', label: t('Reject with feedback'), submit: [{ pagePath: feedbackPath, formId: 'feedback-form' }] },
        { id: 'back', label: t('Back'), navigate: decisionPath },
      ] }),
    ]), { tab: feedbackPath[0]! }),
  ])
}

function answer(event: MayflyUiEvent): ApprovalAnswer | undefined {
  if (event.kind === 'activate') {
    if (event.actionId === 'reject') return { outcome: 'rejected' }
    if (event.actionId === 'allow-once' || event.actionId === 'allow-session') return { outcome: 'allowed-once', session: event.actionId === 'allow-session' }
  }
  if (event.kind !== 'submit' || event.submission.actionId !== 'send-feedback') return undefined
  const reason = event.submission.forms[0]?.fields.find(field => field.id === 'reason')?.value
  return { outcome: 'rejected', ...typeof reason === 'string' && reason.length > 0 ? { reason } : {} }
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
          id: `mayfly.approval.${++sequence}`, title: () => t('Approve {tool}?', { tool: request.toolName }), agent: request.agent, dismissal: 'discard',
          ...request.signal === undefined ? {} : { signal: request.signal },
          view: () => view(request, t), answer,
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
  let observed = currentAgent.current()
  const offAgent = currentAgent.subscribe(agent => {
    if (agent === observed) return
    observed = agent
    allowances.clear()
    for (const cancel of cancellations) cancel()
  })
  ctx.effect(() => () => {
    disposed = true
    offAgent()
    for (const cancel of cancellations) cancel()
    queued.splice(0)
    allowances.clear()
  })
}
