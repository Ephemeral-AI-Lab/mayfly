import { describe, expect, it } from 'vitest'
import * as cwd from '../../src/transcript/status-cwd-model.ts'

describe('shortenCwd', () => {
  it('normalizes Windows separators and compares home paths case insensitively', () => {
    expect(cwd.shortenCwd('C:\\Users\\Demo', 'c:\\users\\demo\\', 'win32')).toBe('~')
    expect(cwd.shortenCwd('C:\\Users\\Demo\\文档', 'c:\\users\\demo', 'win32')).toBe('~/文档')
    expect(cwd.shortenCwd('D:\\work', 'C:\\Users\\Demo', 'win32')).toBe('D:/work')
    expect(cwd.shortenCwd('\\\\server\\share\\a\\b\\c', '', 'win32')).toBe('…/a/b/c')
    expect(cwd.shortenCwd('C:\\one\\two\\three\\four', '', 'win32')).toBe('…/two/three/four')
  })

  it('keeps POSIX backslashes literal and respects whole home path segments', () => {
    expect(cwd.shortenCwd('/a\\b/c', '', 'linux')).toBe('/a\\b/c')
    expect(cwd.shortenCwd('/home', '/home/x', 'linux')).toBe('/home')
    expect(cwd.shortenCwd('/home/xx', '/home/x', 'linux')).toBe('/home/xx')
    expect(cwd.shortenCwd('/home/x/docs', '/home/x/', 'linux')).toBe('~/docs')
  })
  it('shortens the home directory and everything under it', () => {
    expect(cwd.shortenCwd('/home/x', '/home/x')).toBe('~')
    expect(cwd.shortenCwd('/home/x/dev', '/home/x')).toBe('~/dev')
  })

  it('keeps shallow paths and abbreviates deep ones to the last three segments', () => {
    expect(cwd.shortenCwd('/a/b/c', '/home/x')).toBe('/a/b/c')
    expect(cwd.shortenCwd('/a/b/c/d', '/home/x')).toBe('…/b/c/d')
    expect(cwd.shortenCwd('/a/b/c/d/e/f', '/home/x')).toBe('…/d/e/f')
  })

  it('counts home-relative segments after the tilde swap', () => {
    expect(cwd.shortenCwd('/home/x/a/b', '/home/x')).toBe('~/a/b')
    expect(cwd.shortenCwd('/home/x/a/b/c', '/home/x')).toBe('…/a/b/c')
  })

  it('passes an empty path through and ignores an empty home', () => {
    expect(cwd.shortenCwd('', '/home/x')).toBe('')
    expect(cwd.shortenCwd('/a/b/c/d', '')).toBe('…/b/c/d')
    expect(cwd.shortenCwd('/a/b', '')).toBe('/a/b')
  })
})
