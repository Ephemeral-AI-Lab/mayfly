/** Website marketplace generation boundary tests. @module script/tests/market-generator */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { detailPage, installCommand, readmeBlock, requiresDedicatedProfile, validateMarketIndex } from '../../website/scripts/generate-market.mjs'

function entry(overrides = {}) {
  return {
    id: 'loop',
    source: 'official',
    displayName: 'Loop',
    description: 'Recurring prompts.',
    descriptionZh: '循环提示。',
    author: { name: 'Test' },
    category: 'workflow',
    status: 'stable',
    surfaces: { server: {} },
    install: { rows: [{ name: 'dsh-loop', npm: { spec: 'dsh-loop' } }] },
    ...overrides,
  }
}

test('market generator rejects unsafe paths and malformed install rows', () => {
  assert.throws(() => validateMarketIndex(null), /not an object/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 2, entries: [] }), /schema version 2/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1 }), /no entries array/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [null] }), /not an object/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ id: '../../outside' })] }), /unsafe id/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry(), entry()] }), /repeats id/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ displayName: '' })] }), /displayName/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ source: 'unknown' })] }), /unknown source/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ status: 'unknown' })] }), /unknown status/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ surfaces: null })] }), /surfaces/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ install: { rows: [] } })] }), /install.rows/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ install: { rows: [{}] } })] }), /package name and source/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ install: { rows: [{ name: 'x', npm: {} }] } })] }), /npm sources/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ install: { rows: [{ name: 'x', npm: { spec: 'x\n```' } }] } })] }), /npm sources/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ install: { rows: [{ name: 'x', github: {} }] } })] }), /GitHub sources/)
  assert.throws(() => validateMarketIndex({ schemaVersion: 1, entries: [entry({ install: { rows: [{ name: 'x', github: { repo: 'owner/repo', ref: 'main\n```' } }] } })] }), /GitHub sources/)
  const valid = { schemaVersion: 1, entries: [entry()] }
  assert.equal(validateMarketIndex(valid), valid.entries)
  const fallback = JSON.parse(readFileSync(new URL('../../website/scripts/market-fallback.json', import.meta.url), 'utf8'))
  assert.equal(validateMarketIndex(fallback).length, 14)
})

test('third-party README content stays inert in generated Vue Markdown', () => {
  const malicious = entry({
    displayName: 'Line one\n# injected',
    links: { repo: 'javascript:alert(1)', docs: 'https://example.com/docs' },
    provides: { tools: ['<script>alert(2)</script>'], commands: ['{{ globalThis.location }}'] },
    capabilities: ['<img src=x onerror=alert(3)>'],
    verified: { at: '{{ globalThis.location }}', packages: [{ name: '<script>alert(4)</script>', version: '1.0.0' }] },
    readme: '<!-- @include: ../../../../.git/config -->\n{{ globalThis.location }}\n<script>alert(1)</script>',
  })
  const block = readmeBlock(malicious)
  assert.match(block, /^<pre v-pre/u)
  assert.doesNotMatch(block, /<!--|\{\{|<script/u)
  assert.match(block, /&lt;!-- @include/u)
  assert.match(block, /&#123;&#123; globalThis\.location/u)
  const page = detailPage(malicious, 'en')
  assert.match(page, /title: "Line one # injected"/u)
  assert.doesNotMatch(page, /javascript:/u)
  assert.doesNotMatch(page, /<script>|<img|\{\{/u)
  assert.match(page, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/u)
  assert.match(page, /https:\/\/example\.com\/docs/u)
})

test('install commands include every row and quote shell-sensitive GitHub specs', () => {
  const github = entry({ install: { rows: [
    { name: 'a', github: { repo: 'owner/repo', ref: 'main', subdir: 'plugins/a' } },
    { name: 'b', github: { repo: 'owner/repo', ref: 'main', subdir: 'plugins/b' } },
  ] } })
  assert.equal(installCommand(github), "dsh plugin --profile <name> add 'github:owner/repo#main&path:plugins/a' 'github:owner/repo#main&path:plugins/b'")
  const mixed = entry({ install: { rows: [
    { name: 'a', npm: { spec: 'a' } },
    { name: 'b', github: { repo: 'owner/repo', ref: 'main' } },
  ] } })
  assert.equal(installCommand(mixed), 'dsh plugin --profile <name> add <loop>')
})

test('ACP is documented as a dedicated-profile automation frontend', () => {
  const acp = entry({
    id: 'acp',
    displayName: 'ACP Server',
    install: { rows: [{ name: '@deepseek-ai/dsh-acp', npm: { spec: '@deepseek-ai/dsh-acp' } }] },
  })
  assert.equal(requiresDedicatedProfile(entry()), false)
  assert.equal(requiresDedicatedProfile(acp), true)
  assert.equal(installCommand(acp), 'dsh plugin --profile <automation-name> add @deepseek-ai/dsh-acp')
  assert.match(detailPage(acp, 'en'), /owns stdio.*dedicated profile/su)
  assert.match(detailPage(acp, 'zh'), /独占 stdio.*独立 profile/su)
  assert.match(detailPage(acp, 'en'), /`\/plugin install` inside Mayfly refuses/u)
})

test('removed entries retain a detail page without install instructions', () => {
  const removed = entry({ status: 'removed', statusNote: 'compromised release' })
  const page = detailPage(removed, 'en')
  assert.match(page, /compromised release/u)
  assert.match(page, /can no longer be installed/u)
  assert.doesNotMatch(page, /dsh plugin|\/plugin install/u)
})
