/** Link a checkout into a cached throwaway dsh profile, for the PTY bench and the workbench. @module script/workbench/profile */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Link `repo` (and, for a gallery run, the gallery of `galleryRepo`) into a throwaway profile named `bench`, cached
 * per linked checkout under `<artifacts>/homes/<key>/.dsh`, and install it once.
 * @param options - `repo`, `galleryRepo`, `gallery`, `dshBin`, `artifacts` (directory), and `stdio` for the install steps.
 * @returns `{ dshHome, profileDir, work, env }`, the isolated environment a `dsh --profile bench` boot needs.
 */
export function ensureThrowawayProfile({ repo: given, galleryRepo: givenGallery = given, gallery = false, dshBin, artifacts }) {
  // One profile per checkout, however its path is spelled (a trailing slash included).
  const [repo, galleryRepo] = [resolve(given), resolve(givenGallery)]
  const key = createHash('sha256').update([repo, gallery ? galleryRepo : ''].join('\n')).digest('hex').slice(0, 12)
  const dshHome = join(artifacts, 'homes', key, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'bench')
  const work = join(artifacts, 'work', key)
  mkdirSync(work, { recursive: true })
  const env = { ...process.env, DSH_HOME: dshHome, PI_CODING_AGENT_DIR: join(artifacts, 'homes', key, 'pi-agent'), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }
  // A PTY provides its own size, and the default presentation is the one measured.
  for (const name of ['COLUMNS', 'LINES', 'NO_COLOR', 'CI', 'FORCE_COLOR', 'LC_ALL', 'LC_CTYPE', 'NODE_OPTIONS']) delete env[name]

  const run = (command, argv, runEnv = env) => {
    const result = spawnSync(command, argv, { encoding: 'utf8', env: runEnv, timeout: 600_000 })
    if (result.status !== 0) {
      console.error(`FAIL: ${command} ${argv.join(' ')}\n${(result.stdout ?? '').slice(-2000)}\n${(result.stderr ?? '').slice(-2000)}`)
      process.exit(1)
    }
  }
  if (!existsSync(join(profileDir, 'node_modules'))) {
    console.error(`==> Linking ${repo} into a throwaway profile`)
    run(dshBin, ['plugin', '--profile', 'bench', 'add', `link:${repo}/packages/mayfly`, `link:${repo}/packages/ui`, ...(gallery ? [`link:${galleryRepo}/examples/ui-gallery`] : [])])
    run('node', [join(repo, 'script/ensure-loader-entries.mjs'), join(repo, 'packages/mayfly'), profileDir, dshBin])
    run('pnpm', ['--dir', profileDir, 'install', '--no-frozen-lockfile'], { ...env, CI: 'true' })
  }
  return { dshHome, profileDir, work, env }
}
