/** Static Client handoffs fail loudly on registration, export, and external faults. */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  runInThisContext: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))
vi.mock('node:vm', () => ({ runInThisContext: mocks.runInThisContext }))

import { loadClientPlugins } from '../../src/client/bundle.ts'

interface Registration {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

interface Window {
  readonly __ModuleLoader__: { load(registration: Registration): void }
}

function idOf(filename: string): string {
  for (const id of [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-file-upload',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-workspace-controller',
  ]) {
    if (filename.includes(`${id}/`)) return id
  }
  throw new Error(`unexpected fixture filename ${filename}`)
}

function register(factory: Registration['factory'], id?: string): void {
  mocks.runInThisContext.mockImplementation((_source: string, options: { filename: string }) => {
    return (window: Window) => {
      window.__ModuleLoader__.load({ id: id ?? idOf(options.filename), factory })
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readFile.mockResolvedValue('source')
})

describe('loadClientPlugins', () => {
  it('materializes all four official handoffs with their declared externals', async () => {
    register(() => ({ inject: [], apply: () => {} }))
    const plugins = await loadClientPlugins()
    expect(Object.keys(plugins)).toEqual(['remotes', 'fileUpload', 'sessions', 'workspaces'])
    for (const plugin of Object.values(plugins)) expect(plugin.inject).toEqual([])
  })

  it('rejects a missing or mismatched registration', async () => {
    mocks.runInThisContext.mockImplementation(() => () => {})
    await expect(loadClientPlugins()).rejects.toThrow('did not register its entry')
    vi.clearAllMocks()
    register(() => ({ inject: [], apply: () => {} }), '@fixture/wrong')
    await expect(loadClientPlugins()).rejects.toThrow('did not register its entry')
  })

  it.each([
    [{ apply: () => {} }],
    [{ inject: [1], apply: () => {} }],
    [{ inject: [] }],
  ])('rejects a malformed Cordis export', async exports => {
    register(() => exports)
    await expect(loadClientPlugins()).rejects.toThrow('did not export its Cordis entry')
  })

  it('rejects an external absent from the explicit Node module table', async () => {
    register((require) => {
      require('@fixture/undeclared')
      return { inject: [], apply: () => {} }
    })
    await expect(loadClientPlugins()).rejects.toThrow('undeclared external')
  })

  it('names the installed bundle and the supported Harness line in a format fault', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    const installed = JSON.parse(readFileSync(new URL(import.meta.resolve('@deepseek-ai/dsh-api-remotes/package.json')), 'utf8')) as { version: string }
    mocks.runInThisContext.mockImplementation(() => () => {})
    await expect(loadClientPlugins()).rejects.toThrow(`@deepseek-ai/dsh-api-remotes ${installed.version} did not register its entry; Mayfly reads the handoff format of Harness ${manifest.dependencies['@deepseek-ai/dsh-session']!}`)
  })
})
