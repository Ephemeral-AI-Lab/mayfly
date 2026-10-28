/**
 * Mayfly-specific Host Remote service. Standard Harness capabilities remain
 * owned by their native Remote services.
 *
 * @module @ephemeral-ai/mayfly-host/remote/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from 'zod'
import type { MayflyHostCapabilities } from '../types.ts'
import { MAYFLY_HOST_CAPABILITIES } from './capabilities.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Mayfly Host version and feature handshake. */
    mayflyHost: MayflyHostService
  }
}

/** Host service backing the generated `ctx.remote.mayflyHost` namespace. */
export class MayflyHostService extends TypertRemoteService {
  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'mayflyHost')
  }

  /**
   * Return the protocol, package, dsh versions, and implemented feature keys.
   * @returns the immutable capabilities implemented by this Host package.
   */
  @Remote('capabilities')
  capabilities(): MayflyHostCapabilities {
    return MAYFLY_HOST_CAPABILITIES
  }
}

export default MayflyHostService
