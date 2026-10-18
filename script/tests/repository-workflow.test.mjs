/** Repository verification planner and agent-document drift tests. @module script/tests/repository-workflow */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { auditAgentDocs } from '../check-agent-docs.mjs'
import {
  BUGS_URL,
  BUILD_PACKAGE_DIRS,
  HOMEPAGE_URL,
  NODE_RANGE,
  parseManifestText,
  readManifest,
  releaseDistTags,
  releaseRepository,
  RELEASE_PACKAGE_DIRS,
  ROOT,
} from '../package-contract.mjs'
import { owningPackage } from '../change-files.mjs'
import { isStructuralBuildPath } from '../verify/inputs.mjs'
import { classifyChanges, promoteToFull } from '../verify/select.mjs'

describe('change impact planning', () => {
  test('a painter reaches the specs that import it, the work budgets among them, each with the chain that reached it', () => {
    const plan = classifyChanges(['packages/mayfly/src/core/ui-patterns.ts'])
    assert.equal(plan.mode, 'changed')
    assert.ok(plan.tests.specs.includes('packages/mayfly/tests/perf/work-budget.spec.ts'))
    for (const spec of plan.tests.specs) {
      const chain = plan.tests.why[spec]
      assert.equal(chain[0], 'packages/mayfly/src/core/ui-patterns.ts', spec)
      assert.equal(chain.at(-1), spec)
    }
  })

  test('the frame path reaches the work-budget spec, and a renderer outside it does not', () => {
    for (const file of ['packages/mayfly/src/core/terminal.ts', 'packages/mayfly/src/core/surface-renderer.ts', 'packages/mayfly/src/core/surface-manager.ts', 'packages/mayfly/src/core/keymap.ts', 'packages/mayfly/src/interaction/editor-extension-runtime.ts']) {
      assert.ok(classifyChanges([file]).tests.specs.includes('packages/mayfly/tests/perf/work-budget.spec.ts'), file)
    }
    assert.ok(!classifyChanges(['packages/mayfly/tests/transcript/thinking.spec.ts']).tests.specs.includes('packages/mayfly/tests/perf/work-budget.spec.ts'))
  })

  test('key tables reach the key audit', () => {
    for (const file of ['packages/mayfly/src/interaction/keys.ts', 'packages/mayfly/src/core/key-actions.ts', 'packages/mayfly/src/core/keymap.ts', 'packages/mayfly/src/core/ui-key-grammar.ts']) {
      assert.ok(classifyChanges([file]).tests.specs.includes('packages/mayfly/tests/core/key-audit.spec.ts'), file)
    }
  })

  test('a public UI source runs its dependents, its type fixtures, and the contract checks without the full gate', () => {
    const plan = classifyChanges(['packages/ui/src/builders.ts'])
    assert.equal(plan.mode, 'changed')
    assert.ok(plan.tests.specs.includes('packages/ui/tests/types.spec.ts'))
    for (const check of ['build', 'checkLib', 'examples', 'pack']) assert.equal(plan.checks[check], true, check)
  })

  test('keeps RC releases off latest while alpha and stable releases promote it', () => {
    assert.deepEqual(releaseDistTags('0.1.0-alpha.1'), ['latest'])
    assert.deepEqual(releaseDistTags('0.1.0-rc.1'), ['rc'])
    assert.deepEqual(releaseDistTags('0.1.0'), ['latest'])
  })

  test('rejects duplicate keys in manifests, at any object depth', () => {
    assert.throws(() => parseManifestText('{"a": 1, "a": 2}', 'fixture'), /fixture: duplicate key "a"/u)
    assert.throws(() => parseManifestText('{"deps": {"x": "1", "x": "2"}}', 'fixture'), /duplicate key "x"/u)
    assert.throws(() => parseManifestText('{"a": {"b": 1}, "a": 2}', 'fixture'), /duplicate key "a"/u)
    assert.deepEqual(
      parseManifestText('{"files": ["a", "b"], "deps": {"x": "1", "y": "2"}, "ok": true}', 'fixture'),
      { files: ['a', 'b'], deps: { x: '1', y: '2' }, ok: true },
    )
    for (const relativeDir of ['.', 'website', ...BUILD_PACKAGE_DIRS]) {
      const manifestPath = join(ROOT, relativeDir, 'package.json')
      parseManifestText(readFileSync(manifestPath, 'utf8'), `${relativeDir}/package.json`)
    }
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
      'script/check.mjs', '--plan', '--', '--files-json', '[]',
    ], { encoding: 'utf8' })
    assert.equal(JSON.parse(verify).mode, 'none')
    const build = execFileSync(process.execPath, [
      'script/build-changed.mjs', '--', '--files-json', '[]',
    ], { encoding: 'utf8' })
    assert.match(build, /no runtime package source changed/u)
  })

  test('fails closed when the requested comparison base is invalid', () => {
    assert.throws(() => execFileSync(process.execPath, [
      'script/check.mjs', '--plan', '--base', 'refs/heads/does-not-exist',
    ], { encoding: 'utf8', stdio: 'pipe' }))
  })

  test('plans an explicit full gate before the repository has its first commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'mayfly-unborn-repository-'))
    try {
      execFileSync('git', ['init', '--initial-branch', 'main', root], { stdio: 'ignore' })
      const output = execFileSync(process.execPath, [
        join(ROOT, 'script/check.mjs'), '--plan', '--tier', 'full',
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
    assert.deepEqual(plan.tests.specs, [])
    assert.deepEqual(classifyChanges(['docs/design/component-library.md']).tests.specs, [])
  })

  test('routes retired skill documentation through the agent drift gate', () => {
    const plan = classifyChanges(['docs/skills/plugin-validation.md'])
    assert.equal(plan.checks.agentDocs, true)
    assert.deepEqual(plan.tests.specs, [])
  })

  test('selects the specs an ordinary leaf implementation reaches', () => {
    const plan = classifyChanges(['packages/mayfly/src/frontend/locale.ts'])
    assert.equal(plan.mode, 'changed')
    assert.equal(plan.checks.build, true)
    assert.ok(plan.tests.specs.includes('packages/mayfly/tests/locale-catalog.spec.ts'))
  })

  test('a renderer reaches its width scan, and a data file the spec that reads it', () => {
    assert.ok(classifyChanges(['packages/mayfly/src/components/transcript-view.ts']).tests.specs.includes('packages/mayfly/tests/components/width-scan.spec.ts'))
    assert.ok(classifyChanges(['examples/mayfly-user-kit/src/index.ts']).tests.specs.includes('examples/mayfly-user-kit/tests/width-scan.spec.ts'))
    assert.deepEqual(classifyChanges(['packages/mayfly/tests/perf/budgets.json']).tests.specs, ['packages/mayfly/tests/perf/work-budget.spec.ts'])
  })

  test('a leaf edit reaches the guard specs that scan its source tree', () => {
    const guards = [
      'packages/mayfly/tests/core/business-rendering-drift.spec.ts',
      'packages/mayfly/tests/frontend/architecture-boundary.spec.ts',
      'packages/mayfly/tests/locale-catalog.spec.ts',
    ]
    const jobs = classifyChanges(['packages/mayfly/src/interaction/jobs.ts']).tests.specs
    for (const guard of [...guards, 'packages/mayfly/tests/core/keyboard-boundary.spec.ts']) assert.ok(jobs.includes(guard), guard)
    const banner = classifyChanges(['packages/mayfly/src/transcript/banner.ts']).tests.specs
    for (const guard of [...guards, 'packages/mayfly/tests/core/keyboard-boundary.spec.ts']) assert.ok(banner.includes(guard), guard)
    const builders = classifyChanges(['packages/ui/src/builders.ts']).tests.specs
    for (const guard of ['packages/mayfly/tests/core/business-rendering-drift.spec.ts', 'packages/mayfly/tests/frontend/architecture-boundary.spec.ts']) assert.ok(builders.includes(guard), guard)
  })

  test('widens global configuration to full, and only that', () => {
    assert.equal(classifyChanges(['vitest.config.ts']).mode, 'full')
    assert.equal(classifyChanges(['packages/ui/src/index.ts']).mode, 'changed')
  })

  test('routes package metadata through build and validation', () => {
    const plan = classifyChanges(['packages/mayfly/package.json'])
    assert.equal(plan.checks.build, true)
    assert.equal(plan.checks.checkLib, true)
    assert.equal(plan.checks.pack, true)
    const plugin = classifyChanges(['examples/header/package.json'])
    assert.equal(plugin.checks.examples, true)
  })

  test('widens executable compositions and verifies shipped presets', () => {
    assert.equal(classifyChanges(['packages/mayfly/cordis.patch.yml']).mode, 'full')
    const preset = classifyChanges(['packages/mayfly/presets/mayfly-cordis/skills/mayfly-plugin-development/SKILL.md'])
    assert.equal(preset.mode, 'full')
    assert.equal(preset.checks.agentDocs, true)
    assert.equal(preset.checks.pack, true)
    assert.equal(preset.checks.build, true)
    assert.ok(preset.tests.specs.includes('packages/mayfly/tests/presets.spec.ts'))
  })

  test('plans no Website check and owes only runtime acceptance', () => {
    const plan = classifyChanges(['website/en/index.md', 'packages/mayfly/src/transcript/status-context.ts'])
    assert.equal(plan.checks.website, undefined)
    assert.deepEqual(plan.manualAcceptance, ['runtime-profile'])
    assert.deepEqual(classifyChanges(['website/en/index.md']).manualAcceptance, [])
  })

  test('ignores generated artifacts without ignoring tracked composition', () => {
    const root = mkdtempSync(join(tmpdir(), 'mayfly-impact-repository-'))
    try {
      execFileSync('git', ['init', '--initial-branch', 'main', root], { stdio: 'ignore' })
      writeFileSync(join(root, '.gitignore'), readFileSync(join(ROOT, '.gitignore'), 'utf8'))
      mkdirSync(join(root, 'packages', 'mayfly'), { recursive: true })
      writeFileSync(join(root, 'packages', 'mayfly', 'cordis.patch.yml'), 'original\n')
      execFileSync('git', ['add', '.'], { cwd: root })
      execFileSync('git', ['commit', '-m', 'baseline'], {
        cwd: root, stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
      })
      mkdirSync(join(root, '.artifacts', 'pack'), { recursive: true })
      writeFileSync(join(root, '.artifacts', 'pack', 'cordis.patch.yml'), 'generated\n')
      const verify = () => JSON.parse(execFileSync(process.execPath, [
        join(ROOT, 'script/check.mjs'), '--plan',
      ], { cwd: root, encoding: 'utf8' }))
      assert.equal(verify().mode, 'none')
      mkdirSync(join(root, 'website'), { recursive: true })
      writeFileSync(join(root, 'website', 'index.md'), 'website\n')
      const full = JSON.parse(execFileSync(process.execPath, [
        join(ROOT, 'script/check.mjs'), '--plan', '--tier', 'full',
      ], { cwd: root, encoding: 'utf8' }))
      assert.ok(!full.steps.some(step => step.includes('website')))
      writeFileSync(join(root, 'packages', 'mayfly', 'cordis.patch.yml'), 'updated\n')
      assert.equal(verify().mode, 'full')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('recognizes every package manifest shape as structural', () => {
    assert.equal(isStructuralBuildPath('packages/ui/package.json'), true)
    assert.equal(isStructuralBuildPath('packages/mayfly/package.json'), true)
    assert.equal(isStructuralBuildPath('examples/header/package.json'), true)
  })

  test('preserves checks when later paths do not require lint', () => {
    const plan = classifyChanges(['packages/mayfly/src/frontend/locale.ts', 'script/verify/select.mjs'])
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
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { check: '', 'check:agent-docs': '' } }))
    writeFileSync(join(root, 'AGENTS.md'), agent)
    return root
  }

  test('accepts durable instructions without project skills', () => {
    const root = fixture('Use `pnpm run check` and `pnpm run check:agent-docs`.\n')
    assert.deepEqual(auditAgentDocs(root, { packageDirs: [], checkPreset: false }), [])
  })

  test('rejects expiring snapshots, dead links, and project skills', () => {
    const root = fixture('As of 2026-01-01, 10 passed. [missing](./missing.md)\npnpm run check, check:agent-docs\n')
    mkdirSync(join(root, '.agents', 'skills', 'old'), { recursive: true })
    writeFileSync(join(root, '.agents', 'skills', 'old', 'SKILL.md'), '---\nname: old\n---\n')
    const problems = auditAgentDocs(root, { packageDirs: [], checkPreset: false })
    assert.ok(problems.some(problem => problem.includes('expiring verification snapshot')))
    assert.ok(problems.some(problem => problem.includes('dead link')))
    assert.ok(problems.some(problem => problem.includes('.agents/skills')))
  })

  test('rejects prerelease literals outside the maintained version set', () => {
    const root = fixture('Use pnpm run check, check:agent-docs. Old `0.1.1-rc.9`.\n')
    const problems = auditAgentDocs(root, { packageDirs: [], checkPreset: false, allowedVersions: ['0.1.0-alpha.1'] })
    assert.ok(problems.some(problem => problem.includes('stale prerelease 0.1.1-rc.9')))
  })

  test('generated artifacts cannot introduce instruction drift', () => {
    const root = fixture('Use pnpm run check, check:agent-docs.\n')
    mkdirSync(join(root, '.artifacts', 'unpacked'), { recursive: true })
    writeFileSync(join(root, '.artifacts', 'unpacked', 'AGENTS.md'), 'As of 2026-01-01, 10 passed.\n')
    assert.deepEqual(auditAgentDocs(root, { packageDirs: [], checkPreset: false }), [])
  })
})
