/** Generated decorator helpers have no source body; native API code remains mapped. @module */
import assert from 'node:assert/strict'
import { createRequire, SourceMap } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'tsdown'
import hostConfig from '../../packages/host/tsdown.config.ts'
import { ROOT, defaultTarget, readManifest } from '../package-contract.mjs'
import { sourceDecoratorsPlugin } from '../source-decorators.mjs'

const requireHost = createRequire(new URL('../../packages/host/package.json', import.meta.url))
const { decoratorPlugin } = await import(requireHost.resolve('@deepseek-ai/dsh-typert-generator/tsdown'))

const fixture = `function expose(value: unknown, context: ClassMethodDecoratorContext) {
  void value
  void context
}
export class Service {
  @expose
  read(): string {
    return 'business value'
  }
}
`

test('only unmapped synthetic decoration changes; business output matches the native transform', async () => {
  const id = '/tmp/mayfly-source-map-fixture.ts'
  const native = decoratorPlugin().transform.handler(fixture, id)
  const transformed = sourceDecoratorsPlugin().transform.handler(fixture, id)
  assert.equal(transformed.code, native.code)
  assert.notEqual(transformed.map, native.map)
  const compiled = await import(`data:text/javascript,${encodeURIComponent(transformed.code)}`)
  assert.equal(new compiled.Service().read(), 'business value')
  const map = new SourceMap(JSON.parse(transformed.map))
  const oldMap = new SourceMap(JSON.parse(native.map))
  const lines = transformed.code.split('\n')
  const syntheticLine = lines.findIndex(line => line.includes('__esDecorate(this, null,'))
  const syntheticColumn = lines[syntheticLine].indexOf('has:')
  assert.equal(oldMap.findEntry(syntheticLine, syntheticColumn).generatedLine, syntheticLine)
  assert.notEqual(map.findEntry(syntheticLine, syntheticColumn).generatedLine, syntheticLine)
  const bodyLine = lines.findIndex(line => line.includes("return 'business value'"))
  assert.equal(map.findEntry(bodyLine, lines[bodyLine].indexOf('return')).originalLine, 7)
  const decoratorLine = lines.findIndex(line => line.includes('_read_decorators = [expose]'))
  assert.equal(map.findEntry(decoratorLine, lines[decoratorLine].indexOf('expose')).originalLine, 5)
})

test('passes through non-TypeScript and undecorated modules, and handles TSX query identifiers', () => {
  const transform = sourceDecoratorsPlugin().transform.handler
  assert.equal(transform(fixture, '/tmp/fixture.js'), undefined)
  assert.equal(transform('export const x = 1', '/tmp/fixture.ts'), undefined)
  const output = transform(`${fixture}\nexport const node = <div />\n`, '/tmp/fixture.tsx?build')
  assert.match(output.code, /jsx-runtime/u)
  assert.doesNotMatch(output.code, /sourceMappingURL/u)
})

test('Host maps stay local while runtime/declaration publication and chunk closure remain guarded', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'mayfly-host-pack-map-'))
  const root = join(fixtureRoot, 'packages', 'host')
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), fixture)
    writeFileSync(join(root, 'package.json'), JSON.stringify(readManifest('packages/host')))
    await build({ ...hostConfig, config: false, cwd: root, entry: { index: 'src/index.ts' }, plugins: [sourceDecoratorsPlugin()], logLevel: 'silent' })
    const javascript = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
    const sourceMap = new SourceMap(JSON.parse(readFileSync(join(root, 'lib', 'index.js.map'), 'utf8')))
    const lines = javascript.split('\n')
    const bodyLine = lines.findIndex(line => line.includes('business value'))
    assert.notEqual(bodyLine, -1)
    assert.equal(sourceMap.findEntry(bodyLine, lines[bodyLine].indexOf('return')).originalLine, 7)
    assert.match(javascript, /sourceMappingURL=index\.js\.map/u)
    for (const entry of ['startup', 'settings']) {
      writeFileSync(join(root, 'lib', `${entry}.js`), javascript)
      writeFileSync(join(root, 'lib', `${entry}.js.map`), '{}')
    }
    writeFileSync(join(root, 'lib', 'typert.remote-client.d.ts'), 'export {}\n')
    writeFileSync(join(root, 'lib', 'typert.remote-client.d.ts.map'), '{}')
    const manifest = readManifest('packages/host')
    const runtimeTargets = Object.values(manifest.exports).map(defaultTarget).filter(target => target?.startsWith('./lib/'))
    const literalFiles = manifest.files.filter(path => path.startsWith('lib/') && !path.includes('*'))
    for (const target of [...runtimeTargets, ...literalFiles]) {
      const full = join(root, target)
      if (existsSync(full)) continue
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, 'export {}\n')
    }
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    const report = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
    const paths = report.files.map(file => file.path)
    for (const entry of ['index', 'startup', 'settings']) {
      assert.ok(paths.includes(`lib/${entry}.js`), `${entry} runtime is published`)
      assert.ok(!paths.includes(`lib/${entry}.js.map`), `${entry} runtime map stays local`)
      assert.ok(existsSync(join(root, 'lib', `${entry}.js.map`)), `${entry} runtime map survives packaging`)
    }
    assert.ok(paths.includes('lib/typert.remote-client.d.ts.map'), 'generated client declaration map remains published')
    mkdirSync(join(fixtureRoot, 'examples'))
    mkdirSync(join(fixtureRoot, 'script'))
    for (const file of ['check-lib-exports.mjs', 'package-contract.mjs']) {
      writeFileSync(join(fixtureRoot, 'script', file), readFileSync(join(ROOT, 'script', file)))
    }
    const check = () => spawnSync(process.execPath, [join(fixtureRoot, 'script', 'check-lib-exports.mjs')], { encoding: 'utf8' })
    assert.equal(check().status, 0, 'local map companions do not require publication')
    writeFileSync(join(root, 'lib', 'unpublished-chunk.js'), 'export {}\n')
    const missingChunk = check()
    assert.equal(missingChunk.status, 1)
    assert.match(missingChunk.stderr, /built lib\/unpublished-chunk\.js is not in the files list/u)
    rmSync(join(root, 'lib', 'unpublished-chunk.js'))
    writeFileSync(join(root, 'lib', 'orphan.js.map'), '{}')
    const orphanMap = check()
    assert.equal(orphanMap.status, 1)
    assert.match(orphanMap.stderr, /built lib\/orphan\.js\.map is not in the files list/u)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
