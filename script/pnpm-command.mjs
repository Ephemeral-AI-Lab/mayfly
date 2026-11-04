/** Launch pnpm's JavaScript entry without a platform shell or .cmd shim. @module script/pnpm-command */
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** Resolve both npm's global layout and pnpm/action-setup's local installation. */
export function pnpmCommand(args, { env = process.env, platform = process.platform, exists = existsSync, realpath = realpathSync } = {}) {
  const candidates = [env.npm_execpath]
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!directory) continue
    const executable = join(directory, platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    if (exists(executable)) {
      candidates.push(realpath(executable))
      const base = dirname(executable)
      candidates.push(join(base, 'node_modules/pnpm/bin/pnpm.cjs'), join(base, '../lib/node_modules/pnpm/bin/pnpm.cjs'))
    }
  }
  const entry = candidates.find(candidate => candidate && /(?:^|[/\\])pnpm\.(?:cjs|mjs|js)$/u.test(candidate) && exists(candidate))
  if (!entry) throw new Error('Cannot locate pnpm JavaScript entry; run this command through the pinned pnpm installation')
  return [process.execPath, [entry, ...args]]
}
