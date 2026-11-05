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
import { buildAccountPanel } from '../../components/account-panel.ts'
import type { MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'

type OfficialValue<T> = T extends Promise<RemoteResult<infer Value>> ? Value : never

/** Official safe account projection. */
export type RemoteAccountView = OfficialValue<ReturnType<HostClient['remote']['account']['getState']>>
/** Official request identity supplied by the local UI. */
type RemoteAccountClientMetadata = Parameters<HostClient['remote']['account']['startSignIn']>[0]

/** Local presentation of one sign-in flow. */
interface RemoteSignInSnapshot {
  readonly view: RemoteAccountView
  readonly stage: 'idle' | 'starting' | 'waiting' | 'finishing' | 'connected' | 'ended'
  readonly browser: 'pending' | 'opened' | 'failed'
  readonly manual: boolean
  readonly delivering: boolean
  readonly callbackOrigin?: string | undefined
  readonly callbackPort?: number | undefined
  readonly transport: 'loopback' | 'forwarded'
  readonly error?: string | undefined
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
  const expected = remoteAccountCallbackOrigin(origin)
  if (expected === undefined || url.origin !== new URL(expected.origin).origin || url.pathname !== '/oauth/callback' || url.username || url.password) return undefined
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
    locale: context.presentation.snapshot.locale.split('-')[0]!,
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
    const callback = remoteAccountCallbackOrigin(io.callbackOrigin(operation.client))
    this.snapshotValue = {
      view: initial,
      stage: initial.status === 'credential-stored' ? 'connected' : 'idle',
      browser: initial.attempt?.authorizeUrl === undefined ? 'pending' : 'opened',
      manual: false,
      delivering: false,
      transport: operation.client.remote.$host.isLoopback ? 'loopback' : 'forwarded',
      ...callback === undefined ? {} : { callbackOrigin: callback.origin, callbackPort: callback.port },
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
    if (!this.operation.valid()) return
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
    if (!this.operation.valid()) return
    const attempt = this.snapshot.view.attempt
    if (attempt === null || remoteAccountAttemptTerminal(attempt)) return
    const view = await remoteValue(this.operation.client.remote.account.cancelSignIn(attempt.id))
    if (this.operation.valid()) this.apply(view)
  }

  /** Explicitly retire the current attempt and request a fresh link. */
  async restart(): Promise<void> {
    await this.cancel()
    if (!this.operation.valid()) return
    this.ownedAttempt = undefined
    await this.start()
  }

  /** Copy the current authorize URL through the local adapter. */
  async copy(): Promise<void> {
    if (!this.operation.valid()) return
    const url = this.snapshot.view.attempt?.authorizeUrl
    if (url === undefined) throw new Error('No sign-in link is available')
    await this.io.copy(url)
  }

  /** Deliver a pasted callback only to the exact configured origin. */
  async deliver(raw: string): Promise<'delivered' | 'invalid' | 'rejected'> {
    if (!this.operation.valid()) return 'rejected'
    const origin = this.snapshot.callbackOrigin
    const location = origin === undefined ? undefined : remoteAccountCallbackLocation(raw, origin)
    if (location === undefined) return 'invalid'
    this.patch({ delivering: true })
    try {
      const response = await this.io.deliverCallback(location, this.operation.signal)
      if (!this.operation.valid()) return 'rejected'
      this.patch({ delivering: response.status < 400 })
      return response.status >= 400 ? 'rejected' : 'delivered'
    } catch (error) {
      if (this.operation.valid()) this.patch({ delivering: false })
      throw error
    }
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

  private patch(next: Partial<RemoteSignInSnapshot>): void {
    if (!this.operation.valid()) return
    this.snapshotValue = { ...this.snapshotValue, ...next }
    this.changed()
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
  async createSignInFlow(client: HostClient, changed: () => void, parent?: AbortSignal): Promise<RemoteAccountSignInFlow | undefined> {
    if (parent?.aborted) return undefined
    const operation = this.hostOperation(client, parent)
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

  /** Open the exact shared account panel over one native watch and local browser handoff. */
  async open(client = this.context.hosts.current()?.client ?? this.context.hosts.active?.() ?? this.context.hosts.list()[0], parent?: AbortSignal): Promise<void> {
    const id = 'mayfly.provider-account.deepseek-account'
    if (parent?.aborted || client === undefined || this.context.ctx.mayflyOverlays.focus(id)) return
    let panel: RemoteBrowserPanel | undefined
    let expiryAttempt: string | undefined
    let expiryTotalMs: number | undefined
    const flow = await this.createSignInFlow(client, () => { panel?.refresh() }, parent)
    if (flow === undefined) return
    const source = [{ resourceId: id, revision: 1 }]
    const view = () => {
      const snapshot = flow.snapshot
      const attempt = snapshot.view.attempt
      if (attempt?.expiresAt !== undefined && attempt.id !== expiryAttempt) {
        expiryAttempt = attempt.id
        expiryTotalMs = Math.max(0, attempt.expiresAt - Date.now())
      }
      return buildAccountPanel(snapshot.view, this.context.t, remoteAccountCallbackOrigin(this.io.callbackOrigin(client)) !== undefined, snapshot.callbackPort, {
        now: Date.now(), launching: snapshot.browser === 'pending',
        focusPaste: snapshot.browser === 'failed', pasteOpen: snapshot.manual,
        delivering: snapshot.delivering,
        ...expiryTotalMs === undefined ? {} : { expiryTotalMs },
      })
    }
    panel = openRemoteBrowser(this.context, {
      id, scope: { kind: 'app', targetId: 'account/deepseek-account' },
      isCurrent: () => flow.valid(), view,
      action: async (event, context): Promise<MayflyUiActionReply> => {
        if (context.signal.aborted || !flow.valid()) return { kind: 'cancelled' }
        try {
          if (event.kind === 'activate') {
            if (event.actionId === 'copy-link') {
              await flow.copy()
              return flow.valid() ? { kind: 'completed', feedback: { severity: 'success', message: this.context.t('Sign-in link copied') } } : { kind: 'cancelled' }
            }
            if (event.actionId === 'show-paste') flow.setManual(true)
            else if (event.actionId === 'sign-in') await flow.start()
            else if (event.actionId === 'restart-sign-in') await flow.restart()
            else if (event.actionId === 'sign-out') {
              const next = await remoteValue(client.remote.account.signOut(remoteAccountMetadata(this.context, this.clientVersion)))
              if (flow.valid()) flow.applyExternal(next)
            }
          } else if (event.kind === 'submit' && event.submission.actionId === 'deliver-callback') {
            const raw = event.submission.forms.find(form => form.formId === 'callback-paste')?.fields.find(field => field.id === 'callback-url')?.value
            const delivered = await flow.deliver(typeof raw === 'string' ? raw : '')
            if (!flow.valid()) return { kind: 'cancelled' }
            if (delivered === 'invalid') return { kind: 'invalid', errors: [{ pagePath: [], formId: 'callback-paste', fieldId: 'callback-url', message: this.context.t('Paste the full callback address from the browser address bar') }] }
            if (delivered === 'rejected') return { kind: 'failed', message: this.context.t('The pasted link was not accepted — copy the full address bar URL and try again') }
            return { kind: 'accepted', node: view(), source, feedback: { severity: 'success', message: this.context.t('Callback delivered — finishing sign-in') } }
          }
          if (!flow.valid()) return { kind: 'cancelled' }
          panel?.refresh()
          return { kind: 'completed' }
        } catch (error) {
          return flow.valid() ? { kind: 'failed', message: remoteErrorMessage(error) } : { kind: 'cancelled' }
        }
      },
      onClosed: () => flow.dispose(),
    })
    flow.onDispose(() => { panel?.close() })
    const timer = setInterval(() => {
      if (flow.valid() && flow.snapshot.stage === 'waiting') panel?.refresh()
    }, 1000)
    flow.onDispose(() => { clearInterval(timer) })
  }
}
