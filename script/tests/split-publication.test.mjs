/** Shared-renderer publication and two-process installer regressions. @module */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROOT, readManifest } from '../package-contract.mjs'
import { sharedRendererProblems } from '../split-publication.mjs'

const renderer = { exports: { './core': { default: './lib/core.js' } }, files: ['lib/*.js', 'lib/types/**/*.d.ts'] }

test('publication rejects every retired native entry and patch/preset payload', () => {
  assert.deepEqual(sharedRendererProblems(renderer), [])
  assert.match(sharedRendererProblems({ ...renderer, main: 'lib/index.js' }).join('\n'), /explicit subpaths/u)
  assert.match(sharedRendererProblems({ ...renderer, types: 'lib/types/index.d.ts' }).join('\n'), /explicit subpaths/u)
  assert.match(sharedRendererProblems({ ...renderer, dsh: { bundle: {} } }).join('\n'), /dsh bundle/u)
  for (const entry of ['.', './startup', './app', './interaction', './status-jobs', './status-goal', './pane-activity', './pane-todo', './btw-command', './status-agents', './jobs', './agents-command', './mode-status', './attachments', './paste-image', './cordis.patch.yml']) {
    assert.match(sharedRendererProblems({ ...renderer, exports: { [entry]: './lib/legacy.js' } }).join('\n'), /retired native entry/u, entry)
  }
  for (const path of ['cordis.patch.yml', 'presets/', 'presets/standard.patch.yml']) {
    assert.match(sharedRendererProblems({ ...renderer, files: [path] }).join('\n'), /legacy composition payload/u)
    assert.match(sharedRendererProblems(renderer, [{ path }]).join('\n'), /legacy packed payload/u)
  }
})

test('shared runtime admits official stream/surface helpers and refuses Host service entrypoints', () => {
  const source = content => [{ path: 'lib/shared.js', content }]
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session/surface']) {
    assert.deepEqual(sharedRendererProblems(renderer, source(`import { helper } from '${name}'`)), [])
  }
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-settings', '@ephemeral-ai/mayfly-host', '@ephemeral-ai/mayfly-host/types']) {
    for (const content of [`import { native } from '${name}'`, `await import('${name}')`, `import '${name}'`, `export { native } from '${name}'`]) {
      assert.match(sharedRendererProblems(renderer, source(content)).join('\n'), /imports Host runtime/u, content)
    }
  }
  assert.deepEqual(sharedRendererProblems(renderer, [{ path: 'lib/types/legacy.d.ts', content: "import type { Session } from '@deepseek-ai/dsh-session'" }]), [])
})

test('the actual Mayfly manifest exposes only shared renderer subpaths', () => {
  assert.deepEqual(sharedRendererProblems(readManifest('packages/mayfly')), [])
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
