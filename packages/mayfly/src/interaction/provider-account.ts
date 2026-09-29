/** DeepSeek account status and sign-in guidance in the Providers panel.
 *
 * The account adapter (`llm-deepseek-account`) is not a pi-ai profile, so the
 * provider editor refuses it. This panel shows the native account state and,
 * while signed out, the honest sign-in path: the terminal host carries no
 * local callback web server, so browser sign-in happens in a Desktop or Web
 * host on the same machine — the stored grant is Host-shared — after which
 * account models work here with no API key.
 *
 * @module @ephemeral-ai/mayfly/interaction/provider-account
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type { AccountClientMetadata, AccountView, SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account'
import { ui, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { MAYFLY_VERSION } from '../transcript/banner-content.ts'
import { interactionTranslator } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'

/** The settings namespace the account adapter owns; routes in it are not pi-ai profiles. */
export const ACCOUNT_SETTINGS_NS = 'llm-deepseek-account'

/** Native client identity for one account operation; the wire locale keeps the primary subtag only. */
function clientMetadata(ctx: Context): AccountClientMetadata {
  const locale = ctx.get('mayflyLocale')?.snapshot.locale.split('-')[0] ?? 'en'
  return { version: MAYFLY_VERSION, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }
}

/** One localized attempt line; a terminal host never starts attempts itself. */
function attemptText(attempt: SignInAttemptView, t: (key: string) => string): string {
  if (attempt.authorizeUrl !== undefined) return t('Waiting for browser sign-in')
  if (attempt.phase === 'failed' || attempt.phase === 'expired') return t('Sign-in failed — retry from a Desktop or Web host')
  if (attempt.phase === 'succeeded') return t('Signed in')
  return t('Signing in…')
}

/** The panel content for one account view. */
export function accountPanelNode(view: AccountView, t: (key: string) => string): MayflyUiNode {
  return ui.stack.column([
    ui.fields([
      { label: t('Status'), value: [{ text: t(view.status === 'credential-stored' ? 'Signed in' : 'Not signed in') }] },
      ...(view.attempt === null ? [] : [{ label: t('Sign-in'), value: [{ text: attemptText(view.attempt, t) }] }]),
    ]),
    ...(view.status === 'credential-stored' ? [] : [ui.text(t('Sign in from a DeepSeek Harness Desktop or Web host on this machine — the stored login is shared across hosts. Account models then need no API key.'), { tone: 'muted' })]),
    ui.actions({ id: 'account-actions', items: [
      ...(view.status === 'credential-stored' ? [{ id: 'sign-out', label: t('Sign out'), intent: 'danger' as const, confirm: t('Sign out of the DeepSeek account?') }] : []),
      { id: 'close', label: t('Close'), dismiss: true },
    ] }),
  ])
}

/**
 * Open the DeepSeek account panel for the account provider route.
 * @param ctx - Host context with the overlays service.
 * @param route - The provider route the Providers list selected.
 * @param signal - Optional caller lifetime.
 * @returns true when the panel opened (the route is the account adapter and
 * the native account service is available); false when the route is not the
 * account adapter, so callers fall back to their own handling.
 */
export async function openAccountPanel(ctx: Context, route: string, signal?: AbortSignal): Promise<boolean> {
  const service = ctx.get('deepseekAccount')
  const overlays = ctx.get('mayflyOverlays')
  if (service === undefined || overlays === undefined) return false
  const declared = ctx.get('llm')?.listConfigurableProviders().find(item => item.provider === route)
  if (declared === undefined || declared.settingsNs !== ACCOUNT_SETTINGS_NS) return false
  const t = interactionTranslator(ctx)
  const id = `mayfly.provider-account.${route}`
  if (overlays.focus(id)) return true
  const lifetime = new AbortController()
  const cancellation = signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal])
  const releaseLifetime = ctx.effect(() => () => lifetime.abort())
  let cleanup = (): void => {}
  let handle = openUiOverlay(ctx, {
    id, title: t('DeepSeek Account'), presentation: 'editor', capturing: true,
    scope: { kind: 'app', targetId: `account/${route}` },
    onEvent: { action: async (event): Promise<MayflyUiActionReply> => {
      if (event.kind !== 'activate' || event.actionId !== 'sign-out') return { kind: 'completed' }
      try {
        await service.signOut(clientMetadata(ctx))
        return { kind: 'completed' }
      } catch {
        return { kind: 'failed', message: t('Sign-out failed — try again') }
      }
    } },
  }, accountPanelNode(await service.getState(), t), { signal: cancellation, reopen: 'focus', onClosed: () => cleanup() })
  if (handle === undefined) { releaseLifetime(); return true }
  const repaint = (view: AccountView): void => {
    if (!handle?.closed) handle?.set(accountPanelNode(view, t))
  }
  const offWatch = ctx.effect(() => {
    const controller = new AbortController()
    const stop = () => controller.abort()
    cancellation.addEventListener('abort', stop, { once: true })
    void (async () => {
      try {
        for await (const view of service.watch(controller.signal)) repaint(view)
      } catch { /* the overlay closes with its lifetime; a watch failure cannot replace the panel */ }
    })()
    return () => { cancellation.removeEventListener('abort', stop); stop() }
  })
  cleanup = ctx.effect(() => () => { offWatch(); releaseLifetime() })
  return true
}
