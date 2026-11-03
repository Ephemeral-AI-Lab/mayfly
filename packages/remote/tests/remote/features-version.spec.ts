import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { remoteClientVersion } from '../../src/remote/features/version.ts'

/** The manifest this package publishes, read independently of the module's own resolver. */
function manifest(): { readonly name: string, readonly version: string } {
  return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { readonly name: string, readonly version: string }
}

const mocks = vi.hoisted(() => ({
  /** A fake `require` keyed by the depth-relative path the module asks for. */
  manifests: {} as Record<string, unknown>,
}))

/** Replace Node's resolver so each manifest depth can be decided per test. */
function stubManifests(manifests: Record<string, unknown>): void {
  mocks.manifests = manifests
  vi.doMock('node:module', () => ({
    createRequire: () => (path: string) => {
      if (!Object.hasOwn(mocks.manifests, path)) throw new Error(`ENOENT ${path}`)
      return mocks.manifests[path]
    },
  }))
  vi.resetModules()
}

describe('remoteClientVersion', () => {
  it('reports the version of this package manifest, not an arbitrary package.json', () => {
    const own = manifest()
    const version = remoteClientVersion()

    expect(own.name).toBe('@ephemeral-ai/mayfly-remote')
    expect(version).toBe(own.version)
    expect(version).not.toBe('')
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/u)
  })

  it('answers the same version on every call and never throws', () => {
    const first = remoteClientVersion()
    expect(remoteClientVersion()).toBe(first)
    expect(typeof first).toBe('string')
  })

  it('refuses a differently named manifest and keeps descending', async () => {
    stubManifests({
      '../package.json': { name: '@ephemeral-ai/mayfly', version: '9.9.9' },
      '../../package.json': { name: 'some-other-package', version: '8.8.8' },
      '../../../package.json': { name: '@ephemeral-ai/mayfly-remote', version: '1.2.3' },
    })
    const module = await import('../../src/remote/features/version.ts')
    expect(module.remoteClientVersion()).toBe('1.2.3')
    vi.doUnmock('node:module')
    vi.resetModules()
  })

  it('skips a matching name whose version is not a string', async () => {
    stubManifests({
      '../package.json': { name: '@ephemeral-ai/mayfly-remote', version: 42 },
      '../../package.json': { name: '@ephemeral-ai/mayfly-remote', version: '0.0.1' },
    })
    const module = await import('../../src/remote/features/version.ts')
    expect(module.remoteClientVersion()).toBe('0.0.1')
    vi.doUnmock('node:module')
    vi.resetModules()
  })

  it('reports an empty version when no depth resolves this package', async () => {
    stubManifests({
      '../package.json': { name: '@ephemeral-ai/mayfly' },
      '../../package.json': null,
      '../../../package.json': { name: 'workspace-root', version: '5.5.5' },
    })
    const module = await import('../../src/remote/features/version.ts')
    expect(module.remoteClientVersion()).toBe('')
    vi.doUnmock('node:module')
    vi.resetModules()
  })

  it('reads the manifest once and caches the answer for the process', async () => {
    stubManifests({ '../package.json': { name: '@ephemeral-ai/mayfly-remote', version: '3.1.4' } })
    const module = await import('../../src/remote/features/version.ts')
    expect(module.remoteClientVersion()).toBe('3.1.4')

    mocks.manifests = { '../package.json': { name: '@ephemeral-ai/mayfly-remote', version: '9.9.9' } }
    expect(module.remoteClientVersion()).toBe('3.1.4')
    vi.doUnmock('node:module')
    vi.resetModules()
  })
})
