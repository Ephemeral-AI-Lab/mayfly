import { readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'

const runRemoteFrontend = vi.hoisted(() => vi.fn())
vi.mock('../src/remote/runtime.ts', () => ({ runRemoteFrontend }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import { main, sanitized } from '../src/remote-bin.ts'

const originalEnv = process.env
const originalArgv = process.argv
const originalExitCode = process.exitCode

registerTempDirCleanup()

beforeEach(() => {
  process.argv = originalArgv.slice(0, 2)
  process.env = { MAYFLY_DSH_STARTUP_URL: startupUrl() }
  runRemoteFrontend.mockReset()
})

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
  it('prints help and the actual package version before requiring a Host', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    process.env = {}
    for (const option of ['--help', '-h']) {
      process.argv = [...originalArgv.slice(0, 2), option]
      await main()
      expect(write).toHaveBeenLastCalledWith(expect.stringContaining('Mayfly independent terminal UI'))
    }
    for (const option of ['--version', '-V']) {
      process.argv = [...originalArgv.slice(0, 2), option]
      await main()
      expect(write).toHaveBeenLastCalledWith('mayfly 0.1.4-rc.2\n')
    }
    vi.mocked(readFileSync).mockReturnValueOnce('{"version":null}')
    await expect(main()).rejects.toThrow('Mayfly Remote package has no version')
    expect(runRemoteFrontend).not.toHaveBeenCalled()
  })

  it('passes native option aliases, equal values and positional tasks while retaining environment defaults', async () => {
    for (const flags of [
      ['--host', 'https://chosen.example/path', '--resume', 'picked', '--cwd', '/picked', 'first', 'second'],
      ['--host=https://chosen.example/path', '--resume=picked', '--cwd=/picked', '--', 'first', 'second'],
      ['--host=https://chosen.example/path', '--session=picked', '--cwd=/picked', 'first', 'second'],
      ['--host=https://chosen.example/path', '--session', 'picked', '--cwd=/picked', 'first', 'second'],
    ]) {
      process.argv = [...originalArgv.slice(0, 2), ...flags]
      await main()
      expect(runRemoteFrontend).toHaveBeenLastCalledWith({ startupUrl: 'https://chosen.example/path?token=secret', sessionId: 'picked', cwd: '/picked', task: 'first second' })
    }
    process.argv = originalArgv.slice(0, 2)
    await main()
    expect(runRemoteFrontend).toHaveBeenLastCalledWith({ startupUrl: startupUrl() })
    process.argv.push('--', '-dash-task', '--literal')
    await main()
    expect(runRemoteFrontend).toHaveBeenLastCalledWith({ startupUrl: startupUrl(), task: '-dash-task --literal' })
  })

  it('refuses credentials in every argv position without echoing their values', async () => {
    for (const input of ['--token=SECRET', '--cookie', 'http://host/?token=SECRET', 'http://host/?cookie=SECRET', 'token=SECRET', 'task cookie=SECRET', 'Cookie: SECRET', 'Authorization: SECRET', 'http://user:SECRET@host/']) {
      process.argv = [...originalArgv.slice(0, 2), '--help', '--', input]
      await expect(main()).rejects.toThrow('Credentials are not accepted as arguments')
    }
    expect(runRemoteFrontend).not.toHaveBeenCalled()
  })

  it('rejects missing option values and unknown flags before admission', async () => {
    for (const name of ['--host', '--resume', '--session', '--cwd']) {
      for (const flags of [[name], [name, ''], [name, '--help'], [`${name}=`]]) {
        process.argv = [...originalArgv.slice(0, 2), ...flags]
        await expect(main()).rejects.toThrow(`${name} requires a value`)
      }
    }
    process.argv = [...originalArgv.slice(0, 2), '--unknown']
    await expect(main()).rejects.toThrow('Unknown option; run mayfly --help')
    expect(runRemoteFrontend).not.toHaveBeenCalled()
  })

  it('refuses malformed and secret-bearing Host overrides', async () => {
    for (const host of ['{', 'ftp://host/', 'https://user@host/', 'https://:password@host/', 'https://host/?q=1', 'https://host/#fragment']) {
      process.argv = [...originalArgv.slice(0, 2), '--host', host]
      await expect(main()).rejects.toThrow('--host must be a non-secret HTTP(S) URL without credentials, query, or fragment')
    }
    expect(runRemoteFrontend).not.toHaveBeenCalled()
  })
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
    for (const raw of ['', 'http://host/?token=', 'http://user@host/?token=secret', 'http://:password@host/?token=secret']) {
      process.env = { MAYFLY_DSH_STARTUP_URL: raw }
      await expect(main()).rejects.toThrow(raw === '' ? 'is required' : 'must be an HTTP(S) URL with exactly one non-empty token')
    }
    process.env = { MAYFLY_DSH_STARTUP_URL: 'https://host/?token=secret' }
    await main()
    expect(runRemoteFrontend).toHaveBeenLastCalledWith({ startupUrl: 'https://host/?token=secret' })
  })

  it('redacts raw and encoded startup credentials plus ordinary cookie/authorization diagnostics', () => {
    process.env = { MAYFLY_DSH_STARTUP_URL: 'http://host/?token=ab%2Fc' }
    expect(sanitized(new Error('ab/c ab%2Fc http://host/?token=ab%2Fc'))).toBe('<redacted> <redacted> <redacted>')
    expect(sanitized('Cookie: secret\nAuthorization: bearer secret')).toBe('Cookie: <redacted>\nAuthorization: <redacted>')
    process.env = { MAYFLY_DSH_STARTUP_URL: '{' }
    expect(sanitized('{ failed')).toBe('<redacted> failed')
    process.env = { MAYFLY_DSH_STARTUP_URL: 'http://host/?token=' }
    expect(sanitized('plain')).toBe('plain')
    process.env = { MAYFLY_DSH_STARTUP_URL: 'http://host/' }
    expect(sanitized('plain')).toBe('plain')
    process.env = { MAYFLY_DSH_STARTUP_URL: '' }
    expect(sanitized('plain')).toBe('plain')
  })

  it('does not execute the runtime when imported without a bin argv entry', async () => {
    process.argv = [originalArgv[0]!]
    vi.resetModules()
    await import('../src/remote-bin.ts')
    expect(runRemoteFrontend).not.toHaveBeenCalled()
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
