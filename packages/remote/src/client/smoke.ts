/**
 * Headless consumer proving Session list, create, and open through the shared
 * HostClient contract without starting a model turn.
 * @module @ephemeral-ai/mayfly/client/smoke
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createHostClient, type CreateHostClientOptions } from './host-client.ts'
import type { SessionRef } from './types.ts'

/** Inputs for the side-effect-limited headless Session smoke. */
export interface HostClientSmokeOptions extends CreateHostClientOptions {
  readonly cwd?: string
}

/** Serializable evidence returned after the Client has detached. */
export interface HostClientSmokeResult {
  readonly listedBefore: number
  readonly created: SessionRef
  readonly opened: SessionRef
  readonly listedAfter: number
}

/**
 * List, create, refresh, and fully open one Host Session, then detach locally.
 * @param options - Host connection and optional new-Session working directory.
 * @returns Host-namespaced identities and list counts; no Client object is retained.
 */
export async function smokeHostClient(options: HostClientSmokeOptions): Promise<HostClientSmokeResult> {
  const client = await createHostClient(options)
  try {
    await client.sessions.refresh()
    const listedBefore = client.sessions.list.getSnapshot().ids.length
    const sessionId: SessionId = options.cwd === undefined
      ? await client.sessions.create()
      : await client.sessions.create({ cwd: options.cwd })
    await client.sessions.refresh()
    const listedAfter = client.sessions.list.getSnapshot().ids.length
    const opened = await client.sessions.using(
      sessionId,
      { source: 'controllerOperation' },
      reference => reference.binding.sessionId,
    )
    return {
      listedBefore,
      created: { host: client.key, sessionId },
      opened: { host: client.key, sessionId: opened },
      listedAfter,
    }
  } finally {
    await client.detach()
  }
}
