/**
 * The update family's pre-flight gates (D52): pure verdicts over facts
 * the caller gathered through the io seam, so every lane rule and
 * release lesson has one testable home. The gates encode, in order:
 * the lane rule (`link:` pollution refuses — the Frankenstein boot),
 * installed-package consistency, target existence, the Mayfly version floor,
 * the host harness line (the global dsh
 * CLI must meet the bundle's pin), the pnpm cooldown forecast (a
 * fresh release is hard-refused by `minimumReleaseAge`; the user gets
 * an ETA, never a silent bypass), and the downgrade notice (an older
 * target warns that the full set is reinstalled).
 *
 * @module @ephemeral-ai/mayfly/interaction/updater/preflight
 */

import type { Packument } from './registry.ts'
import { interpolateLocaleMessage, type MayflyTranslate } from '../../frontend/index.ts'
import type { ProfileFacts } from './profile.ts'
import { compareVersions, isVersion, VERSION_FLOOR } from './version.ts'

/** pnpm 11's default cooldown window, in minutes (the R4 measurement). */
export const DEFAULT_COOLDOWN_MINUTES = 1440

/** A blocking gate's verdict — it stops the update and carries its message. */
export interface BlockingVerdict {
  /** Stable gate id (`link-pollution`, `host-line`, …). */
  readonly code: string
  readonly blocking: true
  /** The user-facing explanation, printed verbatim. */
  readonly message: string
}

/** A passing gate's verdict — optionally a warning that rides along. */
export interface PassingVerdict {
  /** Stable gate id. */
  readonly code: string
  readonly blocking: false
  /** The warning text, when the gate wants to say something anyway. */
  readonly message?: string
}

/** A gate's verdict; blocking gates stop before anything is touched. */
export type Verdict = BlockingVerdict | PassingVerdict

/** The repair recipe every blocking lane/set verdict offers. */
export function repairRecipe(names: readonly string[], version: string, t: MayflyTranslate = interpolateLocaleMessage): string {
  const specs = names.map(name => `${name}@${version}`).join(' ')
  return t('repair: dsh plugin --profile <name> add {specs} (reinstall by exact version) or delete the profile directory and re-add', { specs })
}

/**
 * Gate 1 — the lane rule: a production profile must be npm-only. A
 * `link:`/`file:` spec half-survives the next npm upgrade and boots
 * `ERR_MODULE_NOT_FOUND` (the state found on the maintainer's machine
 * after R1); pnpm warns about nothing.
 */
export function checkLinkPollution(facts: ProfileFacts, t: MayflyTranslate = interpolateLocaleMessage): Verdict {
  if (facts.linked.length === 0) return { code: 'link-pollution', blocking: false }
  return {
    code: 'link-pollution',
    blocking: true,
    message: t('the profile mixes link/file specs ({specs}) — npm upgrades half-overwrite them and boot a broken tree; refuse to update', { specs: facts.linked.join(', ') }) + '\n' + repairRecipe(['<the names above>'], '<version>', t),
  }
}

/**
 * Gate 2 — the main Mayfly package must be installed. Its UI dependency is
 * owned by the package manager and is not a separately coordinated release.
 * @param facts - the profile facts.
 * @param currentVersion - the running version, for the message.
 * @param names - the target release's set, the repair recipe's fallback
 * when nothing is installed to enumerate.
 */
export function checkSetConsistency(facts: ProfileFacts, currentVersion: string, names: readonly string[], t: MayflyTranslate = interpolateLocaleMessage): Verdict {
  if (facts.installed['@ephemeral-ai/mayfly'] !== undefined) {
    return { code: 'set-consistency', blocking: false }
  }
  return {
    code: 'set-consistency',
    blocking: true,
    message: t('the @ephemeral-ai/mayfly package is not installed (running {version})', { version: currentVersion }) + '\n' + repairRecipe(names, '<version>', t),
  }
}

/** Gate 3 — the target must exist as a published version. */
export function checkTargetExists(packument: Packument, target: string, t: MayflyTranslate = interpolateLocaleMessage): Verdict {
  // Key presence, not truthiness: the npm-view packument shape lists
  // versions as bare keys (values undefined until the targeted deps
  // query), and a value check would declare every one of them
  // unpublished (caught live on the rc.3 real-machine run).
  if (Object.hasOwn(packument.versions, target)) return { code: 'target-exists', blocking: false }
  return {
    code: 'target-exists',
    blocking: true,
    message: t('version {version} is not published under @ephemeral-ai/mayfly (registry knows: {versions})', { version: target, versions: Object.keys(packument.versions).join(', ') }),
  }
}

/** Gate 4 — never offer, install, or roll back below Mayfly's first release. */
export function checkVersionFloor(target: string, t: MayflyTranslate = interpolateLocaleMessage): Verdict {
  if (compareVersions(target, VERSION_FLOOR) >= 0) return { code: 'version-floor', blocking: false }
  return {
    code: 'version-floor',
    blocking: true,
    message: t("version {version} predates Mayfly's first release; pick >= {floor}", { version: target, floor: VERSION_FLOOR }),
  }
}

/** The host-line facts gate 5 reads. */
export interface HostLineInput {
  /** A bundled host advances by reinstalling its launcher, not a global dsh. */
  readonly launcher?: boolean
  /** The global dsh CLI's version, `undefined` when unprobeable. */
  readonly hostVersion: string | undefined
  /** The bundle's pinned harness line, `undefined` when the manifest lacks it. */
  readonly requiredLine: string | undefined
}

/**
 * Gate 5 — the host harness line: the global dsh CLI supplies every
 * `dsh-*` peer at runtime, so an older host than the bundle's pin boots
 * broken. A newer host *line* (different major/minor) is a warning —
 * the R1 ruling says minor jumps are never automatic, and the boot
 * smoke still judges the result. An unprobeable host warns, not blocks:
 * the smoke boots the real dsh either way.
 */
export function checkHostLine(input: HostLineInput, t: MayflyTranslate = interpolateLocaleMessage): Verdict {
  const { hostVersion, requiredLine } = input
  if (hostVersion === undefined || requiredLine === undefined) {
    const detail = hostVersion === undefined
      ? 'could not determine the installed dsh CLI version'
      : `the registry manifest for this release does not name a harness pin`
    return { code: 'host-line', blocking: false, message: t('warning: {detail} — the boot smoke will judge', { detail: t(detail) }) }
  }
  // The first full version anywhere in the probe output (`dsh --version`
  // prefixes the name and may append the Node build) — prerelease
  // included, or a plain `0.1.1` would outrank `0.1.1-rc.2`.
  const host = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(hostVersion)?.[0]
  if (host === undefined) {
    return { code: 'host-line', blocking: false, message: t('warning: unreadable dsh version "{version}" — the boot smoke will judge', { version: hostVersion }) }
  }
  const order = compareVersions(host, requiredLine)
  if (order >= 0) {
    const [hmaj, hmin] = host.split('.')
    const [rmaj, rmin] = requiredLine.split('.')
    if (hmaj === rmaj && hmin === rmin) return { code: 'host-line', blocking: false }
    return {
      code: 'host-line',
      blocking: false,
      message: t('warning: dsh {host} is a different major/minor than the tested line {required} — proceeding; the boot smoke will judge', { host, required: requiredLine }),
    }
  }
  return {
    code: 'host-line',
    blocking: true,
    message: t("the installed dsh CLI ({host}) is older than this release's harness line ({required})\nfirst run: {command}", {
      host, required: requiredLine,
      command: input.launcher === true ? 'npm i -g @ephemeral-ai/mayfly-cli' : `npm i -g @deepseek-ai/dsh@${requiredLine}`,
    }),
  }
}

/** The cooldown facts gate 6 reads. */
export interface CooldownInput {
  /** Target's publish time, epoch ms; `undefined` when unrecorded. */
  readonly publishedAt: number | undefined
  /** pnpm's `minimumReleaseAge` in minutes; `undefined` falls to the default. */
  readonly cooldownMinutes: number | undefined
  /** Wall clock, epoch ms. */
  readonly now: number
}

/**
 * Gate 6 — the cooldown forecast: inside pnpm's `minimumReleaseAge`
 * window an exact-version install is hard-refused (the R1 finding), so
 * the gate converts that future pnpm error into an ETA now. Never a
 * bypass: the supply-chain guard is the user's policy.
 */
export function checkCooldown(target: string, input: CooldownInput, t: MayflyTranslate = interpolateLocaleMessage): Verdict {
  const minutes = input.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES
  if (input.publishedAt === undefined) {
    return { code: 'cooldown', blocking: false, message: t('warning: publish time unknown — cooldown cannot be forecast') }
  }
  const windowMs = minutes * 60_000
  const ageMs = input.now - input.publishedAt
  if (ageMs >= windowMs) return { code: 'cooldown', blocking: false }
  const readyAt = new Date(input.publishedAt + windowMs)
  return {
    code: 'cooldown',
    blocking: true,
    message: t("v{version} was published {age} min ago; pnpm's minimumReleaseAge ({minutes} min) refuses installs until {ready} UTC — retry later", { version: target, age: Math.max(0, Math.round(ageMs / 60_000)), minutes, ready: readyAt.toISOString().replace('T', ' ').slice(0, 16) }),
  }
}

/**
 * Gate 7 — the downgrade notice: an older target reinstalls the main package
 * at an exact version, so the user hears it before confirming.
 * @param facts - the profile facts (the installed bundle version is the
 * comparison base; absent installs say nothing).
 * @param target - the candidate target version.
 */
export function checkDowngrade(facts: ProfileFacts, target: string, t: MayflyTranslate = interpolateLocaleMessage): Verdict {
  const installed = facts.installed['@ephemeral-ai/mayfly']
  if (installed === undefined || compareVersions(target, installed) >= 0) {
    return { code: 'downgrade', blocking: false }
  }
  return {
    code: 'downgrade',
    blocking: false,
    message: t('warning: v{version} is older than the installed v{installed} — a downgrade reinstalls @ephemeral-ai/mayfly at the older version', { version: target, installed }),
  }
}

/** Everything the composed pre-flight needs. */
export interface PreflightInput {
  readonly t?: MayflyTranslate
  readonly facts: ProfileFacts
  /** The package names used in repair guidance. */
  readonly packageNames: readonly string[]
  /** The running version (`MAYFLY_VERSION`). */
  readonly currentVersion: string
  /** The candidate target version. */
  readonly target: string
  readonly packument: Packument
  readonly host: HostLineInput
  readonly cooldown: CooldownInput
}

/**
 * Run all gates, lane-first. Every verdict is returned (warnings ride
 * along); callers stop at the first blocking one for their message.
 * @param input - the gathered facts.
 * @returns the verdicts in gate order.
 */
export function runPreflight(input: PreflightInput): Verdict[] {
  return [
    checkLinkPollution(input.facts, input.t),
    checkSetConsistency(input.facts, input.currentVersion, input.packageNames, input.t),
    checkTargetExists(input.packument, input.target, input.t),
    checkVersionFloor(input.target, input.t),
    checkHostLine(input.host, input.t),
    checkCooldown(input.target, input.cooldown, input.t),
    checkDowngrade(input.facts, input.target, input.t),
  ]
}

/** What the offer resolution concluded. */
export type OfferResolution =
  | { kind: 'offer'; target: string }
  | { kind: 'up-to-date'; target: string }
  | { kind: 'no-tag' }
  | { kind: 'target-below-floor'; target: string }
  | { kind: 'target-unparsable'; target: string }

/**
 * Resolve what a channel offers against the running version: the tag's
 * target when it outranks it, or why not. Reads the tag table — never a
 * package-manager resolution, which silently rolls back inside the
 * cooldown window (R4).
 * @param packument - the normalized packument.
 * @param channel - the dist-tag to follow (`latest` by default).
 * @param currentVersion - the running version.
 */
export function resolveOffer(packument: Packument, channel: string, currentVersion: string): OfferResolution {
  const target = packument.tags[channel]
  if (target === undefined) return { kind: 'no-tag' }
  if (!isVersion(target)) return { kind: 'target-unparsable', target }
  if (compareVersions(target, currentVersion) > 0) {
    return compareVersions(target, VERSION_FLOOR) >= 0
      ? { kind: 'offer', target }
      : { kind: 'target-below-floor', target }
  }
  return { kind: 'up-to-date', target }
}
