/**
 * Decision tests for the `mayflyHost` surface: every `@Remote` method records the native API it stands in for, its
 * recorded scope matches the resources it declares, a request that names a Session declares that Session or suppresses
 * it explicitly, and the seams document lists the same methods and scopes.
 * @module
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { NATIVE_GAPS } from '../../src/remote/native-gaps.ts'

const SERVICE = fileURLToPath(new URL('../../src/remote/service.ts', import.meta.url))
const SEAMS = fileURLToPath(new URL('../../../../docs/mayfly-seams.md', import.meta.url))

/** How one method's decorator scopes it. */
type Declared = 'session' | 'suppressed' | 'none'

interface RemoteMethod {
  readonly name: string
  readonly declared: Declared
  /** Whether the first parameter's type has a `sessionId` property. */
  readonly namesSession: boolean
}

function remoteMethods(): RemoteMethod[] {
  const program = ts.createProgram([SERVICE], { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, experimentalDecorators: false })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(SERVICE)!
  const methods: RemoteMethod[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const decorator = ts.getDecorators(node)?.find(item => ts.isCallExpression(item.expression) && ts.isIdentifier(item.expression.expression) && item.expression.expression.text === 'Remote')
      if (decorator !== undefined) {
        const argument = (decorator.expression as ts.CallExpression).arguments[0]
        let declared: Declared = 'none'
        if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
          const resources = argument.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'resources') as ts.PropertyAssignment | undefined
          const session = resources !== undefined && ts.isObjectLiteralExpression(resources.initializer)
            ? resources.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'session') as ts.PropertyAssignment | undefined
            : undefined
          if (session !== undefined) {
            const body = ts.isArrowFunction(session.initializer) ? session.initializer.body : undefined
            declared = body !== undefined && ts.isIdentifier(body) && body.text === 'undefined' ? 'suppressed' : 'session'
          }
        }
        const parameter = node.parameters[0]
        const type = parameter === undefined ? undefined : checker.getTypeAtLocation(parameter)
        const namesSession = type !== undefined && type.getSymbol()?.getName() !== 'AbortSignal'
          && (type.isUnion() ? type.types : [type]).some(member => member.getProperty('sessionId') !== undefined)
        methods.push({ name: node.name.text, declared, namesSession })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return methods
}

const methods = remoteMethods()

describe('mayflyHost native gaps', () => {
  it('records exactly one native gap per Remote method', () => {
    expect(methods.length).toBeGreaterThan(0)
    expect(Object.keys(NATIVE_GAPS).sort()).toEqual(methods.map(method => method.name).sort())
    for (const [name, gap] of Object.entries(NATIVE_GAPS)) expect(gap.missing.length, name).toBeGreaterThan(20)
  })

  it('scopes a method to a Session exactly when it declares that Session as a resource', () => {
    const mismatched = methods
      .filter(method => (method.declared === 'session') !== (NATIVE_GAPS[method.name]!.scope === 'session'))
      .map(method => `${method.name}: declares ${method.declared}, records ${NATIVE_GAPS[method.name]!.scope}`)
    expect(mismatched).toEqual([])
  })

  it('never leaves a Session-naming request without a declared or explicitly suppressed Session resource', () => {
    expect(methods.filter(method => method.namesSession && method.declared === 'none').map(method => method.name)).toEqual([])
    // The one deliberate suppression: a global statistics scan authorizes against the Host, not the requesting Session.
    expect(methods.filter(method => method.declared === 'suppressed').map(method => method.name)).toEqual(['statsHistory'])
  })

  it('lists the same methods and scopes in the seams document', () => {
    const rows = [...readFileSync(SEAMS, 'utf8').matchAll(/^\| `([A-Za-z]+)` \| (session|host) \|/gmu)].map(match => [match[1]!, match[2]!])
    expect(Object.fromEntries(rows)).toEqual(Object.fromEntries(Object.entries(NATIVE_GAPS).map(([name, gap]) => [name, gap.scope])))
  })
})
