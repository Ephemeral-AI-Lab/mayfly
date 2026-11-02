/** Environment-authenticated independent terminal entry and redacted CLI diagnostics. @module */
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELP = `Mayfly independent terminal UI

Usage: mayfly [options] [task ...]

Options:
  --host <url>       Use a non-secret HTTP(S) Host URL; its token still comes from MAYFLY_DSH_STARTUP_URL
  --resume <id>      Resume a Host Session (alias: --session <id>)
  --cwd <path>       Working directory for a newly created Host Session
  -V, --version      Print the Mayfly version
  -h, --help         Show this help

Environment:
  MAYFLY_DSH_STARTUP_URL  Authenticated dsh Host startup URL (required)
  MAYFLY_SESSION_ID       Session to resume when --resume/--session is absent
  MAYFLY_CWD              Working directory when --cwd is absent
  MAYFLY_TASK             Task to submit when no positional task is supplied

Start dsh separately with the mayfly-host profile. Mayfly neither starts nor stops the Host.
Tokens and cookies are accepted only through the environment, never through arguments.
`

interface CliOptions {
  readonly action: 'help' | 'run' | 'version'
  readonly host?: string
  readonly sessionId?: string
  readonly cwd?: string
  readonly task?: string
}

function credentialArgument(value: string): boolean {
  return /^--(?:token|cookie)(?:=|$)/iu.test(value)
    || /[?&](?:token|cookie)=/iu.test(value)
    || /(?:^|\s)(?:token|cookie)=/iu.test(value)
    || /(?:cookie|authorization)\s*:/iu.test(value)
    || /:\/\/[^/\s:@]+:[^/\s@]+@/u.test(value)
}

function optionValue(argv: readonly string[], index: number, name: string): { readonly value: string, readonly next: number } {
  const argument = argv[index]!
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1)
    if (value === '') throw new Error(`${name} requires a value`)
    return { value, next: index }
  }
  const value = argv[index + 1]
  if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`${name} requires a value`)
  return { value, next: index + 1 }
}

function parseArgv(argv: readonly string[]): CliOptions {
  if (argv.some(credentialArgument)) {
    throw new Error('Credentials are not accepted as arguments; put the authenticated Host URL in MAYFLY_DSH_STARTUP_URL')
  }
  let host: string | undefined
  let sessionId: string | undefined
  let cwd: string | undefined
  const task: string[] = []
  let positional = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (positional) {
      task.push(argument)
      continue
    }
    if (argument === '--') {
      positional = true
      continue
    }
    if (argument === '-V' || argument === '--version') return { action: 'version' }
    if (argument === '-h' || argument === '--help') return { action: 'help' }
    if (argument === '--host' || argument.startsWith('--host=')) {
      const option = optionValue(argv, index, '--host')
      host = option.value
      index = option.next
      continue
    }
    if (argument === '--resume' || argument.startsWith('--resume=') || argument === '--session' || argument.startsWith('--session=')) {
      const name = argument.startsWith('--session') ? '--session' : '--resume'
      const option = optionValue(argv, index, name)
      sessionId = option.value
      index = option.next
      continue
    }
    if (argument === '--cwd' || argument.startsWith('--cwd=')) {
      const option = optionValue(argv, index, '--cwd')
      cwd = option.value
      index = option.next
      continue
    }
    if (argument.startsWith('-')) throw new Error('Unknown option; run mayfly --help')
    task.push(argument)
  }
  return {
    action: 'run',
    ...(host === undefined ? {} : { host }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(task.length === 0 ? {} : { task: task.join(' ') }),
  }
}

function hostOrigin(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('--host must be a non-secret HTTP(S) URL without credentials, query, or fragment')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('--host must be a non-secret HTTP(S) URL without credentials, query, or fragment')
  }
  return url
}

function startupUrl(host: string | undefined): string {
  const raw = process.env.MAYFLY_DSH_STARTUP_URL
  if (raw === undefined || raw === '') {
    throw new Error('MAYFLY_DSH_STARTUP_URL is required; start dsh with the mayfly-host profile and set its authenticated startup URL')
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('MAYFLY_DSH_STARTUP_URL must be an HTTP(S) URL with exactly one non-empty token')
  }
  const tokens = url.searchParams.getAll('token')
  const token = tokens[0] ?? ''
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || tokens.length !== 1 || token === '') {
    throw new Error('MAYFLY_DSH_STARTUP_URL must be an HTTP(S) URL with exactly one non-empty token')
  }
  if (host === undefined) return url.href
  const selected = hostOrigin(host)
  selected.searchParams.set('token', token)
  return selected.href
}

function version(): string {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('Mayfly Remote package has no version; reinstall @ephemeral-ai/mayfly-cli')
  return manifest.version
}

/** Redact startup credentials and credential-shaped fields from ordinary-terminal diagnostics. */
export function sanitized(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  const secrets = new Set<string>()
  const startup = process.env.MAYFLY_DSH_STARTUP_URL
  if (startup !== undefined && startup !== '') {
    secrets.add(startup)
    try {
      const url = new URL(startup)
      secrets.add(url.href)
      const token = url.searchParams.get('token')
      if (token !== null && token !== '') {
        secrets.add(token)
        secrets.add(encodeURIComponent(token))
      }
    } catch {
      // The parser reports an invalid startup URL without echoing it.
    }
  }
  for (const secret of [...secrets].filter(value => value !== '').sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, '<redacted>')
  }
  return message
    .replaceAll(/([?&](?:token|cookie)=)[^&\s]+/giu, '$1<redacted>')
    .replaceAll(/((?:cookie|authorization)\s*:\s*)[^\r\n]+/giu, '$1<redacted>')
}

/** Execute the independent Frontend using environment credentials and Remote-only command-line options. */
export async function main(): Promise<void> {
  const options = parseArgv(process.argv.slice(2))
  if (options.action === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (options.action === 'version') {
    process.stdout.write(`mayfly ${version()}\n`)
    return
  }
  const sessionId = options.sessionId ?? process.env.MAYFLY_SESSION_ID
  const task = options.task ?? process.env.MAYFLY_TASK
  const cwd = options.cwd ?? process.env.MAYFLY_CWD
  const authenticatedUrl = startupUrl(options.host)
  const { runRemoteFrontend } = await import('./remote/runtime.ts')
  await runRemoteFrontend({
    startupUrl: authenticatedUrl,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(task === undefined ? {} : { task }),
    ...(cwd === undefined ? {} : { cwd }),
  })
}

/** Run the bin and report a sanitized ordinary-terminal failure without terminating the Host. */
export async function run(): Promise<void> {
  try {
    await main()
  } catch (error: unknown) {
    process.stderr.write(`mayfly: ${sanitized(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  await run()
}
