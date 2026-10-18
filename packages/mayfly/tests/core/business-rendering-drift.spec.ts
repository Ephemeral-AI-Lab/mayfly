/**
 * @module business-rendering-drift
 * G4 architecture guard keeping terminal presentation mechanics in core.
 */

import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')
const packagesRoot = resolve(root, 'packages')
const sourceSegment = `${sep}src${sep}`
const coreSourceSegment = `${resolve(root, 'packages/mayfly/src/core')}${sep}`
const widthHelperNames = new Set(['visibleWidth', 'truncateToWidth', 'wrapText', 'wrapTextWithAnsi'])
const borderGlyph = /[╭╮╰╯│─├┤┬┴┼]/u
const selectionPointer = /^\s*(?:→|›|❯)\s/u
const paddingGlyph = /^(?: +|[─━═█░]+)$/u
const widthName = /(?:width|columns|cells)/iu
const widthOperators = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
])

const approvedWidthMath = new Set([
  // A digit count of a line number for the edit gutter (an ASCII numeral, not display width); the painter owns the gutter.
  'packages/mayfly/src/interaction/deliverables-command.ts:const numberWidth = diff.hunks.reduce((width, hunk) => Math.max(width, String(hunk.oldStart + hunk.oldLines - 1).length, String(hunk.newStart + hunk.newLines - 1).length), 1)',
  'packages/mayfly/src/transcript/tool-calls.ts:const width = String(preview.at(-1)?.number ?? 0).length',
])

const approvedPresentation = new Set([
  "border:packages/mayfly/src/components/tool-line.ts:{ text: last ? '  \u2514 ' : '  \u251c ', tone: 'muted' },",
  "border:packages/mayfly/src/components/transcript-view.ts:const guide = span(last ? '      ' : '  \u2502   ', 'muted')",
  "border:packages/mayfly/src/transcript/agent-presentation.ts:export function agentTreeBranch(last: boolean): '\u2514\u2500' | '\u251c\u2500' {",
  "border:packages/mayfly/src/transcript/agent-presentation.ts:return last ? '\u2514\u2500' : '\u251c\u2500'",
  "padding:packages/mayfly/src/interaction/stats-account.ts:const total = BigInt(leftWhole + leftFraction.padEnd(scale, '0')) + BigInt(rightWhole + rightFraction.padEnd(scale, '0'))",
  "padding:packages/mayfly/src/transcript/splash.ts:' '.repeat(Math.max(0, Math.floor((width - deps.visibleWidth(text)) / 2))) + text",
  "padding:packages/mayfly/src/transcript/splash.ts:const age = ' '.repeat(Math.max(0, AGE_WIDTH - deps.visibleWidth(session.age))) + (session.live ? colors.success : colors.textMuted)(session.age)",
  "padding:packages/mayfly/src/transcript/splash.ts:const lead = ' '.repeat(Math.max(0, Math.floor((width - listWidth) / 2)))",
  "padding:packages/mayfly/src/transcript/splash.ts:return gap < 2 ? deps.truncate(left, width) : left + ' '.repeat(gap) + right",
  "padding:packages/mayfly/src/transcript/splash.ts:text + ' '.repeat(Math.max(0, width - deps.visibleWidth(text)))",
  "padding:packages/mayfly/src/transcript/tool-calls.ts:const lead = names[index]!.padEnd(wide)",
  "pointer:packages/mayfly/src/interaction/update-command.ts:detail: [`v${fromVersion} \u2192 v${toVersion}`, detail, t('The update is kept only after a successful startup check.')].filter(Boolean).join(' \u00b7 '),",
  "pointer:packages/mayfly/src/interaction/update-command.ts:{ kind: 'divider', label: `v${fromVersion} \u2192 v${toVersion}` },",
  "pointer:packages/mayfly/src/transcript/stream-facts.ts:const tokens = mark?.before !== undefined && mark.after !== undefined ? `${approx(mark.before)} \u2192 ${approx(mark.after)} ${t('tokens')}`",
  "pointer:packages/mayfly/src/transcript/tool-calls.ts:if (mcp !== null) return `${mcp[1]!} \u203a ${mcp[2]!}`",
])

interface Audit {
  readonly violations: ReadonlySet<string>
  readonly widthMath: ReadonlySet<string>
  readonly presentation: ReadonlySet<string>
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

async function businessSourceFiles(): Promise<string[]> {
  return (await sourceFiles(packagesRoot)).filter(path =>
    path.includes(sourceSegment) && !path.includes(coreSourceSegment))
}

function sourceLine(source: string, node: ts.Node): string {
  const start = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line
  return source.split('\n')[start]?.trim() ?? ''
}

function record(path: string, source: string, node: ts.Node): string {
  return `${path}:${sourceLine(source, node)}`
}

function containsLength(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'length') return true
  return node.getChildren().some(containsLength)
}

function containsWidthName(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && widthName.test(node.text)) return true
  return node.getChildren().some(containsWidthName)
}

function stringValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (node.kind === ts.SyntaxKind.TemplateHead
    || node.kind === ts.SyntaxKind.TemplateMiddle
    || node.kind === ts.SyntaxKind.TemplateTail) return (node as ts.TemplateLiteralToken).text
  return undefined
}

function auditSource(path: string, source: string): Audit {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const violations = new Set<string>()
  const widthMath = new Set<string>()
  const presentation = new Set<string>()

  const violate = (node: ts.Node, reason: string): void => {
    violations.add(`${reason}:${record(path, source, node)}`)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text
      if (moduleName.startsWith('@earendil-works/pi-tui')
        || moduleName === '@ephemeral-ai/mayfly/core/chrome'
        || moduleName === '@ephemeral-ai/mayfly/core/width') {
        violate(node, 'renderer-import')
      }
      if (moduleName === '@ephemeral-ai/mayfly/core' && node.importClause !== undefined) {
        const bindings = node.importClause.namedBindings
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = (element.propertyName ?? element.name).text
            if (widthHelperNames.has(imported)) violate(element, 'width-helper-import')
          }
        }
      }
    }

    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node))
      && node.name !== undefined && ts.isIdentifier(node.name)) {
      if (widthHelperNames.has(node.name.text)) violate(node, 'local-width-helper')
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined && widthName.test(node.name.text)
        && containsLength(node.initializer)) {
        widthMath.add(record(path, source, node))
      }
    }

    if (ts.isBinaryExpression(node) && widthOperators.has(node.operatorToken.kind)
      && ((containsLength(node.left) && containsWidthName(node.right))
        || (containsLength(node.right) && containsWidthName(node.left)))) {
      widthMath.add(record(path, source, node))
    }

    const value = stringValue(node)
    if (value !== undefined) {
      if (borderGlyph.test(value)) presentation.add(`border:${record(path, source, node)}`)
      if (selectionPointer.test(value)) presentation.add(`pointer:${record(path, source, node)}`)
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const receiver = stringValue(node.expression.expression)
      if ((method === 'repeat' && receiver !== undefined && paddingGlyph.test(receiver))
        || method === 'padEnd') {
        presentation.add(`padding:${record(path, source, node)}`)
      }
      if (method === 'join' && sourceLine(source, node).match(/Array(?:\.from)?\([^)]*width[^)]*\).*\.fill\(['"] ['"]\)/iu)) {
        violate(node, 'local-padding-math')
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(file)
  return { violations, widthMath, presentation }
}

function merge(target: Set<string>, values: ReadonlySet<string>): void {
  for (const value of values) target.add(value)
}

describe('business package rendering drift guard', () => {
  it('detects representative renderer-import, width, pointer, border, and padding drift', () => {
    const audit = auditSource('positive-fixture.ts', `
import { visibleWidth as columns } from '@ephemeral-ai/mayfly/core'
const widthOf = (text: string) => Array.from(text).length
const available = width - columns(text)
const pointer = '  → active'
const border = '\\u2502'
const padding = Array(width).fill(' ').join('')
void [widthOf, available, pointer, border, padding]
`)
    expect([...audit.violations].map(value => value.split(':', 1)[0])).toEqual([
      'width-helper-import',
      'local-padding-math',
    ])
    expect(audit.widthMath).toEqual(new Set([
      'positive-fixture.ts:const widthOf = (text: string) => Array.from(text).length',
    ]))
    expect(audit.presentation).toEqual(new Set([
      "pointer:positive-fixture.ts:const pointer = '  → active'",
      "border:positive-fixture.ts:const border = '\\u2502'",
    ]))
  })

  it('keeps renderer helpers and local display-width implementations inside core', async () => {
    const violations = new Set<string>()
    const widthMath = new Set<string>()
    for (const absolutePath of await businessSourceFiles()) {
      const path = relative(root, absolutePath)
      const audit = auditSource(path, await readFile(absolutePath, 'utf8'))
      merge(violations, audit.violations)
      merge(widthMath, audit.widthMath)
    }
    expect(violations).toEqual(new Set())
    expect(widthMath).toEqual(approvedWidthMath)
  }, 15_000)

  it('requires an exact baseline review for business-owned pointers, borders and padding', async () => {
    const presentation = new Set<string>()
    for (const absolutePath of await businessSourceFiles()) {
      const path = relative(root, absolutePath)
      const audit = auditSource(path, await readFile(absolutePath, 'utf8'))
      merge(presentation, audit.presentation)
    }
    expect(presentation).toEqual(approvedPresentation)
  }, 15_000)
})
