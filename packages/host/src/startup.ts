/**
 * Authenticated Mayfly Host URL output without a browser handoff.
 *
 * @module @ephemeral-ai/mayfly-host/startup
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-web-app'

/** Stable Cordis plugin name. */
export const name = 'mayfly-host-startup'

/** Services required to advertise the authenticated Host URL. */
export const inject = ['webApp', 'connection']

/**
 * Build the one-time login URL for this Host process.
 * @param ctx - Host context with the Web runtime and Connection services.
 * @returns the advertised URL carrying Connection's process token.
 */
export function authenticatedMayflyHostUrl(ctx: Context): string {
  return ctx.connection.authenticatedUrl(ctx.webApp.getAdvertisedUrl())
}

/**
 * Print the authenticated URL after Loader settlement, or immediately in a
 * hand-built tree without a Loader.
 * @param ctx - Host startup context.
 */
export function apply(ctx: Context): void {
  let active = true
  const managed = process.env.MAYFLY_MANAGED_HOST === '1' && process.send !== undefined
  const stop = (message: unknown): void => {
    if (active && typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'mayfly-stop') {
      const exit = ctx.get('appExit') as ((code: number) => void) | undefined
      exit?.(0)
    }
  }
  const disconnected = (): void => stop({ type: 'mayfly-stop' })
  ctx.effect(() => {
    if (managed) {
      process.on('message', stop)
      process.on('disconnect', disconnected)
    }
    return () => {
      active = false
      process.off('message', stop)
      process.off('disconnect', disconnected)
    }
  })
  const print = (): void => {
    if (!active) return
    if (managed) {
      if (process.connected) process.send!({ type: 'mayfly-ready', url: authenticatedMayflyHostUrl(ctx) })
    } else console.log(`mayfly host: ${authenticatedMayflyHostUrl(ctx)}`)
  }
  const settled = ctx.get('loader')?.await()
  if (settled === undefined) {
    print()
    return
  }
  void settled.then(print).catch((error: unknown) => {
    void error
    // Profile boot reports Loader failure; no readiness URL is printed.
  })
}
