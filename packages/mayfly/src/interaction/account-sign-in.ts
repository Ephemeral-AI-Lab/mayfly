/** One DeepSeek account sign-in, driven without a panel of its own: it starts the attempt, opens the browser once the platform
 * has issued the link, follows the attempt to its end, and reports each moment as a snapshot. The first-run guide draws the
 * snapshots on its Connect page; nothing here knows a screen.
 *
 * @module @ephemeral-ai/mayfly/interaction/account-sign-in
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type { AccountView, SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account'
import { accountInternals, attemptTerminal, callbackOrigin, clientMetadata, openUrlInBrowser, parseCallbackLocation } from './provider-account.ts'
import { copyTextToClipboard } from './clipboard-write.ts'

/** Why a sign-in ended without connecting. */
export type SignInEnd = 'cancelled' | 'expired' | 'network' | 'storage' | 'failed'

/** One moment of a sign-in. */
export interface SignInSnapshot {
  readonly stage: 'starting' | 'waiting' | 'finishing' | 'connected' | 'ended'
  /** `pending` until the browser launch has a result, per attempt. */
  readonly browser: 'pending' | 'opened' | 'failed'
  readonly url?: string
  readonly expiresAt?: number
  /** The link's whole life, noted when it first showed. */
  readonly totalMs?: number
  /** The loopback callback port (paste-back); absent when no web server runs. */
  readonly callbackPort?: number
  readonly ended?: SignInEnd
}

export interface SignInFlow {
  readonly snapshot: () => SignInSnapshot
  /** A fresh attempt: the current one is cancelled first. Also the way back from an ended one. */
  readonly restart: () => Promise<void>
  readonly copyLink: () => Promise<boolean>
  /** Hand the pasted address to the local callback server. */
  readonly deliver: (raw: string) => Promise<'delivered' | 'invalid' | 'rejected' | 'failed'>
  /** Stop the sign-in: the attempt is cancelled and `connected` settles false. */
  readonly cancel: () => void
  /** Settles true when the login lands, false when the flow is cancelled or its lifetime ends. */
  readonly connected: Promise<boolean>
}

/** A sign-in that cannot start here. */
export interface SignInUnavailable { readonly error: 'unavailable' | 'no-server' | 'failed' }

function endOf(attempt: SignInAttemptView): SignInEnd {
  if (attempt.phase === 'cancelled') return 'cancelled'
  if (attempt.phase === 'expired' || attempt.errorCode === 'expired') return 'expired'
  /* `no-response` means fetch produced no Response at all — the same
     reachability story as a failed network exchange. */
  if (attempt.errorCode === 'network' || attempt.errorCode === 'no-response') return 'network'
  if (attempt.errorCode === 'storage') return 'storage'
  return 'failed'
}

/**
 * Start a sign-in and follow it.
 * @param ctx - context with `deepseekAccount` and the web server (its callback receives the browser's redirect).
 * @param options - the owner's lifetime, and the callback each moment is reported to.
 * @returns the flow, or why there is none.
 */
export async function startSignIn(ctx: Context, options: { readonly signal: AbortSignal, readonly onChange: (snapshot: SignInSnapshot) => void }): Promise<SignInFlow | SignInUnavailable> {
  const service = ctx.get('deepseekAccount')
  if (service === undefined) return { error: 'unavailable' }
  const origin = callbackOrigin(ctx)
  const server = ctx.get('webServer')
  if (origin === undefined || server === undefined) return { error: 'no-server' }
  const control = new AbortController()
  const signal = AbortSignal.any([options.signal, control.signal])
  let snapshot: SignInSnapshot = { stage: 'starting', browser: 'pending', callbackPort: server.port }
  const emit = (next: SignInSnapshot): void => { snapshot = next; if (!signal.aborted) options.onChange(next) }
  let settle!: (connected: boolean) => void
  const connected = new Promise<boolean>(resolve => { settle = resolve })
  signal.addEventListener('abort', () => settle(false), { once: true })
  let attemptId: string | undefined
  let restarting = false

  const apply = (view: AccountView): void => {
    const attempt = view.attempt
    if (view.status === 'credential-stored' && attempt?.phase === 'succeeded') {
      emit({ ...snapshot, stage: 'connected' })
      settle(true)
      return
    }
    if (attempt === null) return
    if (attempt.id !== attemptId) {
      /* a new attempt: its browser launch starts over */
      attemptId = attempt.id
      snapshot = { stage: 'starting', browser: 'pending', callbackPort: server.port }
    }
    if (attemptTerminal(attempt)) {
      /* the cancelled attempt a restart leaves behind is not an ending */
      if (!restarting) emit({ stage: 'ended', browser: snapshot.browser, callbackPort: server.port, ended: endOf(attempt) })
      return
    }
    if (attempt.phase === 'exchanging' || attempt.phase === 'committing') { emit({ ...snapshot, stage: 'finishing' }); return }
    const url = attempt.authorizeUrl
    if (url === undefined) { emit({ ...snapshot, stage: 'starting' }); return }
    const first = snapshot.url === undefined
    emit({
      ...snapshot, stage: 'waiting', url,
      ...attempt.expiresAt === undefined ? {} : { expiresAt: attempt.expiresAt },
      totalMs: snapshot.totalMs ?? (attempt.expiresAt === undefined ? 0 : Math.max(0, attempt.expiresAt - Date.now())),
    })
    /* the link has just been issued: try the browser once for this attempt */
    if (first) void openUrlInBrowser(url).then(opened => { if (!signal.aborted && snapshot.url === url) emit({ ...snapshot, browser: opened ? 'opened' : 'failed' }) })
  }

  try {
    const first = await service.startSignIn(clientMetadata(ctx), origin, 'desktop')
    apply(first)
  } catch { return { error: 'failed' } }
  void (async () => {
    try { for await (const view of service.watch(signal)) apply(view) } catch { /* the owner's lifetime ends the watch */ }
  })()

  return {
    snapshot: () => snapshot,
    restart: async () => {
      restarting = true
      try {
        const current = (await service.getState()).attempt
        if (current !== null && !attemptTerminal(current)) await service.cancelSignIn(current.id)
        attemptId = undefined
        emit({ stage: 'starting', browser: 'pending', callbackPort: server.port })
        apply(await service.startSignIn(clientMetadata(ctx), origin, 'desktop'))
      } catch {
        emit({ stage: 'ended', browser: 'pending', callbackPort: server.port, ended: 'failed' })
      } finally { restarting = false }
    },
    copyLink: async () => {
      const url = snapshot.url
      if (url === undefined) return false
      try { await copyTextToClipboard(url); return true } catch { return false }
    },
    deliver: async raw => {
      const location = parseCallbackLocation(raw, server.port)
      if (location === undefined) return 'invalid'
      try {
        const response = await accountInternals.fetchCallback(location.href, signal)
        return response.status >= 400 ? 'rejected' : 'delivered'
      } catch { return 'failed' }
    },
    cancel: () => {
      const current = snapshot
      control.abort()
      if (current.stage !== 'connected') void service.getState().then(view => { if (view.attempt !== null && !attemptTerminal(view.attempt)) void service.cancelSignIn(view.attempt.id) }, () => {})
    },
    connected,
  }
}
