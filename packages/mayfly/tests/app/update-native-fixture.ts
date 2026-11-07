/** Installed public PluginManager with real profile files and a bounded package-process boundary. @module */
import { Context } from '@deepseek-ai/cordis'
import { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtempTracked } from '../core/temp-dir.ts'

const HOST = '@ephemeral-ai/mayfly-host'

/** Keep native install/remove/refusal/activation logic; only the external registry/package executable is a fixture. */
export async function nativeUpdateHost(hmr: boolean) {
  const directory = mkdtempTracked('mayfly-native-update-')
  const anchor = join(directory, 'installation', 'package.json')
  await mkdir(join(directory, 'installation'))
  await writeFile(anchor, JSON.stringify({ name: 'native-update-installation', version: '1.0.0', dependencies: {} }))
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, name: 'native-update-profile', dependencies: { [HOST]: '1.0.0' }, dsh: { profile: { bundles: [HOST] } } }))
  const packageRoot = join(directory, 'node_modules', HOST)
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: HOST, version: '1.0.0', dsh: { bundle: { patch: ['./patch.yml'] } } }))
  await writeFile(join(packageRoot, 'patch.yml'), '[]\n')
  const executable = join(directory, 'package-manager.mjs')
  await writeFile(executable, `
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const host = '${HOST}'
const args = process.argv.slice(2)
const manifestPath = join(process.cwd(), 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const version = args[1]?.slice(args[1].lastIndexOf('@') + 1)
const facts = version => ({ name: host, version, dsh: { bundle: { patch: ['./patch.yml'] } } })
if (args[0] === 'config') console.log('https://registry.npmjs.org/')
else if (args[0] === 'view') console.log(JSON.stringify(facts(version)))
else if (args[0] === 'remove') {
  delete manifest.dependencies[host]
  await writeFile(manifestPath, JSON.stringify(manifest))
  await rm(join(process.cwd(), 'node_modules', host), { recursive: true, force: true })
} else if (args[0] === 'add') {
  const refused = await readFile(join(process.cwd(), 'refuse-version'), 'utf8').catch(() => '')
  if (refused === version) { console.error('ERR_NATIVE_FIXTURE_TARGET_REFUSED'); process.exit(1) }
  manifest.dependencies[host] = version
  await writeFile(manifestPath, JSON.stringify(manifest))
  const root = join(process.cwd(), 'node_modules', host)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify(facts(version)))
  await writeFile(join(root, 'patch.yml'), '[]\\n')
} else throw new Error('Unexpected native package operation: ' + args.join(' '))
`)
  const ctx = new Context()
  ctx.provide('profileContext', { name: 'native-update', dir: directory, cwd: directory, installAnchor: anchor, startedBundles: [HOST], packageManager: { command: process.execPath, args: [executable] } } as never)
  ctx.provide('loader', { entries: () => [] } as never)
  if (hmr) ctx.provide('hmr', { runExclusive: async (operation: () => Promise<unknown>) => operation(), reconcileProfile: async () => ({ warnings: [], pending: [] }) } as never)
  const manager = new PluginManager(ctx, PluginManager.Config({ fallbackRegistries: [] }))
  return { manager, directory,
    refuse: (version: string) => writeFile(join(directory, 'refuse-version'), version),
    manifest: async () => JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { dependencies: Record<string, string> },
    dispose: () => ctx.fiber.dispose(),
  }
}
