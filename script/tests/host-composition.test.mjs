/** Verify installer refusal of a split Host carrying browser-only model context. @module */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const host = fileURLToPath(new URL('../../packages/host', import.meta.url))
const installer = readFileSync(new URL('../install-dev.sh', import.meta.url), 'utf8')
const verification = /MAYFLY_COMPOSED_CONFIG="\$COMPOSED" node - "\$HOST_PKG" <<'NODE'\n([\s\S]*?)\nNODE/u.exec(installer)[1]
const rows = [
  { id: 'web-runtime', config: { surfaceContext: false } },
  { id: 'harness-dev-context', disabled: true },
  { id: 'preset-mayfly-cordis', config: { id: 'mayfly-cordis' } },
]

function verify(entries) {
  return spawnSync(process.execPath, ['-', host], {
    input: verification, encoding: 'utf8',
    env: { ...process.env, MAYFLY_COMPOSED_CONFIG: JSON.stringify(entries) },
  })
}

test('installer accepts the split Host composition including native nested groups', () => {
  for (const entries of [rows, [{ id: 'host', group: true, config: rows }]]) {
    const result = verify(entries)
    assert.equal(result.status, 0, result.stderr)
  }
})

test('installer rejects enabled or missing browser prompt and shell context, and a missing creative preset', () => {
  for (const [index, replacement, message] of [
    [0, { ...rows[0], config: { surfaceContext: true } }, 'shell context'],
    [1, { ...rows[1], disabled: false }, 'model prompt'],
    [2, { ...rows[2], config: { id: 'cordis' } }, 'creative preset'],
  ]) {
    for (const entries of [rows.filter((_, i) => i !== index), rows.map((row, i) => i === index ? replacement : row)]) {
      const result = verify(entries)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(message, 'u'))
    }
  }
})
