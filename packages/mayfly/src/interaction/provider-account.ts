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
import { ui, type MayflyUiActionReply, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { MAYFLY_VERSION } from '../transcript/banner-content.ts'
import { interactionTranslator } from './locale.ts'
import { copyTextToClipboard } from './clipboard-write.ts'
import { openUiOverlay } from './ui-overlay.ts'

/** The settings namespace the account adapter owns; routes in it are not pi-ai profiles. */
export const ACCOUNT_SETTINGS_NS = 'llm-deepseek-account'

/** Process seams for specs: the best-effort system browser opener and callback delivery. */
export const accountInternals = {
  /** Deliver one pasted callback location to the local callback server (loopback only). */
  fetchCallback: async (url: string, signal: AbortSignal): Promise<{ readonly status: number }> => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    return await fetch(url, { signal: deadline, redirect: 'manual' })
  },
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

/**
 * Validate one pasted callback location: the browser's address bar keeps the
 * full redirect URL (with its code) even when the connection itself failed.
 * Only the live loopback callback endpoint is accepted, so a paste can never
 * aim the host's own fetch anywhere else.
 */
export function parseCallbackLocation(raw: string, port: number): URL | undefined {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return undefined }
  if (url.protocol !== 'http:') return undefined
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return undefined
  if (url.port !== String(port)) return undefined
  if (url.pathname !== '/oauth/callback') return undefined
  return url
}

/** The one-line outcome of a finished attempt; the platform error code picks the reason. */
function outcomeText(attempt: SignInAttemptView, t: (key: string) => string): string {
  if (attempt.phase === 'cancelled') return t('Sign-in cancelled')
  if (attempt.phase === 'expired' || attempt.errorCode === 'expired') return t('The sign-in link expired — try again')
  if (attempt.errorCode === 'network') return t('Could not reach DeepSeek — check the connection and try again')
  if (attempt.errorCode === 'storage') return t('The login could not be saved on this machine — try again')
  return t('Sign-in failed — try again')
}

/** Presentation options for the account panel node. */
export interface AccountPanelOptions {
  /** Render inside the first-run guide: adds the step line and the Start chatting close. */
  readonly guide?: boolean
  /** BCP 47 locale for the expiry time; the runtime default when omitted. */
  readonly locale?: string | undefined
}

/**
 * The panel content for one account view.
 * @param callbackPort - the live loopback callback port while an attempt
 * waits for a browser; omit it to render without the paste-back rows.
 */
export function accountPanelNode(
  view: AccountView,
  t: (key: string, values?: Record<string, string | number>) => string,
  canSignIn: boolean,
  callbackPort?: number,
  options: AccountPanelOptions = {},
): MayflyUiNode {
  const attempt = view.attempt
  const stored = view.status === 'credential-stored'
  const live = attempt !== null && !attemptTerminal(attempt)
  const waiting = live && attempt.authorizeUrl !== undefined
  // A cancelled, expired or failed attempt is over: sign-in is offered again.
  const retry = attempt !== null && !live && attempt.phase !== 'succeeded'
  const justConnected = stored && attempt?.phase === 'succeeded'
  return ui.stack.column([
    ...(options.guide === true && !stored ? [ui.text(t('Step 2 of 2 · Finish in your browser'), { tone: 'muted' })] : []),
    ui.fields([
      { label: t('Status'), value: [{ text: t(stored ? 'Signed in' : 'Not signed in') }] },
      ...(live ? [{ label: t('Sign-in'), value: [{ text: t('Signing in…') }] }] : retry ? [{ label: t('Sign-in'), value: [{ text: outcomeText(attempt, t) }] }] : []),
      ...(waiting && attempt.expiresAt !== undefined ? [{ label: t('Expires'), value: [{ text: new Intl.DateTimeFormat(options.locale, { timeStyle: 'medium' }).format(new Date(attempt.expiresAt)) }] }] : []),
    ]),
    ...(justConnected ? [ui.text(t('Connected — account models need no API key.'), { tone: 'muted' })] : []),
    ...(waiting ? [
      ui.text(t('Approve in the browser — on this machine sign-in finishes by itself'), { tone: 'muted' }),
      ui.fields([{ label: t('Sign-in link'), value: [{ text: attempt.authorizeUrl! }] }]),
      ui.text(t('Ctrl+Y copy link · Ctrl+R new link'), { tone: 'muted' }),
      ...(callbackPort === undefined ? [] : [
        ui.text(t('Browser on another machine? Paste the address it ends on (the page may fail to load) — otherwise leave this empty'), { tone: 'muted' }),
        ui.form({ id: 'callback-paste', enterSubmits: 'deliver-callback', fields: [{ kind: 'input', id: 'callback-url', label: t('Callback link'), value: '', placeholder: `http://localhost:${String(callbackPort)}/oauth/callback?…` }] }),
      ]),
    ] : []),
    ...(stored || canSignIn ? [] : [ui.text(t('Sign in from a DeepSeek Harness Desktop or Web host on this machine — the stored login is shared across hosts. Account models then need no API key.'), { tone: 'muted' })]),
    ui.actions({ id: 'account-actions', items: [
      ...(!stored && canSignIn && !live ? [{ id: 'sign-in', label: retry && attempt.phase !== 'cancelled' ? t('Try again') : t('Sign in'), intent: 'primary' as const }] : []),
      // Waiting-state controls are shortcuts, not buttons: keep the panel quiet.
      ...(waiting ? [{ id: 'copy-link', label: t('Copy link'), key: 'ctrl+y', hidden: true }, { id: 'restart-sign-in', label: t('New link'), key: 'ctrl+r', hidden: true }] : []),
      ...(waiting && callbackPort !== undefined ? [{ id: 'deliver-callback', label: t('Deliver callback'), hidden: true, submit: [{ pagePath: [], formId: 'callback-paste' }] }] : []),
      ...(stored ? [{ id: 'sign-out', label: t('Sign out'), intent: 'danger' as const, confirm: t('Sign out of the DeepSeek account?') }] : []),
      { id: 'close', label: justConnected && options.guide === true ? t('Start chatting') : t('Close'), dismiss: true },
    ] }),
  ])
}

/** How long the guide shows the connected confirmation before closing. */
export const GUIDE_CLOSE_DELAY_MS = 1500

/** The way back the first-run guide hands the account panel so no path dead-ends. */
export interface AccountGuideExits {
  /** Closing the panel before connecting returns to the guide's choice. */
  readonly onBack: () => void
}

/**
 * Open the DeepSeek account panel for the account provider route.
 * @param ctx - Host context with the overlays service.
 * @param route - The provider route the Providers list selected.
 * @param signal - Optional caller lifetime.
 * @param guide - Set by the first-run guide: closing the panel before a
 * sign-in completes reopens the guide's choice.
 * @returns true when the panel opened (the route is the account adapter and
 * the native account service is available); false when the route is not the
 * account adapter, so callers fall back to their own handling.
 */
export async function openAccountPanel(ctx: Context, route: string, signal?: AbortSignal, guide?: AccountGuideExits): Promise<boolean> {
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
  /** Paint one view: while an attempt waits, accept pasted callback delivery. */
  const paint = (view: AccountView): MayflyUiNode => {
    const server = ctx.get('webServer')
    const waiting = view.attempt !== null && view.attempt.authorizeUrl !== undefined && !attemptTerminal(view.attempt)
    return accountPanelNode(view, t, server !== undefined, waiting && server !== undefined ? server.port : undefined, { guide: guide !== undefined, locale: ctx.get('mayflyLocale')?.snapshot.locale })
  }
  let connected = false
  let handle = openUiOverlay(ctx, {
    id, title: t('DeepSeek Account'), presentation: 'editor', capturing: true,
    scope: { kind: 'app', targetId: `account/${route}` },
    onEvent: { action: async (event, context): Promise<MayflyUiActionReply> => {
      /* v8 ignore next -- activate and the paste submit are the only panel events */
      if (event.kind !== 'activate' && event.kind !== 'submit') return { kind: 'completed' }
      if (event.kind === 'activate' && event.actionId === 'copy-link') {
        const url = (await service.getState()).attempt?.authorizeUrl
        /* v8 ignore next -- the copy action only renders while a link waits */
        if (url === undefined) return { kind: 'completed' }
        try {
          await copyTextToClipboard(url)
          return { kind: 'completed', feedback: { severity: 'success', message: t('Sign-in link copied') } }
        } catch {
          return { kind: 'failed', message: t('The link could not be copied — select it in the panel instead') }
        }
      }
      if (event.kind === 'activate' && event.actionId === 'sign-out') {
        try {
          await service.signOut(clientMetadata(ctx))
          return { kind: 'completed' }
        } catch {
          return { kind: 'failed', message: t('Sign-out failed — try again') }
        }
      }
      if (event.kind === 'submit' && event.submission.actionId === 'deliver-callback') {
        const server = ctx.get('webServer')
        const raw = event.submission.forms[0]?.fields.find(field => field.id === 'callback-url')?.value
        /* v8 ignore next -- the paste form only renders while a webserver is composed */
        const location = server === undefined || typeof raw !== 'string' ? undefined : parseCallbackLocation(raw, server.port)
        if (location === undefined) {
          return { kind: 'invalid', errors: [{ pagePath: [], formId: 'callback-paste', fieldId: 'callback-url', message: t('Paste the full callback address from the browser address bar') }] }
        }
        try {
          const response = await accountInternals.fetchCallback(location.href, context.signal)
          return response.status >= 400
            ? { kind: 'failed', message: t('The pasted link was not accepted — copy the full address bar URL and try again') }
            : { kind: 'accepted', node: paint(await service.getState()), source: [], feedback: { severity: 'success', message: t('Callback delivered — finishing sign-in') } }
        } catch {
          return { kind: 'failed', message: t('The callback could not be delivered') }
        }
      }
      /* v8 ignore next -- every other activate action returns in its own branch above */
      if (event.kind === 'activate' && ['sign-in', 'restart-sign-in'].includes(event.actionId)) {
        const origin = callbackOrigin(ctx)
        /* v8 ignore next -- both actions only render while a webserver is composed */
        if (origin === undefined) return { kind: 'failed', message: t('Sign-in needs the local web server, which this setup does not run — use an API key instead') }
        try {
          if (event.actionId === 'restart-sign-in') {
            // The platform keeps one live attempt per host process and answers
            // startSignIn idempotently with its URL while it waits, so a fresh
            // authorize link requires retiring the current attempt first.
            const current = (await service.getState()).attempt
            /* v8 ignore next -- the restart action only renders while a live attempt waits */
            if (current !== null && !attemptTerminal(current)) await service.cancelSignIn(current.id)
            const restarted = await service.startSignIn(clientMetadata(ctx), origin, 'desktop')
            const url = restarted.attempt?.authorizeUrl
            /* v8 ignore next -- a fresh attempt may still be initializing without its URL */
            const opened = url === undefined ? false : await openUrlInBrowser(url)
            // Two state hops (retire, then fresh attempt) race the watch
            // repaint; the watch stream owns the final node, this replies
            // with the outcome only.
            return { kind: 'completed', feedback: { severity: 'success', message: opened ? t('Opened the sign-in page in a browser') : t('Sign-in restarted with a fresh link') } }
          }
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
      }
      /* v8 ignore next -- only the panel actions above reach activate */
      return { kind: 'completed' }
    } },
  }, paint(await service.getState()), { signal: cancellation, reopen: 'focus', onClosed: () => {
    // The lifetime aborts before this hook on unload, so only a user close is deliberate.
    const deliberate = !cancellation.aborted
    cleanup()
    // Backing out of the account step returns to the guide, never to nothing.
    if (guide !== undefined && !connected && deliberate) guide.onBack()
  } })
  if (handle === undefined) { releaseLifetime(); return true }
  let closing = false
  const repaint = (view: AccountView): void => {
    connected = view.status === 'credential-stored'
    /* v8 ignore next -- the watch stops with the panel; a late view races its own abort */
    if (!handle?.closed) handle?.set(paint(view))
    // Inside the guide a finished sign-in is the end of setup: show the
    // confirmation briefly, then hand the session back.
    if (guide !== undefined && !closing && view.status === 'credential-stored' && view.attempt?.phase === 'succeeded') {
      closing = true
      ctx.effect(() => {
        const timer = setTimeout(() => handle?.close(), GUIDE_CLOSE_DELAY_MS)
        return () => clearTimeout(timer)
      })
    }
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
