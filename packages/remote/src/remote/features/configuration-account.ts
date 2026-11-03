/**
 * Remote-process account transport I/O: loopback callback origins, platform
 * browser opening, local clipboard delivery, and callback POSTs restricted to
 * the configured origin. Copied or opened content is never logged.
 * @module @ephemeral-ai/mayfly/remote/features/configuration-account
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { HostClient } from '../../client/types.ts'
import { copyLocalText } from '../local/clipboard.ts'
import type { RemoteAccountLocalIO } from './contracts.ts'

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']
const OPEN_GRACE_MS = 1_500
const CALLBACK_TIMEOUT_MS = 30_000

function openerFor(platform: NodeJS.Platform, url: string): readonly [string, readonly string[]] {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]]
  return ['xdg-open', [url]]
}

/** Node-process account I/O owned by one configuration composition mount. */
export class RemoteAccountNodeIO implements RemoteAccountLocalIO {
  private readonly lifetime = new AbortController()

  /** @param injectedCopy - integration-owned clipboard hook preferred over local tools. */
  constructor(private readonly injectedCopy?: (text: string) => Promise<void>) {}

  /** Loopback HTTP callback origin derived from the Client's configured origin. */
  callbackOrigin(client: HostClient): string | undefined {
    let url: URL
    try { url = new URL(client.origin) } catch { return undefined }
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(url.hostname)) return undefined
    // URL already rejects malformed and out-of-range ports. An omitted or
    // default HTTP port is not the explicit loopback callback listener.
    if (url.port === '' || url.port === '0') return undefined
    return `http://localhost:${url.port}`
  }

  /** Open the system browser detached; success is judged within the grace window. */
  openBrowser(url: string): Promise<boolean> {
    if (this.lifetime.signal.aborted) return Promise.resolve(false)
    if (process.platform !== 'darwin' && process.platform !== 'win32'
      && process.env.DISPLAY === undefined && process.env.WAYLAND_DISPLAY === undefined) return Promise.resolve(false)
    const opener = openerFor(process.platform, url)
    return new Promise(resolve => {
      let settled = false
      let child: ChildProcess | undefined
      const finish = (opened: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.lifetime.signal.removeEventListener('abort', abort)
        resolve(opened)
      }
      const timer = setTimeout(() => { finish(true) }, OPEN_GRACE_MS)
      const abort = (): void => { finish(false) }
      this.lifetime.signal.addEventListener('abort', abort, { once: true })
      try {
        child = spawn(opener[0], [...opener[1]], { detached: true, stdio: 'ignore', windowsHide: true })
      } catch {
        finish(false)
        return
      }
      child.once('error', () => { finish(false) })
      child.unref()
    })
  }

  /** Copy through the injected hook, then OSC52 and verified local clipboard tools. */
  async copy(text: string): Promise<void> {
    if (this.injectedCopy !== undefined) {
      await this.injectedCopy(text)
      return
    }
    await copyLocalText(text, this.lifetime.signal)
  }

  /** Deliver one pasted callback to its exact configured origin without following redirects. */
  async deliverCallback(url: URL, signal: AbortSignal): Promise<{ readonly status: number }> {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(CALLBACK_TIMEOUT_MS)]),
    })
    await response.body?.cancel().catch(() => {})
    return { status: response.status }
  }

  /** Cancel every open, copy, and callback still owned by this mount. */
  dispose(): void {
    this.lifetime.abort()
  }
}
