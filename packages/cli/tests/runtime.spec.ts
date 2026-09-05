/** Tests for the archived dsh runtime cache and its atomic publication. */

import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'
import { cliInternals } from '../src/internals.ts'
import { bundledDsh, HARNESS_LINE } from '../src/runtime.ts'

registerTempDirCleanup()

const REAL = { ...cliInternals }
const VERSION = '0.1.0-alpha.1'

afterEach(() => {
  Object.assign(cliInternals, REAL)
})

/** A valid packaged-host manifest. */
function hostManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: HARNESS_LINE, bin: { dsh: 'lib/bin.js' }, ...overrides })
}

function runtimeIndex(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ platform: cliInternals.platform, arch: cliInternals.arch, harness: HARNESS_LINE, files: [{ path: 'node_modules/native/binary.node', size: 1 }], ...overrides })
}

function runtimeFile(path: string): string {
  return path.endsWith('.mayfly-runtime.json') ? runtimeIndex() : hostManifest()
}

/** Set a fixture DSH_HOME and return the target and temporary roots. */
function fixturePaths(): { target: string, temporary: string } {
  const home = mkdtempTracked('mayfly-cli-runtime-home-')
  cliInternals.env = { DSH_HOME: home }
  cliInternals.fileSize = () => 1
  return {
    target: join(home, 'cache', 'mayfly-cli-runtime', `${VERSION}-${HARNESS_LINE}-${cliInternals.platform}-${cliInternals.arch}`),
    temporary: join(home, 'cache', 'mayfly-cli-runtime', '.extract-fixture'),
  }
}

describe('bundledDsh', () => {
  it('reuses an already validated cache without filesystem writes', async () => {
    const { target } = fixturePaths()
    cliInternals.readTextFile = path => path.startsWith(target) ? runtimeFile(path) : undefined
    cliInternals.makeDirectory = () => { throw new Error('unexpected write') }
    await expect(bundledDsh(VERSION)).resolves.toEqual({
      binJs: join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      version: HARNESS_LINE,
    })
  })

  it('extracts, validates, and atomically publishes a missing cache', async () => {
    const { target, temporary } = fixturePaths()
    const removed: string[] = []
    const extracted: Array<{ file: string, cwd: string }> = []
    let renamed: { from: string, to: string } | undefined
    cliInternals.readTextFile = path => path.startsWith(temporary) ? runtimeFile(path) : undefined
    cliInternals.makeDirectory = () => {}
    cliInternals.removeTree = path => { removed.push(path) }
    cliInternals.makeTempDirectory = () => temporary
    cliInternals.extractRuntimeArchive = async (file, cwd) => { extracted.push({ file, cwd }) }
    cliInternals.renamePath = (from, to) => { renamed = { from, to } }
    await expect(bundledDsh(VERSION)).resolves.toEqual({
      binJs: join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      version: HARNESS_LINE,
    })
    expect(extracted.map(item => item.file)).toEqual([
      expect.stringMatching(/runtime-common\.tgz$/),
      expect.stringMatching(new RegExp(`runtime-${process.platform}-${process.arch}\\.tgz$`)),
    ])
    expect(extracted.every(item => item.cwd === temporary)).toBe(true)
    expect(renamed).toEqual({ from: temporary, to: target })
    expect(removed).toEqual([])
  })

  it('accepts a concurrent publisher after losing the atomic rename race', async () => {
    const { target, temporary } = fixturePaths()
    let winner = false
    const removed: string[] = []
    cliInternals.readTextFile = path => {
      if (path.startsWith(temporary)) return runtimeFile(path)
      return winner && path.startsWith(target) ? runtimeFile(path) : undefined
    }
    cliInternals.makeDirectory = () => {}
    cliInternals.removeTree = path => { removed.push(path) }
    cliInternals.makeTempDirectory = () => temporary
    cliInternals.extractRuntimeArchive = async () => {}
    cliInternals.renamePath = () => { winner = true; throw new Error('EEXIST') }
    await expect(bundledDsh(VERSION)).resolves.toMatchObject({ version: HARNESS_LINE })
    expect(removed).toEqual([temporary])
  })

  it('cleans the temporary tree and surfaces extraction or rename failures', async () => {
    const { temporary } = fixturePaths()
    const removed: string[] = []
    cliInternals.readTextFile = path => path.startsWith(temporary) ? runtimeFile(path) : undefined
    cliInternals.makeDirectory = () => {}
    cliInternals.removeTree = path => { removed.push(path) }
    cliInternals.makeTempDirectory = prefix => prefix.endsWith('.invalid-') ? `${temporary}-quarantine` : temporary
    cliInternals.extractRuntimeArchive = async () => {}
    cliInternals.renamePath = () => { throw new Error('disk full') }
    await expect(bundledDsh(VERSION)).rejects.toThrow('disk full')
    expect(removed).toEqual([`${temporary}-quarantine`, temporary])

    removed.length = 0
    cliInternals.extractRuntimeArchive = async () => { throw new Error('bad gzip') }
    await expect(bundledDsh(VERSION)).rejects.toThrow('bad gzip')
    expect(removed).toEqual([temporary])
  })

  it.each(['entry', 'native', 'truncated'])('repairs an existing cache with a missing or invalid %s file', async damage => {
    const { target } = fixturePaths()
    cliInternals.fileSize = REAL.fileSize
    const createRuntime = (root: string): void => {
      const host = join(root, 'node_modules', '@deepseek-ai', 'dsh')
      mkdirSync(join(host, 'lib'), { recursive: true })
      mkdirSync(join(root, 'node_modules', 'native'), { recursive: true })
      writeFileSync(join(host, 'package.json'), hostManifest())
      writeFileSync(join(host, 'lib', 'bin.js'), 'entry')
      writeFileSync(join(root, 'node_modules', 'native', 'binary.node'), 'x')
      writeFileSync(join(root, 'node_modules', '.mayfly-runtime.json'), runtimeIndex())
    }
    createRuntime(target)
    const damaged = damage === 'entry'
      ? join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : join(target, 'node_modules', 'native', 'binary.node')
    if (damage === 'truncated') writeFileSync(damaged, '')
    else rmSync(damaged)
    const extractions: string[] = []
    cliInternals.extractRuntimeArchive = async (archive, cwd) => { extractions.push(archive); createRuntime(cwd) }
    const result = await bundledDsh(VERSION)
    expect(result.binJs).toBe(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    expect(extractions).toHaveLength(2)
    expect(REAL.fileSize(damaged)).toBeGreaterThan(0)
    await expect(bundledDsh(VERSION)).resolves.toEqual(result)
    expect(extractions).toHaveLength(2)
  })

  it.each(['quarantine-winner', 'replacement-winner', 'replacement-failure'])('handles a repair publication race: %s', async scenario => {
    const { target, temporary } = fixturePaths()
    let winner = false
    let renames = 0
    cliInternals.readTextFile = path => path.startsWith(temporary) || (winner && path.startsWith(target)) ? runtimeFile(path) : undefined
    cliInternals.makeDirectory = () => {}
    cliInternals.makeTempDirectory = prefix => prefix.endsWith('.invalid-') ? `${temporary}-quarantine` : temporary
    cliInternals.removeTree = () => {}
    cliInternals.extractRuntimeArchive = async () => {}
    cliInternals.renamePath = () => {
      renames += 1
      if (renames === 1) throw new Error('existing corrupt cache')
      if (renames === 2 && scenario === 'quarantine-winner') {
        winner = true
        throw new Error('concurrent quarantine')
      }
      if (renames === 3) {
        winner = scenario === 'replacement-winner'
        throw new Error('replacement failed')
      }
    }
    if (scenario === 'replacement-failure') await expect(bundledDsh(VERSION)).rejects.toThrow('replacement failed')
    else await expect(bundledDsh(VERSION)).resolves.toMatchObject({ version: HARNESS_LINE })
  })

  it.each([
    undefined, '{broken', runtimeIndex({ platform: 'wrong' }), runtimeIndex({ arch: 'wrong' }),
    runtimeIndex({ harness: 'wrong' }), runtimeIndex({ files: [] }), runtimeIndex({ files: 'bad' }),
    runtimeIndex({ files: Array.from({ length: 65 }, () => ({ path: 'node_modules/x', size: 1 })) }),
    runtimeIndex({ files: [null] }), runtimeIndex({ files: [{ path: 1 }] }),
    runtimeIndex({ files: [{ path: '../outside', size: 1 }] }),
    runtimeIndex({ files: [{ path: 'node_modules/../outside', size: 1 }] }),
    runtimeIndex({ files: [{ path: 'node_modules/back\\slash', size: 1 }] }),
    runtimeIndex({ files: [{ path: 'node_modules/x', size: '1' }] }),
    runtimeIndex({ files: [{ path: 'node_modules/x', size: 0 }] }),
  ])('rejects a missing or malformed native index %#', async index => {
    const { temporary } = fixturePaths()
    cliInternals.readTextFile = path => path.startsWith(temporary)
      ? path.endsWith('.mayfly-runtime.json') ? index : hostManifest()
      : undefined
    cliInternals.makeDirectory = () => {}
    cliInternals.removeTree = () => {}
    cliInternals.makeTempDirectory = () => temporary
    cliInternals.extractRuntimeArchive = async () => {}
    await expect(bundledDsh(VERSION)).rejects.toThrow('runtime payload does not contain')
  })

  it.each([
    ['{ broken'],
    [hostManifest({ version: '0.1.0' })],
    [hostManifest({ bin: null })],
    [hostManifest({ bin: 'lib/bin.js' })],
    [hostManifest({ bin: { other: 'x.js' } })],
  ])('rejects a payload with an invalid host manifest %#', async manifest => {
    const { temporary } = fixturePaths()
    cliInternals.readTextFile = path => path.startsWith(temporary) ? manifest : undefined
    cliInternals.makeDirectory = () => {}
    cliInternals.removeTree = () => {}
    cliInternals.makeTempDirectory = () => temporary
    cliInternals.extractRuntimeArchive = async () => {}
    await expect(bundledDsh(VERSION)).rejects.toThrow(`runtime payload does not contain @deepseek-ai/dsh@${HARNESS_LINE}`)
  })

  it('rejects an invalid launcher version before touching the cache', async () => {
    await expect(bundledDsh('unknown')).rejects.toThrow('launcher manifest has no valid version')
  })

  it('rejects an unsupported platform before extraction', async () => {
    fixturePaths()
    cliInternals.platform = 'aix'
    cliInternals.arch = 'ppc64'
    cliInternals.makeDirectory = () => {}
    cliInternals.makeTempDirectory = () => '/temporary'
    cliInternals.removeTree = () => {}
    await expect(bundledDsh(VERSION)).rejects.toThrow('unsupported runtime platform: aix-ppc64')
  })
})
