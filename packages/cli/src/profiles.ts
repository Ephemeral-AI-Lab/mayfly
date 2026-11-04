/** First-use native profile installation using the exact packaged Harness CLI. @module */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { execute, readJson, writeJson, type Paths } from './state.ts'

const require = createRequire(import.meta.url)
export function packageManifest(name: string): { version: string } { return JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string } }
export function dshBin(): string { return require.resolve('@deepseek-ai/dsh/lib/bin.js') }

/** Materialize a dedicated Harness environment without inheriting another DSH_HOME. */
export function hostEnvironment(p: Paths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: join(p.home, 'harness') }
  delete env.MAYFLY_DSH_STARTUP_URL
  return env
}

/** Install a missing bundle and validate existing runtime pins before every launch. */
export async function initialize(p: Paths, profile: string, progress: (message: string) => void, upgrade = false): Promise<void> {
  const version = packageManifest('@ephemeral-ai/mayfly-host').version
  const dir = join(p.home, 'harness', 'profiles', profile)
  const file = join(dir, 'package.json')
  const marker = await readJson<{ version: string }>(join(dir, 'mayfly-install.json'))
  if (upgrade && !marker) throw new Error('Profile is not a managed Mayfly installation; use server start to initialize it')
  const invoke = async (args: string[]): Promise<string> => {
    const result = await execute(process.execPath, [dshBin(), ...args], { env: hostEnvironment(p), maxBuffer: 8 * 1024 * 1024 })
    return result.stdout
  }
  if (!existsSync(file)) {
    progress(`Initializing Mayfly profile ${profile}…`)
    await invoke(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  }
  const manifest = (await readJson<{ dependencies: Record<string, string>, dsh?: { profile?: { bundles?: string[] } } }>(file))!
  const installed = manifest.dependencies['@ephemeral-ai/mayfly-host']
  if (upgrade && installed === undefined) throw new Error('Profile is not a managed Mayfly installation; use server start to initialize it')
  if (!upgrade && installed !== undefined && marker?.version !== undefined && marker.version !== version) throw new Error('Host profile version does not match this Mayfly installation; stop it with the old installer, back up its data, then run mayfly server upgrade')
  if (upgrade || !marker || installed === undefined) {
    const workspace = join(dir, 'pnpm-workspace.yaml')
    const text = await readFile(workspace, 'utf8')
    if (!/^allowBuilds:/mu.test(text)) await appendFile(workspace, '\nallowBuilds:\n  koffi: false\n  node-pty: false\n')
    progress(`Installing Mayfly Host ${version} and its native dependencies…`)
    // The linked bundle uses the same official plugin install path as a published bundle.
    const bundle = dirname(require.resolve('@ephemeral-ai/mayfly-host/package.json'))
    await invoke(['plugin', '--profile', profile, 'add', `link:${bundle}`])
  }
  const composed = await invoke(['--profile', profile, '--dump-config'])
  for (const id of ['web-runtime', 'connection', 'mayfly-host', 'mayfly-host-startup']) {
    if (!composed.includes(`id: ${id}`)) throw new Error(`Host profile is missing ${id}`)
  }
  await writeJson(join(dir, 'mayfly-install.json'), { version })
}
