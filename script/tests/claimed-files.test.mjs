import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { ROOT } from '../package-contract.mjs'
import { CHECKS, DATA_READS } from '../verify/inputs.mjs'
import { claimed, repositoryGraph } from '../verify/select.mjs'

test('every repository file is claimed: parsed by the graph, read through an edge, or named by the inputs', () => {
  const graph = repositoryGraph(ROOT)
  const unclaimed = graph.files.filter(file => !claimed(graph, file))
  assert.deepEqual(unclaimed, [], `declare these in script/verify/inputs.mjs or read them through a literal path:\n${unclaimed.join('\n')}`)
})

test('the declared entries and readers exist', () => {
  for (const [name, check] of Object.entries(CHECKS)) if (check.entry !== undefined) assert.ok(existsSync(join(ROOT, check.entry)), `${name}: ${check.entry}`)
  for (const [reader, read] of DATA_READS) {
    assert.ok(existsSync(join(ROOT, reader)), reader)
    assert.ok(existsSync(join(ROOT, read)), read)
  }
})
