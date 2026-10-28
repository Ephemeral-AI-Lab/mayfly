import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'

const runRemoteFrontend = vi.hoisted(() => vi.fn())
vi.mock('../src/remote/runtime.ts', () => ({ runRemoteFrontend }))

import { main, sanitized } from '../src/remote-bin.ts'

const originalEnv = process.env
const originalArgv = process.argv
const originalExitCode = process.exitCode

registerTempDirCleanup()

function endpoint(): string {
  return JSON.stringify({ id: 'local', url: 'http://127.0.0.1:3080/', token: 'secret' })
}

afterEach(() => {
  process.env = originalEnv
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
})

describe('remote-bin environment entry', () => {
  it('passes the endpoint and optional startup values to the runtime', async () => {
    process.env = {
      MAYFLY_ENDPOINT: endpoint(),
      MAYFLY_SESSION_ID: 'session-1',
      MAYFLY_TASK: 'hello',
      MAYFLY_CWD: '/workspace',
    }
    await main()
    expect(runRemoteFrontend).toHaveBeenCalledWith({
      startupUrl: 'http://127.0.0.1:3080/?token=secret',
      hostId: 'local',
      sessionId: 'session-1',
      task: 'hello',
      cwd: '/workspace',
    })
  })

  it('rejects missing, malformed, and incomplete endpoint input', async () => {
    process.env = {}
    await expect(main()).rejects.toThrow('MAYFLY_ENDPOINT is required')
    process.env = { MAYFLY_ENDPOINT: '{' }
    await expect(main()).rejects.toThrow()
    process.env = { MAYFLY_ENDPOINT: JSON.stringify({ id: 'missing-fields' }) }
    await expect(main()).rejects.toThrow('MAYFLY_ENDPOINT must contain id, url, and token')
  })

  it('redacts tokens in direct execution and diagnostics', async () => {
    expect(sanitized(new Error('GET http://host/?token=secret&x=1 failed'))).toBe('GET http://host/?token=<redacted>&x=1 failed')
    expect(sanitized('plain failure')).toBe('plain failure')
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    process.env = {}
    process.argv[1] = fileURLToPath(new URL('../src/remote-bin.ts', import.meta.url))
    vi.resetModules()
    await import('../src/remote-bin.ts')
    await vi.waitFor(() => { expect(process.exitCode).toBe(1) })
    expect(write).toHaveBeenCalledWith('mayfly remote: MAYFLY_ENDPOINT is required\n')
  })

  it('runs main when invoked as the binary entry', async () => {
    process.env = { MAYFLY_ENDPOINT: endpoint() }
    process.argv[1] = fileURLToPath(new URL('../src/remote-bin.ts', import.meta.url))
    runRemoteFrontend.mockClear()
    vi.resetModules()
    await import('../src/remote-bin.ts')
    await vi.waitFor(() => { expect(runRemoteFrontend).toHaveBeenCalled() })
  })

  it('runs main through a dev profile symlink', async () => {
    const root = mkdtempTracked('mayfly-remote-bin-')
    const linkedBin = join(root, 'remote-bin.ts')
    symlinkSync(fileURLToPath(new URL('../src/remote-bin.ts', import.meta.url)), linkedBin)
    process.env = { MAYFLY_ENDPOINT: endpoint() }
    process.argv[1] = linkedBin
    runRemoteFrontend.mockClear()
    vi.resetModules()
    await import('../src/remote-bin.ts')
    await vi.waitFor(() => { expect(runRemoteFrontend).toHaveBeenCalled() })
  })
})
