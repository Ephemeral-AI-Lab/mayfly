import { readdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as frontend from '../../src/frontend/index.ts'

const root = resolve(import.meta.dirname, '../../../..')
const headlessRoots = [
  resolve(root, 'packages/ui/src'),
  resolve(root, 'packages/mayfly/src/frontend'),
  resolve(root, 'packages/mayfly/src/conversation'),
] as const
const forbidden = /(?:@earendil-works\/pi-tui|from ['\"](?:react|react-dom|domino)|\b(?:ANSI|process\.stdout|process\.stdin|raw terminal)\b)/i

afterEach(() => { vi.restoreAllMocks() })

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

/** Runtime dependency edges, including re-exports and dynamic imports, with type-only edges erased. */
function runtimeSpecifiers(source: string): string[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
  const references: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.isTypeOnly === true) return
      if (clause?.name === undefined && clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly)) return
      references.push((node.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (node.isTypeOnly) return
      if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0
        && node.exportClause.elements.every(element => element.isTypeOnly)) return
      references.push((node.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const target = node.arguments[0]
      if (target !== undefined && ts.isStringLiteral(target)) references.push(target.text)
      else throw new Error('headless dynamic imports require a literal dependency')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return references
}

describe('frontend runtime architecture boundary', () => {
  it('follows runtime imports while erasing every type-only import and export form', () => {
    expect(runtimeSpecifiers(`
      import type { A } from './type-a.ts'
      import { type A } from './type-b.ts'
      export type * from './type-c.ts'
      export { type A } from './type-d.ts'
      type A = import('./type-e.ts').A
      import './side-effect.ts'
      import { type A, value } from './mixed.ts'
      import value from './default.ts'
      export * from './reexport.ts'
      export { value } from './named.ts'
      void import('./dynamic.ts')
    `)).toEqual(['./side-effect.ts', './mixed.ts', './default.ts', './reexport.ts', './named.ts', './dynamic.ts'])
    expect(() => runtimeSpecifiers('void import(target)')).toThrow('literal dependency')
  })

  it('keeps the complete public frontend runtime import graph independent of terminal rendering', async () => {
    const entry = resolve(root, 'packages/mayfly/src/frontend/index.ts')
    const visited = new Set<string>()
    const visit = async (file: string, chain: readonly string[]): Promise<void> => {
      if (visited.has(file)) return
      visited.add(file)
      const source = await readFile(file, 'utf8')
      for (const target of runtimeSpecifiers(source)) {
        const route = [...chain, file, target].join(' → ')
        expect(target, route).not.toMatch(/@earendil-works\/pi-tui|(?:^|\/)(?:width|key-matching|document-layout|content-rows|markdown-rows|highlight)\.ts$/u)
        if (target.startsWith('.')) await visit(resolve(file, '..', target), [...chain, file])
        else if (target === '@ephemeral-ai/mayfly-ui') await visit(resolve(root, 'packages/ui/src/index.ts'), [...chain, file])
      }
    }
    await visit(entry, [])
    expect(visited.size).toBeGreaterThan(30)
    expect(visited.has(resolve(root, 'packages/mayfly/src/core/ui-interaction-document.ts'))).toBe(true)
  })

  it('loads the built frontend entry with pi-tui unavailable', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { registerHooks } from 'node:module'
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith('@earendil-works/pi-tui')) throw new Error('terminal renderer loaded by frontend')
        return next(specifier, context)
      } })
      const frontend = await import('./packages/mayfly/lib/frontend.js')
      if (typeof frontend.apply !== 'function') throw new Error('frontend entry missing')
      process.stdout.write('headless frontend loaded')
    `], { cwd: root })
    expect(stdout).toBe('headless frontend loaded')
  })

  it('keeps headless package source free of renderer and terminal dependencies', async () => {
    for (const directory of headlessRoots) {
      for (const path of await sourceFiles(directory)) {
        const source = await readFile(path, 'utf8')
        expect(source, path).not.toMatch(forbidden)
      }
    }
  })

  it('keeps pi-tui imports inside the consolidated core adapter', async () => {
    const sourceRoot = resolve(root, 'packages/mayfly/src')
    for (const path of await sourceFiles(sourceRoot)) {
      if (path.startsWith(`${resolve(sourceRoot, 'core')}/`)) continue
      const source = await readFile(path, 'utf8')
      expect(source, path).not.toContain('@earendil-works/pi-tui')
      expect(source, path).not.toMatch(/\\x1b\[(?:1m|3m|9m|38)/u)
    }
  })

  it('exposes a renderer-neutral public surface without renderer objects', () => {
    expect(frontend.freezeModel).toBeTypeOf('function')
    expect(frontend.MayflyLocaleService).toBeTypeOf('function')
    expect(Object.keys(frontend)).not.toContain('NotificationModelService')
    expect(Object.keys(frontend)).not.toContain('Terminal')
  })

  it('keeps cross-area imports on leaf modules, not the area index barrels', async () => {
    const pkgRoot = resolve(root, 'packages/mayfly')
    const srcRoot = resolve(pkgRoot, 'src')
    /** A file's own declared exports plus names it re-exports from leaves (`export {...} from`, `export *`). */
    const exportedNames = async (file: string, own: boolean): Promise<Set<string>> => {
      const names = new Set<string>()
      const source = await readFile(file, 'utf8')
      const bare = (name: string): string => name.trim().replace(/^type\s+/u, '').split(' as ').at(-1)!.trim()
      if (own) {
        for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:const|function|class|interface|type|enum|async function)\s+(\w+)/gu))
          names.add(match[1]!)
        for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}(?!\s+from)/gu))
          for (const name of match[1]!.split(',')) names.add(bare(name))
      }
      for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']+)'/gu))
        for (const name of match[1]!.split(',')) names.add(bare(name))
      for (const match of source.matchAll(/export \* from '(\.[^']+)'/gu))
        for (const name of await exportedNames(resolve(file, '..', match[1]!), true)) names.add(name)
      return names
    }
    /** Names an area index only forwards: importers must use the leaf; the index's own locals (`apply`, `name`, ...) stay legal. */
    const barrels = new Map<string, Promise<Set<string>>>()
    const barrelNames = (area: string): Promise<Set<string>> => {
      if (!barrels.has(area)) barrels.set(area, exportedNames(resolve(srcRoot, area, 'index.ts'), false))
      return barrels.get(area)!
    }
    const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gu
    for (const path of [...await sourceFiles(srcRoot), ...await sourceFiles(resolve(pkgRoot, 'tests'))]) {
      const source = await readFile(path, 'utf8')
      for (const match of source.matchAll(imports)) {
        const target = resolve(path, '..', match[2]!)
        const area = /^.*\/src\/([^/]+)\/index\.ts$/u.exec(target)?.[1]
        if (area === undefined || target === path) continue
        const reexported = await barrelNames(area)
        for (const named of match[1]!.split(',')) {
          const bare = named.trim().replace(/^type\s+/u, '').split(' as ')[0]!.trim()
          if (bare !== '') expect(reexported.has(bare), `${path} imports ${bare} through src/${area}/index.ts — import the leaf`).toBe(false)
        }
      }
    }
  })

  it.each([
    ['zh-CN', 'zh'],
    ['en-US', 'en'],
  ] as const)('mounts and disposes the locale service for %s', async (systemLocale, expected) => {
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
      resolvedOptions: () => ({ locale: systemLocale }),
    } as Intl.DateTimeFormat)
    const ctx = new Context()
    frontend.apply(ctx)
    expect(frontend.name).toBe('mayfly-frontend')
    expect(ctx.mayflyLocale.locale).toBe(expected)
    const service = ctx.mayflyLocale
    await ctx.fiber.dispose()
    expect(service.setPreference('zh')).toBe(false)
  })
})
