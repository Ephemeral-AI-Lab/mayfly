/**
 * Generated mayflyHost attachment, capability validation, and presentation adaptation.
 * @module @ephemeral-ai/mayfly/app/host-composition
 */

import { createRequire } from 'node:module'
import { TYPERT_REMOTE } from '@ephemeral-ai/mayfly-host/remote'
import type { MayflyHostCapabilities } from '@ephemeral-ai/mayfly-host/types'
import { createHostClient } from '../client/host-client.ts'
import type { HostClient, HostKey, SessionRef } from '../client/types.ts'
import { mountMayflyHostRemote } from '../hosts/host-mount.ts'
import { createMayflyToolPresentationResolver, type RemoteToolPresentationGeneration, type RemoteToolPresentationResolver } from '../hosts/tool-presentations.ts'
import { mayflyHostRemote } from '../hosts/host-mount.ts'

const PROTOCOL_VERSION = 1
const manifest = createRequire(import.meta.url)('@ephemeral-ai/mayfly/package.json') as {
  readonly version: string
  readonly dependencies: Readonly<Record<string, string>>
}
const HOST_VERSION = manifest.version
const DSH_VERSION = manifest.dependencies['@deepseek-ai/dsh-session']!
const REQUIRED_FEATURES = ['mayflyConversation', 'presentTools'] as const
const PRESENTER = Symbol('mayfly.validatedPresenter')
interface ValidatedHostClient extends HostClient { readonly [PRESENTER]: RemoteToolPresentationResolver }

/** Mount only the generated client-safe Host artifact and validate this composition's required base. */
export async function attachMayflyHostClient(key: HostKey, startupUrl: string): Promise<HostClient> {
  const client = await createHostClient({ key, startupUrl })
  try {
    await mountMayflyHostRemote(client, TYPERT_REMOTE)
    const result = await mayflyHostRemote(client).capabilities()
    if (!result.ok) throw new Error(`Mayfly Host capabilities request failed: ${result.error.message}`)
    validateCapabilities(result.value)
    Object.defineProperty(client, PRESENTER, { value: createMayflyToolPresentationResolver(client,
      `${String(result.value.protocolVersion)}:${result.value.hostVersion}:${result.value.requiredDshVersion}`,
    ) })
    return client
  } catch (error) {
    await client.detach()
    throw error
  }
}

/** Resolve the validated Host presenter for one exact Session, without consulting a Host Agent or Session object. */
export function resolveMayflyToolPresentation(
  clients: () => readonly HostClient[],
  ref: SessionRef,
): RemoteToolPresentationGeneration {
  const client = clients().find(candidate => candidate.key === ref.host)
  if (client === undefined) throw new Error(`Mayfly Host "${ref.host}" is not attached for tool presentation`)
  const resolver = (client as Partial<ValidatedHostClient>)[PRESENTER]
  if (resolver === undefined) throw new Error(`Mayfly Host "${ref.host}" has no validated capabilities`)
  return resolver(ref)
}

function validateCapabilities(value: MayflyHostCapabilities): void {
  const mismatches: string[] = []
  if (value.protocolVersion !== PROTOCOL_VERSION) mismatches.push(`protocol ${String(value.protocolVersion)} (required ${String(PROTOCOL_VERSION)})`)
  if (value.hostVersion !== HOST_VERSION) mismatches.push(`Host version ${value.hostVersion} (required ${HOST_VERSION})`)
  if (value.requiredDshVersion !== DSH_VERSION) mismatches.push(`dsh version ${value.requiredDshVersion} (required ${DSH_VERSION})`)
  const missing = REQUIRED_FEATURES.filter(feature => !value.features.includes(feature))
  if (missing.length > 0) mismatches.push(`missing features: ${missing.join(', ')}`)
  if (mismatches.length > 0) throw new Error(`Unsupported Mayfly Host capabilities: ${mismatches.join('; ')}`)
}
