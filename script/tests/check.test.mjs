/** The verification tiers, the report, and the CI wiring of `pnpm run check`. @module script/tests/check */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseCheckArgs } from '../check.mjs'
import { ROOT } from '../package-contract.mjs'
import { addedLines, uncoveredChangedLines } from '../verify/coverage-diff.mjs'
import { renderSummary, vitestFailures } from '../verify/report.mjs'
import { classifyChanges } from '../verify/select.mjs'
import { stepsFor } from '../verify/steps.mjs'

const names = steps => steps.map(step => step.name)
const commandOf = (steps, prefix) => steps.find(step => step.name.startsWith(prefix))
const scriptsOf = steps => steps.filter(step => step.command === 'pnpm' && step.args[0] === 'run').map(step => step.args[1])

test('a leaf edit in the round tier lints, builds, and runs the specs it reaches, without coverage or checks', () => {
  const steps = stepsFor(classifyChanges(['packages/mayfly/src/transcript/status-context.ts', 'packages/mayfly/AGENTS.md']), 'round', { root: ROOT })
  assert.deepEqual(names(steps).map(name => name.replace(/ \(\d+\)$/u, '')), ['lint', 'build', 'specs'])
  const specs = commandOf(steps, 'specs')
  assert.ok(specs.args.includes('packages/mayfly/tests/transcript/width-scan.spec.ts'))
  assert.ok(!specs.args.includes('--coverage'))
  assert.equal(commandOf(steps, 'build').blocking, true)
})

test('the pr tier adds the checks the change claims, builds before packing, and advises on coverage only when asked', () => {
  const plan = classifyChanges(['packages/mayfly/src/transcript/status-context.ts', 'packages/mayfly/AGENTS.md'])
  assert.ok(names(stepsFor(plan, 'pr', { root: ROOT })).includes('agent docs'))
  const manifest = scriptsOf(stepsFor(classifyChanges(['packages/mayfly/package.json']), 'pr', { root: ROOT }))
  assert.ok(manifest.indexOf('build:changed') < manifest.indexOf('check:pack'))
  assert.ok(scriptsOf(stepsFor(classifyChanges(['examples/header/package.json']), 'pr', { root: ROOT })).includes('check:examples'))
  const advised = commandOf(stepsFor(plan, 'pr', { root: ROOT, coverageAdvice: true }), 'specs')
  assert.equal(advised.kind, 'coverage')
  assert.deepEqual(advised.args.filter((_, index) => advised.args[index - 1] === '--coverage.include'), ['packages/mayfly/src/transcript/status-context.ts'])
  assert.ok(advised.args.includes('--coverage.thresholds.lines=0'))
})

test('the full tier runs everything once: one vitest run with coverage, the smoke, and the bench on its own build', () => {
  const steps = stepsFor(classifyChanges(['website/index.md']), 'full', { root: ROOT })
  const scripts = scriptsOf(steps)
  for (const name of ['test:repo-workflow', 'typecheck', 'lint', 'diagrams:check', 'build', 'check:lib', 'shots:check', 'check:agent-docs', 'check:examples', 'website:build', 'smoke:happy', 'bench:pty:assert']) assert.ok(scripts.includes(name), name)
  assert.ok(!scripts.includes('check:pack'))
  const vitest = steps.filter(step => step.args.includes('vitest'))
  assert.equal(vitest.length, 1)
  assert.ok(vitest[0].args.includes('--coverage'))
  assert.ok(scripts.indexOf('build') < scripts.indexOf('smoke:happy'))
})

test('a global input or a shipped skill runs the full tier whatever tier was asked', () => {
  for (const file of ['vitest.config.ts', 'packages/mayfly/presets/mayfly-cordis/skills/mayfly-plugin-development/SKILL.md']) {
    const scripts = scriptsOf(stepsFor(classifyChanges([file]), 'round', { root: ROOT }))
    assert.ok(scripts.includes('smoke:happy') && scripts.includes('check:agent-docs'), file)
  }
  assert.ok(scriptsOf(stepsFor(classifyChanges(['packages/mayfly/presets/mayfly-cordis.patch.yml']), 'round', { root: ROOT })).includes('check:pack'))
})

test('the prototype gates nothing of its own; a change to it runs only the spec that imports its keymap', () => {
  const plan = classifyChanges(['docs/design/prototypes/ui-kit.mjs'])
  assert.equal(plan.mode, 'changed')
  assert.deepEqual(plan.tests.specs, ['packages/mayfly/tests/core/key-audit.spec.ts'])
})

test('a grid golden or the grid serializer reruns the specs that compare grids, and the serializer its own test', () => {
  for (const file of ['packages/mayfly/tests/design/frames/02-actions/move.grid', 'script/scenarios/grid.mjs']) {
    assert.ok(commandOf(stepsFor(classifyChanges([file]), 'round', { root: ROOT }), 'specs').args.includes('packages/mayfly/tests/design/scene-02-actions.spec.ts'), file)
  }
  const tests = commandOf(stepsFor(classifyChanges(['script/scenarios/grid.mjs']), 'round', { root: ROOT }), 'workflow tests')
  assert.equal(tests.command, 'node')
  assert.ok(tests.args.includes('script/tests/grid.test.mjs'))
})

test('CI runs the pr tier on a pull request and the full tier otherwise, and every workflow command exists', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  assert.match(ci, /pnpm run check --\s+--tier \$\{\{ github\.event_name == 'pull_request' && 'pr' \|\| 'full' \}\}/u)
  assert.match(ci, /schedule:/u)
  assert.match(ci, /cat \.artifacts\/verify\/summary\.md >> "\$GITHUB_STEP_SUMMARY"/u)
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts
  for (const workflow of ['ci.yml', 'release.yml', 'harness-drift.yml']) {
    const text = readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8').split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
    for (const match of text.matchAll(/\bpnpm (?:run )?([a-z][a-z0-9:_-]*)/gu)) {
      if (['install', 'exec', 'vitest', 'add', 'dlx', '--dir', 'store'].includes(match[1])) continue
      assert.ok(Object.hasOwn(scripts, match[1]), `${workflow} runs the missing script ${match[1]}`)
    }
  }
})

test('the command line defaults to the pr tier and refuses an unknown tier or flag', () => {
  assert.equal(parseCheckArgs(['--']).options.tier, 'pr')
  assert.deepEqual(parseCheckArgs(['--tier', 'round', '--files-json', '["a"]', '--why']).options, { tier: 'round', files: ['a'], plan: false, why: true, verbose: false, coverageAdvice: false })
  assert.match(parseCheckArgs(['--tier', 'nightly']).error, /--tier/u)
  assert.match(parseCheckArgs(['--bogus']).error, /unknown argument/u)
})

test('the report keeps the first failure of each failing spec, why it ran, and how to rerun it', () => {
  const failures = vitestFailures({
    testResults: [
      { name: `${ROOT}/packages/a/tests/ok.spec.ts`, status: 'passed', assertionResults: [] },
      { name: `${ROOT}/packages/a/tests/bad.spec.ts`, status: 'failed', assertionResults: [
        { fullName: 'bad keeps going', status: 'passed' },
        { fullName: 'bad paints the row', status: 'failed', failureMessages: ['\u001b[31mAssertionError: expected 1 to be 2\u001b[39m\n    at line 1\n    at run (/repo/node_modules/@vitest/runner/dist/x.js:1:1)\n    at new Promise (<anonymous>)\n'] },
        { fullName: 'bad paints twice', status: 'failed', failureMessages: ['second'] },
      ] },
      { name: `${ROOT}/packages/a/tests/broken.spec.ts`, status: 'failed', message: 'SyntaxError: x', assertionResults: [] },
    ],
  }, ROOT)
  assert.deepEqual(failures, [
    { file: 'packages/a/tests/bad.spec.ts', test: 'bad paints the row', message: 'AssertionError: expected 1 to be 2\n    at line 1' },
    { file: 'packages/a/tests/broken.spec.ts', test: '(the file failed before its tests ran)', message: 'SyntaxError: x' },
  ])
  const summary = renderSummary({
    tier: 'round', base: 'origin/main', verdict: 'fail', durationMs: 4200, files: ['packages/a/src/x.ts'], reasons: [], manualAcceptance: ['runtime-profile'],
    steps: [{ name: 'lint', status: 'pass', durationMs: 300, command: 'pnpm exec oxlint' }, { name: 'specs (2)', status: 'fail', durationMs: 3000, command: 'pnpm exec vitest run' }],
    tests: { specs: ['packages/a/tests/bad.spec.ts', 'packages/a/tests/broken.spec.ts'], nodeTests: [], why: { 'packages/a/tests/bad.spec.ts': ['packages/a/src/x.ts', 'packages/a/tests/bad.spec.ts'] } },
    failures: failures.map(failure => ({ step: 'specs (2)', ...failure })), uncovered: [{ file: 'packages/a/src/x.ts', lines: [3, 4] }],
    rerun: ['pnpm exec vitest run packages/a/tests/bad.spec.ts packages/a/tests/broken.spec.ts'],
  })
  assert.match(summary, /^# check: FAIL \(round, 4\.2 s\)$/mu)
  assert.match(summary, /Manual acceptance still owed: runtime-profile/u)
  assert.match(summary, /\| specs \(2\) \| ✗ \| 3\.0 s \|/u)
  assert.match(summary, /Selected by: packages\/a\/src\/x\.ts → packages\/a\/tests\/bad\.spec\.ts/u)
  assert.match(summary, /- packages\/a\/src\/x\.ts: 3, 4/u)
  assert.match(summary, /## Rerun\n```\npnpm exec vitest run packages\/a\/tests\/bad\.spec\.ts/u)
})

test('the coverage advice reports changed lines whose statements never ran', () => {
  const changed = addedLines('diff --git a/x b/x\n@@ -10,0 +11,3 @@\n+a\n+b\n+c\n@@ -20 +23 @@\n-d\n+e\n@@ -30,2 +33,0 @@\n-f\n')
  assert.deepEqual([...changed], [11, 12, 13, 23])
  const coverage = { [`${ROOT}/packages/a/src/x.ts`]: { statementMap: { 0: { start: { line: 11 } }, 1: { start: { line: 12 } }, 2: { start: { line: 40 } } }, s: { 0: 0, 1: 3, 2: 0 } } }
  assert.deepEqual(uncoveredChangedLines(coverage, new Map([['packages/a/src/x.ts', changed]]), ROOT), [{ file: 'packages/a/src/x.ts', lines: [11] }])
})
