import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { commandContracts } from '../scenarios/split-commands.mjs'
import { serializeGrid } from '../scenarios/grid.mjs'
import { compareSplitReference, normalizeSplitGrid, redactSplitOutput, SPLIT_REFERENCE, verifyReferenceTarball } from '../scenarios/split-reference.mjs'

const grid = serializeGrid({ cols: 20, lines: ['hello', ''], styles: [[{ from: 0, to: 4, style: 'fg:#112233 b' }], []], cursor: [0, 5] })

function fixture(t) {
  const dir = join(tmpdir(), `mayfly-reference-test-${randomUUID()}`)
  mkdirSync(dir)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filename = 'startup-20x2.grid'
  writeFileSync(join(dir, filename), grid)
  const manifest = { ...SPLIT_REFERENCE, checkpoints: { [filename]: createHash('sha256').update(grid).digest('hex') } }
  writeFileSync(join(dir, 'reference.json'), JSON.stringify(manifest))
  return { dir, manifest }
}

test('strict comparison preserves text, colors, styles, dimensions and visible cursor', t => {
  const { dir } = fixture(t)
  const compare = actual => compareSplitReference(dir, [{ name: 'startup', grid: actual }], { cols: 20, rows: 2 })
  assert.deepEqual(compare(grid), [])
  for (const changed of [grid.replace('hello', 'hallo'), grid.replace('#112233', '#112234'), grid.replace(' b', ' i'), grid.replace('cursor 0,5', 'cursor none'), grid.replace('20x2', '21x2')]) assert.ok(compare(changed).length > 0)
})

test('comparison refuses missing checkpoints and tampered provenance or reference bytes', t => {
  const { dir, manifest } = fixture(t)
  assert.match(compareSplitReference(dir, [{ name: 'missing', grid }], { cols: 20, rows: 2 })[0], /no frozen reference/u)
  assert.deepEqual(compareSplitReference(dir, [], { cols: 20, rows: 2 }), ['No candidate checkpoints were captured'])
  writeFileSync(join(dir, 'startup-20x2.grid'), `${grid}\n`)
  assert.throws(() => compareSplitReference(dir, [{ name: 'startup', grid }], { cols: 20, rows: 2 }), /checksum mismatch/u)
  writeFileSync(join(dir, 'reference.json'), JSON.stringify({ ...manifest, version: 'candidate' }))
  assert.throws(() => compareSplitReference(dir, [{ name: 'startup', grid }], { cols: 20, rows: 2 }), /frozen published/u)
  assert.throws(() => verifyReferenceTarball(Buffer.from('candidate tarball')), /frozen npm integrity/u)
})

test('only named volatile fields normalize, without removing spacing or style differences', () => {
  assert.equal(normalizeSplitGrid('cmd-0123abcd-1 12345678-1234-1234-1234-123456789abc'), 'cmd-xxxxxxxx-1 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
  assert.equal(normalizeSplitGrid(grid), grid)
})

test('diagnostics redact URLs and raw, encoded, form-encoded and unknown startup tokens', () => {
  const url = 'http://127.0.0.1:3080/?token=a%20b%2Bc'
  const redacted = redactSplitOutput(`${url} a b+c a%20b%2Bc a+b%2Bc http://host/?token=other-secret`, url)
  for (const token of [url, 'a b+c', 'a%20b%2Bc', 'a+b%2Bc', 'other-secret']) assert.ok(!redacted.includes(token))
})

test('command inventory reads canonical names, aliases and loop registrations without renderer names', () => {
  const result = commandContracts(`
    ctx.commands.register({ name: 'model', handler() {} })
    registerOwnedCommand(ctx, { name: 'new' })
    aliasRegistry.register('new', ['clear'])
    for (const command of ['version', 'changelog'] as const) ctx.commands.register({ name: command })
    panes.register({ name: 'not-a-command' })
  `, 'fixture.ts')
  assert.deepEqual(result.commands.map(command => command.name), ['model', 'new', 'version', 'changelog'])
  assert.deepEqual(result.aliases, [{ canonical: 'new', aliases: ['clear'] }])
})
