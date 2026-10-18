/** Release metadata, build entry, and agent-document drift tests. @module script/tests/repository-workflow */

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

describe('release metadata', () => {
  test('promotes alpha and stable releases to latest while retaining the RC tag', () => {
    assert.deepEqual(releaseDistTags('0.1.0-alpha.1'), ['latest'])
    assert.deepEqual(releaseDistTags('0.1.0-rc.1'), ['rc', 'latest'])
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

  test('build-changed accepts pnpm argument separators and an explicit empty set', () => {
    const build = execFileSync(process.execPath, [
      'script/build-changed.mjs', '--', '--files-json', '[]',
    ], { encoding: 'utf8' })
    assert.match(build, /no runtime package source changed/u)
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
