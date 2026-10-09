/**
 * Pure change classification for the repository's local verification loop.
 * Unknown or cross-cutting inputs deliberately widen to the full gate.
 *
 * @module script/test-impact
 */

import { posix } from 'node:path'

const CODE_PATTERN = /\.(?:[cm]?ts|tsx)$/u
const EXECUTABLE_SOURCE_PATTERN = /^(?:packages|examples)\/[^/]+\/src\/(?!types\.ts$).+\.ts$/u
const GLOBAL_PATHS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.json',
  'tsdown.config.ts',
  'vitest.config.ts',
  'script/package-contract.mjs',
])
const LIFECYCLE_WORDS = /(?:adapter|action|bridge|host|provider|projection|runtime|service|session)/u

/** Normalize and de-duplicate repository-relative paths. */
export function normalizeChangedFiles(files) {
  return [...new Set(files
    .map(file => posix.normalize(String(file).replaceAll('\\', '/')).replace(/^\.\//u, ''))
    .filter(file => file !== '' && file !== '.'))].sort()
}

/** Return the workspace package directory owning a path, when any. */
export function owningPackage(file) {
  const parts = normalizeChangedFiles([file])[0]?.split('/') ?? []
  if ((parts[0] === 'packages' || parts[0] === 'examples') && parts[1] !== undefined) return parts.slice(0, 2).join('/')
  return undefined
}

/** Whether a path changes the package/build graph rather than one implementation. */
export function isStructuralBuildPath(file) {
  return GLOBAL_PATHS.has(file)
    || /^(?:packages\/[^/]+|examples\/[^/]+)\/(?:package\.json|tsconfig\.json)$/u.test(file)
    || file === 'script/clean-lib.mjs'
    || file === 'script/prune-types.mjs'
}

/** Expand a plan to the repository's complete deterministic gate. */
export function promoteToFull(plan, reason) {
  return {
    ...plan,
    mode: 'full',
    reasons: [...new Set([...plan.reasons, reason])],
    checks: {
      lint: true,
      typecheck: true,
      build: true,
      checkLib: true,
      pack: plan.checks.pack,
      examples: true,
      shots: true,
      agentDocs: true,
      diagrams: true,
      designGolden: true,
      website: plan.checks.website,
      repoWorkflowTests: true,
    },
  }
}

/** Build a fail-closed local verification plan for a concrete file set. */
export function classifyChanges(inputFiles) {
  const files = normalizeChangedFiles(inputFiles)
  const reasons = []
  const related = new Set()
  const coverage = new Set()
  const packageTests = new Set()
  const directTests = new Set()
  const manualAcceptance = new Set()
  let full = false
  let lint = false
  let typecheck = false
  let build = false
  let checkLib = false
  let pack = false
  let examples = false
  let shots = false
  let agentDocs = false
  let diagrams = false
  let designGolden = false
  let website = false
  let repoWorkflowTests = false

  for (const file of files) {
    const owner = owningPackage(file)
    if (GLOBAL_PATHS.has(file) || file.startsWith('.github/workflows/')) {
      full = true
      if (file === 'pnpm-lock.yaml' || file === 'pnpm-workspace.yaml' || file === 'script/package-contract.mjs') pack = true
      reasons.push(`${file}: cross-cutting repository input`)
      continue
    }
    if (file.startsWith('script/')) {
      repoWorkflowTests = true
      if (['script/check-pack.mjs', 'script/pack-cli-runtime.mjs', 'script/release-packages.mjs',
        'script/release-preflight.mjs', 'script/registry-release.mjs'].includes(file)) pack = true
      if (!/^script\/(?:test-impact|change-files|verify-changed|build-changed|check-agent-docs|design-golden(?:-clock|-walks)?)\.mjs$/u.test(file)
        && !file.startsWith('script/tests/')) {
        full = true
        reasons.push(`${file}: unclassified repository script`)
      }
    }
    if (file === 'script/check-agent-docs.mjs') agentDocs = true
    if (file.startsWith('docs/design/prototypes/') || file.startsWith('packages/mayfly/tests/design/golden/')
      || /^script\/design-golden(?:-clock|-walks)?\.mjs$/u.test(file)) designGolden = true
    if (file === 'AGENTS.md' || file.endsWith('/AGENTS.md') || file.includes('/SKILL.md') || file.startsWith('.agents/')
      || file.startsWith('docs/skills/') || file.endsWith('/mayfly-skills-plan.md')) {
      agentDocs = true
    }
    if (file.startsWith('docs/diagrams/') || file === 'README.md' || file === 'README.zh.md'
      || file === 'docs/mayfly-architecture.md') diagrams = true
    if (file.startsWith('website/')) {
      website = true
      manualAcceptance.add('website-preview')
    }
    if (file.startsWith('packages/mayfly/presets/')) {
      full = true
      pack = true
      build = true
      directTests.add('packages/mayfly/tests/presets.spec.ts')
    }
    if (file.endsWith('/cordis.patch.yml')) {
      full = true
      if (owner === 'packages/mayfly') pack = true
      reasons.push(`${file}: executable composition contract`)
    }
    if (owner === 'packages/mayfly' && (file.includes('/src/') || file.startsWith('packages/mayfly/presets/') || file === 'packages/mayfly/cordis.patch.yml')
      || owner === 'packages/ui' && file.includes('/src/')) manualAcceptance.add('runtime-profile')
    if (isStructuralBuildPath(file)) {
      build = true
      checkLib = true
      if (owner?.startsWith('examples/') && file.endsWith('package.json')) examples = true
      if (owner?.startsWith('packages/') && file.endsWith('package.json')) pack = true
    }
    if (owner?.startsWith('examples/') && file.includes('/src/')) examples = true
    if (!CODE_PATTERN.test(file)) continue

    lint ||= file.startsWith('packages/') || file.startsWith('examples/')
    typecheck ||= file.includes('/src/') || file.startsWith('script/')
    if (/\/(?:src|tests)\//u.test(file)) related.add(file)
    if (EXECUTABLE_SOURCE_PATTERN.test(file)) {
      coverage.add(file)
      build = true
    }

    if (owner === 'packages/ui' && file.includes('/src/')) {
      full = true
      pack = true
      reasons.push(`${file}: public contract or construction layer`)
      continue
    }
    if (owner !== undefined && LIFECYCLE_WORDS.test(posix.basename(file))) {
      packageTests.add(`${owner}/tests`)
      reasons.push(`${file}: lifecycle-sensitive implementation`)
    }
    const rendererArea = /^packages\/mayfly\/src\/(core|interaction|transcript)\//u.exec(file)?.[1]
    if (rendererArea !== undefined) {
      directTests.add(`packages/mayfly/tests/${rendererArea}/width-scan.spec.ts`)
    } else if (owner === 'examples/mayfly-user-kit' && file.includes('/src/')) {
      directTests.add('examples/mayfly-user-kit/tests/width-scan.spec.ts')
    }
    if (/^packages\/mayfly\/src\/core\/ui-[^/]+\.ts$/u.test(file)) {
      directTests.add('packages/mayfly/tests/design/parity.spec.ts')
      directTests.add('packages/mayfly/tests/perf/work-budget.spec.ts')
    }
    // The frame workloads paint through the lanes, the surface renderer, the clock, and the editor shell's keymap reads.
    if (/^packages\/mayfly\/src\/(?:core\/(?:terminal|surface-renderer|surface-manager|keymap|key-actions)|interaction\/editor-extension-runtime)\.ts$/u.test(file)) {
      directTests.add('packages/mayfly/tests/perf/work-budget.spec.ts')
    }
    if (/^packages\/mayfly\/src\/(?:core\/(?:key-actions|keymap|ui-key-grammar)|interaction\/keys)\.ts$/u.test(file)) {
      directTests.add('packages/mayfly/tests/core/key-audit.spec.ts')
    }
    if (/^packages\/mayfly\/src\/.*(?:locale|hints)\.ts$/u.test(file)) {
      directTests.add('packages/mayfly/tests/locale-catalog.spec.ts')
    }
    if (file === 'packages/mayfly/tests/core/width-scan.ts' || file === 'packages/mayfly/tests/core/temp-dir.ts') {
      full = true
      reasons.push(`${file}: shared test infrastructure`)
    }
  }

  const plan = {
    files,
    mode: full ? 'full' : files.length === 0 ? 'none' : 'changed',
    reasons: [...new Set(reasons)],
    checks: { lint, typecheck, build, checkLib, pack, examples, shots, agentDocs, diagrams, designGolden, website, repoWorkflowTests },
    tests: {
      related: [...related],
      coverage: [...coverage],
      packageTests: [...packageTests],
      direct: [...directTests],
    },
    manualAcceptance: [...manualAcceptance],
  }
  return full ? promoteToFull(plan, 'full gate required by change classification') : plan
}
