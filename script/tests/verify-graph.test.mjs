import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { buildGraph, dependents } from '../verify/graph.mjs'

/** A throwaway repository of the given files, graphed without a cache. */
function graphOf(files) {
  const root = mkdtempSync(join(tmpdir(), 'mayfly-graph-'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  try {
    return buildGraph(root, { files: Object.keys(files).sort(), cache: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const edges = (graph, file) => graph.nodes.get(file).edges.map(edge => `${edge.kind} ${edge.to}`).sort()
const reached = (graph, changed) => [...dependents(graph, changed).keys()].sort()

const PKG = JSON.stringify({ name: '@x/ui', exports: { '.': './lib/index.js', './core': { types: './lib/core.d.ts', default: './lib/core.js' } } })

test('relative imports resolve the .js an ESM source names, and a missing extension, to the TypeScript file', () => {
  const graph = graphOf({
    'packages/a/src/a.ts': "import { b } from './b.js'\nimport { c } from './c'\nexport const a = b + c\n",
    'packages/a/src/b.ts': 'export const b = 1\n',
    'packages/a/src/c.ts': 'export const c = 2\n',
  })
  assert.deepEqual(edges(graph, 'packages/a/src/a.ts'), ['value packages/a/src/b.ts', 'value packages/a/src/c.ts'])
})

test('a workspace package name and a literal path to a built entry both reach the entry source', () => {
  const graph = graphOf({
    'packages/ui/package.json': PKG,
    'packages/ui/src/index.ts': "export * from './leaf.ts'\n",
    'packages/ui/src/core.ts': 'export const core = 1\n',
    'packages/ui/src/leaf.ts': 'export const leaf = 1\n',
    'packages/app/tests/app.spec.ts': "import { leaf } from '@x/ui'\nimport { core } from '@x/ui/core'\nimport { other } from 'vitest'\n",
    'script/shots.mjs': "const core = await import(new URL('../packages/ui/lib/core.js', import.meta.url).href)\n",
  })
  assert.deepEqual(edges(graph, 'packages/app/tests/app.spec.ts'), ['value packages/ui/src/core.ts', 'value packages/ui/src/index.ts'])
  assert.deepEqual(edges(graph, 'script/shots.mjs'), ['value packages/ui/src/core.ts'])
  assert.deepEqual(reached(graph, ['packages/ui/src/leaf.ts']), ['packages/app/tests/app.spec.ts', 'packages/ui/src/index.ts', 'packages/ui/src/leaf.ts'])
})

test('a type-only import is a type edge the selection does not follow', () => {
  const graph = graphOf({
    'packages/a/src/types.ts': 'export interface T { readonly n: number }\n',
    'packages/a/src/use.ts': "import type { T } from './types.ts'\nimport { type T as U } from './types.ts'\nexport const n = (t: T, u: U) => t.n + u.n\n",
  })
  assert.deepEqual(edges(graph, 'packages/a/src/use.ts'), ['type packages/a/src/types.ts', 'type packages/a/src/types.ts'])
  assert.deepEqual(reached(graph, ['packages/a/src/types.ts']), ['packages/a/src/types.ts'])
})

test('literal data reads, template prefixes, and file snapshots are data edges; a base directory is not', () => {
  const graph = graphOf({
    'packages/a/tests/perf/budgets.json': '{}\n',
    'packages/a/tests/perf/work.spec.ts': "const budgets = new URL('./budgets.json', import.meta.url)\nconst root = new URL('../..', import.meta.url)\n",
    'packages/a/tests/frames/x.grid': 'grid\n',
    'packages/a/tests/probe.ts': "await expect(text).toMatchFileSnapshot(`./frames/${name}.grid`)\n",
    'script/shots/assets/font.woff2': '',
    'script/shots/svg.mjs': "const font = new URL(`assets/${file}`, import.meta.url)\n",
  })
  assert.deepEqual(edges(graph, 'packages/a/tests/perf/work.spec.ts'), ['data packages/a/tests/perf/budgets.json'])
  assert.deepEqual(edges(graph, 'packages/a/tests/probe.ts'), ['data packages/a/tests/frames/'])
  assert.deepEqual(edges(graph, 'script/shots/svg.mjs'), ['data script/shots/assets/'])
  assert.ok(reached(graph, ['packages/a/tests/frames/x.grid']).includes('packages/a/tests/probe.ts'))
})

test('a Cordis patch reaches the entries its rows name, and a mocked module path is an import', () => {
  const graph = graphOf({
    'packages/ui/package.json': PKG,
    'packages/ui/src/core.ts': 'export const core = 1\n',
    'packages/ui/cordis.patch.yml': "- insert:\n    - id: core\n      name: '@x/ui/core'\n    - id: base\n      name: '@deepseek-ai/dsh-base'\n",
    'packages/ui/tests/boot.spec.ts': "const patch = new URL('../cordis.patch.yml', import.meta.url)\nvi.mock('../src/core.ts', () => ({}))\n",
  })
  assert.deepEqual(edges(graph, 'packages/ui/cordis.patch.yml'), ['value packages/ui/src/core.ts'])
  assert.deepEqual(edges(graph, 'packages/ui/tests/boot.spec.ts'), ['data packages/ui/cordis.patch.yml', 'value packages/ui/src/core.ts'])
})

test('a deleted file reaches the importers it leaves unresolved, and a cycle ends', () => {
  const graph = graphOf({
    'packages/a/src/a.ts': "import { b } from './b.ts'\nimport { gone } from './gone.js'\nexport const a = b + gone\n",
    'packages/a/src/b.ts': "import { a } from './a.ts'\nexport const b = () => a\n",
    'packages/a/tests/a.spec.ts': "import { a } from '../src/a.ts'\n",
  })
  assert.deepEqual(graph.nodes.get('packages/a/src/a.ts').missing, ['packages/a/src/gone.js', 'packages/a/src/gone.ts'])
  const chain = dependents(graph, ['packages/a/src/gone.ts'])
  assert.deepEqual(chain.get('packages/a/tests/a.spec.ts'), ['packages/a/src/gone.ts', 'packages/a/src/a.ts', 'packages/a/tests/a.spec.ts'])
  assert.deepEqual(reached(graph, ['packages/a/src/b.ts']), ['packages/a/src/a.ts', 'packages/a/src/b.ts', 'packages/a/tests/a.spec.ts'])
})
