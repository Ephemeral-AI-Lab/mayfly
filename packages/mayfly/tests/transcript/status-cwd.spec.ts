/**
 * `mayfly-status-cwd` plugin: the abbreviated working-directory entry.
 * `shortenCwd` is asserted pure (home shortening, three-segment tail, the
 * shallow and empty passthroughs); the entry spec covers the session-cwd
 * source, the rebind on `'test/session-changed'`, the muted tier, and the
 * fiber unload.
 */

import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import * as cwd from '../../src/transcript/status-cwd.ts'
import { asAgent, bootStatusPlugin, COLORS, fakeAgent } from './status-fakes.ts'

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

describe('mayfly-status-cwd', () => {
  it('abbreviates the session cwd at priority 5 in the muted tier', async () => {
    const muted = (text: string): string => `[Mu]${text}[/Mu]`
    const harness = await bootStatusPlugin(
      cwd,
      fakeAgent([], { cwd: '/a/b/c/d/e' }),
      { colors: { ...COLORS, muted } },
    )
    expect(harness.entry.id).toBe('mayfly.status.cwd')
    expect(harness.entry.priority).toBe(5)
    expect(harness.entry.render(80)).toBe('[Mu]…/c/d/e[/Mu]')
    await harness.dispose()
  })

  it('falls back to the process cwd without a session', async () => {
    const harness = await bootStatusPlugin(cwd)
    expect(harness.entry.render(80)).toBe(cwd.shortenCwd(process.cwd(), homedir()))
    await harness.dispose()
  })

  it('renders nothing for an empty cwd', async () => {
    const harness = await bootStatusPlugin(cwd, fakeAgent([], { cwd: '' }))
    expect(harness.entry.render(80)).toBe('')
    await harness.dispose()
  })

  it('re-abbreviates from the new session cwd on test/session-changed', async () => {
    const first = fakeAgent([], { cwd: '/one/two' })
    const { ctx, screen, entry, dispose } = await bootStatusPlugin(cwd, first)
    expect(entry.render(80)).toBe('/one/two')
    const baseline = screen.renderRequests.length

    ctx.emit('test/session-changed', asAgent(fakeAgent([], { cwd: '/a/b/c/d' })))
    expect(entry.render(80)).toBe('…/b/c/d')
    expect(screen.renderRequests.length).toBe(baseline + 1)

    // An unchanged abbreviation requests no redraw; a session without a
    // header cwd falls back to the process cwd.
    ctx.emit('test/session-changed', asAgent(fakeAgent([], { cwd: '/a/b/c/d' })))
    expect(screen.renderRequests.length).toBe(baseline + 1)
    ctx.emit('test/session-changed', asAgent(fakeAgent([])))
    expect(screen.renderRequests.length).toBe(baseline + 2)
    await dispose()
  })

  it('truncates to the offered width budget', async () => {
    const harness = await bootStatusPlugin(cwd, fakeAgent([], { cwd: '/abcdefghij/kl' }))
    expect(harness.entry.render(10)).toBe('/abcdefghi')
    await harness.dispose()
  })

  it('unregisters the entry when the fiber unloads', async () => {
    const harness = await bootStatusPlugin(cwd, fakeAgent([], { cwd: '/a' }))
    expect(harness.models.list()).toHaveLength(1)
    await harness.dispose()
    expect(harness.models.list()).toHaveLength(0)
  })
})
