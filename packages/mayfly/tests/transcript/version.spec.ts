/**
 * The global version-control guard for one Mayfly release version and the one
 * Harness line every package rides.
 *
 * Mayfly side: the four release package.json versions plus the website (whose
 * package.json must agree with its own tagline), and the `MAYFLY_VERSION`
 * constant the banner title and the `/version` panel read, all equal. The
 * website's user-facing version mentions (index.md tagline, guide/faq) are
 * pinned here too, so the site can never advertise a different number than
 * the code ships.
 *
 * Harness side: every dependency, development, and peer pin, and the workspace
 * release-age exclusions, name the same line. It is not tied to Mayfly's
 * release number; the `/version` panel shows the line the Host advertises.
 *
 * A bump edits one side at a time: publishing Mayfly bumps the release
 * manifests + MAYFLY_VERSION + the website copy; upgrading the Harness line
 * updates every pin and sentinel together.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'

/** The published release version (the website's advertised number). */
const RELEASE_VERSION = '0.1.5'
/** The harness prerelease line every dsh pin rides. */
const HARNESS_LINE = '0.2.2-rc.1'

/** One workspace package manifest. */
interface Manifest {
  readonly name: string
  readonly version: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

/** Every release manifest plus the website. */
const MANIFESTS: readonly string[] = [
  '../../package.json',
  '../../../ui/package.json',
  '../../../cli/package.json',
  '../../../host/package.json',
  '../../../../website/package.json',
]
/** Publishable manifests that carry official runtime Harness pins. */
const HARNESS_MANIFESTS = MANIFESTS.filter(rel => !rel.endsWith('/website/package.json'))

/** Read one manifest relative to this spec. */
function manifest(rel: string): Manifest {
  return JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as Manifest
}

/** The dsh-harness dependency pins of one manifest's dependency table. */
function dshEntries(table: Readonly<Record<string, string>> | undefined): ReadonlyArray<[string, string]> {
  return Object.entries(table ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
}

describe('the Mayfly release line', () => {
  it('MAYFLY_VERSION is the version of all release manifests and website', () => {
    expect(MANIFESTS).toHaveLength(5)
    for (const rel of MANIFESTS) {
      const pkg = manifest(rel)
      expect(pkg.version, `${pkg.name} version`).toBe(RELEASE_VERSION)
    }
  })

  it('MAYFLY_VERSION is the constant', () => {
    expect(MAYFLY_VERSION).toBe(RELEASE_VERSION)
  })

  it('the website never advertises a different number than the code ships', () => {
    const zh = readFileSync(new URL('../../../../website/index.md', import.meta.url), 'utf8')
    const en = readFileSync(new URL('../../../../website/en/index.md', import.meta.url), 'utf8')
    expect(zh).toContain(`v${RELEASE_VERSION}`)
    expect(en).toContain(`v${RELEASE_VERSION}`)
    // Reference pins on guide/FAQ pages remain immutable across release bumps.
    const zhReference = readFileSync(new URL('../../../../website/plugins/ui-reference.md', import.meta.url), 'utf8')
    const enReference = readFileSync(new URL('../../../../website/en/plugins/ui-reference.md', import.meta.url), 'utf8')
    expect(zhReference).toContain(RELEASE_VERSION)
    expect(enReference).toContain(RELEASE_VERSION)
  })

  it('release packages pin every internal Mayfly dependency exactly', () => {
    const releaseNames = new Set(MANIFESTS.map(rel => manifest(rel).name))
    for (const rel of MANIFESTS.filter(rel => !rel.endsWith('/website/package.json'))) {
      const pkg = manifest(rel)
      for (const table of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const) {
        for (const [name, spec] of Object.entries(pkg[table] ?? {})) {
          if (!name.startsWith('@ephemeral-ai/') || name === pkg.name || !releaseNames.has(name)) continue
          // The launcher installs published packages, so it pins them exactly; workspace packages link each other.
          expect(spec, `${pkg.name} ${table} ${name}`).toBe(pkg.name === '@ephemeral-ai/mayfly-cli' ? RELEASE_VERSION : 'workspace:*')
        }
      }
    }
  })
})

describe('the harness dependency line', () => {
  it('every dsh runtime dependency is exact-pinned to one line', () => {
    const specs = new Set<string>()
    for (const rel of HARNESS_MANIFESTS) {
      const pkg = manifest(rel)
      for (const [name, spec] of dshEntries(pkg.dependencies)) {
        expect(spec, `${pkg.name} dependencies ${name}`).toMatch(/^0\.[0-9]+\.[0-9]+-(?:alpha|rc)\.[0-9]+$/)
        specs.add(spec)
      }
    }
    expect(specs.size, 'runtime dsh pins exist').toBeGreaterThan(0)
    expect([...specs]).toEqual([HARNESS_LINE])
  })

  it('every dsh dev dependency is exact-pinned to one line', () => {
    for (const rel of HARNESS_MANIFESTS) {
      const pkg = manifest(rel)
      const specs = new Set<string>()
      for (const [name, spec] of dshEntries(pkg.devDependencies)) {
        expect(spec, `${pkg.name} devDependencies ${name}`).toMatch(/^0\.[0-9]+\.[0-9]+-(?:alpha|rc)\.[0-9]+$/)
        specs.add(spec)
      }
      if (specs.size > 0) expect([...specs], pkg.name).toEqual([HARNESS_LINE])
    }
  })

  it('every dsh peer dependency ranges exactly one line up from the pins', () => {
    for (const rel of HARNESS_MANIFESTS) {
      const pkg = manifest(rel)
      for (const [name, spec] of dshEntries(pkg.peerDependencies)) {
        expect(spec, `${pkg.name} peerDependencies ${name}`).toBe(HARNESS_LINE)
      }
    }
  })

  it('the workspace release-age excludes pin the Harness line', () => {
    const workspace = readFileSync(new URL('../../../../pnpm-workspace.yaml', import.meta.url), 'utf8')
    const pins = [...workspace.matchAll(/'(@deepseek-ai\/dsh-[a-z-]+)@([^']+)'/g)]
    expect(pins.length).toBeGreaterThan(0)
    for (const [, name, spec] of pins) {
      expect(spec, `pnpm-workspace exclude ${name}`).toBe(HARNESS_LINE)
    }
  })

  it('the /version panel shows the Host-advertised harness line, not one derived from the Mayfly number', () => {
    const source = readFileSync(new URL('../../src/app/interactions/plain-panels.ts', import.meta.url), 'utf8')
    expect(source).toContain("harness: harness ?? this.t('not advertised by the Host')")
    expect(source).not.toContain(HARNESS_LINE)
  })

  it('split verification resolves the packaged current runtime without changing global dsh', () => {
    const split = readFileSync(new URL('../../../../script/split-parity.mjs', import.meta.url), 'utf8')
    expect(split).toContain("createRequire(resolve(root, 'packages/cli/package.json')).resolve('@deepseek-ai/dsh/lib/bin.js')")
    const ci = readFileSync(new URL('../../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    expect(ci).not.toContain('npm install -g "@deepseek-ai/dsh@')
  })
})
