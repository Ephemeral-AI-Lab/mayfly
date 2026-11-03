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
  ctx.effect(() => () => { active = false })
  const print = (): void => {
    if (active) console.log(`mayfly host: ${authenticatedMayflyHostUrl(ctx)}`)
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
