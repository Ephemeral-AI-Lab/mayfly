import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
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

describe('frontend runtime architecture boundary', () => {
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
