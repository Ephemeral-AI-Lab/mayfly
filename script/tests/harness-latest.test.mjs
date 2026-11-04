/** Release freshness follows published upstream versions rather than a stale dist-tag. @module script/tests/harness-latest */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newestHarness } from '../check-harness-latest.mjs'

test('selects the newest published Harness including its current alpha line', () => {
  assert.equal(newestHarness({
    'dist-tags': { latest: '0.2.1-rc.5' },
    versions: { '0.2.1-rc.5': {}, '0.2.2-alpha.3': {}, '0.2.2-alpha.4': {} },
    time: { '0.2.1-rc.5': '2026-10-29', '0.2.2-alpha.3': '2026-11-03' },
  }), '0.2.2-alpha.3')
  assert.throws(() => newestHarness({}), /no published versions/u)
})
