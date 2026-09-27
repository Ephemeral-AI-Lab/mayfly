/** Release preparation and registry transition contracts. @module script/tests/release-workflow */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { RELEASE_PACKAGE_DIRS, ROOT } from '../package-contract.mjs'
import { advertisedVersionFiles } from '../release-line.mjs'
import { releaseVersionChanges } from '../release-version.mjs'
import { checkReleaseIndex, checkReleaseReadiness } from '../release-preflight.mjs'
import { validatePromotionSource } from '../promotion-source.mjs'

const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mayfly-release-workflow-'))
  roots.push(root)
  const files = [
    ...RELEASE_PACKAGE_DIRS.map(dir => `${dir}/package.json`),
    'website/package.json',
    'packages/mayfly/src/transcript/banner-content.ts',
    'packages/cli/tests/main.spec.ts',
    'packages/cli/tests/runtime.spec.ts',
    'packages/mayfly/tests/transcript/banner.spec.ts',
    'packages/mayfly/src/interaction/changelog-content.ts',
    ...advertisedVersionFiles,
  ]
  for (const file of new Set(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    cpSync(join(ROOT, file), join(root, file))
  }
  return root
}

test('a release bump validates all markers before any write', () => {
  const root = fixture()
  const file = join(root, 'website/en/index.md')
  writeFileSync(file, 'missing release marker\n')
  const manifest = join(root, 'packages/ui/package.json')
  const before = readFileSync(manifest, 'utf8')
  assert.throws(() => releaseVersionChanges(root, '0.1.1-rc.3'), /release marker not found/u)
  assert.equal(readFileSync(manifest, 'utf8'), before)
  assert.equal(readFileSync(file, 'utf8'), 'missing release marker\n')
  assert.throws(() => releaseVersionChanges(root, '0.1.1-rc.1'), /must advance/u)
})

test('the release bump computes consistent changes without writing files', () => {
  const root = fixture()
  const manifest = join(root, 'packages/mayfly/package.json')
  const before = readFileSync(manifest, 'utf8')
  const { changes } = releaseVersionChanges(root, '0.1.1-rc.3')
  assert.match(changes.get('packages/mayfly/package.json'), /"version": "0\.1\.1-rc\.3"/u)
  assert.match(changes.get('website/en/index.md'), /0\.1\.1-rc\.3/u)
  assert.equal(readFileSync(manifest, 'utf8'), before)
  const cli = join(root, 'packages/cli/package.json')
  writeFileSync(cli, readFileSync(cli, 'utf8').replace('0.1.1-rc.2', '0.1.1-rc.9'))
  assert.throws(() => releaseVersionChanges(root, '0.1.1-rc.3'), /expected 0\.1\.1-rc\.2/u)
})

test('release preflight rejects stale changelogs, advertised versions, and mismatched artifacts', () => {
  const root = fixture()
  assert.deepEqual(checkReleaseReadiness(root, '0.1.1-rc.2'), [])
  const changelog = join(root, 'packages/mayfly/src/interaction/changelog-content.ts')
  writeFileSync(changelog, readFileSync(changelog, 'utf8').replace('Align with Harness', "Mayfly\\'s build aligns with Harness"))
  assert.deepEqual(checkReleaseReadiness(root, '0.1.1-rc.2'), [])
  writeFileSync(changelog, readFileSync(changelog, 'utf8').replace("version: '0.1.1-rc.2'", "version: '0.1.1-rc.9'"))
  assert.ok(checkReleaseReadiness(root, '0.1.1-rc.2').some(problem => problem.includes('changelog')))
  const pkg = join(root, 'website/package.json')
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('0.1.1-rc.2', '0.1.1-rc.9'))
  assert.ok(checkReleaseReadiness(root, '0.1.1-rc.2').some(problem => problem.includes('website/package.json')))
  const index = { packages: RELEASE_PACKAGE_DIRS.map(dir => {
    const name = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).name
    return { name, version: '0.1.1-rc.2', filename: `${name.slice(1).replace('/', '-')}-0.1.1-rc.2.tgz` }
  }) }
  assert.deepEqual(checkReleaseIndex(root, index, '0.1.1-rc.2'), [])
  index.packages[0].version = '0.1.1-rc.9'
  assert.ok(checkReleaseIndex(root, index, '0.1.1-rc.2').some(problem => problem.includes('version')))
  index.packages[0].filename = '../outside.tgz'
  assert.ok(checkReleaseIndex(root, index, '0.1.1-rc.2').some(problem => problem.includes('filename')))
  index.packages[0].filename = 'ephemeral-ai-mayfly-ui-0.1.1-rc.9.tgz'
  assert.ok(checkReleaseIndex(root, index, '0.1.1-rc.2').some(problem => problem.includes('filename')))
})

test('the release workflow validates before publish and verifies the downloaded promotion artifact', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8')
  assert.ok(workflow.indexOf('pnpm release:preflight "${RELEASE_VERSION#v}"') < workflow.indexOf('pnpm check:pack'))
  assert.ok(workflow.indexOf('pnpm release:preflight --artifact "${RELEASE_VERSION#v}"') < workflow.indexOf('node script/release-packages.mjs publish'))
  assert.ok(workflow.indexOf('node script/release-preflight.mjs --artifact "${RELEASE_VERSION#v}"') < workflow.indexOf('node script/release-packages.mjs promote'))
  assert.ok(workflow.includes('node script/promotion-source.mjs "$(git rev-parse HEAD)"'))
})

test('release preflight works in a promotion checkout without node_modules', () => {
  const root = fixture()
  for (const file of ['script/package-contract.mjs', 'script/release-line.mjs', 'script/release-preflight.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    cpSync(join(ROOT, file), join(root, file))
  }
  assert.match(execFileSync(process.execPath, [join(root, 'script/release-preflight.mjs'), '0.1.1-rc.2'], { encoding: 'utf8' }), /are consistent/u)
})

test('promote-only requires the same release commit and six successful registry installs', () => {
  const jobs = [{ name: 'gate + publish candidate', conclusion: 'success' }]
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
    for (const node of ['22', '24']) jobs.push({ name: `registry install (${os}, node ${node})`, conclusion: 'success' })
  }
  const source = { workflowName: 'release', headSha: 'abc123', jobs }
  assert.deepEqual(validatePromotionSource(source, 'abc123'), [])
  assert.ok(validatePromotionSource(source, 'other').length > 0)
  assert.ok(validatePromotionSource({ ...source, workflowName: 'ci' }, 'abc123').length > 0)
  assert.ok(validatePromotionSource({ ...source, jobs: jobs.slice(0, -1) }, 'abc123').length > 0)
  assert.ok(validatePromotionSource({ ...source, jobs: [{ ...jobs[0], conclusion: 'failure' }, ...jobs.slice(1)] }, 'abc123').length > 0)
})
