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
import { signInBody, type SignInFacts, type SignInIds } from '../components/account-sign-in.ts'

/** The settings namespace the account adapter owns; routes in it are not pi-ai profiles. */
export const ACCOUNT_SETTINGS_NS = 'llm-deepseek-account'

/** Process seams for specs: the best-effort system browser opener and callback delivery. */
export const accountInternals = {
  /** Deliver one pasted callback location to the local callback server (loopback only). */
  fetchCallback: async (url: string, signal: AbortSignal): Promise<{ readonly status: number }> => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    return await fetch(url, { signal: deadline, redirect: 'manual' })
  },
  /**
   * Spawn one opener command detached. Resolves false when the opener is missing or fails: an opener that exits non-zero
   * within a moment (no display, no browser configured) did not open anything, while one that keeps running (a browser
   * that outlives its launcher) or exits clean did.
   */
  spawnOpener: async (command: string, args: readonly string[]): Promise<boolean> => {
    try {
      const { spawn } = await import('node:child_process')
      return await new Promise<boolean>(resolve => {
        const child = spawn(command, args, { stdio: 'ignore', detached: true })
        const timer = setTimeout(() => { child.unref(); resolve(true) }, OPENER_GRACE_MS)
        child.once('error', () => { clearTimeout(timer); resolve(false) })
        child.once('exit', code => { clearTimeout(timer); resolve(code === 0) })
      })
    } catch {
      /* node:child_process and spawn failures surface as the error event */
      return false
    }
  },
}

/** How long an opener may run before it counts as having handed the URL to a browser. */
const OPENER_GRACE_MS = 1500

/** The system browser opener for one platform; every platform opens one URL. */
export function openerFor(platform: NodeJS.Platform): { command: string, prefix: readonly string[] } {
  if (platform === 'darwin') return { command: 'open', prefix: [] }
  if (platform === 'win32') return { command: 'cmd', prefix: ['/c', 'start', ''] }
  return { command: 'xdg-open', prefix: [] }
}

/** Open one URL in the system browser; a failure leaves the visible link as the fallback. */
export async function openUrlInBrowser(url: string): Promise<boolean> {
  /* a Linux session with no display (a bare SSH login) has no browser to open */
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false
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
export function attemptTerminal(attempt: SignInAttemptView): boolean {
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
interface AccountPanelOptions {
  /** The browser launch has no result yet. */
  readonly launching?: boolean
  /** The browser could not be opened for the link: the page says so and the paste-back field is open and focused. */
  readonly focusPaste?: boolean
  /** The reader asked for the other-machine view (`p`). */
  readonly pasteOpen?: boolean
  /** The clock the countdown reads, in epoch milliseconds (the current time when omitted). */
  readonly now?: number
  /** The whole life of the link in milliseconds, for the countdown bar; the time left when omitted. */
  readonly expiryTotalMs?: number
}

/** The ids the sign-in page's events are read by in this panel. */
const PANEL_SIGN_IN: SignInIds = {
  pagePath: [], keys: 'account-actions', form: 'callback-paste', field: 'callback-url', copy: 'copy-link', restart: 'restart-sign-in',
  other: 'show-paste', deliver: 'deliver-callback', retryList: 'unused-retry-list', retry: 'unused-retry',
}

/**
 * The panel for one account view. Signing in is the shared sign-in page (`components/account-sign-in.ts`): getting the link,
 * opening the browser, waiting with a countdown, and the other-machine paste when this browser could not be opened. The
 * rest are one-sentence states with a single action; the shortcuts live only in the hint row.
 * @param callbackPort - the live loopback callback port while an attempt waits for a browser; omit it to render without the paste-back.
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
  const linked = live && attempt.authorizeUrl !== undefined
  // A cancelled, expired or failed attempt is over: sign-in is offered again.
  const retry = attempt !== null && !live && attempt.phase !== 'succeeded'
  const frame = (child: MayflyUiNode, escapeLabel: 'cancel' | 'close' = 'close'): MayflyUiNode => ui.surface({ title: t('DeepSeek Account'), chrome: 'overlay', escapeLabel, child })

  if (live) {
    const left = attempt.expiresAt === undefined ? undefined : attempt.expiresAt - (options.now ?? Date.now())
    const facts: SignInFacts = {
      stage: attempt.phase === 'exchanging' || attempt.phase === 'committing' ? 'finishing' : linked ? 'waiting' : 'starting',
      browser: options.launching === true ? 'pending' : options.focusPaste === true ? 'failed' : 'opened',
      manual: options.pasteOpen === true,
      ...attempt.authorizeUrl === undefined ? {} : { url: attempt.authorizeUrl },
      ...left === undefined ? {} : { remainingMs: left },
      ...options.expiryTotalMs === undefined ? {} : { totalMs: options.expiryTotalMs },
      ...callbackPort === undefined ? {} : { callbackPort },
    }
    return frame(signInBody(facts, {
      starting: t('Getting your sign-in link…'),
      opening: t('Opening your browser…'),
      waiting: t('Waiting for you to sign in in your browser'),
      noBrowser: t('Couldn’t open a browser. Copy the link below and open it yourself, then paste the address it ends on (the page may fail to load).'),
      otherMachine: t('Open the link below in a browser on another machine, then paste the address it ends on (the page may fail to load).'),
      finishing: t('Signing you in…'),
      connected: t('Signed in'),
      expires: (time: string) => t('expires in {time}', { time }),
      callbackLabel: t('Callback URL'),
      callbackPlaceholder: `http://localhost:${String(callbackPort ?? '')}/oauth/callback?…`,
      retry: t('Try again'),
      copyLink: t('Copy link'),
      newLink: t('New link'),
      otherMachineKey: t('Other machine'),
      deliver: t('Deliver callback'),
    }, PANEL_SIGN_IN), 'cancel')
  }

  if (stored) {
    return frame(ui.stack.column([
      ui.richText([{ text: '✓ ', tone: 'success' }, { text: t('Signed in') }]),
      ui.text(t('Account models need no API key.'), { tone: 'muted' }),
      ui.spacer(),
      ui.actions({ id: 'account-actions', items: [
        { id: 'sign-out', label: t('Sign out'), hintLabel: t('sign out'), key: 'o', hidden: true, intent: 'danger' as const, confirm: t('Sign out of the DeepSeek account?') },
      ] }),
    ]))
  }

  return frame(ui.stack.column([
    ...retry ? [ui.text(outcomeText(attempt, t), { tone: 'warning' }), ui.spacer()] : [],
    ui.text(canSignIn
      ? t('Sign in with your DeepSeek account — models are billed to it and need no API key.')
      : t('Sign in from a DeepSeek Harness Desktop or Web host on this machine — the stored login is shared across hosts. Account models then need no API key.'), { tone: 'muted' }),
    ui.spacer(),
    ui.actions({ id: 'account-actions', items: canSignIn
      ? [{ id: 'sign-in', label: retry && attempt.phase !== 'cancelled' ? t('Try again') : t('Sign in'), intent: 'primary' as const }]
      : [{ id: 'close', label: t('Close'), dismiss: true }] }),
  ]))
}

/** How long a started sign-in waits for the platform to issue the link before the panel stops expecting it. */
const LINK_WAIT_MS = 15_000

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
  /* reassigned to the watch-disposal effect before the overlay can close */
  let cleanup = (): void => {}
  /** The browser could not be opened for the current link, so the paste-back field is the way on and takes the focus. */
  let browserFailed = false
  /** A sign-in just started and the browser launch has no result yet: the watch holds its repaint so the paste-back field first appears with the right focus. */
  let launching = false
  /** Resolves with the link once the platform has issued it (it comes a moment after a sign-in starts), or undefined when the attempt ends first or the wait runs out. */
  let linkWaiter: ((url: string | undefined) => void) | undefined
  const awaitLink = (view: AccountView): Promise<string | undefined> => {
    const ready = view.attempt?.authorizeUrl
    if (ready !== undefined) return Promise.resolve(ready)
    if (view.attempt === null || attemptTerminal(view.attempt)) return Promise.resolve(undefined)
    return new Promise(resolve => {
      const done = (url: string | undefined): void => { clearTimeout(timer); linkWaiter = undefined; resolve(url) }
      const timer = setTimeout(() => done(undefined), LINK_WAIT_MS)
      linkWaiter = done
    })
  }
  /** The reader asked for the paste-back field (`p`) for the current attempt. */
  let pasteOpen = false
  /** The whole life of the current link, noted when it first shows, so the countdown bar has its full length. */
  let expiryTotalMs: number | undefined
  let expiryAttempt: string | undefined
  /** Paint one view: while an attempt waits, accept pasted callback delivery. */
  const paint = (view: AccountView): MayflyUiNode => {
    const server = ctx.get('webServer')
    const waiting = view.attempt !== null && view.attempt.authorizeUrl !== undefined && !attemptTerminal(view.attempt)
    if (waiting && view.attempt!.expiresAt !== undefined && expiryAttempt !== view.attempt!.id) {
      expiryAttempt = view.attempt!.id
      expiryTotalMs = Math.max(0, view.attempt!.expiresAt - Date.now())
    }
    return accountPanelNode(view, t, server !== undefined, waiting && server !== undefined ? server.port : undefined, {
      launching, focusPaste: browserFailed, pasteOpen, ...expiryTotalMs === undefined ? {} : { expiryTotalMs },
    })
  }
  let handle = openUiOverlay(ctx, {
    id, presentation: 'editor', capturing: true,
    scope: { kind: 'app', targetId: `account/${route}` },
    onEvent: { action: async (event, context): Promise<MayflyUiActionReply> => {
      /* activate and the paste submit are the only panel events */
      if (event.kind !== 'activate' && event.kind !== 'submit') return { kind: 'completed' }
      if (event.kind === 'activate' && event.actionId === 'copy-link') {
        const url = (await service.getState()).attempt?.authorizeUrl
        /* the copy action only renders while a link waits */
        if (url === undefined) return { kind: 'completed' }
        try {
          await copyTextToClipboard(url)
          return { kind: 'completed', feedback: { severity: 'success', message: t('Sign-in link copied') } }
        } catch {
          return { kind: 'failed', message: t('The link could not be copied — select it in the panel instead') }
        }
      }
      if (event.kind === 'activate' && event.actionId === 'show-paste') {
        pasteOpen = true
        return { kind: 'accepted', node: paint(await service.getState()), source: [] }
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
        /* the paste form only renders while a webserver is composed */
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
      /* every other activate action returns in its own branch above */
      if (event.kind === 'activate' && ['sign-in', 'restart-sign-in'].includes(event.actionId)) {
        const origin = callbackOrigin(ctx)
        /* both actions only render while a webserver is composed */
        if (origin === undefined) return { kind: 'failed', message: t('Sign-in needs the local web server, which this setup does not run — use an API key instead') }
        try {
          if (event.actionId === 'restart-sign-in') {
            // The platform keeps one live attempt per host process and answers
            // startSignIn idempotently with its URL while it waits, so a fresh
            // authorize link requires retiring the current attempt first.
            const current = (await service.getState()).attempt
            /* the restart action only renders while a live attempt waits */
            if (current !== null && !attemptTerminal(current)) await service.cancelSignIn(current.id)
            const restarted = await service.startSignIn(clientMetadata(ctx), origin, 'desktop')
            /* a fresh attempt comes back initializing, without its link: wait for the link, then try the browser */
            const url = await awaitLink(restarted)
            const opened = url === undefined ? false : await openUrlInBrowser(url)
            browserFailed = url !== undefined && !opened
            /* the watch painted before the launch result was known: paint again with it */
            if (!handle?.closed) handle?.set(paint(await service.getState()))
            // Two state hops (retire, then fresh attempt) race the watch
            // repaint; the watch stream owns the final node, this replies
            // with the outcome only.
            return { kind: 'completed', feedback: { severity: 'success', message: opened ? t('Opened the sign-in page in a browser') : t('Sign-in restarted with a fresh link') } }
          }
          launching = true
          pasteOpen = false
          let opened: boolean
          let linked: boolean
          try {
            const started = await service.startSignIn(clientMetadata(ctx), origin, 'desktop')
            /* the platform issues the link a moment after the attempt starts: wait for it, then try the browser */
            const url = await awaitLink(started)
            linked = url !== undefined
            opened = url === undefined ? false : await openUrlInBrowser(url)
            browserFailed = linked && !opened
          } finally { launching = false }
          return {
            kind: 'accepted',
            node: paint(await service.getState()),
            source: [],
            /* when the browser did not open, the panel's instruction says so: no second notice */
            ...opened ? { feedback: { severity: 'success' as const, message: t('Opened the sign-in page in a browser') } } : {},
          }
        } catch {
          return { kind: 'failed', message: t('Sign-in could not start — try again') }
        }
      }
      /* only the panel actions above reach activate */
      return { kind: 'completed' }
    } },
  }, paint(await service.getState()), { signal: cancellation, reopen: 'focus', onClosed: () => { cleanup() } })
  if (handle === undefined) { releaseLifetime(); return true }
  /* the countdown bar moves each second while a link waits */
  let lastView: AccountView | undefined
  let ticker: ReturnType<typeof setInterval> | undefined
  ctx.effect(() => () => { if (ticker !== undefined) clearInterval(ticker) })
  const syncTicker = (view: AccountView): void => {
    lastView = view
    const counting = view.attempt?.phase === 'waiting-browser' && view.attempt.expiresAt !== undefined
    if (counting && ticker === undefined) ticker = setInterval(() => { if (lastView !== undefined && !handle?.closed && !launching) handle?.set(paint(lastView)) }, 1000)
    else if (!counting && ticker !== undefined) { clearInterval(ticker); ticker = undefined }
  }
  const repaint = (view: AccountView): void => {
    syncTicker(view)
    if (view.attempt?.authorizeUrl !== undefined) linkWaiter?.(view.attempt.authorizeUrl)
    else if (view.attempt !== null && attemptTerminal(view.attempt)) linkWaiter?.(undefined)
    /* the watch stops with the panel; a late view races its own abort */
    if (!handle?.closed && !launching) handle?.set(paint(view))
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
