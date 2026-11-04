/** Locate a candidate CLI and resolve its actual installed dependency graph. @module script/installed-cli */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

export function installedCli(env = process.env) {
  if (env.MAYFLY_SMOKE_LAUNCHER) return resolve(env.MAYFLY_SMOKE_LAUNCHER)
  const command = process.platform === 'win32' ? env.ComSpec ?? 'cmd.exe' : 'npm'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm root -g'] : ['root', '-g']
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.status !== 0) throw new Error(`cannot locate installed launcher: ${result.stderr}`)
  return join(result.stdout.trim(), '@ephemeral-ai/mayfly-cli/lib/bin.js')
}

export function installedManifests(entry) {
  const cli = createRequire(entry)
  const remotePath = cli.resolve('@ephemeral-ai/mayfly-remote/package.json')
  const remote = createRequire(remotePath)
  return [
    cli.resolve('../package.json'),
    cli.resolve('@ephemeral-ai/mayfly-host/package.json'),
    remotePath,
    remote.resolve('@ephemeral-ai/mayfly/package.json'),
    remote.resolve('@ephemeral-ai/mayfly-ui/package.json'),
  ]
}
