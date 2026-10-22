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
