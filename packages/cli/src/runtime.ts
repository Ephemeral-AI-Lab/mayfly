/**
 * Lazy materialization of the launcher's prepacked Harness runtime. npm only
 * writes compressed runtime layers; the first command that needs dsh expands
 * the current layers into a versioned user cache and later invocations reuse it.
 *
 * @module @ephemeral-ai/mayfly-cli/runtime
 */

import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './calibrate.ts'
import { cliInternals } from './internals.ts'

/** The Harness line carried inside the runtime archives. */
export const HARNESS_LINE = '0.1.2-alpha.5'

/** A validated runtime ready to execute. */
export interface BundledDsh {
  /** The dsh JavaScript bin entry. */
  readonly binJs: string
  /** The exact packaged Harness version. */
  readonly version: string
}

/** The common and native archives shipped beside the bundled bin. */
function runtimeArchives(platform: string, arch: string): readonly string[] {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`unsupported runtime platform: ${platform}-${arch}`)
  }
  return [
    fileURLToPath(new URL('../runtime-common.tgz', import.meta.url)),
    fileURLToPath(new URL(`../runtime-${platform}-${arch}.tgz`, import.meta.url)),
  ]
}

/** Read and validate the dsh manifest below one materialized runtime root. */
function readRuntime(root: string): BundledDsh | undefined {
  const manifestPath = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const text = cliInternals.readTextFile(manifestPath)
  if (text === undefined) return undefined
  try {
    const manifest = JSON.parse(text) as { version?: unknown, bin?: unknown }
    if (manifest.version !== HARNESS_LINE || manifest.bin === null || typeof manifest.bin !== 'object') return undefined
    const entry = (manifest.bin as Record<string, unknown>).dsh
    if (typeof entry !== 'string') return undefined
    const binJs = join(dirname(manifestPath), entry)
    if (!isRuntimePath(relative(root, binJs).replaceAll('\\', '/')) || !cliInternals.fileSize(binJs)) return undefined
    const indexText = cliInternals.readTextFile(join(root, 'node_modules', '.mayfly-runtime.json'))
    if (indexText === undefined) return undefined
    const index = JSON.parse(indexText) as { platform?: unknown, arch?: unknown, harness?: unknown, files?: unknown }
    if (index.platform !== cliInternals.platform || index.arch !== cliInternals.arch || index.harness !== HARNESS_LINE) return undefined
    if (!Array.isArray(index.files) || index.files.length === 0 || index.files.length > 64) return undefined
    for (const file of index.files as Array<{ path?: unknown, size?: unknown } | null>) {
      if (file === null || typeof file.path !== 'string' || !isRuntimePath(file.path)) return undefined
      if (typeof file.size !== 'number' || file.size <= 0 || cliInternals.fileSize(join(root, file.path)) !== file.size) return undefined
    }
    return { binJs, version: HARNESS_LINE }
  } catch {
    return undefined
  }
}

/** The sentinel index and dsh entry cannot name paths outside the runtime. */
function isRuntimePath(path: string): boolean {
  return path.startsWith('node_modules/') && !path.includes('\\') && !path.split('/').includes('..')
}

/**
 * Materialize and validate the bundled host, atomically publishing a complete
 * cache directory so concurrent first launches cannot observe half a tree.
 * @param mayflyVersion - the launcher's exact package version.
 * @returns the nested dsh facts.
 */
export async function bundledDsh(mayflyVersion: string): Promise<BundledDsh> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(mayflyVersion)) throw new Error('launcher manifest has no valid version')
  const cacheParent = join(dshHome(), 'cache', 'mayfly-cli-runtime')
  const archives = runtimeArchives(cliInternals.platform, cliInternals.arch)
  const target = join(cacheParent, `${mayflyVersion}-${HARNESS_LINE}-${cliInternals.platform}-${cliInternals.arch}`)
  const current = readRuntime(target)
  if (current !== undefined) return current

  cliInternals.makeDirectory(cacheParent)
  const temporary = cliInternals.makeTempDirectory(join(cacheParent, '.extract-'))
  let published = false
  let quarantined: string | undefined
  try {
    for (const archive of archives) {
      await cliInternals.extractRuntimeArchive(archive, temporary)
    }
    const prepared = readRuntime(temporary)
    if (prepared === undefined) throw new Error(`runtime payload does not contain @deepseek-ai/dsh@${HARNESS_LINE}`)
    return await cliInternals.withRuntimeLock(target, assertLock => {
      const current = readRuntime(target)
      if (current !== undefined) return current
      assertLock()
      try {
        cliInternals.renamePath(temporary, target)
      } catch (error) {
        // Every publisher holds this lock, so a validated winner cannot be
        // replaced between the check above and quarantining the invalid tree.
        assertLock()
        const quarantine = cliInternals.makeTempDirectory(join(cacheParent, '.invalid-'))
        quarantined = quarantine
        try {
          assertLock()
          cliInternals.renamePath(target, join(quarantine, 'runtime'))
        } catch {
          throw error
        }
        assertLock()
        cliInternals.renamePath(temporary, target)
      }
      published = true
      return { ...prepared, binJs: join(target, relative(temporary, prepared.binJs)) }
    })
  } finally {
    // Recursive deletion may be slow; it must not block the publication lease
    // heartbeat. These uniquely owned paths no longer contain the live target.
    if (quarantined !== undefined) cliInternals.removeTree(quarantined)
    if (!published) cliInternals.removeTree(temporary)
  }
}
