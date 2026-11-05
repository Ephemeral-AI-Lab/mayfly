/** Discover Mayfly-owned command contracts from frozen source, without claiming behavioral verification. @module script/scenarios/split-commands */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { SPLIT_REFERENCE } from './split-reference.mjs'

/** Extract command registrations and literal alias declarations, including for-of registrations. */
export function commandContracts(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const commands = []
  const aliases = []
  const literal = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined
  const strings = node => ts.isArrayLiteralExpression(node) ? node.elements.map(literal).filter(value => value !== undefined) : []
  const names = (node, call) => {
    const value = literal(node)
    if (value !== undefined) return [value]
    if (ts.isAsExpression(node)) return names(node.expression, call)
    if (!ts.isIdentifier(node)) return []
    for (let parent = call.parent; parent !== undefined; parent = parent.parent) {
      if (!ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer)) continue
      if (parent.initializer.declarations[0]?.name.getText(file) !== node.text) continue
      const expression = ts.isAsExpression(parent.expression) ? parent.expression.expression : parent.expression
      return strings(expression)
    }
    return []
  }
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const target = node.expression.getText(file)
      const isCommand = /(?:^|\.)commands\.register$/u.test(target) || /register(?:Owned|Sessionless)Command$/u.test(target)
      if (isCommand) for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue
        const name = arg.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(file) === 'name')
        if (name === undefined) continue
        for (const command of names(name.initializer, node)) commands.push({ name: command, source: filename, line: file.getLineAndCharacterOfPosition(name.getStart(file)).line + 1 })
      }
      if (/aliases\.register$/u.test(target) || /aliasRegistry\.register$/u.test(target)) {
        const canonical = node.arguments[0] === undefined ? undefined : literal(node.arguments[0])
        if (canonical !== undefined && node.arguments[1] !== undefined) aliases.push({ canonical, aliases: strings(node.arguments[1]) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { commands, aliases }
}

/** The native Harness command catalog is additional; this source inventory deliberately labels that boundary. */
export function referenceCommandInventory(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const files = git(['ls-tree', '-r', '--name-only', SPLIT_REFERENCE.commit, 'packages/mayfly/src/interaction']).trim().split('\n').filter(file => file.endsWith('.ts'))
  const registrations = files.map(file => commandContracts(git(['show', `${SPLIT_REFERENCE.commit}:${file}`]), file))
  const aliases = new Map(registrations.flatMap(result => result.aliases).map(entry => [entry.canonical, entry.aliases]))
  const byName = new Map()
  for (const entry of registrations.flatMap(result => result.commands)) {
    const existing = byName.get(entry.name)
    if (existing === undefined) byName.set(entry.name, { name: entry.name, aliases: aliases.get(entry.name) ?? [], sources: [entry], status: 'unverified' })
    else existing.sources.push(entry)
  }
  const candidateFiles = git(['ls-files', 'packages/mayfly/src/app']).trim().split('\n').filter(file => file.endsWith('.ts'))
  const candidateNames = new Set(candidateFiles.flatMap(file => {
    const source = readFileSync(join(root, file), 'utf8')
    // Feature registries are independent from dsh commands; presence is only a routing hint.
    return [...source.matchAll(/\bname:\s*'([a-z][a-z-]*)'/gu)].map(match => match[1])
  }))
  return {
    reference: SPLIT_REFERENCE,
    scope: 'Mayfly-owned static command registrations; native Harness and dynamic extension catalogs require runtime capture',
    behaviorVerified: false,
    commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({ ...entry, candidateNameMentioned: candidateNames.has(entry.name) })),
  }
}
