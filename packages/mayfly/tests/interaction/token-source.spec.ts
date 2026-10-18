/**
 * Decisions of the interaction-owned tokens: a pasted image's marker is a token while the tree holds its image, and a
 * mention is a token when it was accepted or names an existing file or folder.
 * @module @ephemeral-ai/mayfly/tests/interaction/token-source
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTokenSource, mentionFile } from '../../src/interaction/token-source.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mayfly-token-source-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'export {}\n')
  writeFileSync(join(root, 'notes file.md'), 'x\n')
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function contextOf(images: string[], mentions: string[] = [], cwd = root) {
  return {
    get: () => undefined,
    mayflyInteractionState: {
      pasteImage: { pastedImages: new Map(images.map(marker => [marker, {}])) },
      mentions: new Set(mentions),
    },
    mayflyCurrentAgent: { current: () => ({ session: { header: { cwd } } }) },
  } as never
}

describe('mentionFile', () => {
  it('resolves a home-relative path against the home directory and a relative one against the session', () => {
    expect(mentionFile('@~/notes.md', root)).toBe(join(homedir(), 'notes.md'))
    expect(mentionFile('@~', root)).toBe(homedir())
    expect(mentionFile('@src/a.ts', root)).toBe(join(root, 'src', 'a.ts'))
    expect(mentionFile(`@${join(root, 'src', 'a.ts')}`, '/elsewhere')).toBe(join(root, 'src', 'a.ts'))
  })

  it('reads a quoted path without its quotes', () => {
    expect(mentionFile('@"notes file.md"', root)).toBe(join(root, 'notes file.md'))
  })
})

describe('createTokenSource', () => {
  it('makes an image marker a token only while the tree holds its image', () => {
    const source = createTokenSource(contextOf(['[image #1 84 KB]']))
    expect(source('see [image #1 84 KB] and [image #2 1 KB]')).toEqual([{ start: 4, end: 20, kind: 'image' }])
    expect(source('no line break here')).toEqual([])
  })

  it('makes an accepted mention a token even when its file is missing', () => {
    const source = createTokenSource(contextOf([], ['@gone.ts']))
    expect(source('open @gone.ts now')).toEqual([{ start: 5, end: 13, kind: 'mention' }])
  })

  it('makes a typed mention a token when it names an existing file or folder', () => {
    const source = createTokenSource(contextOf([]))
    expect(source('look at @src/a.ts and @src')).toEqual([
      { start: 8, end: 17, kind: 'mention' },
      { start: 22, end: 26, kind: 'mention' },
    ])
    expect(source('look at @nope.ts')).toEqual([])
  })

  it('takes a quoted mention whole when the path exists', () => {
    const source = createTokenSource(contextOf([]))
    expect(source('open @"notes file.md" here')).toEqual([{ start: 5, end: 21, kind: 'mention' }])
  })

  it('does not treat an @ inside a word as a mention', () => {
    const source = createTokenSource(contextOf([], ['@src/a.ts']))
    expect(source('mail me@src/a.ts')).toEqual([])
  })
})
