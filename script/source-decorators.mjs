/** Preserve business source locations while lowering standard decorators for Host builds. @module */
import ts from 'typescript'

const TYPESCRIPT_MODULE = /^[^?]*\.[cm]?tsx?(?:\?|$)/u
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/mu

/**
 * TypeScript assigns generated decorator accessors to the original method's
 * signature. They have no source body, so keep those synthetic statements
 * unmapped. Method decorators, method bodies, and all user-written statements
 * retain TypeScript's source locations. This transform emits the same code as
 * the native generator's decoratorPlugin; Typert still owns metadata emission.
 */
export function sourceDecoratorsPlugin() {
  return {
    name: 'mayfly-source-decorators',
    transform: {
      filter: { id: TYPESCRIPT_MODULE },
      handler(code, id) {
        if (!TYPESCRIPT_MODULE.test(id) || !DECORATOR_SYNTAX.test(code)) return
        const file = id.replace(/\?.*$/su, '')
        const result = ts.transpileModule(code, {
          fileName: file,
          compilerOptions: {
            target: ts.ScriptTarget.ES2024,
            module: ts.ModuleKind.ESNext,
            ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
            sourceMap: true,
          },
          transformers: {
            after: [context => source => {
              const visit = node => {
                if (node.pos === -1 && ts.isExpressionStatement(node)
                  && ts.isCallExpression(node.expression)
                  && ts.isIdentifier(node.expression.expression)
                  && node.expression.expression.text === '__esDecorate') {
                  ts.setEmitFlags(node, ts.EmitFlags.NoSourceMap | ts.EmitFlags.NoNestedSourceMaps)
                }
                return ts.visitEachChild(node, visit, context)
              }
              return ts.visitNode(source, visit)
            }],
          },
        })
        return {
          code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
          map: result.sourceMapText,
        }
      },
    },
  }
}
