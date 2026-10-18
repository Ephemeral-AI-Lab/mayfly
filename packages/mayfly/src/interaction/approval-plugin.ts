/** Native tool approvals retain FIFO ownership and settle through the decision card.
 * @module @ephemeral-ai/mayfly/interaction/approval-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { decisionArmMs, type MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
import { DecisionCard } from '../components/decision-card.ts'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { interactionTranslator, mountInteractionLocale } from './locale.ts'
import { openInEditor, readDecision } from './decision-actions.ts'
import { requestOverlay } from './request-overlay.ts'

export const name = 'mayfly-approval'
export const inject = ['mayflyOverlays', 'mayflyCurrentAgent', 'mayflyScreen']

interface ApprovalAnswer { readonly outcome: ApprovalOutcome, readonly session?: boolean, readonly reason?: string }

/** Tools whose request is a file change: the card offers the diff in `$EDITOR`. */
const FILE_CHANGES = /^(?:edit|write|multi_?edit|apply_patch|notebook_?edit)$/u

function card(request: ApprovalRequest, queue: string | undefined, t: MayflyTranslate) {
  const change = FILE_CHANGES.test(request.toolName)
  return DecisionCard({
    title: t('Decide'),
    ...queue === undefined ? {} : { queue },
    options: [
      { id: 'allow-once', label: t('Allow once') },
      { id: 'allow-session', label: t('Allow {tool} for this session', { tool: request.toolName }) },
      { id: 'reject', label: t('Reject') },
    ],
    note: { label: t('Feedback'), placeholder: t('type to explain…') },
    keys: [{ id: 'open', semantic: 'external', label: change ? t('Open diff') : t('Open command'), hintLabel: change ? t('open diff') : t('open command') }],
  })
}

/** The answer a card event settles: a grant, or a rejection that carries the note when one was typed. */
function answer(event: MayflyUiEvent): ApprovalAnswer | undefined {
  if (event.kind !== 'activate') return undefined
  const read = readDecision(event)
  if (read === undefined) return undefined
  if (read.action === 'send') return read.note === '' ? undefined : { outcome: 'rejected', reason: read.note }
  if (read.choice === 'allow-once') return { outcome: 'allowed-once' }
  if (read.choice === 'allow-session') return { outcome: 'allowed-once', session: true }
  return { outcome: 'rejected', ...read.note === '' ? {} : { reason: read.note } }
}

/** The text of a call the card can open in `$EDITOR`: the command, the diff's two sides, or the code to write. */
function documentOf(request: ApprovalRequest): string {
  const call = request.callId === undefined ? undefined : request.agent.session.snapshotEvents().findLast(event => event.type === 'tool/call' && event.data.callId === request.callId)
  const raw = call?.type === 'tool/call' ? call.data.arguments : undefined
  if (raw === undefined) return request.reason ?? request.toolName
  let args: Record<string, unknown>
  try { args = JSON.parse(raw) as Record<string, unknown> } catch { return raw }
  const text = (key: string): string | undefined => typeof args[key] === 'string' ? args[key] : undefined
  const path = text('file_path') ?? text('path')
  if (text('old_string') !== undefined || text('new_string') !== undefined) return `${path ?? ''}\n\n--- old\n${text('old_string') ?? ''}\n\n+++ new\n${text('new_string') ?? ''}\n`
  if (text('content') !== undefined) return `${path ?? ''}\n\n${text('content')}\n`
  return text('command') ?? JSON.stringify(args, null, 2)
}

/** What the asker said about the request, in the language shown. */
function reasonOf(request: ApprovalRequest, locale: string | undefined): string | undefined {
  return request.displayReason === undefined ? request.reason : request.displayReason[locale ?? ''] ?? request.displayReason.en
}

export function apply(ctx: Context): void {
  mountInteractionLocale(ctx)
  const currentAgent = ctx.mayflyCurrentAgent
  const allowances = new Map<Agent, Set<string>>()
  const queued: Array<() => void> = []
  const cancellations = new Set<() => void>()
  /* The requests waiting on the user in the order they were asked, the first on the card: the stream turns its call
     into the request block, and the card says how many wait. */
  const roster: Array<{ readonly request: ApprovalRequest, refresh: () => void }> = []
  const publish = (): void => {
    const locale = ctx.get('mayflyLocale')?.snapshot.locale
    ctx.emit('mayfly/decision-requests-changed', 'approval', roster.map(({ request }) => {
      const reason = reasonOf(request, locale)
      return {
        type: 'approval' as const,
        toolName: request.toolName,
        ...request.callId === undefined ? {} : { callId: String(request.callId) },
        ...reason === undefined ? {} : { reason },
      }
    }))
    roster[0]?.refresh()
  }
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
      const entry = { request, refresh: () => {} }
      const finish = (outcome: ApprovalOutcome): void => {
        cancellations.delete(cancel)
        request.signal?.removeEventListener('abort', cancel)
        roster.splice(roster.indexOf(entry), 1)
        resolve(outcome)
        if (started) {
          active = false
          ctx.emit('mayfly/decision-wait-changed', undefined)
          queued.shift()?.()
        }
        publish()
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
        ctx.emit('mayfly/decision-wait-changed', { kind: 'approval' })
        const prompt = requestOverlay(ctx, {
          id: `mayfly.approval.${++sequence}`, title: () => t('Approve {tool}?', { tool: request.toolName }), agent: request.agent, dismissal: 'discard',
          bare: true, contentScroll: true, armMs: decisionArmMs,
          ...request.signal === undefined ? {} : { signal: request.signal },
          view: () => card(request, roster.length > 1 ? t('{index} of {total} waiting', { index: 1, total: roster.length }) : undefined, t), answer,
          onAction: (event, context) => event.kind === 'activate' && event.actionId === 'open' ? openInEditor(ctx, documentOf(request), t, context.signal) : undefined,
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
        entry.refresh = prompt.refresh
        stop = prompt.cancel
        void prompt.result.then(result => finish(result.outcome), () => finish('unavailable'))
      }
      cancellations.add(cancel)
      request.signal?.addEventListener('abort', cancel, { once: true })
      roster.push(entry)
      publish()
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
