/** Executable verification selection contracts. @module script/tests/verification-commands */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ROOT } from '../package-contract.mjs'
import { commandsForPlan } from '../verification-commands.mjs'
import { classifyChanges, promoteToFull } from '../verify/select.mjs'

const scripts = commands => commands.filter(([command, args]) => command === 'pnpm' && args[0] === 'run').map(([, args]) => args[1])

test('a leaf change runs its related specs and width scan, and never measures coverage', () => {
  const plan = classifyChanges(['packages/mayfly/src/transcript/status-context.ts'])
  const commands = commandsForPlan(plan)
  assert.ok(scripts(commands).includes('build:changed'))
  assert.ok(commands.some(([command, args]) => command === 'pnpm' && args.includes('vitest') && args.includes('packages/mayfly/tests/transcript/width-scan.spec.ts')))
  assert.ok(!commands.some(([, args]) => args.includes('--coverage')))
  assert.ok(!scripts(commands).includes('check:pack'))
})

test('release manifests and examples execute their advertised package gates', () => {
  const manifest = scripts(commandsForPlan(classifyChanges(['packages/mayfly/package.json'])))
  assert.ok(manifest.includes('build:changed'))
  assert.ok(manifest.includes('check:pack'))
  assert.ok(manifest.indexOf('build:changed') < manifest.indexOf('check:pack'))
  const example = scripts(commandsForPlan(classifyChanges(['examples/header/package.json'])))
  assert.ok(example.includes('check:examples'))
})

test('a shipped skill runs full validation, agent docs, and packaging', () => {
  const scriptsRun = scripts(commandsForPlan(classifyChanges(['packages/mayfly/presets/mayfly-cordis/skills/mayfly-plugin-development/SKILL.md'])))
  for (const name of ['build', 'check:agent-docs', 'shots:check', 'check:pack', 'test:coverage']) assert.ok(scriptsRun.includes(name), name)
})

test('a full gate retains Website selection and follows the CI deterministic checks', () => {
  const plan = promoteToFull(classifyChanges(['website/index.md']), 'requested')
  const full = scripts(commandsForPlan(plan, { smoke: true }))
  for (const name of ['test:repo-workflow', 'typecheck', 'lint', 'diagrams:check', 'build', 'check:lib', 'shots:check', 'check:agent-docs', 'check:examples', 'website:build', 'test:coverage', 'smoke:happy', 'bench:pty:assert']) {
    assert.ok(full.includes(name), name)
  }
  assert.ok(!full.includes('check:pack'))
  const ci = readFileSync(`${ROOT}/.github/workflows/ci.yml`, 'utf8')
  for (const script of ['typecheck', 'lint', 'test:repo-workflow', 'check:agent-docs', 'diagrams:check', 'build', 'check:lib', 'shots:check', 'check:examples', 'test:coverage', 'smoke:happy', 'bench:pty:assert']) {
    assert.ok(ci.includes(`- run: pnpm ${script}`), `CI must execute ${script}`)
    assert.ok(full.includes(script), `local full gate must execute ${script}`)
  }
})

test('the prototype gates nothing of its own; a change to it runs only the spec that imports its keymap', () => {
  const plan = classifyChanges(['docs/design/prototypes/ui-kit.mjs'])
  assert.equal(plan.mode, 'changed')
  assert.deepEqual(plan.tests.specs, ['packages/mayfly/tests/core/key-audit.spec.ts'])
})

test('a grid golden or the grid serializer reruns the specs that compare grids, and the serializer its own test', () => {
  for (const file of ['packages/mayfly/tests/design/frames/02-actions/move.grid', 'script/scenarios/grid.mjs']) {
    const plan = classifyChanges([file])
    assert.equal(plan.mode, 'changed', file)
    assert.ok(plan.tests.specs.includes('packages/mayfly/tests/design/scene-02-actions.spec.ts'), file)
    assert.ok(commandsForPlan(plan).some(([, args]) => args[0] === 'exec' && args[1] === 'vitest' && args[2] === 'run'), file)
  }
  const serializer = commandsForPlan(classifyChanges(['script/scenarios/grid.mjs']))
  assert.ok(serializer.some(([command, args]) => command === 'node' && args.includes('script/tests/grid.test.mjs')))
})

test('the full gate runs the suites once, and the bench only with the smoke', () => {
  const plan = promoteToFull(classifyChanges(['packages/mayfly/src/core/ui-compiler.ts']), 'requested')
  const full = commandsForPlan(plan, { smoke: true })
  // Retained-row verification rides in the same run as coverage (the vitest `suite` project); no second suite run.
  assert.deepEqual(scripts(full).filter(name => name.startsWith('test:') && name !== 'test:repo-workflow'), ['test:coverage'])
  assert.ok(!full.some(([, args]) => args[0] === 'exec' && args[1] === 'vitest'))
  assert.ok(!scripts(commandsForPlan(plan)).includes('bench:pty:assert'))
  assert.equal(classifyChanges(['script/bench-pty.mjs']).mode, 'changed')
})
