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
import type { FileUploadService } from '@deepseek-ai/dsh-client-file-upload/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { loadClientPlugins, type ClientPlugin } from './bundle.ts'
import { NodeConnectionTransport } from './transport.ts'
import { HostKey, type HostClient } from './types.ts'
import { withNodeFileUpload } from './upload.ts'

/** Generated Client-safe Remote contribution supplied by the integration layer. */
export type HostRemoteContribution = Parameters<ClientRemote['$mount']>[0]

/** Configuration for one independently owned remote Host Client. */
export interface CreateHostClientOptions {
  readonly key: HostKey
  readonly startupUrl: string
  /** Optional generated mayflyHost artifact mounted after official api-remotes. */
  readonly mayflyHost?: HostRemoteContribution
}

/**
 * Assemble the React-free official Client plugins over authenticated HTTP/WS.
 * @param options - frontend-local Host identity, tokenized startup URL, and optional generated Host Remote.
 * @returns the shared HostClient contract; no Host Agent, Session, or Cordis object escapes.
 */
export async function createHostClient(options: CreateHostClientOptions): Promise<HostClient> {
  const key = HostKey(options.key)
  const transport = new NodeConnectionTransport(options.startupUrl)
  const ctx = new Context()
  let detaching: Promise<void> | undefined
  try {
    installConnection(ctx, {
      interactions: 'answer',
      location: { hostname: transport.hostname },
      transport: transport.hooks,
    })
    const installed = ctx.get('connection') as ConnectionHandle | undefined
    if (installed === undefined) throw new Error('Host Client assembly did not provide its Connection')
    const connection = superviseConnection(ctx, installed, transport)

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
      const install = async (): Promise<void> => {
        await ctx.plugin({ inject: plugin.inject, apply: plugin.apply })
      }
      if (plugin === handoffs.fileUpload) {
        await withNodeFileUpload((input, init) => transport.upload(input, init), install)
      } else {
        await install()
      }
      if (plugin === handoffs.remotes && options.mayflyHost !== undefined) {
        const remote = ctx.get('remote') as ClientRemote | undefined
        if (remote === undefined) throw new Error('Host Client assembly did not provide its Remote mount')
        await remote.$mount(options.mayflyHost)
      }
    }

    const remote = ctx.get('remote') as ClientRemote | undefined
    const fileUpload = ctx.get('fileUpload') as FileUploadService | undefined
    const sessions = ctx.get('sessions') as ISessions | undefined
    const workspaces = ctx.get('workspaces') as IWorkspaces | undefined
    if (remote === undefined || fileUpload === undefined || sessions === undefined || workspaces === undefined) {
      throw new Error('Host Client assembly did not provide its object layer')
    }
    return {
      key,
      connection,
      remote,
      fileUpload,
      sessions,
      workspaces,
      state: transport.state,
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

function superviseConnection(
  ctx: Context,
  connection: ConnectionHandle,
  transport: NodeConnectionTransport,
): ConnectionHandle {
  let stopLoop: (() => void) | undefined
  const supervised: ConnectionHandle = {
    ...connection,
    start(sinks, config) {
      if (transport.terminalError !== undefined) return { stop() {} }
      const loop = connection.start({
        ...sinks,
        onStateChange(state) {
          transport.connectionChanged(state)
          sinks.onStateChange?.(state)
        },
      }, config)
      stopLoop = () => { loop.stop() }
      if (transport.terminalError !== undefined) loop.stop()
      return { stop: () => { loop.stop() } }
    },
  }
  ctx.set('connection', supervised)
  const removeTerminalListener = transport.onTerminal(() => { stopLoop?.() })
  ctx.effect(() => () => { removeTerminalListener() }, 'mayfly.client.connection.lifecycle')
  return supervised
}
