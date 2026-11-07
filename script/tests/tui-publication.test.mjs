/** TUI publication boundary and two-process installer regressions. @module script/tests/tui-publication */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT, readManifest } from '../package-contract.mjs'
import { tuiPackageProblems } from '../tui-publication.mjs'

const tui = {
  exports: { '.': { default: './lib/index.js' }, './client': { default: './lib/client.js' }, './bin': { default: './lib/bin.js' }, './package.json': './package.json' },
  files: ['lib/*.js', 'lib/types/**/*.d.ts'],
}

test('the TUI publishes exactly root, client and bin, with no composition payload', () => {
  assert.deepEqual(tuiPackageProblems(tui), [])
  assert.match(tuiPackageProblems({ ...tui, exports: { ...tui.exports, './core': './lib/core.js' } }).join('\n'), /exports must be exactly/u)
  assert.match(tuiPackageProblems({ ...tui, exports: { '.': './lib/index.js' } }).join('\n'), /exports must be exactly/u)
  assert.match(tuiPackageProblems({ ...tui, dsh: { bundle: {} } }).join('\n'), /dsh bundle/u)
  for (const path of ['cordis.patch.yml', 'presets/', 'presets/standard.patch.yml']) {
    assert.match(tuiPackageProblems({ ...tui, files: [path] }).join('\n'), /composition payload/u)
    assert.match(tuiPackageProblems(tui, [{ path }]).join('\n'), /composition payload/u)
  }
})

test('the TUI runtime reaches Host only through its client-safe subpaths', () => {
  const source = content => [{ path: 'lib/app.js', content }]
  for (const subpath of ['/remote', '/types', '/conversation']) {
    assert.deepEqual(tuiPackageProblems(tui, source(`import { helper } from '@ephemeral-ai/mayfly-host${subpath}'`)), [])
  }
  for (const name of ['@ephemeral-ai/mayfly-host', '@ephemeral-ai/mayfly-host/startup', '@ephemeral-ai/mayfly-host/settings', '@ephemeral-ai/mayfly-host/typert']) {
    for (const content of [`import { native } from '${name}'`, `await import('${name}')`, `import '${name}'`, `export { native } from '${name}'`]) {
      assert.match(tuiPackageProblems(tui, source(content)).join('\n'), /imports Host-process entry/u, content)
    }
  }
  assert.deepEqual(tuiPackageProblems(tui, [{ path: 'lib/types/app.d.ts', content: "import type { Startup } from '@ephemeral-ai/mayfly-host/startup'" }]), [])
})

test('the actual Mayfly manifest satisfies the TUI publication contract', () => {
  assert.deepEqual(tuiPackageProblems(readManifest('packages/mayfly')), [])
})

test('the canonical installer rejects a shared or arbitrary profile before invoking dsh', () => {
  for (const profile of ['mayfly', 'default', 'unrelated']) {
    const result = spawnSync('bash', [join(ROOT, 'script/install-dev.sh')], { env: { ...process.env, PROFILE: profile, DSH_BIN: '/missing/dsh' }, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /dedicated mayfly-<tag> profile/u)
    assert.doesNotMatch(result.stderr, /not found on PATH/u)
  }
  const script = readFileSync(join(ROOT, 'script/install-dev.sh'), 'utf8')
  assert.match(script, /terminal 1 \(Host\)/u)
  assert.match(script, /terminal 2 \(TUI\)/u)
  assert.match(script, /packages\/host/u)
  assert.match(script, /MAYFLY_DSH_STARTUP_URL/u)
  assert.doesNotMatch(script, /link:\$REPO_ROOT\/packages\/mayfly/u)
})
