import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRemoteFrontend } from './remote/runtime.ts'

interface EndpointEnvironment {
  readonly id: string
  readonly url: string
  readonly token: string
}

function endpoint(): EndpointEnvironment {
  const raw = process.env.MAYFLY_ENDPOINT
  if (raw === undefined) throw new Error('MAYFLY_ENDPOINT is required')
  const value = JSON.parse(raw) as Partial<EndpointEnvironment>
  if (typeof value.id !== 'string' || typeof value.url !== 'string' || typeof value.token !== 'string') {
    throw new Error('MAYFLY_ENDPOINT must contain id, url, and token')
  }
  return { id: value.id, url: value.url, token: value.token }
}

function startupUrl(value: EndpointEnvironment): string {
  const url = new URL(value.url)
  url.searchParams.set('token', value.token)
  return url.href
}

export function sanitized(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(/([?&]token=)[^&\s]+/giu, '$1<redacted>')
}

/** Execute the independent Frontend from the launcher's credential-carrying environment. */
export async function main(): Promise<void> {
  const value = endpoint()
  await runRemoteFrontend({
    startupUrl: startupUrl(value),
    hostId: value.id,
    ...(process.env.MAYFLY_SESSION_ID === undefined ? {} : { sessionId: process.env.MAYFLY_SESSION_ID }),
    ...(process.env.MAYFLY_TASK === undefined ? {} : { task: process.env.MAYFLY_TASK }),
    ...(process.env.MAYFLY_CWD === undefined ? {} : { cwd: process.env.MAYFLY_CWD }),
  })
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  main().catch((error: unknown) => {
    process.stderr.write(`mayfly remote: ${sanitized(error)}\n`)
    process.exitCode = 1
  })
}
