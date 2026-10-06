/** Executable verification selection contracts. @module script/tests/verification-commands */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ROOT } from '../package-contract.mjs'
import { classifyChanges, promoteToFull } from '../test-impact.mjs'
import { commandsForPlan } from '../verification-commands.mjs'

const scripts = commands => commands.filter(([command, args]) => command === 'pnpm' && args[0] === 'run').map(([, args]) => args[1])

test('a leaf change executes its focused coverage and width scan', () => {
  const plan = classifyChanges(['packages/mayfly/src/transcript/status-context.ts'])
  const commands = commandsForPlan(plan)
  assert.ok(scripts(commands).includes('build:changed'))
  assert.ok(commands.some(([command, args]) => command === 'pnpm' && args.includes('vitest') && args.includes('--coverage') && args.includes('packages/mayfly/tests/transcript/width-scan.spec.ts')))
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
  for (const name of ['test:repo-workflow', 'typecheck', 'lint', 'diagrams:check', 'build', 'check:lib', 'shots:check', 'design:golden:check', 'check:agent-docs', 'check:examples', 'website:build', 'test:coverage', 'smoke:happy']) {
    assert.ok(full.includes(name), name)
  }
  assert.ok(!full.includes('check:pack'))
  const ci = readFileSync(`${ROOT}/.github/workflows/ci.yml`, 'utf8')
  for (const script of ['typecheck', 'lint', 'test:repo-workflow', 'check:agent-docs', 'diagrams:check', 'build', 'check:lib', 'shots:check', 'design:golden:check', 'check:examples', 'test:coverage', 'smoke:happy']) {
    assert.ok(ci.includes(`- run: pnpm ${script}`), `CI must execute ${script}`)
    assert.ok(full.includes(script), `local full gate must execute ${script}`)
  }
})

test('a prototype change executes the golden check without widening the gate', () => {
  const plan = classifyChanges(['docs/design/prototypes/ui-kit.mjs'])
  assert.equal(plan.mode, 'changed')
  assert.deepEqual(scripts(commandsForPlan(plan)), ['design:golden:check'])
})

test('the golden scripts are classified repository scripts', () => {
  const plan = classifyChanges(['script/design-golden.mjs', 'script/design-golden-clock.mjs', 'script/design-golden-walks.mjs'])
  assert.equal(plan.mode, 'changed')
  assert.ok(plan.checks.designGolden && plan.checks.repoWorkflowTests)
})
