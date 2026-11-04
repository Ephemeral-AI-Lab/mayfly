/** Build visual candidates before installing the isolated Remote consumer. @module script/build-split */
import { spawnSync } from 'node:child_process'
import { BUILD_PACKAGE_DIRS, ROOT } from './package-contract.mjs'
import { pnpmCommand } from './pnpm-command.mjs'

function run(command, args, extraEnv = {}) {
  const result = spawnSync(...(command === 'pnpm' ? pnpmCommand(args) : [command, args]), { cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, ['script/clean-lib.mjs'])
run('pnpm', ['--filter', '@ephemeral-ai/mayfly-host', 'bundle'])
run('pnpm', ['exec', 'tsc', '-b', 'packages/ui', 'packages/mayfly', 'packages/host', '--force'])
run('pnpm', ['exec', 'tsdown'], { MAYFLY_BUILD_PACKAGES: 'packages/ui,packages/mayfly' })
// file: overrides deliberately consume this build, not the immutable npm reference.
// Force refresh also copies newly emitted chunks after a clean build.
run(process.execPath, ['script/refresh-remote.mjs'])
run('pnpm', ['exec', 'tsc', '-b', 'tsconfig.json', '--force'])
run(process.execPath, ['script/prune-types.mjs'])
run('pnpm', ['exec', 'tsdown'], {
  MAYFLY_BUILD_PACKAGES: BUILD_PACKAGE_DIRS.filter(dir => dir !== 'packages/ui' && dir !== 'packages/mayfly').join(','),
})
