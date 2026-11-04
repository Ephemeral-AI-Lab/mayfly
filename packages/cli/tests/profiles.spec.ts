/** First-use installation, retries and runtime-pin refusal through native CLI calls. @module */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'

vi.mock('../src/state.ts', async original => ({ ...await original<typeof import('../src/state.ts')>(), execute: vi.fn() }))
import { execute, paths, writeJson } from '../src/state.ts'
import { dshBin, hostEnvironment, initialize, packageManifest } from '../src/profiles.ts'

registerTempDirCleanup()
beforeEach(() => {
  vi.stubEnv('MAYFLY_HOME', mkdtempTracked('mayfly-profile-'))
  vi.mocked(execute).mockReset()
})
afterEach(() => vi.unstubAllEnvs())

async function fixture(dependencies: Record<string, string> = {}): Promise<string> {
  const dir = join(paths('work').home, 'harness/profiles/work')
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'package.json'), { dependencies })
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
  return dir
}
const composed = ['web-runtime', 'connection', 'mayfly-host', 'mayfly-host-startup'].map(id => `id: ${id}`).join('\n')

it('uses packaged dsh and a dedicated data root without exporting remote credentials', () => {
  vi.stubEnv('MAYFLY_DSH_STARTUP_URL', 'secret')
  expect(hostEnvironment(paths('work')).MAYFLY_DSH_STARTUP_URL).toBeUndefined()
  expect(hostEnvironment(paths('work')).DSH_HOME).toBe(join(paths('work').home, 'harness'))
  expect(dshBin()).toMatch(/[/\\]lib[/\\]bin\.js$/u)
  expect(packageManifest('@ephemeral-ai/mayfly-host').version).toBeTruthy()
})

it('initializes a missing profile, pre-denies native builds and records only completed installs', async () => {
  let dir = ''
  vi.mocked(execute).mockImplementation(async (_node, args) => {
    if (args?.includes('--from-default-profile')) dir = await fixture()
    return { stdout: composed, stderr: '' } as never
  })
  const progress = vi.fn()
  await initialize(paths('work'), 'work', progress)
  expect(progress).toHaveBeenCalledTimes(2)
  expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('koffi: false')
  expect(await readFile(join(dir, 'mayfly-install.json'), 'utf8')).toContain(packageManifest('@ephemeral-ai/mayfly-host').version)
  expect(execute).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['plugin', '--profile', 'work', 'add']), expect.objectContaining({ env: expect.objectContaining({ DSH_HOME: join(paths('work').home, 'harness') }) }))
})

it('preserves existing build policy, skips matching installs and refuses mismatched releases', async () => {
  const version = packageManifest('@ephemeral-ai/mayfly-host').version
  const dir = await fixture({ '@ephemeral-ai/mayfly-host': `link:/bundle` })
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  koffi: false\n')
  vi.mocked(execute).mockResolvedValue({ stdout: composed, stderr: '' } as never)
  await initialize(paths('work'), 'work', () => {})
  expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe('allowBuilds:\n  koffi: false\n')
  vi.mocked(execute).mockClear()
  await initialize(paths('work'), 'work', () => {})
  expect(execute).toHaveBeenCalledTimes(1)
  await writeJson(join(dir, 'mayfly-install.json'), { version: `${version}-old` })
  await expect(initialize(paths('work'), 'work', () => {})).rejects.toThrow('does not match')
})

it('rejects incomplete composition and retries installation after native failure', async () => {
  const dir = await fixture()
  vi.mocked(execute).mockRejectedValueOnce(new Error('install failed'))
  await expect(initialize(paths('work'), 'work', () => {})).rejects.toThrow('install failed')
  await expect(readFile(join(dir, 'mayfly-install.json'))).rejects.toThrow()
  vi.mocked(execute).mockResolvedValue({ stdout: '', stderr: '' } as never)
  await expect(initialize(paths('work'), 'work', () => {})).rejects.toThrow('missing web-runtime')
})

it('explicitly upgrades only a managed profile through the current native installer and preserves its data', async () => {
  await expect(initialize(paths('work'), 'work', () => {}, true)).rejects.toThrow('not a managed')
  expect(execute).not.toHaveBeenCalled()
  const dir = await fixture()
  await expect(initialize(paths('work'), 'work', () => {}, true)).rejects.toThrow('not a managed')
  await writeJson(join(dir, 'mayfly-install.json'), { version: '0.1.4-rc.2' })
  await expect(initialize(paths('work'), 'work', () => {}, true)).rejects.toThrow('not a managed')
  await writeJson(join(dir, 'package.json'), { dependencies: { '@ephemeral-ai/mayfly-host': 'link:/old' } })
  await writeJson(join(dir, 'mayfly-install.json'), { version: '0.1.4-rc.2' })
  await writeFile(join(dir, 'saved-session'), 'retained')
  vi.mocked(execute).mockRejectedValueOnce(new Error('native upgrade failed'))
  await expect(initialize(paths('work'), 'work', () => {}, true)).rejects.toThrow('native upgrade failed')
  expect(JSON.parse(await readFile(join(dir, 'mayfly-install.json'), 'utf8')).version).toBe('0.1.4-rc.2')
  expect(await readFile(join(dir, 'saved-session'), 'utf8')).toBe('retained')
  vi.mocked(execute).mockResolvedValue({ stdout: composed, stderr: '' } as never)
  await initialize(paths('work'), 'work', () => {}, true)
  expect(execute).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['plugin', '--profile', 'work', 'add']), expect.any(Object))
  expect(await readFile(join(dir, 'saved-session'), 'utf8')).toBe('retained')
  expect(JSON.parse(await readFile(join(dir, 'mayfly-install.json'), 'utf8')).version).toBe(packageManifest('@ephemeral-ai/mayfly-host').version)
})
