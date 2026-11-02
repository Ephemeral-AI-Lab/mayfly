/** Generated decorator helpers have no source body; native API code remains mapped. @module */
import assert from 'node:assert/strict'
import { createRequire, SourceMap } from 'node:module'
import test from 'node:test'
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
