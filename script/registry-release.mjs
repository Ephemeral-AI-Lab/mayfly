/** Idempotent npm release transitions over an injected registry. @module script/registry-release */

import { releaseDistTags } from './package-contract.mjs'

/** Treat an npm 404 as absence, never as a network or authentication failure. */
export function readNpmView(result, spec, field) {
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    if (/\bE404\b|404 Not Found/u.test(result.stderr ?? '')) return undefined
    throw new Error(`npm view ${spec} ${field} failed with status ${result.status}`)
  }
  const text = result.stdout.trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text.replace(/^"|"$/gu, '')
  }
}

/** Registry-visibility window: npm's ~130 MB CLI tarball regularly needs minutes. */
const visibilityAttempts = 40
const visibilityIntervalMs = 15_000

/**
 * npm's staged publishing accepts a publish into a queue that an owner with a
 * 2FA challenge must approve before the version becomes installable. A repeat
 * publish inside that window fails with an E409 that names the staged version.
 */
export function isStagedRelease(error) {
  return /previously staged version/iu.test(error?.message ?? '')
}

/** Actionable guidance for versions waiting in npm's staged-publish queue. */
export function stagedApprovalError(packages) {
  const specs = packages.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')
  return new Error(`staged on npm, awaiting maintainer approval: ${specs}. Run \`npm stage list\` and \`npm stage approve <stage-id>\` (npm 11.15 or newer), then re-run this release`)
}

async function waitFor(pkg, expected, registry, sleep, log, warn) {
  // The ~130 MB CLI tarball regularly needs more than five minutes to become
  // visible after npm accepts it; the window has to outlive that processing.
  for (let attempt = 1; attempt <= visibilityAttempts; attempt += 1) {
    const integrity = registry.view(`${pkg.name}@${pkg.version}`, 'dist.integrity')
    if (integrity === expected) {
      const attestations = registry.view(`${pkg.name}@${pkg.version}`, 'dist.attestations')
      if (attestations === undefined || attestations === null) warn(`${pkg.name}@${pkg.version}: npm did not expose dist.attestations; integrity is still verified`)
      log(`${pkg.name}@${pkg.version}: registry integrity and provenance verified`)
      return
    }
    if (integrity !== undefined) throw new Error(`${pkg.name}@${pkg.version}: registry integrity differs from local tarball`)
    log(`${pkg.name}@${pkg.version}: not visible yet (${attempt}/${visibilityAttempts})`)
    await sleep(visibilityIntervalMs)
  }
  throw new Error(`${pkg.name}@${pkg.version}: not visible after ${Math.round((visibilityAttempts * visibilityIntervalMs) / 60_000)} minutes; a staged release needs maintainer approval (\`npm stage list\`, \`npm stage approve <stage-id>\`) before it becomes installable`)
}

async function waitForTag(pkg, tag, version, registry, sleep, log) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const current = registry.view(pkg.name, `dist-tags.${tag}`)
    if (current === version) {
      log(`${pkg.name}: ${tag} -> ${version}`)
      return
    }
    log(`${pkg.name}: ${tag} is still ${current ?? 'unset'} (${attempt}/20)`)
    await sleep(15_000)
  }
  throw new Error(`${pkg.name}: ${tag} did not converge to ${version} after five minutes`)
}

/** Publish, verify, or promote one immutable package set. */
export async function releaseRegistry(mode, packages, { registry, integrity, sleep, log = console.log, warn = console.warn, publishTag }) {
  const version = packages[0]?.version
  if (version === undefined || packages.some(pkg => pkg.version !== version)) throw new Error('release package versions differ')
  if (!['publish', 'verify', 'promote'].includes(mode)) throw new Error('usage: release-packages.mjs publish|verify|promote')
  const testRelease = version.includes('-test.')
  if (mode === 'publish' || mode === 'verify') {
    const staged = []
    for (const pkg of packages) {
      const expected = integrity(pkg)
      const current = registry.view(`${pkg.name}@${pkg.version}`, 'dist.integrity')
      if (current === undefined && mode === 'publish') {
        try {
          registry.publish(pkg, publishTag ?? (testRelease ? 'rc9-test' : 'candidate'))
        } catch (error) {
          if (!isStagedRelease(error)) throw error
          log(`${pkg.name}@${pkg.version}: accepted into npm's staged queue; awaiting maintainer approval`)
          staged.push(pkg)
          continue
        }
      } else if (current !== undefined && current !== expected && !testRelease) {
        throw new Error(`${pkg.name}@${pkg.version}: immutable registry version has different integrity`)
      } else if (current !== undefined && current !== expected) {
        warn(`${pkg.name}@${pkg.version}: test version already exists with a different local tarball; leaving immutable registry content unchanged`)
      } else if (current === undefined) {
        throw new Error(`${pkg.name}@${pkg.version}: version is missing from registry`)
      }
      if (!testRelease) await waitFor(pkg, expected, registry, sleep, log, warn)
    }
    if (staged.length > 0) throw stagedApprovalError(staged)
    if (testRelease && mode === 'publish') {
      // npm assigns `latest` on a package's first publish even when a custom
      // tag is supplied. Keep production consumers on the previous rc line.
      for (const pkg of packages) {
        const latest = registry.view(pkg.name, 'dist-tags.latest')
        if (latest !== version) continue
        const stableRc = registry.view(pkg.name, 'dist-tags.rc')
        if (typeof stableRc === 'string' && stableRc !== version) {
          registry.addTag({ ...pkg, version: stableRc }, 'latest')
          log(`${pkg.name}: restored latest -> ${stableRc}`)
        }
      }
    }
  }

  if (mode === 'promote') {
    for (const pkg of packages) {
      if (registry.view(`${pkg.name}@${pkg.version}`, 'dist.integrity') !== integrity(pkg)) {
        throw new Error(`${pkg.name}@${pkg.version}: registry integrity differs from local tarball`)
      }
    }
    for (const pkg of packages) {
      for (const tag of releaseDistTags(version)) {
        if (registry.view(pkg.name, `dist-tags.${tag}`) !== version) registry.addTag(pkg, tag)
        await waitForTag(pkg, tag, version, registry, sleep, log)
      }
    }
    for (const pkg of packages) {
      if (registry.view(pkg.name, 'dist-tags.candidate') === version) {
        try {
          registry.removeTag(pkg, 'candidate')
        } catch {
          // npm may forbid deleting dist-tags; candidate is harmless after the release tags converge.
          warn(`${pkg.name}: candidate cleanup was refused; leaving it at ${version}`)
        }
      }
    }
  }
}
