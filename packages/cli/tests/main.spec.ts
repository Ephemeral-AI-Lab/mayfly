/**
 * Tests for the launcher's main flow (S37, failure form extended by D56):
 * the `-V` three-segment self-answer, the missing-host bootstrap line, the
 * boot surface's calibration (current / installed / dev lane / failed with
 * its classified manual pointer and output tail) ahead of the inherited
 * exec, the plugin surface's calibration skip, and exit code propagation.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../../mayfly/tests/core/temp-dir.ts'
import { cliInternals, type SpawnOutcome } from '../src/internals.ts'
import { main, shellVersion } from '../src/main.ts'

registerTempDirCleanup()

/** The real seams, restored after every test. */
const REAL = { ...cliInternals }

afterEach(() => {
  Object.assign(cliInternals, REAL)
  vi.unstubAllGlobals()
})

/** The shell's own manifest version — the pin every fixture calibrates to. */
const PIN = '0.1.0-alpha.2'
const AHEAD = '0.1.0-alpha.199'

/** One captured write or exit. */
const captures: { out: string[], err: string[], exits: number[] } = { out: [], err: [], exits: [] }

/** One recorded spawn call (either shape). */
interface Call {
  cmd: string
  args: readonly string[]
  env?: Record<string, string>
}

/** A successful spawn outcome. */
const OK: SpawnOutcome = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
/**
 * Stand the launcher up over a materialized nested host and an empty `mayfly`
 * profile under a temp DSH_HOME,
 * with every effect seam
 * captured. Returns the spawn recorders.
 */
function fixtureLauncher(): { calls: { once: Call[], inherit: Call[] }, root: string, hostBin: string } {
  const home = mkdtempTracked('mayfly-cli-main-home-')
  const root = join(home, 'profiles', 'mayfly')
  const runtime = join(home, 'cache', 'mayfly-cli-runtime', `${PIN}-0.1.2-alpha.5-${process.platform}-${process.arch}`, 'node_modules')
  const host = join(runtime, '@deepseek-ai', 'dsh')
  const hostBin = join(host, 'lib', 'bin.js')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(host, 'lib'), { recursive: true })
  writeFileSync(hostBin, '/* fixture */')
  writeFileSync(join(runtime, '.mayfly-runtime.json'), JSON.stringify({
    platform: process.platform, arch: process.arch, harness: '0.1.2-alpha.5',
    files: [{ path: 'node_modules/@deepseek-ai/dsh/lib/bin.js', size: 13 }],
  }))
  writeFileSync(join(host, 'package.json'), JSON.stringify({ version: '0.1.2-alpha.5', bin: { dsh: 'lib/bin.js' } }))
  cliInternals.env = { DSH_HOME: home }
  captures.out = []
  captures.err = []
  captures.exits = []
  cliInternals.stdout = text => { captures.out.push(text) }
  cliInternals.stderr = text => { captures.err.push(text) }
  cliInternals.exit = code => { captures.exits.push(code) }
  cliInternals.spawnOnce = async () => OK
  const calls = { once: [] as Call[], inherit: [] as Call[] }
  return { calls, root, hostBin }
}

/** Install the bundle at the pin inside a fixture profile root. */
function installBundle(root: string, version: string): void {
  mkdirSync(join(root, 'node_modules', '@ephemeral-ai', 'mayfly'), { recursive: true })
  writeFileSync(join(root, 'node_modules', '@ephemeral-ai', 'mayfly', 'package.json'), JSON.stringify({ name: '@ephemeral-ai/mayfly', version }))
}

describe('main', () => {
  it('answers -V with the shell, Mayfly pin, and harness line in one line', async () => {
    fixtureLauncher()
    await main(['-V'])
    expect(captures.out).toEqual([`mayfly ${PIN} (Mayfly @ephemeral-ai/mayfly@${PIN} · harness @deepseek-ai/dsh@0.1.2-alpha.5)\n`])
    expect(captures.exits).toEqual([])
  })

  it('refuses to boot when the bundled runtime cannot be materialized', async () => {
    fixtureLauncher()
    cliInternals.readTextFile = path => path.includes('@deepseek-ai') ? undefined : REAL.readTextFile(path)
    cliInternals.extractRuntimeArchive = async () => { throw new Error('corrupt payload') }
    await main(['task'])
    expect(captures.err).toEqual(['mayfly: bundled dsh runtime is unavailable — corrupt payload; reinstall @ephemeral-ai/mayfly-cli\n'])
    expect(captures.exits).toEqual([1])
  })

  it('boots without a word when the profile already carries the pin, marking the child MAYFLY_LAUNCHER', async () => {
    const { calls, root, hostBin } = fixtureLauncher()
    installBundle(root, PIN)
    let inherit: SpawnOutcome = OK
    cliInternals.spawnInherit = async (cmd, args, opts) => {
      calls.inherit.push({ cmd, args, env: opts?.env })
      return inherit
    }
    await main(['fix', 'the', 'build'])
    expect(captures.err).toEqual([])
    expect(calls.inherit).toHaveLength(1)
    expect(calls.inherit[0]?.cmd).toBe(cliInternals.execPath)
    expect(calls.inherit[0]?.args).toEqual([hostBin, '--profile', 'mayfly', 'fix', 'the', 'build'])
    expect(calls.inherit[0]?.env).toMatchObject({ MAYFLY_LAUNCHER: 'mayfly' })
    expect(calls.inherit[0]?.env?.MAYFLY_DSH_BIN).toBe(hostBin)
    expect(captures.exits).toEqual([0])
    inherit = { code: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: false }
    captures.exits = []
    await main([])
    expect(captures.exits).toEqual([1])
  })

  it('boots an ahead profile as-is with the reinstall pointer, never downgrading', async () => {
    const { calls, root } = fixtureLauncher()
    installBundle(root, AHEAD)
    let once = false
    cliInternals.spawnOnce = async () => { once = true; return OK }
    cliInternals.spawnInherit = async (cmd, args, opts) => {
      calls.inherit.push({ cmd, args, env: opts?.env })
      return OK
    }
    await main(['task'])
    expect(once).toBe(false)
    expect(captures.err).toEqual([
      `mayfly: profile 'mayfly' is at @ephemeral-ai/mayfly@${AHEAD}, ahead of this shell (${PIN}) — reinstall to advance: npm -g install @ephemeral-ai/mayfly-cli\n`,
    ])
    expect(calls.inherit).toHaveLength(1)
    expect(captures.exits).toEqual([0])
  })

  it('announces a first install, then execs; and skips a dev link lane with a notice', async () => {
    const { calls, root } = fixtureLauncher()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@ephemeral-ai/mayfly': 'link:/checkout' } }))
    cliInternals.spawnInherit = async (cmd, args, opts) => {
      calls.inherit.push({ cmd, args, env: opts?.env })
      return OK
    }
    await main([])
    expect(captures.err).toEqual(["mayfly: profile 'mayfly' is a dev link lane — calibration skipped\n"])
    expect(calls.inherit).toHaveLength(1)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }))
    cliInternals.spawnOnce = async () => {
      installBundle(root, PIN)
      return OK
    }
    captures.err = []
    await main([])
    expect(captures.err).toEqual([`mayfly: installed @ephemeral-ai/mayfly@${PIN} into profile 'mayfly'\n`])
  })

  it('fails bootstrap with the classified manual pointer and output tail, never execing', async () => {
    fixtureLauncher()
    cliInternals.spawnOnce = async () => ({ code: 1, signal: null, stdout: '', stderr: 'pnpm: ETARGET\n', timedOut: false })
    let inherited = false
    cliInternals.spawnInherit = async () => {
      inherited = true
      return OK
    }
    await main(['task'])
    expect(captures.err).toEqual([
      `mayfly: bootstrap failed — pnpm: ETARGET\n  manual: fix the cause and re-run mayfly (with a global dsh: dsh plugin --profile mayfly add @ephemeral-ai/mayfly@${PIN})\n`,
    ])
    expect(captures.exits).toEqual([1])
    expect(inherited).toBe(false)
  })

  it('routes a pnpm-missing bootstrap to the pnpm manual line', async () => {
    fixtureLauncher()
    cliInternals.spawnOnce = async (cmd, args) => args[args.length - 1] === '--version'
      ? cliInternals.platform === 'win32'
        ? { code: 9009, signal: null, stdout: '', stderr: '', timedOut: false }
        : { code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'Error: spawn pnpm ENOENT' }
      : OK
    let inherited = false
    cliInternals.spawnInherit = async () => {
      inherited = true
      return OK
    }
    await main(['task'])
    expect(captures.err).toEqual([
      'mayfly: bootstrap failed — pnpm is missing on PATH — npm i -g pnpm@11 (or: corepack enable pnpm@11)\n  manual: npm i -g pnpm@11 (or: corepack enable pnpm@11), then re-run mayfly\n',
    ])
    expect(captures.exits).toEqual([1])
    expect(inherited).toBe(false)
  })

  it('routes an unsupported pnpm major to the pnpm 11 manual line', async () => {
    fixtureLauncher()
    cliInternals.spawnOnce = async (cmd, args) => args[args.length - 1] === '--version'
      ? { code: 0, signal: null, stdout: '10.4.1\n', stderr: '', timedOut: false }
      : OK
    await main(['task'])
    expect(captures.err).toEqual([
      'mayfly: bootstrap failed — pnpm 11 is required — npm i -g pnpm@11 (or: corepack enable pnpm@11)\n  manual: npm i -g pnpm@11 (or: corepack enable pnpm@11), then re-run mayfly\n',
    ])
    expect(captures.exits).toEqual([1])
  })

  it('routes a timed-out bootstrap to the resume manual line', async () => {
    fixtureLauncher()
    cliInternals.spawnOnce = async () => ({ code: null, signal: null, stdout: '', stderr: 'mayfly: install timed out', timedOut: true })
    await main(['task'])
    expect(captures.err).toEqual([
      'mayfly: bootstrap failed — install timed out after 20 minutes\n  mayfly: install timed out\n  manual: re-run mayfly — downloaded packages are cached and the install resumes\n',
    ])
    expect(captures.exits).toEqual([1])
  })

  it('prints the failure tail as indented lines between verdict and manual', async () => {
    fixtureLauncher()
    cliInternals.spawnOnce = async (cmd, args) => args[args.length - 1] === '--version'
      ? OK
      : { code: 1, signal: null, stdout: '', stderr: 'first line\nsecond line\nETARGET no match\n', timedOut: false }
    await main(['task'])
    expect(captures.err).toEqual([
      'mayfly: bootstrap failed — ETARGET no match\n  first line\n  second line\n  manual: fix the cause and re-run mayfly (with a global dsh: dsh plugin --profile mayfly add @ephemeral-ai/mayfly@'
      + `${PIN})\n`,
    ])
    expect(captures.exits).toEqual([1])
  })

  it('forwards the plugin surface without calibrating', async () => {
    const { calls } = fixtureLauncher()
    let once = false
    cliInternals.spawnOnce = async () => { once = true; return OK }
    cliInternals.spawnInherit = async (cmd, args, opts) => {
      calls.inherit.push({ cmd, args, env: opts?.env })
      return OK
    }
    await main(['plugin', 'add', '@ephemeral-ai/mayfly@rc'])
    expect(once).toBe(false)
    expect(calls.inherit[0]?.args?.slice(1)).toEqual(['plugin', '--profile', 'mayfly', 'add', '@ephemeral-ai/mayfly@rc'])
    expect(captures.exits).toEqual([0])
  })

  it('passes read-only plugin commands directly to dsh', async () => {
    const { calls, hostBin } = fixtureLauncher()
    cliInternals.spawnInherit = async (cmd, args, opts) => {
      calls.inherit.push({ cmd, args, env: opts?.env })
      return OK
    }
    await main(['plugin', 'list'])
    expect(captures.err).toEqual([])
    expect(calls.inherit[0]?.args).toEqual([hostBin, 'plugin', '--profile', 'mayfly', 'list'])
    expect(captures.exits).toEqual([0])
  })

  it('skips calibration on the version and plugin surfaces', async () => {
    const { calls } = fixtureLauncher()
    cliInternals.spawnInherit = async (cmd, args, opts) => {
      calls.inherit.push({ cmd, args, env: opts?.env })
      return OK
    }
    await main(['-V'])
    await main(['plugin', 'add', '@ephemeral-ai/mayfly@rc'])
  })
})

describe('shellVersion', () => {
  it('reads the real manifest version', () => {
    expect(shellVersion()).toBe(PIN)
  })

  it('reads a broken manifest as unknown', () => {
    cliInternals.readTextFile = () => undefined
    expect(shellVersion()).toBe('unknown')
    cliInternals.readTextFile = () => '{ not json'
    expect(shellVersion()).toBe('unknown')
    cliInternals.readTextFile = () => JSON.stringify({ version: 3 })
    expect(shellVersion()).toBe('unknown')
  })
})
