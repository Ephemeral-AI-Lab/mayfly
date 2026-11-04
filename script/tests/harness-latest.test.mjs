/** Release freshness follows published upstream versions rather than a stale dist-tag. @module script/tests/harness-latest */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newestHarness } from '../check-harness-latest.mjs'

test('selects the newest publication across alpha and RC tags without unpublished versions', () => {
  assert.equal(newestHarness({
    'dist-tags': { latest: '0.2.1-rc.5' },
    versions: { '0.2.1-rc.5': {}, '0.2.2-alpha.3': {}, '0.2.2-rc.1': {}, '0.2.2-rc.2': {} },
    time: { '0.2.1-rc.5': '2026-10-29', '0.2.2-alpha.3': '2026-11-03', '0.2.2-rc.1': '2026-11-04' },
  }), '0.2.2-rc.1')
  assert.throws(() => newestHarness({}), /no published versions/u)
})
