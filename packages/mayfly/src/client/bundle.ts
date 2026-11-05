/**
 * Execute official React-free Client handoffs with a lexical window and the
 * module-table externals they declare. No process global is installed. The
 * handoff format belongs to the Harness line in the manifest; a bundle that
 * breaks it fails with its installed version and the supported line.
 * @module @ephemeral-ai/mayfly/client/bundle
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'
import * as Cordis from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import * as GatewayClient from '@deepseek-ai/dsh-api-gateway/client'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import * as zod from 'zod'

/** Cordis entry shape shared by Node entries and materialized handoffs. */
export interface ClientPlugin {
  readonly inject: string[]
  readonly apply: (ctx: Context) => unknown
}

interface BundleRegistration {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

interface BundleWindow {
  readonly __ModuleLoader__: {
    load(registration: BundleRegistration): void
  }
}

const require = createRequire(import.meta.url)
/** The Harness line whose Client handoff format this loader reads. */
const SUPPORTED_HARNESS = (require('@ephemeral-ai/mayfly/package.json') as { dependencies: Record<string, string> }).dependencies['@deepseek-ai/dsh-session']!

const externals: Readonly<Record<string, unknown>> = {
  '@deepseek-ai/cordis': Cordis,
  '@deepseek-ai/dsh-api-gateway/client': GatewayClient,
  '@deepseek-ai/dsh-client-store': ClientStore,
  zod,
}

/** Load the four static Client handoffs without evaluating them as page scripts. */
export async function loadClientPlugins(): Promise<{
  remotes: ClientPlugin
  fileUpload: ClientPlugin
  sessions: ClientPlugin
  workspaces: ClientPlugin
}> {
  const [remotes, fileUpload, sessions, workspaces] = await Promise.all([
    loadClientPlugin('@deepseek-ai/dsh-api-remotes/client', '@deepseek-ai/dsh-api-remotes'),
    loadClientPlugin('@deepseek-ai/dsh-client-file-upload/client', '@deepseek-ai/dsh-client-file-upload'),
    loadClientPlugin('@deepseek-ai/dsh-api-session-controller/client', '@deepseek-ai/dsh-api-session-controller'),
    loadClientPlugin('@deepseek-ai/dsh-api-workspace-controller/client', '@deepseek-ai/dsh-api-workspace-controller'),
  ])
  return { remotes, fileUpload, sessions, workspaces }
}

async function loadClientPlugin(specifier: string, id: string): Promise<ClientPlugin> {
  const filename = fileURLToPath(import.meta.resolve(specifier))
  const source = await readFile(filename, 'utf8')
  let registration: BundleRegistration | undefined
  const evaluate = runInThisContext(`(function (window) {\n${source}\n})`, { filename }) as (window: BundleWindow) => void
  evaluate({
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  })
  if (registration?.id !== id) throw bundleError(id, 'did not register its entry')
  const exports = registration.factory(specifier => {
    if (!Object.hasOwn(externals, specifier)) throw bundleError(id, `requested undeclared external ${JSON.stringify(specifier)}`)
    return externals[specifier]
  })
  if (!Array.isArray(exports.inject) || !exports.inject.every(value => typeof value === 'string') || typeof exports.apply !== 'function') {
    throw bundleError(id, 'did not export its Cordis entry')
  }
  return {
    inject: exports.inject,
    apply: exports.apply as ClientPlugin['apply'],
  }
}

/** A handoff-format fault, naming the installed bundle version and the Harness line this loader supports. */
function bundleError(id: string, problem: string): Error {
  let installed = 'of an unknown version'
  try {
    installed = (require(`${id}/package.json`) as { version: string }).version
  } catch {
    // The version only enriches the message; the fault is reported either way.
  }
  return new Error(`Client bundle ${id} ${installed} ${problem}; Mayfly reads the handoff format of Harness ${SUPPORTED_HARNESS}`)
}
