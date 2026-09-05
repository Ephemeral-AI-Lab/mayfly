/**
 * Tests for the updater's profile module (D52): the argv profile scan,
 * home/root resolution, dsh discovery, profile facts (specs, installed
 * versions, lane violations), and the snapshot/restore round trip.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'

registerTempDirCleanup()
import { updaterInternals } from '../../src/interaction/updater/io.ts'
import { profileNameFromArgv } from '../../src/internal/profile.ts'
import {
  appendUpdateLog,
  backupDir,
  dshHome,
  findDshCommand,
  profileRoot,
  readProfileFacts,
  restoreSnapshot,
  snapshotProfile,
} from '../../src/interaction/updater/profile.ts'

/** The real seams, restored after every test. */
const REAL = { ...updaterInternals }

afterEach(() => {
  Object.assign(updaterInternals, REAL)
})

/** Write a profile fixture into a fresh temp dir and return its root. */
function fixtureProfile(files: Record<string, string>): string {
  const root = mkdtempTracked('mayfly-updater-profile-')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** A package.json text for a manifest fixture. */
function manifestJson(dependencies: Record<string, string>, devDependencies?: Record<string, string>): string {
  return JSON.stringify({ name: 'profile', dependencies, ...(devDependencies === undefined ? {} : { devDependencies }) })
}

/** An installed-package manifest with just a version. */
function installedJson(version: string): string {
  return JSON.stringify({ name: 'pkg', version })
}

/** The package managed by the updater. */
const RC2_NAMES = ['@ephemeral-ai/mayfly']

/** Install the release set at one version inside a fixture root. */
function installSet(root: string, version: string): void {
  for (const name of RC2_NAMES) {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), installedJson(version))
  }
}

describe('updater/profile profileNameFromArgv', () => {
  it('reads --profile= and the spaced pair, defaulting to mayfly', () => {
    expect(profileNameFromArgv(['node', 'dsh', '--profile=work'])).toBe('work')
    expect(profileNameFromArgv(['node', 'dsh', '--profile', 'work'])).toBe('work')
    expect(profileNameFromArgv(['node', 'dsh', '--profile'])).toBe('mayfly')
    expect(profileNameFromArgv(['node', 'dsh', '--profile', '--other'])).toBe('mayfly')
    expect(profileNameFromArgv(['node', 'dsh'])).toBe('mayfly')
  })
})

describe('updater/profile home and root resolution', () => {
  it('prefers DSH_HOME and falls back to ~/.dsh', () => {
    updaterInternals.env = { DSH_HOME: '/custom/home' }
    expect(dshHome()).toBe('/custom/home')
    expect(profileRoot('mayfly')).toBe(join('/custom/home', 'profiles', 'mayfly'))
    updaterInternals.env = { DSH_HOME: '' }
    updaterInternals.homedir = () => '/fake/home'
    expect(dshHome()).toBe(join('/fake/home', '.dsh'))
    expect(profileRoot('work')).toBe(join('/fake/home', '.dsh', 'profiles', 'work'))
  })
})

describe('updater/profile findDshCommand', () => {
  it('executes the launcher entry using Node with no global dsh installation', async () => {
    const root = fixtureProfile({ 'nested host/入口.cjs': 'process.stdout.write(JSON.stringify(process.argv.slice(2)))' })
    const bin = join(root, 'nested host', '入口.cjs')
    updaterInternals.env = { MAYFLY_DSH_BIN: bin, DSH_BIN: '/wrong/global/dsh' }
    const resolved = await findDshCommand()
    expect(resolved).toBeDefined()
    if (resolved === undefined) throw new Error('expected bundled host')
    const result = await updaterInternals.spawnOnce(resolved.command, [...resolved.args, 'plugin', '--profile', 'space profile', 'add', 'literal$&package'], { env: { PATH: root } })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['plugin', '--profile', 'space profile', 'add', 'literal$&package'])
  })

  it('uses explicit native and JavaScript commands without PATH fallback', async () => {
    updaterInternals.env = { DSH_BIN: '/opt/bin/dsh' }
    await expect(findDshCommand()).resolves.toEqual({ command: '/opt/bin/dsh', args: [] })
    updaterInternals.env = { DSH_BIN: '/missing space/host.mjs' }
    await expect(findDshCommand()).resolves.toEqual({ command: process.execPath, args: ['/missing space/host.mjs'] })
    updaterInternals.env = { DSH_BIN: '/global/dsh', MAYFLY_DSH_BIN: '/bundled space/host.js' }
    await expect(findDshCommand()).resolves.toEqual({ command: process.execPath, args: ['/bundled space/host.js'] })
  })

  it('probes PATH directly without a POSIX shell', async () => {
    updaterInternals.env = { DSH_BIN: '', MAYFLY_DSH_BIN: '' }
    updaterInternals.spawnOnce = (command, args) => {
      expect(command).toBe('dsh')
      expect(args).toEqual(['--version'])
      return Promise.resolve({ code: 0, signal: null, stdout: 'dsh 0.1.2\n', stderr: '', timedOut: false })
    }
    await expect(findDshCommand()).resolves.toEqual({ command: 'dsh', args: [] })
  })

  it('returns undefined when the lookup fails or comes back empty', async () => {
    updaterInternals.env = {}
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'not found', timedOut: false })
    await expect(findDshCommand()).resolves.toBeUndefined()
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ code: 0, signal: null, stdout: '\n', stderr: '', timedOut: true })
    await expect(findDshCommand()).resolves.toBeUndefined()
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' })
    await expect(findDshCommand()).resolves.toBeUndefined()
  })
})

describe('updater/profile readProfileFacts', () => {
  it('reads a healthy npm-only profile', () => {
    const root = fixtureProfile({ 'package.json': manifestJson({ '@ephemeral-ai/mayfly': '0.1.0-rc.2' }) })
    installSet(root, '0.1.0-rc.2')
    const facts = readProfileFacts(root)
    expect(facts.manifest).toBeDefined()
    expect(facts.specs['@ephemeral-ai/mayfly']).toBe('0.1.0-rc.2')
    expect(facts.installed['@ephemeral-ai/mayfly']).toBe('0.1.0-rc.2')
    expect(facts.linked).toEqual([])
  })

  it('merges devDependencies and flags link/file specs', () => {
    const root = fixtureProfile({
      'package.json': manifestJson(
        { '@ephemeral-ai/mayfly': 'link:../../mayfly/packages/mayfly' },
        { '@ephemeral-ai/other': 'file:../other' },
      ),
    })
    installSet(root, '0.1.0-rc.2')
    const facts = readProfileFacts(root)
    expect(facts.specs['@ephemeral-ai/mayfly']).toBe('link:../../mayfly/packages/mayfly')
    expect(facts.specs['@ephemeral-ai/other']).toBe('file:../other')
    expect(facts.linked).toEqual(['@ephemeral-ai/mayfly'])
  })

  it('treats a missing or broken manifest as absent but still reads installs', () => {
    const noManifest = fixtureProfile({})
    installSet(noManifest, '0.1.0-rc.2')
    expect(readProfileFacts(noManifest).manifest).toBeUndefined()

    const broken = fixtureProfile({ 'package.json': '{not json' })
    installSet(broken, '0.1.0-rc.2')
    const facts = readProfileFacts(broken)
    expect(facts.manifest).toBeUndefined()
    expect(facts.specs).toEqual({})
    expect(facts.installed['@ephemeral-ai/mayfly']).toBe('0.1.0-rc.2')
  })

  it('skips malformed dependency blocks and non-string installed versions', () => {
    const root = fixtureProfile({
      'package.json': JSON.stringify({
        name: 'profile',
        dependencies: { '@ephemeral-ai/mayfly': '0.1.0-rc.2', weird: 7 },
        devDependencies: 'not an object',
      }),
    })
    installSet(root, '0.1.0-rc.2')
    const badInstall = join(root, 'node_modules', '@ephemeral-ai', 'mayfly', 'package.json')
    writeFileSync(badInstall, JSON.stringify({ version: 9 }))
    const facts = readProfileFacts(root)
    expect(facts.specs['@ephemeral-ai/mayfly']).toBe('0.1.0-rc.2')
    expect(facts.specs.weird).toBeUndefined()
    expect(facts.installed['@ephemeral-ai/mayfly']).toBeUndefined()
  })

  it('reports missing installs as absent', () => {
    const root = fixtureProfile({ 'package.json': manifestJson({}) })
    const facts = readProfileFacts(root)
    expect(facts.installed['@ephemeral-ai/mayfly']).toBeUndefined()
  })

  it('reads a broken installed manifest as absent', () => {
    const root = fixtureProfile({ 'package.json': manifestJson({}) })
    const dir = join(root, 'node_modules', '@ephemeral-ai', 'mayfly')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{nope')
    expect(readProfileFacts(root).installed['@ephemeral-ai/mayfly']).toBeUndefined()
  })

  it('reads a non-object installed manifest as absent', () => {
    const root = fixtureProfile({ 'package.json': manifestJson({}) })
    const dir = join(root, 'node_modules', '@ephemeral-ai', 'mayfly')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '7')
    expect(readProfileFacts(root).installed['@ephemeral-ai/mayfly']).toBeUndefined()
  })
})

describe('updater/profile snapshot and restore', () => {
  it('round-trips the manifest files that exist and records the intent', () => {
    const root = fixtureProfile({
      'package.json': manifestJson({ '@ephemeral-ai/mayfly': '0.1.0-rc.2' }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    })
    snapshotProfile(root, { fromVersion: '0.1.0-rc.2', toVersion: '0.1.0-rc.3', createdAt: 1_000, files: [] })
    const manifest = JSON.parse(readFileSync(join(backupDir(root), 'manifest.json'), 'utf8')) as {
      files: string[]
    }
    expect(manifest.files).toEqual(['package.json', 'pnpm-lock.yaml'])
    // A swap that leaves a half-written tree behind.
    writeFileSync(join(root, 'package.json'), 'garbage')
    expect(restoreSnapshot(root)).toBe(true)
    expect(readProfileFacts(root).specs['@ephemeral-ai/mayfly']).toBe('0.1.0-rc.2')
  })

  it('restore refuses when no snapshot or a broken manifest exists', () => {
    const empty = fixtureProfile({})
    expect(restoreSnapshot(empty)).toBe(false)
    const broken = fixtureProfile({})
    updaterInternals.ensureDir(join(broken, '.mayfly-update-backup'))
    writeFileSync(join(broken, '.mayfly-update-backup', 'manifest.json'), '{nope')
    expect(restoreSnapshot(broken)).toBe(false)
    writeFileSync(join(broken, '.mayfly-update-backup', 'manifest.json'), JSON.stringify({ files: 'nope' }))
    expect(restoreSnapshot(broken)).toBe(false)
    writeFileSync(join(broken, '.mayfly-update-backup', 'manifest.json'), JSON.stringify({ files: [7, 'package.json'] }))
    // The number is skipped and the never-snapshotted package.json is
    // absent from the backup — restore is best-effort and still true.
    expect(restoreSnapshot(broken)).toBe(true)
  })

  it('appendUpdateLog creates and extends the log', () => {
    const root = fixtureProfile({})
    appendUpdateLog(root, 'first')
    appendUpdateLog(root, 'second')
    expect(readFileSync(join(backupDir(root), 'update.log'), 'utf8')).toBe('first\nsecond\n')
  })

  it('appendUpdateLog truncates an over-cap log to its tail under a marker', () => {
    const root = fixtureProfile({})
    const logPath = join(backupDir(root), 'update.log')
    updaterInternals.ensureDir(backupDir(root))
    const head = 'old line\n'
    const tail = 'recent line\n'
    writeFileSync(logPath, `${head.repeat(30_000)}${tail.repeat(6_000)}`)
    appendUpdateLog(root, 'next')
    const result = readFileSync(logPath, 'utf8')
    expect(result).toContain('… log truncated …')
    expect(result.endsWith(`${tail}next\n`)).toBe(true)
    expect(result.length).toBeLessThan(100 * 1024)
  })

  it('snapshot replaces the slot atomically and cleans a stale staging dir', () => {
    const root = fixtureProfile({ 'package.json': manifestJson({ '@ephemeral-ai/mayfly': '0.1.0-rc.2' }) })
    snapshotProfile(root, { fromVersion: '0.1.0-rc.2', toVersion: '0.1.0-rc.3', createdAt: 1, files: [] })
    expect(readFileSync(join(backupDir(root), 'package.json'), 'utf8')).toContain('0.1.0-rc.2')
    // Debris of a killed snapshot run: cleaned at the next snapshot start.
    mkdirSync(`${backupDir(root)}.tmp`, { recursive: true })
    writeFileSync(join(`${backupDir(root)}.tmp`, 'stale.txt'), 'stale')
    writeFileSync(join(root, 'package.json'), manifestJson({ '@ephemeral-ai/mayfly': '0.1.0-rc.3' }))
    snapshotProfile(root, { fromVersion: '0.1.0-rc.3', toVersion: '0.1.0-rc.4', createdAt: 2, files: [] })
    expect(readFileSync(join(backupDir(root), 'package.json'), 'utf8')).toContain('0.1.0-rc.3')
    const manifest = JSON.parse(readFileSync(join(backupDir(root), 'manifest.json'), 'utf8')) as { toVersion: string }
    expect(manifest.toVersion).toBe('0.1.0-rc.4')
    expect(() => readFileSync(join(`${backupDir(root)}.tmp`, 'stale.txt'), 'utf8')).toThrow()
  })
})
