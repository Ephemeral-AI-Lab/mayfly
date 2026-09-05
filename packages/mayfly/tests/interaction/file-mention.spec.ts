/**
 * Tests for the `@`-mention support module: mention-token extraction, the
 * `fd` PATH probe (default probes against real fake binaries, caching, and
 * the test replacement seam), and the filesystem fallback's scanner
 * semantics (kind detection, skip set, caps, and abort behavior).
 */

import { mkdirSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_FALLBACK_SUGGESTIONS,
  detectFdPath,
  extractAtPrefix,
  fsMentionSuggestions,
  listDirectoryMentions,
  setFdProbe,
} from '../../src/interaction/file-mention.ts'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import { mentionPath, requiresFilesystemMention } from '../../src/internal/mention.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>() }))

registerTempDirCleanup()

const signal = (): AbortSignal => new AbortController().signal
const probeState = (): { result: Promise<string | null> | undefined } => ({ result: undefined })

const savedPath = process.env.PATH
const savedCwd = process.cwd()

afterEach(() => {
  setFdProbe(undefined)
  process.env.PATH = savedPath
  process.chdir(savedCwd)
  vi.restoreAllMocks()
})

/** A fixture root: a source tree, a hidden tree, a spaced name, node_modules. */
function fixture(): string {
  const dir = mkdtempTracked('mayfly-mention-')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'a')
  writeFileSync(join(dir, 'src', 'b.ts'), 'b')
  writeFileSync(join(dir, 'top.md'), 'top')
  writeFileSync(join(dir, 'a b.txt'), 'spaced')
  mkdirSync(join(dir, '.hidden'))
  writeFileSync(join(dir, '.hidden', 'secret.ts'), 'x')
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'i.js'), 'x')
  return dir
}

/** A fake `fd` binary that prints one fixed line regardless of arguments. */
function fakeFdBin(line: string): string {
  const bin = mkdtempTracked('mayfly-mention-bin-')
  const fd = join(bin, 'fd')
  writeFileSync(fd, `#!/bin/sh\nprintf '${line}\\n'\n`)
  chmodSync(fd, 0o755)
  return bin
}

describe('extractAtPrefix', () => {
  it('routes only path forms the native fd backend cannot represent to the filesystem', () => {
    expect(requiresFilesystemMention('@C:\\Users\\de', 'win32')).toBe(true)
    expect(requiresFilesystemMention('@C:/Users/de', 'win32')).toBe(true)
    expect(requiresFilesystemMention('@\\\\server\\share\\de', 'win32')).toBe(false)
    expect(requiresFilesystemMention('@src\\co', 'win32')).toBe(false)
    expect(requiresFilesystemMention('@src\\co', 'linux')).toBe(true)
    expect(requiresFilesystemMention("@'a b", 'linux')).toBe(true)
    expect(requiresFilesystemMention('@"a b"', 'linux')).toBe(true)
    expect(requiresFilesystemMention('@src/co', 'linux')).toBe(false)
  })
  it('returns the token from the line start or after any path delimiter', () => {
    expect(extractAtPrefix('@sr')).toBe('@sr')
    expect(extractAtPrefix('see @sr')).toBe('@sr')
    expect(extractAtPrefix("see\t@sr")).toBe('@sr')
    expect(extractAtPrefix('="see\' @sr')).toBe('@sr')
  })

  it('returns null outside a mention', () => {
    expect(extractAtPrefix('')).toBeNull()
    expect(extractAtPrefix('hello')).toBeNull()
    expect(extractAtPrefix('see sr')).toBeNull()
    expect(extractAtPrefix('email@example.com')).toBeNull()
    expect(extractAtPrefix('@"a b" next')).toBeNull()
  })

  it('keeps open and closed quoted paths, including spaces and Windows separators', () => {
    for (const token of ['@"a b', '@"a b/"', "@'a b'", '@"', '@"C:\\Users\\文档 文件\\']) {
      expect(extractAtPrefix(`see ${token}`)).toBe(token)
    }
  })

  it('extracts literal paths from either quote style without swallowing their spaces', () => {
    for (const [token, path] of [['@abc', 'abc'], ['@"', ''], ["@'", ''], ['@"a b', 'a b'], ["@'a b'", 'a b'], ['@"a b/"', 'a b/']]) {
      expect(mentionPath(token!)).toBe(path)
    }
  })
})

describe('detectFdPath', () => {
  it('shares one cached promise across concurrent detections', async () => {
    const probe = vi.fn(async () => 'fd')
    setFdProbe(probe)
    const state = probeState()
    await Promise.all([detectFdPath(state), detectFdPath(state)])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('isolates cached results between frontend trees', async () => {
    setFdProbe(async () => 'fd')
    const first = probeState()
    await detectFdPath(first)
    setFdProbe(async () => null)
    await expect(detectFdPath(first)).resolves.toBe('fd')
    await expect(detectFdPath(probeState())).resolves.toBeNull()
  })

  it('finds fd on the PATH through the default probe', async () => {
    process.env.PATH = `${fakeFdBin('src/')}:${savedPath ?? ''}`
    await expect(detectFdPath(probeState())).resolves.toBe('fd')
  })

  it('falls back to fdfind when fd is absent', async () => {
    const bin = fakeFdBin('src/')
    const fd = join(bin, 'fd')
    const fdfind = join(bin, 'fdfind')
    writeFileSync(fd, '#!/bin/sh\nexit 1\n')
    chmodSync(fd, 0o755)
    // The stand-in must not invoke fd itself (the broken one would fail it).
    writeFileSync(fdfind, '#!/bin/sh\necho fdfind 8.0\n')
    chmodSync(fdfind, 0o755)
    process.env.PATH = bin
    await expect(detectFdPath(probeState())).resolves.toBe('fdfind')
  })

  it('resolves null with no usable binary on the PATH', async () => {
    process.env.PATH = mkdtempTracked('mayfly-mention-empty-')
    await expect(detectFdPath(probeState())).resolves.toBeNull()
  })
})

describe('fsMentionSuggestions', () => {
  it('scopes quoted and absolute queries when fd is unavailable', async () => {
    const root = fixture()
    expect((await fsMentionSuggestions(root, '@src/a', signal()))?.items.map(item => item.value)).toEqual(['@src/a.ts'])
    expect((await fsMentionSuggestions(root, '@"a b', signal()))?.items.map(item => item.value)).toEqual(['@"a b.txt"'])
    expect((await fsMentionSuggestions(root, `@${root}/src/a`, signal()))?.items[0]?.value).toBe(`@${root}/src/a.ts`)
    if (process.platform !== 'win32') {
      writeFileSync(join(root, 'literal\\name.txt'), 'x')
      expect((await fsMentionSuggestions(root, '@literal\\na', signal(), 'linux'))?.items[0]?.value).toBe('@literal\\name.txt')
    }
  })

  it('normalizes Windows scan results before ranking and preserves scoped prefixes', async () => {
    const entry = (name: string, directory = false) => ({ name, isDirectory: () => directory, isSymbolicLink: () => false })
    const read = vi.spyOn(fsPromises, 'readdir').mockImplementation(async path => {
      if (String(path).replaceAll('\\', '/').replace(/\/$/u, '') === 'C:/repo') return [entry('src', true), entry('top.ts')] as never
      if (String(path).replaceAll('\\', '/').replace(/\/$/u, '') === 'C:/repo/src') return [entry('中文 File.ts')] as never
      return [] as never
    })
    const all = await fsMentionSuggestions('C:\\repo', '@', signal(), 'win32')
    expect(all?.items.map(item => item.value)).toEqual(['@src/', '@top.ts', '@"src/中文 File.ts"'])
    expect((await fsMentionSuggestions('C:\\repo', '@src\\中文', signal(), 'win32'))?.items[0]?.value).toBe('@"src/中文 File.ts"')
    expect(read).toHaveBeenCalledWith('C:\\repo\\src', { withFileTypes: true })
  })

  it('resolves Windows drive, UNC, home and quoted bases without prefixing the cwd', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\demo')
    const read = vi.spyOn(fsPromises, 'readdir').mockResolvedValue([{ name: '文档', isDirectory: () => true, isSymbolicLink: () => false }] as never)
    const cases = [
      ['@C:\\Users\\demo\\', 'C:/Users/demo/', '@C:/Users/demo/文档/'],
      ['@\\\\server\\share\\', '//server/share/', '@//server/share/文档/'],
      ['@~\\', 'C:\\Users\\demo', '@~/文档/'],
      ['@"C:\\Program Files\\"', 'C:/Program Files/', '@"C:/Program Files/文档/"'],
    ]
    for (const [prefix, resolved, value] of cases) {
      const result = await listDirectoryMentions('D:\\repo', prefix!, signal(), 'win32')
      expect(read).toHaveBeenLastCalledWith(resolved, { withFileTypes: true })
      expect(result?.prefix).toBe(prefix)
      expect(result?.items[0]?.value).toBe(value)
    }
    expect(await listDirectoryMentions('D:\\repo', '@C:\\Users\\de', signal(), 'win32')).toBeNull()
  })
  it('returns null for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fsMentionSuggestions(fixture(), '@x', controller.signal)).resolves.toBeNull()
  })

  it('aborts a walk already in flight', async () => {
    const root = fixture()
    const controller = new AbortController()
    // Abort lands while the first readdir is still pending, so the walk
    // observes it on its very first entry check.
    const pending = fsMentionSuggestions(root, '@x', controller.signal)
    controller.abort()
    await expect(pending).resolves.toBeNull()
  })

  it('counts a symlink pointing at a directory as a directory without descending it', async () => {
    const root = fixture()
    symlinkSync(join(root, 'src'), join(root, 'link'))
    process.chdir(root)
    const all = await fsMentionSuggestions(root, '@', signal())
    // `link` ranks as a directory (shallow, +10) while `src`'s contents
    // stay singly-scanned: the symlink is never pushed onto the stack.
    expect(all?.items.map(item => item.value)).toContain('@link/')
    const inner = await fsMentionSuggestions(root, '@inner', signal())
    expect(inner).toBeNull()
  })

  it('keeps a broken symlink as a file candidate', async () => {
    const root = fixture()
    symlinkSync(join(root, 'no-such-target'), join(root, 'broken'))
    const suggestions = await fsMentionSuggestions(root, '@broken', signal())
    expect(suggestions?.items).toEqual([{ value: '@broken', label: 'broken', description: 'broken' }])
  })

  it('stops the scan at the entry cap, leaving deeper trees unlisted', async () => {
    const root = mkdtempTracked('mayfly-mention-deep-')
    // a/ holds 1999 files plus subdir b/; with a/ itself that fills the
    // 2000-entry budget exactly, so b/ (holding needle.txt) is never
    // scanned — regardless of the order a/'s entries surface in.
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    for (let index = 0; index < 1999; index += 1) {
      writeFileSync(join(root, 'a', `f${String(index).padStart(4, '0')}.txt`), 'x')
    }
    writeFileSync(join(root, 'a', 'b', 'needle.txt'), 'x')
    const over = await fsMentionSuggestions(root, '@needle', signal())
    expect(over).toBeNull()
  })

  it('reaches needles below the scan cap through nested directories', async () => {
    const root = mkdtempTracked('mayfly-mention-shallow-')
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    for (let index = 0; index < 1990; index += 1) {
      writeFileSync(join(root, 'a', `f${String(index).padStart(4, '0')}.txt`), 'x')
    }
    writeFileSync(join(root, 'a', 'b', 'needle.txt'), 'x')
    const under = await fsMentionSuggestions(root, '@needle', signal())
    expect(under?.items.map(item => item.value)).toEqual(['@a/b/needle.txt'])
  })

  it('caps suggestions at the fallback limit', async () => {
    const root = mkdtempTracked('mayfly-mention-many-')
    for (let index = 0; index < 205; index += 1) {
      writeFileSync(join(root, `f${String(index).padStart(3, '0')}.txt`), 'x')
    }
    const suggestions = await fsMentionSuggestions(root, '@', signal())
    expect(suggestions?.items).toHaveLength(MAX_FALLBACK_SUGGESTIONS)
  })

  it('scores basename containment below prefix matches and boosts directories', async () => {
    const root = fixture()
    // 'op' sits inside top.md's basename but not at its start; src/a.ts
    // matches only through its path.
    const suggestions = await fsMentionSuggestions(root, '@op', signal())
    expect(suggestions?.items.map(item => item.description)).toEqual(['top.md'])
    // A directory matching the query outranks its own contents: the +10
    // bonus rides the 80-point basename prefix.
    const ranked = await fsMentionSuggestions(root, '@s', signal())
    expect(ranked?.items[0]).toEqual({ value: '@src/', label: 'src/', description: 'src' })
  })

  it('breaks score ties between a deep directory and a shallow file directory-first', async () => {
    const root = mkdtempTracked('mayfly-mention-tie-')
    // An empty query scores directories 120 minus depth and files 100
    // minus depth: a directory 20 levels down ties a root file at 100,
    // and the tiebreak ranks the directory first. The intermediate
    // directories (119 down to 101) fill the ranks above the pair.
    let dir = root
    for (let index = 0; index < 21; index += 1) {
      dir = join(dir, `d${String(index).padStart(2, '0')}`)
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(root, 'top.md'), 'top')
    const suggestions = await fsMentionSuggestions(root, '@', signal())
    const values = suggestions?.items.map(item => item.value)
    const deep = Array.from({ length: 21 }, (_, index) => `d${String(index).padStart(2, '0')}`).join('/')
    expect(values?.at(-2)).toBe(`@${deep}/`)
    expect(values?.at(-1)).toBe('@top.md')
  })

  it('returns null when the root itself cannot be read', async () => {
    const root = mkdtempTracked('mayfly-mention-notdir-')
    writeFileSync(join(root, 'file'), 'x')
    await expect(fsMentionSuggestions(join(root, 'file'), '@x', signal())).resolves.toBeNull()
  })

  it('lists one level for a bare @, directories first, node_modules and .git skipped', async () => {
    const root = fixture()
    const suggestions = await listDirectoryMentions(root, '@', signal())
    expect(suggestions).toEqual({
      prefix: '@',
      items: [
        { value: '@.hidden/', label: '.hidden/', description: '.hidden' },
        { value: '@src/', label: 'src/', description: 'src' },
        { value: '@"a b.txt"', label: 'a b.txt', description: 'a b.txt' },
        { value: '@top.md', label: 'top.md', description: 'top.md' },
      ],
    })
  })

  it('drills into a typed base, preserving it verbatim in the values', async () => {
    const root = fixture()
    const relative = await listDirectoryMentions(root, '@src/', signal())
    expect(relative?.items.map(item => item.value)).toEqual(['@src/a.ts', '@src/b.ts'])
    const absolute = await listDirectoryMentions(root, `@${root}/`, signal())
    expect(absolute?.items.map(item => item.value)).toContain(`@${root}/src/`)
    const home = await listDirectoryMentions(root, '@~/', signal())
    expect(home).not.toBeNull()
  })

  it('declines query-bearing tokens, non-directory bases, and empty listings', async () => {
    const root = fixture()
    await expect(listDirectoryMentions(root, '@src/a', signal())).resolves.toBeNull()
    await expect(listDirectoryMentions(root, `@${join(root, 'top.md')}/`, signal())).resolves.toBeNull()
    const empty = mkdtempTracked('mayfly-mention-emptydir-')
    await expect(listDirectoryMentions(empty, '@', signal())).resolves.toBeNull()
    const locked = mkdtempTracked('mayfly-mention-locked-')
    chmodSync(locked, 0o000)
    await expect(listDirectoryMentions(locked, '@', signal())).resolves.toBeNull()
  })

  it('aborts a one-level listing', async () => {
    const root = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(listDirectoryMentions(root, '@', controller.signal)).resolves.toBeNull()
    const midWalk = new AbortController()
    const pending = listDirectoryMentions(root, '@', midWalk.signal)
    midWalk.abort()
    await expect(pending).resolves.toBeNull()
  })

  it('counts symlinked directories as directories and broken symlinks as files', async () => {
    const root = fixture()
    symlinkSync(join(root, 'src'), join(root, 'link'))
    symlinkSync(join(root, 'no-such-target'), join(root, 'broken'))
    const suggestions = await listDirectoryMentions(root, '@', signal())
    const values = suggestions?.items.map(item => item.value)
    expect(values).toContain('@link/')
    expect(values).toContain('@broken')
  })

  it('caps a one-level listing at the entry limit', async () => {
    const root = mkdtempTracked('mayfly-mention-level-')
    for (let index = 0; index < 55; index += 1) {
      writeFileSync(join(root, `f${String(index).padStart(2, '0')}.txt`), 'x')
    }
    const suggestions = await listDirectoryMentions(root, '@', signal())
    expect(suggestions?.items).toHaveLength(50)
  })
})
