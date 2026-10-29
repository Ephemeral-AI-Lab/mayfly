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

function startupUrl(): string {
  return 'http://127.0.0.1:3080/?token=secret'
}

afterEach(() => {
  process.env = originalEnv
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
})

describe('remote-bin environment entry', () => {
  it('passes the startup URL and optional values to the runtime', async () => {
    process.env = {
      MAYFLY_DSH_STARTUP_URL: startupUrl(),
      MAYFLY_SESSION_ID: 'session-1',
      MAYFLY_TASK: 'hello',
      MAYFLY_CWD: '/workspace',
    }
    await main()
    expect(runRemoteFrontend).toHaveBeenCalledWith({
      startupUrl: startupUrl(),
      sessionId: 'session-1',
      task: 'hello',
      cwd: '/workspace',
    })
  })

  it('rejects missing, malformed, and incomplete startup URL input', async () => {
    process.env = {}
    await expect(main()).rejects.toThrow('MAYFLY_DSH_STARTUP_URL is required')
    process.env = { MAYFLY_DSH_STARTUP_URL: '{' }
    await expect(main()).rejects.toThrow()
    process.env = { MAYFLY_DSH_STARTUP_URL: 'http://127.0.0.1:3080/' }
    await expect(main()).rejects.toThrow('must be an HTTP(S) URL with exactly one non-empty token')
    process.env = { MAYFLY_DSH_STARTUP_URL: 'http://127.0.0.1:3080/?token=one&token=two' }
    await expect(main()).rejects.toThrow('must be an HTTP(S) URL with exactly one non-empty token')
    process.env = { MAYFLY_DSH_STARTUP_URL: 'ftp://127.0.0.1:3080/?token=secret' }
    await expect(main()).rejects.toThrow('must be an HTTP(S) URL with exactly one non-empty token')
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
    expect(write).toHaveBeenCalledWith('mayfly: MAYFLY_DSH_STARTUP_URL is required; start dsh with the mayfly-host profile and set its authenticated startup URL\n')
  })

  it('runs main when invoked as the binary entry', async () => {
    process.env = { MAYFLY_DSH_STARTUP_URL: startupUrl() }
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
    process.env = { MAYFLY_DSH_STARTUP_URL: startupUrl() }
    process.argv[1] = linkedBin
    runRemoteFrontend.mockClear()
    vi.resetModules()
    await import('../src/remote-bin.ts')
    await vi.waitFor(() => { expect(runRemoteFrontend).toHaveBeenCalled() })
  })
})
