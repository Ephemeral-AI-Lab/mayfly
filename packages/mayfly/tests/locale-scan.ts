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
  /** Keys of the file's inline Chinese catalogs (`const zh = { … }` or `const *_ZH = { … }`); they are not literals. */
  readonly catalogKeys: ReadonlySet<string>
}

const INLINE_CATALOG = /^(?:zh|[A-Z][A-Z0-9_]*_ZH)$/u

/** The object literal an inline catalog declaration initializes, through `Object.freeze(…)` and `as` casts. */
function inlineCatalog(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !INLINE_CATALOG.test(node.name.text)) return undefined
  let value = node.initializer
  while (value !== undefined && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression
  if (value !== undefined && ts.isCallExpression(value) && value.arguments.length === 1) value = value.arguments[0]
  return value !== undefined && ts.isObjectLiteralExpression(value) ? value : undefined
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
  const catalogKeys = new Set<string>()
  const catalogNames = new Set<ts.Node>()

  const visit = (node: ts.Node): void => {
    const catalog = inlineCatalog(node)
    if (catalog !== undefined) {
      for (const property of catalog.properties) {
        if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)) {
          catalogKeys.add(property.name.text)
          catalogNames.add(property.name)
        }
      }
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isModuleSpecifier(node) && !catalogNames.has(node)) {
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
  return { literals, translatorKeys, translatorFile, catalogKeys }
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
