/**
 * The baseline build a perf A/B compares with: a commit (by default the merge base with the comparison branch) checked
 * out as a git worktree under `.artifacts/baseline/<sha>`, installed from the store, and built once; later runs reuse
 * it. The scenarios, the driver, and the runner stay the current ones; only the product comes from the baseline.
 * @module script/scenarios/baseline
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

/** The commit a ref names, or the merge base of a branch with HEAD. */
export const commitOf = (root, ref) => git(root, ['rev-parse', '--verify', `${ref}^{commit}`])
export const mergeBaseOf = (root, branch) => git(root, ['merge-base', branch, 'HEAD'])

/**
 * Check out, install, and build a commit once.
 * @param {string} root - the repository.
 * @param {string} sha - the commit.
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {string} the baseline checkout.
 */
export function ensureBaseline(root, sha, { log = () => {} } = {}) {
  const dir = join(root, '.artifacts/baseline', sha.slice(0, 12))
  const ready = join(dir, '.mayfly-baseline-ready')
  if (existsSync(ready)) return dir
  const run = (command, args, cwd) => {
    log(`> ${command} ${args.join(' ')}`)
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' }, timeout: 900_000 })
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${(result.stdout ?? '').slice(-1500)}\n${(result.stderr ?? '').slice(-1500)}`)
  }
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(join(root, '.artifacts/baseline'), { recursive: true })
    run('git', ['worktree', 'add', '--detach', '--force', dir, sha], root)
  }
  const offline = spawnSync('pnpm', ['install', '--frozen-lockfile', '--offline'], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
  if (offline.status !== 0) run('pnpm', ['install', '--frozen-lockfile'], dir)
  run('pnpm', ['run', 'build'], dir)
  writeFileSync(ready, `${sha}\n`)
  return dir
}
