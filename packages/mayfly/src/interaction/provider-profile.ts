/** Provider profile identities and endpoint conventions shared by configuration workflows.
 * @module @ephemeral-ai/mayfly/interaction/provider-profile
 */
export function deriveKeyRef(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

export function normalizeBaseURL(protocol: string, entered: string, listingBase?: string): string {
  const trimmed = entered.replace(/\/+$/, '')
  if (protocol === 'anthropic-messages') return trimmed.replace(/\/v1$/, '')
  if (listingBase === `${trimmed}/v1`) return listingBase
  return trimmed
}

export interface ProviderProfile {
  readonly displayName?: string
  readonly api?: string
  readonly baseURL?: string
  readonly apiKeyEnv?: string
  readonly models?: readonly { readonly id?: unknown, readonly [key: string]: unknown }[]
  readonly reasoning?: string
}
