/**
 * AST scan for the locale catalog integrity spec. Translator call arguments
 * are resolved through the TypeScript type checker, so a ternary branch
 * contributes its literal while a comparison inside the same call does not.
 *
 * @module @ephemeral-ai/mayfly/tests/locale-scan
 */

import ts from 'typescript'

const TRANSLATOR_CALLEES = new Set(['t', 'translate', 'tr', 'translator'])

/** One translator key with its source line. */
export interface TranslatorKey {
  /** Resolved string literal value. */
  readonly value: string
  /** 1-based source line of the argument. */
  readonly line: number
}

/** Scan result for one source file. */
export interface SourceAnalysis {
  /** Every string literal value in the file, excluding module specifiers. */
  readonly literals: ReadonlySet<string>
  /** Literal values reachable through a translator call argument. */
  readonly translatorKeys: readonly TranslatorKey[]
  /** Whether the file mentions a translator binding at all. */
  readonly translatorFile: boolean
}

/**
 * Analyze one program source file.
 * @param program - program containing every scanned source file.
 * @param fileName - absolute source path.
 * @param text - source text, used only for the cheap translator-file probe.
 * @returns literals and translator keys for the file.
 */
export function analyzeSource(program: ts.Program, fileName: string, text: string): SourceAnalysis {
  const source = program.getSourceFile(fileName)
  if (source === undefined) throw new Error(`locale scan: ${fileName} is not part of the program`)
  const checker = program.getTypeChecker()
  const literals = new Set<string>()
  const translatorKeys: TranslatorKey[] = []
  const translatorFile = /(?:Translator|MayflyTranslate|contextHints)/u.test(text)

  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isModuleSpecifier(node)) {
      literals.add(node.text)
    }
    if (translatorFile && ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      const argument = node.arguments[0]
      if (name !== undefined && TRANSLATOR_CALLEES.has(name) && argument !== undefined) {
        for (const value of literalValues(checker.getTypeAtLocation(argument))) {
          translatorKeys.push({ value, line: source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1 })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { literals, translatorKeys, translatorFile }
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return undefined
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent
  return ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)
}

function literalValues(type: ts.Type): string[] {
  if (type.isStringLiteral()) return [type.value]
  if (type.isUnion()) return type.types.flatMap(literalValues)
  return []
}
