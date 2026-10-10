/**
 * The steps a verification tier runs for a plan (roadmap Phase 2b): `round` for every edit (the incremental build or
 * the typecheck, lint, and the selected tests), `pr` for finalizing (round plus the checks the change claims), `full`
 * for CI on `main`, a release, and a phase end (everything, with coverage against its floor, the smoke, and the bench).
 * A step is `blocking` when nothing after it is worth running once it fails. @module script/verify/steps
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {object} Step
 * @property {string} name - what the report calls it.
 * @property {string} command - the executable.
 * @property {string[]} args - its arguments.
 * @property {boolean} [blocking] - stop the tier when this step fails.
 * @property {'specs' | 'coverage' | 'scenarios' | 'perf'} [kind] - a run whose results the report reads: vitest's JSON,
 *   the scenario results, or the perf results.
 */

export const TIERS = ['round', 'pr', 'full']

/** Where a tier writes its report, logs, and the results the report reads. */
export const OUTPUT = '.artifacts/verify'
export const VITEST_RESULTS = `${OUTPUT}/vitest.json`
export const SCENARIO_RESULTS = `${OUTPUT}/scenarios.json`
export const PERF_RESULTS = `${OUTPUT}/perf.json`

const pnpm = (name, ...args) => ({ name, command: 'pnpm', args })
const vitest = (name, kind, args) => ({ name, kind, command: 'pnpm', args: ['exec', 'vitest', 'run', ...args, '--reporter=dot', '--reporter=json', `--outputFile.json=${VITEST_RESULTS}`, '--silent=passed-only'] })

/**
 * The ordered steps of a tier.
 * @param {ReturnType<typeof import('./select.mjs').classifyChanges>} plan - the plan; a full plan runs the full tier.
 * @param {'round' | 'pr' | 'full'} tier
 * @param {{ root?: string, coverageAdvice?: boolean }} [options] - `coverageAdvice` measures the coverage of the changed
 *   sources in the pr tier (CI).
 * @returns {Step[]}
 */
export function stepsFor(plan, tier, { root = process.cwd(), coverageAdvice = false } = {}) {
  if (tier === 'full' || plan.mode === 'full') {
    return [
      pnpm('workflow tests', 'run', 'test:repo-workflow'),
      { ...pnpm('typecheck', 'run', 'typecheck'), blocking: true },
      pnpm('lint', 'run', 'lint'),
      pnpm('diagrams', 'run', 'diagrams:check'),
      { ...pnpm('build', 'run', 'build'), blocking: true },
      pnpm('lib exports', 'run', 'check:lib'),
      pnpm('shots', 'run', 'shots:check'),
      pnpm('agent docs', 'run', 'check:agent-docs'),
      pnpm('examples', 'run', 'check:examples'),
      ...(plan.checks.pack ? [pnpm('pack', 'run', 'check:pack')] : []),
      ...(plan.checks.website ? [pnpm('website', 'run', 'website:build')] : []),
      // One run: the suites with every retained-row hit painted again, the work budgets, and coverage against its floor.
      vitest('suites and coverage', 'coverage', ['--coverage']),
      // The real terminal on the build above: every scenario against its goldens, the happy smoke, and every perf
      // scenario against its ceilings.
      { name: 'scenarios', kind: 'scenarios', command: 'node', args: ['script/scenarios.mjs'] },
      pnpm('happy smoke', 'run', 'smoke:happy'),
      { name: 'perf ceilings', kind: 'perf', command: 'node', args: ['script/perf.mjs', '--assert'] },
    ]
  }
  if (plan.mode === 'none') return []
  const steps = []
  const lintFiles = plan.files.filter(file => /^(?:packages|examples)\/.+\.(?:[cm]?ts|tsx)$/u.test(file) && existsSync(join(root, file)))
  if (lintFiles.length > 0) steps.push({ name: 'lint', command: 'pnpm', args: ['exec', 'oxlint', ...lintFiles] })
  if (plan.checks.build) steps.push({ ...pnpm('build', 'run', 'build:changed', '--', '--files-json', JSON.stringify(plan.files)), blocking: true })
  else if (plan.checks.typecheck) steps.push({ ...pnpm('typecheck', 'run', 'typecheck'), blocking: true })
  if (tier === 'pr') {
    if (plan.checks.agentDocs) steps.push(pnpm('agent docs', 'run', 'check:agent-docs'))
    if (plan.checks.diagrams) steps.push(pnpm('diagrams', 'run', 'diagrams:check'))
    if (plan.checks.checkLib) steps.push(pnpm('lib exports', 'run', 'check:lib'))
    if (plan.checks.shots) steps.push(pnpm('shots', 'run', 'shots:check'))
    if (plan.checks.examples) steps.push(pnpm('examples', 'run', 'check:examples'))
    if (plan.checks.pack) steps.push(pnpm('pack', 'run', 'check:pack'))
    if (plan.checks.website) steps.push(pnpm('website', 'run', 'website:build'))
  }
  // The repository-workflow tests the change reaches, and only those.
  if (plan.tests.nodeTests.length > 0) steps.push({ name: `workflow tests (${String(plan.tests.nodeTests.length)})`, command: 'node', args: ['--test', ...plan.tests.nodeTests] })
  // The specs the import graph carries the change to. A local run never measures coverage (D29); in CI the pr tier
  // reports the changed source lines no selected spec ran, as advice.
  const sources = plan.files.filter(file => /^(?:packages|examples)\/[^/]+\/src\/(?!types\.ts$).+\.ts$/u.test(file) && existsSync(join(root, file)))
  if (plan.tests.specs.length > 0) {
    const coverage = tier === 'pr' && coverageAdvice && sources.length > 0
      ? ['--coverage', '--coverage.reporter=json', '--coverage.thresholds.statements=0', '--coverage.thresholds.branches=0', '--coverage.thresholds.functions=0', '--coverage.thresholds.lines=0', ...sources.flatMap(file => ['--coverage.include', file])]
      : []
    steps.push(vitest(`specs (${String(plan.tests.specs.length)})`, coverage.length > 0 ? 'coverage' : 'specs', [...plan.tests.specs, ...coverage]))
  }
  // The scenarios the change can show, against their goldens: the first size in a round, every size in the pr tier.
  if (plan.tests.scenarios.length > 0) {
    steps.push({ name: `scenarios (${String(plan.tests.scenarios.length)})`, kind: 'scenarios', command: 'node', args: ['script/scenarios.mjs', '--sizes', tier === 'round' ? 'first' : 'all', ...plan.tests.scenarios] })
  }
  if (tier === 'pr' && plan.checks.smoke) steps.push(pnpm('happy smoke', 'run', 'smoke:happy'))
  // The perf scenarios the change reaches, A/B against the merge base: reported, not gated (D28).
  if (tier === 'pr' && plan.tests.perf.length > 0) steps.push({ name: `perf A/B (${String(plan.tests.perf.length)})`, kind: 'perf', command: 'node', args: ['script/perf.mjs', ...plan.tests.perf] })
  return steps
}
