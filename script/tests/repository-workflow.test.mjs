/** Repository verification planner and agent-document drift tests. @module script/tests/repository-workflow */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { auditAgentDocs } from '../check-agent-docs.mjs'
import {
  BUGS_URL,
  HOMEPAGE_URL,
  NODE_RANGE,
  readManifest,
  releaseDistTags,
  releaseRepository,
  RELEASE_PACKAGE_DIRS,
  ROOT,
} from '../package-contract.mjs'
import { classifyChanges, isStructuralBuildPath, owningPackage, promoteToFull } from '../test-impact.mjs'

describe('change impact planning', () => {
  test('promotes alpha and stable releases to latest while retaining the RC tag', () => {
    assert.deepEqual(releaseDistTags('0.1.0-alpha.1'), ['latest'])
    assert.deepEqual(releaseDistTags('0.1.0-rc.1'), ['rc', 'latest'])
    assert.deepEqual(releaseDistTags('0.1.0'), ['latest'])
  })

  test('keeps release manifests linked to the provenance repository', () => {
    for (const relativeDir of RELEASE_PACKAGE_DIRS) {
      const manifest = readManifest(relativeDir)
      assert.deepEqual(manifest.repository, releaseRepository(relativeDir))
      assert.equal(manifest.homepage, HOMEPAGE_URL)
      assert.deepEqual(manifest.bugs, { url: BUGS_URL })
      assert.deepEqual(manifest.engines, { node: NODE_RANGE })
    }
  })

  test('CLI entry points accept pnpm argument separators', () => {
    const verify = execFileSync(process.execPath, [
      'script/verify-changed.mjs', '--plan', '--', '--files-json', '[]',
    ], { encoding: 'utf8' })
    assert.equal(JSON.parse(verify).mode, 'none')
    const build = execFileSync(process.execPath, [
      'script/build-changed.mjs', '--', '--files-json', '[]',
    ], { encoding: 'utf8' })
    assert.match(build, /no runtime package source changed/u)
  })

  test('fails closed when the requested comparison base is invalid', () => {
    assert.throws(() => execFileSync(process.execPath, [
      'script/verify-changed.mjs', '--plan', '--base', 'refs/heads/does-not-exist',
    ], { encoding: 'utf8', stdio: 'pipe' }))
  })

  test('plans an explicit full gate before the repository has its first commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'mayfly-unborn-repository-'))
    try {
      execFileSync('git', ['init', '--initial-branch', 'main', root], { stdio: 'ignore' })
      const output = execFileSync(process.execPath, [
        join(ROOT, 'script/verify-changed.mjs'), '--plan', '--full',
      ], { cwd: root, encoding: 'utf8' })
      assert.equal(JSON.parse(output).mode, 'full')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('keeps documentation-only edits out of Vitest', () => {
    const plan = classifyChanges(['packages/mayfly/AGENTS.md'])
    assert.equal(plan.mode, 'changed')
    assert.equal(plan.checks.agentDocs, true)
    assert.deepEqual(plan.tests.related, [])
  })

  test('routes retired skill documentation through the agent drift gate', () => {
    const plan = classifyChanges(['docs/skills/plugin-validation.md'])
    assert.equal(plan.checks.agentDocs, true)
    assert.deepEqual(plan.tests.related, [])
  })

  test('selects related coverage for an ordinary leaf implementation', () => {
    const plan = classifyChanges(['packages/mayfly/src/frontend/locale.ts'])
    assert.equal(plan.mode, 'changed')
    assert.equal(plan.checks.build, true)
    assert.deepEqual(plan.tests.coverage, ['packages/mayfly/src/frontend/locale.ts'])
    assert.deepEqual(plan.tests.related, ['packages/mayfly/src/frontend/locale.ts'])
  })

  test('adds width and lifecycle package gates where required', () => {
    const renderer = classifyChanges(['packages/mayfly/src/transcript/tool-model.ts'])
    assert.ok(renderer.tests.direct.includes('packages/mayfly/tests/transcript/width-scan.spec.ts'))
    const lifecycle = classifyChanges(['packages/mayfly/src/interaction/editor-extension-runtime.ts'])
    assert.ok(lifecycle.tests.packageTests.includes('packages/mayfly/tests'))
    const userKit = classifyChanges(['examples/mayfly-user-kit/src/index.ts'])
    assert.ok(userKit.tests.direct.includes('examples/mayfly-user-kit/tests/width-scan.spec.ts'))
  })

  test('widens public contracts and global configuration to full', () => {
    assert.equal(classifyChanges(['packages/ui/src/index.ts']).mode, 'full')
    assert.equal(classifyChanges(['vitest.config.ts']).mode, 'full')
  })

  test('routes package metadata through build and validation', () => {
    const plan = classifyChanges(['packages/mayfly/package.json'])
    assert.equal(plan.checks.build, true)
    assert.equal(plan.checks.checkLib, true)
    assert.deepEqual(plan.validatePackages, ['packages/mayfly'])
    const plugin = classifyChanges(['examples/header/package.json'])
    assert.deepEqual(plugin.validatePackages, ['examples/header'])
  })

  test('widens executable compositions and verifies shipped presets', () => {
    assert.equal(classifyChanges(['packages/mayfly/cordis.patch.yml']).mode, 'full')
    const preset = classifyChanges(['packages/mayfly/presets/mayfly-cordis/preset.yml'])
    assert.equal(preset.checks.authorDocs, true)
    assert.equal(preset.checks.build, true)
    assert.ok(preset.tests.direct.includes('packages/mayfly/tests/presets.spec.ts'))
  })

  test('recognizes every package manifest shape as structural', () => {
    assert.equal(isStructuralBuildPath('packages/ui/package.json'), true)
    assert.equal(isStructuralBuildPath('packages/mayfly/package.json'), true)
    assert.equal(isStructuralBuildPath('examples/header/package.json'), true)
  })

  test('preserves checks when later paths do not require lint', () => {
    const plan = classifyChanges(['packages/mayfly/src/frontend/locale.ts', 'script/test-impact.mjs'])
    assert.equal(plan.checks.lint, true)
  })

  test('promotes all deterministic checks without mutating the source plan', () => {
    const changed = classifyChanges(['packages/mayfly/AGENTS.md'])
    const full = promoteToFull(changed, 'test')
    assert.equal(changed.mode, 'changed')
    assert.equal(full.mode, 'full')
    assert.equal(full.checks.build, true)
  })

  test('recognizes consolidated runtime package ownership', () => {
    assert.equal(owningPackage('packages/mayfly/src/core/index.ts'), 'packages/mayfly')
  })
})

describe('agent documentation drift', () => {
  const roots = []
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  function fixture(agent) {
    const root = mkdtempSync(join(tmpdir(), 'mayfly-agent-docs-'))
    roots.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'verify:changed': '', 'verify:full': '', 'check:agent-docs': '' } }))
    writeFileSync(join(root, 'AGENTS.md'), agent)
    return root
  }

  test('accepts durable instructions without project skills', () => {
    const root = fixture('Use `pnpm run verify:changed`, `pnpm run verify:full`, and `pnpm run check:agent-docs`.\n')
    assert.deepEqual(auditAgentDocs(root, { packageDirs: [], checkPreset: false }), [])
  })

  test('rejects expiring snapshots, dead links, and project skills', () => {
    const root = fixture('As of 2026-01-01, 10 passed. [missing](./missing.md)\nverify:changed verify:full check:agent-docs\n')
    mkdirSync(join(root, '.agents', 'skills', 'old'), { recursive: true })
    writeFileSync(join(root, '.agents', 'skills', 'old', 'SKILL.md'), '---\nname: old\n---\n')
    const problems = auditAgentDocs(root, { packageDirs: [], checkPreset: false })
    assert.ok(problems.some(problem => problem.includes('expiring verification snapshot')))
    assert.ok(problems.some(problem => problem.includes('dead link')))
    assert.ok(problems.some(problem => problem.includes('.agents/skills')))
  })

  test('rejects prerelease literals outside the maintained version set', () => {
    const root = fixture('Use verify:changed verify:full check:agent-docs. Old `0.1.1-rc.9`.\n')
    const problems = auditAgentDocs(root, { packageDirs: [], checkPreset: false, allowedVersions: ['0.1.0-alpha.1'] })
    assert.ok(problems.some(problem => problem.includes('stale prerelease 0.1.1-rc.9')))
  })
})
