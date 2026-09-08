/** Persistent authorization instructions and native prompt settlement through shared UI controls.
 * @module @ephemeral-ai/mayfly/interaction/authorization-ui
 */
import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError, type AuthorizationNotice, type AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { ui, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { openUiOverlay } from './ui-overlay.ts'
import { interactionTranslator } from './locale.ts'

function instructions(notice: AuthorizationNotice | undefined): MayflyUiNode {
  return notice === undefined ? ui.text('') : ui.scroll(ui.stack.column([
    ui.text(notice.message),
    ...(notice.url === undefined ? [] : [ui.text(notice.url)]),
    ...(notice.code === undefined ? [] : [ui.fields([{ label: 'Code', value: [{ text: notice.code }] }])]),
  ]), { scrollbar: true })
}

/** Open one application-level authorization attempt; the native service owns its protocol. */
export function openAuthorization(ctx: Context, route: string, onAuthorized: () => Promise<void>, signal?: AbortSignal): MayflyOverlayHandle {
  const authorization = ctx.get('authorization')
  if (authorization === undefined) throw new Error('Authorization is unavailable')
  const t = interactionTranslator(ctx)
  let notice: AuthorizationNotice | undefined
  let prompt: { readonly handle: MayflyOverlayHandle, readonly refresh: () => void } | undefined
  let promptSequence = 0
  let finished = false
  let authorized = false
  const id = `mayfly.authorization.${Buffer.from(route).toString('hex')}`
  const copy = async (target: 'url' | 'code', cancellation: AbortSignal) => {
    const value = notice?.[target]
    if (value === undefined) return { kind: 'failed' as const, message: t('Authorization instructions are no longer available') }
    const { copyTextToClipboard } = await import('./clipboard-write.ts')
    cancellation.throwIfAborted()
    await copyTextToClipboard(value)
    return { kind: 'completed' as const }
  }
  const copyActions = () => ui.actions({ id: 'authorization-copy', items: [
    ...(notice?.url === undefined ? [] : [{ id: 'copy-url', label: t('Copy URL') }]),
    ...(notice?.code === undefined ? [] : [{ id: 'copy-code', label: t('Copy code') }]),
  ] })
  const view = () => {
    const running = authorization.describe(credentialKey('llm-pi-ai', route))?.inFlight === true
    return ui.stack.column([
    instructions(notice), copyActions(),
    ...(running ? [ui.loader({ message: t('Waiting for authorization') })] : []),
    ui.actions({ id: 'authorization-actions', items: [
      ...finished ? [] : [{ id: 'start', label: t(authorized ? 'Finish setup' : 'Sign in'), disabled: running }],
      { id: 'cancel', label: t(finished ? 'Close' : 'Cancel'), dismiss: true },
    ] }),
    ])
  }
  let handle!: MayflyOverlayHandle
  const refresh = () => { handle.set(view()); prompt?.refresh() }
  const ask = (request: AuthorizationPrompt, ownerSignal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
    const withdrawal = request.signal === undefined ? ownerSignal : AbortSignal.any([request.signal, ownerSignal])
    if (withdrawal.aborted) { reject(new Error('Authorization prompt withdrawn')); return }
    const promptId = `${id}.prompt.${++promptSequence}`
    let settled = false
    let answer: { readonly operationId: string, readonly value: string } | undefined
    let off!: () => void
    let child!: MayflyOverlayHandle
    const finish = (declined: boolean): void => {
      if (settled) return
      settled = true
      off()
      if (prompt?.handle === child) prompt = undefined
      reject(declined ? new AuthorizationDeclinedError() : new Error('Authorization prompt withdrawn'))
      answer = undefined
      child.close()
    }
    const promptView = () => ui.stack.column([
      instructions(notice), copyActions(),
      ui.text(request.message),
      request.kind === 'select'
        ? ui.list({ id: 'authorization-options', role: 'choose', selectedIds: answer === undefined ? [] : [answer.value], minSelected: 1, items: request.options.map(option => ({ id: option.id, label: option.label, ...(option.description === undefined ? {} : { detail: option.description }) })), empty: ui.empty({ title: t('No authorization options are available') }) })
        : ui.form({ id: 'authorization-answer', fields: [{ kind: request.kind === 'secret' ? 'secret' : 'input', id: 'answer', label: t('Answer'), value: '', required: true, ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }) }] }),
      ui.actions({ id: 'authorization-prompt-actions', items: [
        ...(request.kind === 'select' ? [] : [{ id: 'submit-answer', label: t('Continue'), submit: [{ pagePath: [], formId: 'authorization-answer' }] }]),
        { id: 'cancel', label: t('Cancel'), dismiss: true },
      ] }),
    ])
    child = openUiOverlay(ctx, {
      id: promptId, title: t('Sign in'), presentation: 'editor', capturing: true,
      scope: { kind: 'app', targetId: `authorization/${route}` },
      onEvent: { action: (event, context) => {
        if (event.kind === 'dismiss') { finish(true); return { kind: 'cancelled' } }
        if (event.kind === 'activate' && (event.actionId === 'copy-url' || event.actionId === 'copy-code')) return copy(event.actionId === 'copy-url' ? 'url' : 'code', context.signal)
        const value = event.kind === 'submit' ? event.submission.forms[0]?.fields.find(field => field.id === 'answer')?.value : event.kind === 'selection-accept' ? event.selectedIds[0] : undefined
        if (typeof value !== 'string') return { kind: 'completed' }
        answer = { operationId: context.operationId, value }
        return { kind: 'accepted', node: promptView(), source: [], dismiss: true }
      } },
    }, promptView(), withdrawal)
    prompt = { handle: child, refresh: () => { child.set(promptView()) } }
    off = ctx.mayflyOverlays.subscribe(delta => {
      if (delta.kind === 'upsert' && delta.entry.id === promptId && delta.entry.update.reason === 'ack' && delta.entry.update.operationId === answer?.operationId) {
        const value = answer.value
        answer = undefined
        settled = true
        off()
        if (prompt?.handle === child) prompt = undefined
        resolve(value)
      } else if (delta.kind === 'remove' && delta.id === promptId && child.closed) finish(!withdrawal.aborted)
    })
  })
  handle = openUiOverlay(ctx, {
    id, title: t('Authorize {route}', { route }), presentation: 'editor', capturing: true,
    scope: { kind: 'app', targetId: `authorization/${route}` },
    onEvent: { action: async (event, context) => {
      if (event.kind === 'activate' && (event.actionId === 'copy-url' || event.actionId === 'copy-code')) return copy(event.actionId === 'copy-url' ? 'url' : 'code', context.signal)
      if (event.kind === 'activate' && event.actionId === 'start' && authorized) {
        try {
          await onAuthorized()
          if (context.signal.aborted) return { kind: 'cancelled' }
          finished = true
          return { kind: 'accepted', node: view(), source: [], feedback: { severity: 'success', message: t('Authorization completed') } }
        } catch { return { kind: 'failed', node: view(), message: t('Signed in, but provider setup could not be completed') } }
      }
      if (event.kind !== 'activate' || event.actionId !== 'start') return { kind: 'completed' }
      try {
        const pending = authorization.begin({
          key: credentialKey('llm-pi-ai', route), method: 'oauth', signal: context.signal,
          interaction: {
            notify: next => {
              if (context.signal.aborted || handle.closed) return
              const url = next.url ?? notice?.url
              const code = next.code ?? (next.url === undefined || next.url === notice?.url ? notice?.code : undefined)
              notice = { message: next.message, ...(url === undefined ? {} : { url }), ...(code === undefined ? {} : { code }) }
              refresh()
            },
            prompt: request => ask(request, context.signal),
          },
        })
        refresh()
        const result = await pending
        if (context.signal.aborted || handle.closed) return { kind: 'cancelled' }
        authorized = result.status === 'authorized'
        notice = undefined
        if (authorized) await onAuthorized()
        finished = authorized
        return { kind: 'accepted', node: view(), source: [], feedback: { severity: 'success', message: t(result.status === 'authorized' ? 'Authorization completed' : 'Authorization cancelled') } }
      } catch {
        if (context.signal.aborted || handle.closed) return { kind: 'cancelled' }
        notice = undefined
        return { kind: 'failed', node: view(), message: t(authorized ? 'Signed in, but provider setup could not be completed' : 'Authorization could not be completed') }
      } finally { prompt?.handle.close(); prompt = undefined; if (!handle.closed) refresh() }
    } },
  }, view(), signal)
  const off = ctx.mayflyOverlays.subscribe(delta => {
    if (delta.kind === 'remove' && delta.id === id && handle.closed) { notice = undefined; prompt?.handle.close(); prompt = undefined; off() }
  })
  return handle
}
