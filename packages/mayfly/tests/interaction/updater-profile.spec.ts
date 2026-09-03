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
import {
  appendUpdateLog,
  backupDir,
  dshHome,
  findDshBin,
  profileNameFromArgv,
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

describe('updater/profile findDshBin', () => {
  it('honors DSH_BIN first', async () => {
    updaterInternals.env = { DSH_BIN: '/opt/bin/dsh' }
    await expect(findDshBin()).resolves.toBe('/opt/bin/dsh')
  })

  it('falls back to command -v dsh', async () => {
    updaterInternals.env = {}
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ code: 0, signal: null, stdout: '/usr/bin/dsh\n', stderr: '', timedOut: false })
    await expect(findDshBin()).resolves.toBe('/usr/bin/dsh')
  })

  it('returns undefined when the lookup fails or comes back empty', async () => {
    updaterInternals.env = {}
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ code: 1, signal: null, stdout: '', stderr: 'not found', timedOut: false })
    await expect(findDshBin()).resolves.toBeUndefined()
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ code: 0, signal: null, stdout: '\n', stderr: '', timedOut: false })
    await expect(findDshBin()).resolves.toBeUndefined()
    updaterInternals.spawnOnce = () =>
      Promise.resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' })
    await expect(findDshBin()).resolves.toBeUndefined()
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
