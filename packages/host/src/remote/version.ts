/** Package-derived facts shared by the Host handshake and build. @module */
import { createRequire } from 'node:module'

// Self-reference resolves the same published manifest from source and bundled
// entries. Reading it avoids a second version that release tooling can miss.
const manifest = createRequire(import.meta.url)('@ephemeral-ai/mayfly-host/package.json') as {
  readonly version: string
  readonly peerDependencies: Readonly<Record<string, string>>
}

export const hostVersion = manifest.version
export const requiredDshVersion = manifest.peerDependencies['@deepseek-ai/dsh-agent']!
