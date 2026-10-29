/**
 * DeepSeek Platform account state, details, and browser sign-in over the
 * official account Remote namespace.
 * @module @ephemeral-ai/mayfly/remote/features/account
 */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient } from '../../client/types.ts'
import type {
  RemoteAccountLocalIO,
  RemoteFeatureContext,
} from './contracts.ts'
import {
  RemoteFeatureController,
  RemoteFeatureOperation,
  remoteErrorMessage,
  remoteValue,
} from './official.ts'
import { openRemoteFeaturePanel, type RemoteMountedPanel, type RemotePanelModel } from './panel.ts'

type OfficialValue<T> = T extends Promise<RemoteResult<infer Value>> ? Value : never

/** Official safe account projection. */
export type RemoteAccountView = OfficialValue<ReturnType<HostClient['remote']['account']['getState']>>
/** Official display-safe profile response. */
export type RemoteAccountProfile = OfficialValue<ReturnType<HostClient['remote']['account']['getProfile']>>
/** Official Platform balance response; never an API-key-derived balance. */
export type RemoteAccountBalance = OfficialValue<ReturnType<HostClient['remote']['account']['getBalance']>>
/** Official request identity supplied by the local UI. */
export type RemoteAccountClientMetadata = Parameters<HostClient['remote']['account']['startSignIn']>[0]

/** Local presentation of one sign-in flow. */
export interface RemoteSignInSnapshot {
  readonly view: RemoteAccountView
  readonly stage: 'idle' | 'starting' | 'waiting' | 'finishing' | 'connected' | 'ended'
  readonly browser: 'pending' | 'opened' | 'failed'
  readonly manual: boolean
  readonly delivering: boolean
  readonly callbackOrigin?: string
  readonly callbackPort?: number
  readonly transport: 'loopback' | 'forwarded'
  readonly error?: string
}

/** Validate the exact loopback HTTP origin accepted by the official account service. */
export function remoteAccountCallbackOrigin(value: string | undefined): { readonly origin: string, readonly port: number } | undefined {
  if (value === undefined) return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  const explicitPort = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/i.exec(value)?.[1]
  if (explicitPort === undefined || Number(explicitPort) === 0
    || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
  return { origin: `${url.protocol}//${url.hostname}:${Number(explicitPort)}`, port: Number(explicitPort) }
}

/** Accept only the configured Host callback origin and exact OAuth callback path. */
export function remoteAccountCallbackLocation(raw: string, origin: string): URL | undefined {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return undefined }
  if (url.origin !== origin || url.pathname !== '/oauth/callback' || url.username || url.password) return undefined
  return url
}

/** Whether an official attempt no longer accepts cancellation. */
export function remoteAccountAttemptTerminal(attempt: RemoteAccountView['attempt']): boolean {
  return attempt !== null && ['succeeded', 'cancelled', 'expired', 'failed'].includes(attempt.phase)
}

/** Build request metadata without credentials or device secrets. */
export function remoteAccountMetadata(context: RemoteFeatureContext, version: string): RemoteAccountClientMetadata {
  if (version === '') throw new Error('Account client version must not be empty')
  return {
    version,
    locale: context.presentation.snapshot.locale.split('-')[0] ?? 'en',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/**
 * One reusable sign-in flow. Disposing it closes only local watches and timers;
 * remote cancellation occurs solely through cancel() or an explicit restart.
 */
export class RemoteAccountSignInFlow {
  private snapshotValue: RemoteSignInSnapshot
  private ownedAttempt: string | undefined
  private linkWaiter: ((url: string | undefined) => void) | undefined
  private linkTimer: ReturnType<typeof setTimeout> | undefined
  private settleConnected: ((connected: boolean) => void) | undefined

  readonly connected: Promise<boolean>

  constructor(
    private readonly operation: RemoteFeatureOperation,
    private readonly io: RemoteAccountLocalIO,
    private readonly metadata: RemoteAccountClientMetadata,
    initial: RemoteAccountView,
    private readonly changed: () => void,
  ) {
    this.snapshotValue = {
      view: initial,
      stage: initial.status === 'credential-stored' ? 'connected' : 'idle',
      browser: 'pending',
      manual: false,
      delivering: false,
      transport: operation.client.remote.$host.isLoopback ? 'loopback' : 'forwarded',
    }
    this.connected = new Promise<boolean>(resolve => { this.settleConnected = resolve })
    operation.onDispose(() => {
      if (this.linkTimer !== undefined) clearTimeout(this.linkTimer)
      this.linkWaiter?.(undefined)
      this.linkWaiter = undefined
      this.settleConnected?.(false)
      this.settleConnected = undefined
    })
    void this.watch()
    if (initial.status === 'credential-stored' && initial.attempt?.phase === 'succeeded') {
      this.settleConnected?.(true)
      this.settleConnected = undefined
    }
  }

  get snapshot(): RemoteSignInSnapshot { return this.snapshotValue }

  /** Start or join an attempt with the configured loopback/SSH-forwarded origin. */
  async start(): Promise<void> {
    const callback = remoteAccountCallbackOrigin(this.io.callbackOrigin(this.operation.client))
    if (callback === undefined) {
      const error = 'Account sign-in requires a browser-accessible HTTP loopback callback origin with an explicit port (use an SSH local forward for a remote Host).'
      this.patch({ error, stage: 'ended' })
      throw new Error(error)
    }
    this.patch({ stage: 'starting', browser: 'pending', manual: false, delivering: false, error: undefined, callbackOrigin: callback.origin, callbackPort: callback.port })
    try {
      const view = await remoteValue(this.operation.client.remote.account.startSignIn(this.metadata, callback.origin, 'desktop'))
      if (!this.operation.valid()) return
      this.ownedAttempt = String(view.attempt?.id ?? '')
      this.apply(view)
      const url = view.attempt?.authorizeUrl ?? await this.awaitLink()
      if (url === undefined || !this.operation.valid()) return
      const opened = await this.io.openBrowser(url)
      if (this.operation.valid() && this.url === url) this.patch({ browser: opened ? 'opened' : 'failed' })
    } catch (error) {
      if (this.operation.valid()) this.patch({ stage: 'ended', error: remoteErrorMessage(error) })
      throw error
    }
  }

  /** Explicitly cancel the displayed live attempt; panel close never calls this. */
  async cancel(): Promise<void> {
    const attempt = this.snapshot.view.attempt
    if (attempt === null || remoteAccountAttemptTerminal(attempt)) return
    const view = await remoteValue(this.operation.client.remote.account.cancelSignIn(attempt.id))
    if (this.operation.valid()) this.apply(view)
  }

  /** Explicitly retire the current attempt and request a fresh link. */
  async restart(): Promise<void> {
    await this.cancel()
    this.ownedAttempt = undefined
    await this.start()
  }

  /** Copy the current authorize URL through the local adapter. */
  async copy(): Promise<void> {
    const url = this.snapshot.view.attempt?.authorizeUrl
    if (url === undefined) throw new Error('No sign-in link is available')
    await this.io.copy(url)
  }

  /** Deliver a pasted callback only to the exact configured origin. */
  async deliver(raw: string): Promise<'delivered' | 'invalid' | 'rejected'> {
    const origin = this.snapshot.callbackOrigin
    const location = origin === undefined ? undefined : remoteAccountCallbackLocation(raw, origin)
    if (location === undefined) return 'invalid'
    this.patch({ delivering: true })
    const response = await this.io.deliverCallback(location, this.operation.signal)
    if (!this.operation.valid()) return 'rejected'
    this.patch({ delivering: response.status >= 400 })
    return response.status >= 400 ? 'rejected' : 'delivered'
  }

  /** Stop local work without cancelling the Host attempt. */
  dispose(): void { this.operation.dispose() }

  /** Register panel-owned cleanup with the same local lifetime. */
  onDispose(cleanup: () => void): void { this.operation.onDispose(cleanup) }

  /** Show the manual callback path without changing Host state. */
  setManual(manual: boolean): void { this.patch({ manual }) }

  /** Apply the result of an explicit account operation through the ordinary view path. */
  applyExternal(view: RemoteAccountView): void { this.apply(view) }

  /** Whether this flow may still update its current panel. */
  valid(): boolean { return this.operation.valid() }

  private get url(): string | undefined { return this.snapshot.view.attempt?.authorizeUrl }

  private patch(next: { readonly [Key in keyof RemoteSignInSnapshot]?: RemoteSignInSnapshot[Key] | undefined }): void {
    this.snapshotValue = Object.assign(this.snapshotValue, next)
    if (this.operation.valid()) this.changed()
  }

  private apply(view: RemoteAccountView): void {
    const attempt = view.attempt
    const terminal = remoteAccountAttemptTerminal(attempt)
    const stage = view.status === 'credential-stored' && attempt?.phase === 'succeeded' ? 'connected'
      : attempt === null ? this.snapshot.stage === 'starting' ? 'starting' : 'idle'
        : terminal ? 'ended'
          : attempt.phase === 'exchanging' || attempt.phase === 'committing' ? 'finishing'
            : attempt.authorizeUrl === undefined ? 'starting' : 'waiting'
    this.patch({ view, stage, ...stage === 'connected' ? { delivering: false } : {} })
    if (attempt?.authorizeUrl !== undefined) this.linkWaiter?.(attempt.authorizeUrl)
    else if (terminal) this.linkWaiter?.(undefined)
    if (stage === 'connected') {
      this.settleConnected?.(true)
      this.settleConnected = undefined
    } else if (stage === 'ended' && this.ownedAttempt !== undefined && String(attempt?.id) === this.ownedAttempt) {
      this.settleConnected?.(false)
      this.settleConnected = undefined
    }
  }

  private async watch(): Promise<void> {
    try {
      for await (const view of this.operation.client.remote.account.watch(this.operation.signal)) {
        if (!this.operation.valid()) return
        this.apply(view)
      }
    } catch {
      // Detach and panel close end only this local stream, not the Host attempt.
    }
  }

  private awaitLink(): Promise<string | undefined> {
    if (this.linkWaiter !== undefined) return Promise.resolve(undefined)
    return new Promise(resolve => {
      const done = (url: string | undefined): void => {
        if (this.linkTimer !== undefined) clearTimeout(this.linkTimer)
        this.linkTimer = undefined
        this.linkWaiter = undefined
        resolve(url)
      }
      this.linkWaiter = done
      this.linkTimer = setTimeout(() => { done(undefined) }, 15_000)
    })
  }
}

/** Account panel and sign-in flow factory for one feature mount. */
export class RemoteAccountController extends RemoteFeatureController {
  constructor(
    context: RemoteFeatureContext,
    private readonly io: RemoteAccountLocalIO,
    private readonly clientVersion: string,
  ) {
    super(context)
  }

  /** Create a flow for account or onboarding; the caller owns its local disposal. */
  async createSignInFlow(client: HostClient, changed: () => void): Promise<RemoteAccountSignInFlow | undefined> {
    const operation = this.hostOperation(client)
    if (operation === undefined) return undefined
    try {
      const view = await remoteValue(client.remote.account.getState())
      if (!operation.valid()) { operation.dispose(); return undefined }
      return new RemoteAccountSignInFlow(operation, this.io, remoteAccountMetadata(this.context, this.clientVersion), view, changed)
    } catch (error) {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
      return undefined
    }
  }

  /** Open account state, profile, Platform balance, and sign-in controls. */
  async open(client = this.context.hosts.current()?.client ?? this.context.hosts.list()[0]): Promise<void> {
    if (client === undefined) return
    let flow: RemoteAccountSignInFlow | undefined
    let mounted: RemoteMountedPanel | undefined
    let profile: RemoteAccountProfile = null
    let balance: RemoteAccountBalance = null
    let detailSequence = 0
    let timer: ReturnType<typeof setInterval> | undefined
    const refreshDetails = async (): Promise<void> => {
      if (flow === undefined) return
      const generation = ++detailSequence
      if (flow.snapshot.view.status !== 'credential-stored') { profile = null; balance = null; return }
      try {
        const metadata = remoteAccountMetadata(this.context, this.clientVersion)
        const [nextProfile, nextBalance] = await Promise.all([
          remoteValue(client.remote.account.getProfile(metadata)),
          remoteValue(client.remote.account.getBalance(metadata)),
        ])
        if (generation !== detailSequence || mounted === undefined || flow.snapshot.view.status !== 'credential-stored') return
        profile = nextProfile
        balance = nextBalance
        mounted.panel.update(view())
      } catch (error) {
        if (flow !== undefined && generation === detailSequence) this.context.notice.set(remoteErrorMessage(error))
      }
    }
    const view = (): RemotePanelModel => {
      const snapshot = flow?.snapshot
      const account = snapshot?.view
      const attempt = account?.attempt
      const rows: RemotePanelModel['rows'] = [
        { text: account?.status === 'credential-stored' ? this.context.t('Signed in') : this.context.t('Not signed in'), current: account?.status === 'credential-stored' },
        ...profile?.status === 'ready' ? [{ text: profile.value.name ?? profile.value.contact ?? this.context.t('Account') }] : [],
        ...balance?.status === 'ready' ? balance.value.map((wallet: { readonly balance: string, readonly currency: string }) => ({ text: `${this.context.t('Balance')}: ${wallet.balance} ${wallet.currency}` })) : [],
        ...account === undefined ? [] : account.status === 'credential-stored'
          ? [{ id: 'sign-out', text: this.context.t('Sign out') }]
          : snapshot?.stage === 'waiting' || snapshot?.stage === 'finishing'
            ? [
              { id: 'copy-link', text: this.context.t('Copy link') },
              { id: 'manual', text: this.context.t('Other machine') },
              { id: 'restart-sign-in', text: this.context.t('New link') },
              { id: 'cancel-sign-in', text: this.context.t('Cancel') },
            ]
            : [{ id: 'sign-in', text: this.context.t('Sign in') }],
      ]
      const remaining = attempt?.expiresAt === undefined ? undefined : Math.max(0, attempt.expiresAt - Date.now())
      return {
        title: this.context.t('DeepSeek Account'),
        subtitle: snapshot?.transport === 'forwarded' ? 'SSH-forwarded Host callback' : 'Local Host callback',
        rows,
        footer: [
          snapshot?.error,
          attempt?.authorizeUrl !== undefined && (snapshot?.manual || snapshot?.browser === 'failed') ? attempt.authorizeUrl : undefined,
          remaining === undefined ? undefined : this.context.t('expires in {time}', { time: `${Math.ceil(remaining / 1000)}s` }),
          snapshot?.delivering === true ? this.context.t('Signing you in…') : undefined,
          snapshot?.manual || snapshot?.browser === 'failed' ? 'Paste callback with the “callback” field on the next screen (Ctrl+R).' : undefined,
        ].filter((part): part is string => part !== undefined).join('\n'),
        fields: snapshot?.manual || snapshot?.browser === 'failed' ? [{ id: 'callback', label: this.context.t('Callback URL'), kind: 'input', placeholder: 'http://localhost:…/oauth/callback?…' }] : undefined,
        hint: snapshot?.manual || snapshot?.browser === 'failed' ? 'Enter callback · Ctrl+R deliver · Esc close' : '↑↓ select · Enter action · p paste mode · Esc close',
      }
    }
    const run = async (action: () => Promise<void>): Promise<void> => {
      try { await action() }
      catch (error) {
        if (flow !== undefined) this.context.notice.set(remoteErrorMessage(error))
      }
      if (mounted !== undefined && flow !== undefined) mounted.panel.update(view())
    }
    flow = await this.createSignInFlow(client, () => {
      if (mounted === undefined) return
      mounted.panel.update(view())
      void refreshDetails()
    })
    if (flow === undefined) return
    mounted = openRemoteFeaturePanel(this.context, view(), (action, id, values) => {
      if (flow === undefined) return
      if (action === 'accept' && id === 'sign-in') void run(() => flow!.start())
      else if (action === 'accept' && id === 'restart-sign-in') void run(() => flow!.restart())
      else if (action === 'accept' && id === 'cancel-sign-in') void run(() => flow!.cancel())
      else if (action === 'accept' && id === 'copy-link' || action === 'copy') void run(async () => { await flow!.copy(); this.context.notice.set(this.context.t('Sign-in link copied')) })
      else if (action === 'accept' && id === 'manual' || action === 'manual') { flow!.setManual(true); mounted?.panel.update(view()) }
      else if (action === 'accept' && id === 'sign-out') void run(async () => {
        const view = await remoteValue(client.remote.account.signOut(remoteAccountMetadata(this.context, this.clientVersion)))
        flow!.applyExternal(view)
      })
      else if ((action === 'submit' || action === 'refresh') && (snapshotNeedsCallback(flow.snapshot))) void run(async () => {
        const result = await flow!.deliver(values.callback ?? '')
        if (result === 'invalid') throw new Error(this.context.t('Paste the full callback address from the browser address bar'))
        if (result === 'rejected') throw new Error(this.context.t('The callback could not be delivered'))
      })
      else if (action === 'refresh') void refreshDetails()
    }, () => {
      if (timer !== undefined) clearInterval(timer)
      flow?.dispose()
    })
    timer = setInterval(() => {
      if (flow?.snapshot.stage === 'waiting') mounted?.panel.update(view())
    }, 1000)
    flow.onDispose(() => { if (timer !== undefined) clearInterval(timer) })
    await refreshDetails()
  }
}

function snapshotNeedsCallback(snapshot: RemoteSignInSnapshot): boolean {
  return snapshot.manual || snapshot.browser === 'failed'
}
