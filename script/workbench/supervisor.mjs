/**
 * A PTY supervisor for the workbench: boots `dsh --profile <name>` attached to the caller's terminal, forwards keys
 * and resizes, and restarts the child on the same persisted session. Pure helpers are exported for the repo tests.
 * @module script/workbench/supervisor
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * The directory name dsh keeps a working directory's sessions under: the path with `/` as `-`, wrapped in `--`.
 * @param cwd - an absolute working directory.
 */
export function sessionSlug(cwd) {
  return `--${cwd.replace(/^\//u, '').replaceAll('/', '-')}--`
}

/**
 * The most recently written session of a working directory, as the id `--resume` takes.
 * @param dshHome - the dsh home directory (`DSH_HOME`, else `~/.dsh`).
 * @param cwd - the working directory the child ran in.
 * @returns the session directory name, or undefined when none was saved yet.
 */
export function newestSessionId(dshHome, cwd) {
  const dir = join(dshHome, 'sessions', sessionSlug(cwd))
  if (!existsSync(dir)) return undefined
  const sessions = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('session-'))
    .map(entry => ({ id: entry.name, at: statSync(join(dir, entry.name)).mtimeMs }))
    .sort((left, right) => right.at - left.at)
  return sessions[0]?.id
}

/**
 * Environment for a degraded presentation: `NO_COLOR` for monochrome, the C charset for the one-cell ASCII glyphs.
 * Reduced motion is a saved setting, so it is changed from `/settings`, not here.
 * @param options - `noColor` and `ascii` flags.
 */
export function presentationEnv({ noColor = false, ascii = false } = {}) {
  return { ...(noColor ? { NO_COLOR: '1' } : {}), ...(ascii ? { LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C' } : {}) }
}

/**
 * Run `dsh` under a PTY attached to this terminal until the user quits it.
 * @param options - `dshBin`, `profile`, `cwd`, `env`, optional `args` (dsh app arguments), `cols`, `rows`.
 * @returns `{ restart(), stop(), done }`: `restart` kills the child and boots it again on the newest session of `cwd`;
 *   `done` resolves with the exit code when the user (not a restart) ends the child.
 */
export function superviseDsh({ dshBin, profile, cwd, env, args = [], patch, cols, rows }) {
  const pty = require('node-pty')
  const dshHome = env.DSH_HOME ?? join(homedir(), '.dsh')
  const out = process.stdout
  let child
  let restarting = false
  let stopped = false
  let finish
  const done = new Promise(resolve => { finish = resolve })

  const boot = (resume) => {
    const argv = ['--profile', profile, ...(patch === undefined ? [] : ['--patch', patch]), ...(resume === undefined ? args : ['--resume', resume])]
    child = pty.spawn(dshBin, argv, { name: 'xterm-256color', cols: cols ?? out.columns ?? 120, rows: rows ?? out.rows ?? 40, cwd, env })
    const mine = child
    mine.onData(data => { if (mine === child) out.write(data) })
    mine.onExit(({ exitCode }) => {
      if (mine !== child) return
      if (restarting) return
      stopped = true
      finish(exitCode)
    })
  }

  const onInput = data => { if (!restarting) child?.write(data.toString('binary')) }
  const onResize = () => { if (out.columns !== undefined) child?.resize(cols ?? out.columns, rows ?? out.rows) }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', onInput)
  process.stdin.resume()
  out.on('resize', onResize)

  boot(undefined)

  const stop = () => {
    process.stdin.off('data', onInput)
    out.off('resize', onResize)
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
    process.stdin.pause()
    if (!stopped) { stopped = true; child?.kill() }
  }
  return {
    done: done.then((code) => { stop(); return code }),
    stop,
    async restart() {
      if (stopped || restarting) return
      restarting = true
      const old = child
      await new Promise((resolve) => {
        old.onExit(() => resolve(undefined))
        old.kill()
        setTimeout(() => resolve(undefined), 3000).unref()
      })
      const resume = newestSessionId(dshHome, cwd)
      out.write('\u001bc')
      restarting = false
      boot(resume)
    },
  }
}
