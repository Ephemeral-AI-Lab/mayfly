/** DeepSeek account sign-in inside the terminal.
 *
 * The account adapter (`llm-deepseek-account`) is not a pi-ai profile, so the
 * provider editor refuses it. This panel drives the native account service
 * instead: with the bundle's loopback webserver present, Sign in starts the
 * PKCE attempt (`startSignIn`), opens the authorize URL in the system
 * browser, and follows the attempt phases to completion; without a webserver
 * the panel falls back to explaining where browser sign-in can happen (the
 * stored grant is Host-shared across hosts of one machine).
 *
 * @module @ephemeral-ai/mayfly/interaction/provider-account
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type { AccountClientMetadata, AccountView, SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account'
import { hostname, userInfo as userInfoSync } from 'node:os'
import { ui, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { MAYFLY_VERSION } from '../transcript/banner-content.ts'
import { interactionTranslator } from './locale.ts'
import { openUiOverlay } from './ui-overlay.ts'

/** The settings namespace the account adapter owns; routes in it are not pi-ai profiles. */
export const ACCOUNT_SETTINGS_NS = 'llm-deepseek-account'

/** Process seams for specs: the best-effort system browser opener and SSH detection. */
export const accountInternals = {
  /** Whether this mayfly runs inside an interactive SSH session (the `~C` escape works inline). */
  isSshSession: (): boolean => process.env.SSH_TTY !== undefined || process.env.SSH_CONNECTION !== undefined,
  /** Spawn one opener command detached; resolves false when the opener is missing. */
  spawnOpener: async (command: string, args: readonly string[]): Promise<boolean> => {
    try {
      const { spawn } = await import('node:child_process')
      return await new Promise<boolean>(resolve => {
        const child = spawn(command, args, { stdio: 'ignore', detached: true })
        child.once('error', () => resolve(false))
        child.once('spawn', () => { child.unref(); resolve(true) })
      })
    } catch {
      /* v8 ignore next -- node:child_process and spawn failures surface as the error event */
      return false
    }
  },
}

/** The system browser opener for one platform; every platform opens one URL. */
export function openerFor(platform: NodeJS.Platform): { command: string, prefix: readonly string[] } {
  if (platform === 'darwin') return { command: 'open', prefix: [] }
  if (platform === 'win32') return { command: 'cmd', prefix: ['/c', 'start', ''] }
  return { command: 'xdg-open', prefix: [] }
}

/** Open one URL in the system browser; a failure leaves the visible link as the fallback. */
export async function openUrlInBrowser(url: string): Promise<boolean> {
  const opener = openerFor(process.platform)
  return await accountInternals.spawnOpener(opener.command, [...opener.prefix, url])
}

/** Native client identity for one account operation; the wire locale keeps the primary subtag only. */
export function clientMetadata(ctx: Context): AccountClientMetadata {
  const locale = ctx.get('mayflyLocale')?.snapshot.locale.split('-')[0] ?? 'en'
  return { version: MAYFLY_VERSION, locale, timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }
}

/** The loopback callback origin for a browser sign-in, when a web carrier is composed. */
export function callbackOrigin(ctx: Context): string | undefined {
  const server = ctx.get('webServer')
  return server === undefined ? undefined : `http://localhost:${String(server.port)}`
}

/** Whether one attempt phase is terminal (no cancel, maybe retry). */
function attemptTerminal(attempt: SignInAttemptView): boolean {
  return attempt.phase === 'succeeded' || attempt.phase === 'cancelled' || attempt.phase === 'expired' || attempt.phase === 'failed'
}

/** Callback-guidance facts for a waiting attempt, when the callback port is known. */
export interface RemoteCallbackHint {
  /** The loopback port the OAuth callback server listens on this boot. */
  readonly port: number
  /** The full `ssh -L` command a local machine runs to reach this port. */
  readonly command: string
  /** Whether this mayfly itself runs inside an SSH session (`~C` works inline). */
  readonly sshSession: boolean
}

/** Build the SSH port-forward guidance for one callback port. */
export function remoteCallbackHint(port: number, sshSession: boolean): RemoteCallbackHint {
  const forward = `-L ${String(port)}:localhost:${String(port)}`
  const userInfo = userInfoSync()
  return { port, command: `ssh ${forward} ${userInfo.username}@${hostname()}`, sshSession }
}

/**
 * The panel content for one account view.
 * @param hint - callback-forwarding guidance while an attempt waits for a
 * browser; omit it to render without the remote-browser rows.
 */
export function accountPanelNode(
  view: AccountView,
  t: (key: string, values?: Record<string, string | number>) => string,
  canSignIn: boolean,
  hint?: RemoteCallbackHint,
): MayflyUiNode {
  const attempt = view.attempt
  const failed = attempt !== null && (attempt.phase === 'failed' || attempt.phase === 'expired')
  const waiting = attempt !== null && attempt.authorizeUrl !== undefined && !attemptTerminal(attempt)
  const signInLabel = failed ? t('Try again') : t('Sign in')
  return ui.stack.column([
    ui.fields([
      { label: t('Status'), value: [{ text: t(view.status === 'credential-stored' ? 'Signed in' : 'Not signed in') }] },
      ...(attempt === null ? [] : [{ label: t('Sign-in'), value: [{ text: failed ? t('Sign-in failed — try again') : t('Signing in…') }] }]),
      ...(waiting && attempt!.expiresAt !== undefined ? [{ label: t('Expires'), value: [{ text: new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(attempt!.expiresAt)) }] }] : []),
    ]),
    ...(waiting ? [
      ui.text(t('Open the link in a browser to finish signing in'), { tone: 'muted' }),
      ui.fields([{ label: t('Sign-in link'), value: [{ text: attempt!.authorizeUrl! }] }]),
      ...(hint === undefined ? [] : [
        ui.text(t('Browsing on your local machine? Forward the callback port over SSH, then open the link there.'), { tone: 'muted' }),
        ui.fields([{ label: t('Port forward'), value: [{ text: hint.command }] }]),
        ...(hint.sshSession ? [ui.text(t('Inside this SSH session, press ~C and run: {command}', { command: `-L ${String(hint.port)}:localhost:${String(hint.port)}` }), { tone: 'muted' })] : []),
      ]),
    ] : []),
    ...(view.status === 'credential-stored' || canSignIn ? [] : [ui.text(t('Sign in from a DeepSeek Harness Desktop or Web host on this machine — the stored login is shared across hosts. Account models then need no API key.'), { tone: 'muted' })]),
    ui.actions({ id: 'account-actions', items: [
      ...(view.status === 'credential-stored' ? [] : canSignIn && (attempt === null || failed) ? [{ id: 'sign-in', label: signInLabel, intent: 'primary' as const }] : []),
      ...(waiting ? [{ id: 'cancel-sign-in', label: t('Cancel sign-in') }] : []),
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
  const lifetime = new AbortController()
  const cancellation = signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal])
  const releaseLifetime = ctx.effect(() => () => lifetime.abort())
  /* v8 ignore next -- reassigned to the watch-disposal effect before the overlay can close */
  let cleanup = (): void => {}
  /** Paint one view: while an attempt waits, carry the callback-forwarding guidance. */
  const paint = (view: AccountView): MayflyUiNode => {
    const server = ctx.get('webServer')
    const waiting = view.attempt !== null && view.attempt.authorizeUrl !== undefined && !attemptTerminal(view.attempt)
    return accountPanelNode(view, t, server !== undefined, waiting && server !== undefined
      ? remoteCallbackHint(server.port, accountInternals.isSshSession())
      : undefined)
  }
  let handle = openUiOverlay(ctx, {
    id, title: t('DeepSeek Account'), presentation: 'editor', capturing: true,
    scope: { kind: 'app', targetId: `account/${route}` },
    onEvent: { action: async (event): Promise<MayflyUiActionReply> => {
      /* v8 ignore next -- only activate reaches a panel without submit or read actions */
      if (event.kind !== 'activate') return { kind: 'completed' }
      if (event.actionId === 'sign-out') {
        try {
          await service.signOut(clientMetadata(ctx))
          return { kind: 'completed' }
        } catch {
          return { kind: 'failed', message: t('Sign-out failed — try again') }
        }
      }
      if (event.actionId === 'cancel-sign-in') {
        const attempt = (await service.getState()).attempt
        /* v8 ignore next -- the cancel action only renders while an attempt is live */
        if (attempt === null) return { kind: 'completed' }
        try {
          const view = await service.cancelSignIn(attempt.id)
          return { kind: 'accepted', node: paint(view), source: [] }
        } catch {
          return { kind: 'failed', message: t('Sign-in could not be cancelled') }
        }
      }
      /* v8 ignore next -- only the three panel actions reach activate */
      if (event.actionId !== 'sign-in') return { kind: 'completed' }
      const origin = callbackOrigin(ctx)
      /* v8 ignore next -- the Sign in action only renders while a webserver is composed */
      if (origin === undefined) return { kind: 'failed', message: t('Sign-in needs the local webserver — enable the webserver row') }
      try {
        const view = await service.startSignIn(clientMetadata(ctx), origin, 'desktop')
        const url = view.attempt?.authorizeUrl
        const opened = url === undefined ? false : await openUrlInBrowser(url)
        return {
          kind: 'accepted',
          node: paint(view),
          source: [],
          feedback: { severity: 'success', message: opened ? t('Opened the sign-in page in a browser') : t('Sign-in started — open the link below in a browser') },
        }
      } catch {
        return { kind: 'failed', message: t('Sign-in could not start — try again') }
      }
    } },
  }, paint(await service.getState()), { signal: cancellation, reopen: 'focus', onClosed: () => cleanup() })
  if (handle === undefined) { releaseLifetime(); return true }
  const repaint = (view: AccountView): void => {
    /* v8 ignore next -- the watch stops with the panel; a late view races its own abort */
    if (!handle?.closed) handle?.set(paint(view))
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
