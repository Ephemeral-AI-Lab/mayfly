/**
 * Generated mayflyHost attachment, capability validation, and presentation adaptation.
 * @module @ephemeral-ai/mayfly/remote/host-composition
 */

import { TYPERT_REMOTE } from '@ephemeral-ai/mayfly-host/remote'
import type { MayflyHostCapabilities } from '@ephemeral-ai/mayfly-host/types'
import { createHostClient } from '../client/host-client.ts'
import type { HostClient, HostKey, SessionRef } from '../client/types.ts'
import { mountMayflyHostRemote } from '../frontend/host-mount.ts'
import type { RemoteToolPresentationGeneration } from '../frontend/tool-presentations.ts'
import { mayflyHostRemote } from '../frontend/host-mount.ts'

const PROTOCOL_VERSION = 1
const HOST_VERSION = '0.1.4-rc.2'
const DSH_VERSION = '0.2.2-alpha.2'
const REQUIRED_FEATURES = ['mayflyConversation', 'presentTools'] as const
const capabilities = new WeakMap<HostClient, MayflyHostCapabilities>()

/** Mount only the generated client-safe Host artifact and validate this composition's required base. */
export async function attachMayflyHostClient(key: HostKey, startupUrl: string): Promise<HostClient> {
  const client = await createHostClient({ key, startupUrl })
  try {
    await mountMayflyHostRemote(client, TYPERT_REMOTE)
    const result = await mayflyHostRemote(client).capabilities()
    if (!result.ok) throw new Error(`Mayfly Host capabilities request failed: ${result.error.message}`)
    validateCapabilities(result.value)
    capabilities.set(client, result.value)
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
  const capability = capabilities.get(client)
  if (capability === undefined) throw new Error(`Mayfly Host "${ref.host}" has no validated capabilities`)
  return {
    presentationRevision: `${String(capability.protocolVersion)}:${capability.hostVersion}:${capability.requiredDshVersion}`,
    present: (request, signal) => mayflyHostRemote(client).presentTools(request, signal),
  }
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
