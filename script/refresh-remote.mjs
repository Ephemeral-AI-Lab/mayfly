/** Refresh the isolated Remote graph from freshly built candidate file packages. @module script/refresh-remote */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './package-contract.mjs'
import { pnpmCommand } from './pnpm-command.mjs'

// pnpm 11 retains the file dependency's old directory entries on a force
// install. A fresh consumer is necessary after tsdown emits new chunk names.
// Only this checkout's generated dependency directory is removed.
rmSync(join(ROOT, 'packages/remote/node_modules'), { recursive: true, force: true })
const result = spawnSync(...pnpmCommand(['--dir', 'packages/remote', 'install', '--frozen-lockfile', '--ignore-scripts']), { cwd: ROOT, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
