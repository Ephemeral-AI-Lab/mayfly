/** Clean full build: Host's generated client, declarations, then every runtime bundle. @module script/build-split */
import { spawnSync } from 'node:child_process'
import { ROOT } from './package-contract.mjs'
import { pnpmCommand } from './pnpm-command.mjs'

function run(command, args) {
  const result = spawnSync(...(command === 'pnpm' ? pnpmCommand(args) : [command, args]), { cwd: ROOT, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, ['script/clean-lib.mjs'])
run('pnpm', ['--filter', '@ephemeral-ai/mayfly-host', 'bundle'])
run('pnpm', ['exec', 'tsc', '-b', 'tsconfig.json', '--force'])
run(process.execPath, ['script/prune-types.mjs'])
run('pnpm', ['exec', 'tsdown'])
