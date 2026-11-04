/** Unified terminal and local server command grammar. @module */
export const actions = ['start', 'stop', 'restart', 'status', 'logs', 'enable', 'disable', 'upgrade'] as const
export type Action = typeof actions[number]
export interface Options {
  server: boolean
  action: Action
  profile: string
  explicitProfile: boolean
  host?: string
  port?: number
  follow: boolean
  printUrl: boolean
  help: boolean
  version: boolean
  remote: string[]
}

/** Parse management options, preserving the independent Remote's argv grammar. */
export function parse(argv: readonly string[]): Options {
  const result: Options = {
    server: argv[0] === 'server', action: 'start', profile: 'mayfly', explicitProfile: false,
    follow: false, printUrl: false, help: false, version: false, remote: [],
  }
  let args = result.server ? argv.slice(1) : argv
  if (result.server && args[0] !== undefined && !args[0].startsWith('-')) {
    if (!actions.includes(args[0] as Action)) throw new Error('Unknown server action; run mayfly server --help')
    result.action = args[0] as Action
    args = args.slice(1)
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--' && !result.server) {
      result.remote.push(...args.slice(index))
      break
    }
    if (arg === '--profile' || arg.startsWith('--profile=') || (result.server && /^(?:--host|--port)(?:=|$)/u.test(arg))) {
      const name = arg.split('=')[0]!
      const value = arg.includes('=') ? arg.slice(name.length + 1) : args[++index]
      if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`${name} requires a value`)
      if (name === '--profile') {
        if (!/^[a-zA-Z0-9_-]+$/u.test(value)) throw new Error('Profile names may contain only letters, digits, hyphens and underscores')
        result.profile = value
        result.explicitProfile = true
      } else if (name === '--port') {
        if (!/^\d+$/u.test(value) || Number(value) > 65535) throw new Error('--port must be an integer from 0 to 65535')
        result.port = Number(value)
      } else result.host = value
      continue
    }
    if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--version' || arg === '-V') result.version = true
    else if (arg === '--follow' && result.server) result.follow = true
    else if (arg === '--print-startup-url' && result.server) result.printUrl = true
    else if (result.server) throw new Error('Unknown server option; run mayfly server --help')
    else {
      result.remote.push(arg)
      // Values owned by the Remote parser must not be interpreted as CLI flags.
      if (['--host', '--resume', '--session', '--cwd'].includes(arg) && args[index + 1] !== undefined) result.remote.push(args[++index]!)
    }
  }
  if ((result.host !== undefined || result.port !== undefined) && !['start', 'restart'].includes(result.action)) throw new Error('--host and --port require server start or restart')
  if (result.follow && result.action !== 'logs') throw new Error('--follow requires server logs')
  if (result.printUrl && !['start', 'restart'].includes(result.action)) throw new Error('--print-startup-url requires server start or restart')
  if (!result.server && result.explicitProfile && (process.env.MAYFLY_DSH_STARTUP_URL || result.remote.some(arg => /^--host(?:=|$)/u.test(arg)))) {
    throw new Error('--profile cannot be combined with an explicit remote Host')
  }
  return result
}

export const HELP = `Mayfly terminal UI and background Host

Usage: mayfly [--profile <name>] [--resume <id>] [--cwd <path>] [task ...]
       mayfly server [start|stop|restart|status|logs|enable|disable|upgrade] [options]

The terminal automatically starts its local Host. Quitting detaches only the UI.
Server defaults to start. --profile selects an instance (default: mayfly).
Start/restart: --host <address> --port <0..65535> --print-startup-url
Logs: --follow (default: last 100 lines)
Enable/disable controls login startup without changing the running state.
Upgrade refreshes a stopped managed profile after an external CLI upgrade.
--help, --version do not initialize or start a Host.

MAYFLY_HOME defaults to ~/.mayfly. Explicit MAYFLY_DSH_STARTUP_URL connects
remotely without starting a local Host. Never pass credentials in arguments.
Use mayfly -- server ... for a task beginning with the reserved word server.
`
