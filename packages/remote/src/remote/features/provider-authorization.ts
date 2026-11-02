/** Reference authorization instructions and acknowledgement-ordered prompt replies.
 * @module @ephemeral-ai/mayfly/remote/features/provider-authorization
 */
import { panel, ui, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { RemoteAccountLocalIO, RemoteFeatureContext } from './contracts.ts'
import type { RemoteFeatureOperation } from './official.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import type { RemoteAuthorizationNotice, RemoteAuthorizationPromptReply, RemoteAuthorizationPromptView, RemoteProviderAuthorization } from './providers.ts'

/** Run authorization under one selected Host and one native attempt owner. */
export function mountRemoteProviderAuthorization(
  context: RemoteFeatureContext,
  operation: RemoteFeatureOperation,
  route: string,
  authorization: RemoteProviderAuthorization,
  onAuthorized: () => Promise<void>,
  localIO?: Pick<RemoteAccountLocalIO, 'copy'>,
): void {
  const t = context.t
  const id = `mayfly.authorization.${Buffer.from(route).toString('hex')}`
  let notice: RemoteAuthorizationNotice | undefined
  let running = false
  let finished = false
  let authorized = false
  let promptSequence = 0
  let prompt: { readonly panel: RemoteBrowserPanel, refresh(): void, settle(reply: RemoteAuthorizationPromptReply | undefined): void } | undefined
  let mounted: RemoteBrowserPanel | undefined
  const instructions = (): MayflyUiNode => notice === undefined ? ui.text('') : ui.scroll(ui.stack.column([
    ui.text(notice.message), ...notice.url === undefined ? [] : [ui.text(notice.url)], ...notice.code === undefined ? [] : [ui.fields([{ label: 'Code', value: [{ text: notice.code }] }])],
  ]), { scrollbar: true })
  const copyActions = () => ui.actions({ id: 'authorization-copy', items: [
    ...notice?.url === undefined ? [] : [{ id: 'copy-url', label: t('Copy URL'), hintLabel: t('copy URL'), key: 'u', hidden: true }],
    ...notice?.code === undefined ? [] : [{ id: 'copy-code', label: t('Copy code'), hintLabel: t('copy code'), key: 'c', hidden: true }],
  ] })
  const copy = async (target: 'url' | 'code', signal: AbortSignal): Promise<MayflyUiActionReply> => {
    const text = notice?.[target]
    if (text === undefined) return { kind: 'failed', message: t('Authorization instructions are no longer available') }
    if (localIO === undefined) return { kind: 'failed', message: t('The link could not be copied — select it in the panel instead') }
    if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
    try { await localIO.copy(text); return !operation.valid() || signal.aborted ? { kind: 'cancelled' } : { kind: 'completed' } }
    catch { return { kind: 'failed', message: t('The link could not be copied — select it in the panel instead') } }
  }
  const view = () => panel({ title: t('Authorize {route}', { route }), escapeLabel: 'cancel', body: ui.stack.column([
    instructions(), copyActions(), ...running ? [ui.loader({ message: t('Waiting for authorization') })] : [],
    ui.actions({ id: 'authorization-actions', items: finished ? [] : [{ id: 'start', label: t(authorized ? 'Finish setup' : 'Sign in'), hintLabel: t(authorized ? 'finish setup' : 'sign in'), key: 's', hidden: true, disabled: running }] }),
  ]) })
  const refresh = () => { mounted?.refresh(); prompt?.refresh() }
  const ask = (requested: RemoteAuthorizationPromptView, signal: AbortSignal): Promise<RemoteAuthorizationPromptReply | undefined> => new Promise(resolve => {
    if (!operation.valid() || signal.aborted) { resolve(undefined); return }
    const promptId = `${id}.prompt.${++promptSequence}`
    let settled = false
    let answer: { readonly operationId: string, readonly value: string } | undefined
    let offRegistry = () => {}
    let child: RemoteBrowserPanel | undefined
    const settle = (reply: RemoteAuthorizationPromptReply | undefined) => {
      if (settled) return
      settled = true; offRegistry(); answer = undefined
      if (prompt?.panel === child) prompt = undefined
      resolve(reply); child?.close()
    }
    const promptView = () => panel({ title: t('Sign in'), escapeLabel: 'cancel', body: ui.stack.column([
      instructions(), copyActions(), ui.text(requested.message),
      requested.kind === 'select' ? ui.list({ id: 'authorization-options', role: 'choose', numbered: true, selectedIds: answer === undefined ? [] : [answer.value], minSelected: 1, items: (requested.options ?? []).map(option => ({ id: option.id, label: option.label, ...option.description === undefined ? {} : { detail: option.description } })), empty: ui.empty({ title: t('No authorization options are available') }) })
        : ui.form({ id: 'authorization-answer', enterSubmits: 'submit-answer', fields: [{ kind: requested.kind === 'secret' ? 'secret' : 'input', id: 'answer', label: t('Answer'), value: '', required: true, ...requested.placeholder === undefined ? {} : { placeholder: requested.placeholder } }] }),
      ui.actions({ id: 'authorization-prompt-actions', items: requested.kind === 'select' ? [] : [{ id: 'submit-answer', label: t('Continue'), hintLabel: t('continue'), hidden: true, submit: [{ pagePath: [], formId: 'authorization-answer' }] }] }),
    ]) })
    child = openRemoteBrowser(context, {
      id: promptId, scope: { kind: 'app', targetId: `authorization/${route}` }, signal: AbortSignal.any([operation.signal, signal]), isCurrent: () => operation.valid(), view: promptView,
      action: (event, eventContext) => {
        if (!operation.valid() || eventContext.signal.aborted) return { kind: 'cancelled' }
        if (event.kind === 'activate' && (event.actionId === 'copy-url' || event.actionId === 'copy-code')) return copy(event.actionId === 'copy-url' ? 'url' : 'code', eventContext.signal)
        const value = event.kind === 'submit' ? event.submission.forms[0]?.fields.find(field => field.id === 'answer')?.value : event.kind === 'selection-accept' ? event.selectedIds[0] : undefined
        if (typeof value !== 'string') return { kind: 'completed' }
        answer = { operationId: eventContext.operationId, value }
        return { kind: 'accepted', node: promptView(), source: [], dismiss: true }
      },
      onClosed: () => settle(operation.valid() && !signal.aborted ? { type: 'decline' } : undefined),
    })
    prompt = { panel: child, refresh: () => { child?.refresh() }, settle }
    offRegistry = context.ctx.mayflyOverlays.subscribe(delta => {
      if (answer !== undefined && delta.kind === 'upsert' && delta.entry.id === promptId && delta.entry.update.reason === 'ack' && delta.entry.update.operationId === answer?.operationId) settle({ type: 'answer', value: answer.value })
    })
    if (child.closed) settle(undefined)
  })
  mounted = openRemoteBrowser(context, {
    id, scope: { kind: 'app', targetId: `authorization/${route}` }, signal: operation.signal, isCurrent: () => operation.valid(), view,
    action: async (event, eventContext): Promise<MayflyUiActionReply> => {
      if (!operation.valid() || eventContext.signal.aborted) return { kind: 'cancelled' }
      if (event.kind === 'activate' && (event.actionId === 'copy-url' || event.actionId === 'copy-code')) return copy(event.actionId === 'copy-url' ? 'url' : 'code', eventContext.signal)
      if (event.kind !== 'activate' || event.actionId !== 'start' || running || finished) return { kind: 'completed' }
      const signal = AbortSignal.any([operation.signal, eventContext.signal])
      running = !authorized; refresh()
      try {
        if (!authorized) {
          const outcome = await authorization.authorize(operation.client, `llm-pi-ai/${route}`, 'oauth', {
            notice: next => {
              if (!operation.valid() || signal.aborted) return
              const url = next.url ?? notice?.url
              const code = next.code ?? (next.url === undefined || next.url === notice?.url ? notice?.code : undefined)
              notice = { message: next.message, ...url === undefined ? {} : { url }, ...code === undefined ? {} : { code } }
              refresh()
            },
            prompt: requested => ask(requested, signal),
          }, signal)
          if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
          authorized = outcome === 'authorized'
        }
        running = false; notice = undefined
        if (authorized) await onAuthorized()
        if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
        finished = authorized
        return { kind: 'accepted', node: view(), source: [], feedback: { severity: 'success', message: t(authorized ? 'Authorization completed' : 'Authorization cancelled') } }
      } catch {
        if (!operation.valid() || signal.aborted) return { kind: 'cancelled' }
        notice = undefined
        return { kind: 'failed', node: view(), message: t(authorized ? 'Signed in, but provider setup could not be completed' : 'Authorization could not be completed') }
      } finally { running = false; prompt?.settle(undefined); if (operation.valid()) refresh() }
    },
    onClosed: () => { notice = undefined; prompt?.settle(undefined); operation.dispose() },
  })
  operation.onDispose(() => { prompt?.settle(undefined); mounted?.close() })
}
