/**
 * Independent Node assembly of the official dsh HTTP/WebSocket Client object
 * layer. Only Client services cross this module's public interface.
 * @module @ephemeral-ai/mayfly/client/host-client
 */

import { Context } from '@deepseek-ai/cordis'
import {
  installConnection,
  type ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import * as TypertClient from '@deepseek-ai/dsh-typert-registry/client'
import * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { loadClientPlugins, type ClientPlugin } from './bundle.ts'
import { NodeConnectionTransport } from './transport.ts'
import { HostKey, type HostClient } from './types.ts'

/** Configuration for one independently owned remote Host Client. */
export interface CreateHostClientOptions {
  readonly key: HostKey
  readonly startupUrl: string
}

/**
 * Assemble the React-free official Client plugins over authenticated HTTP/WS.
 * @param options - frontend-local Host identity and tokenized dsh startup URL.
 * @returns the shared HostClient contract; no Host Agent, Session, or Cordis object escapes.
 */
export async function createHostClient(options: CreateHostClientOptions): Promise<HostClient> {
  const key = HostKey(options.key)
  const transport = new NodeConnectionTransport(options.startupUrl)
  const ctx = new Context()
  let detaching: Promise<void> | undefined
  try {
    installConnection(ctx, { interactions: 'answer', transport: transport.hooks })
    const handoffs = await loadClientPlugins()
    const plugins: ClientPlugin[] = [
      TypertClient,
      GatewayClient,
      handoffs.remotes,
      handoffs.fileUpload,
      handoffs.sessions,
      handoffs.workspaces,
    ]
    for (const plugin of plugins) {
      await ctx.plugin({ inject: plugin.inject, apply: plugin.apply })
    }
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    const remote = ctx.get('remote') as ClientRemote | undefined
    const sessions = ctx.get('sessions') as ISessions | undefined
    const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
    if (connection === undefined || remote === undefined || sessions === undefined || workspaces === undefined) {
      throw new Error('Host Client assembly did not provide its object layer')
    }
    return {
      key,
      connection,
      remote,
      sessions,
      workspaces,
      detach() {
        detaching ??= (async () => {
          const transportClosed = transport.detach()
          try {
            await ctx.fiber.dispose()
          } finally {
            await transportClosed
          }
        })()
        return detaching
      },
    }
  } catch (error) {
    const transportClosed = transport.detach()
    try {
      await ctx.fiber.dispose()
    } finally {
      await transportClosed
    }
    throw error
  }
}
