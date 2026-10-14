/** The stream search's matching: the pattern's case rule, what each part is searched by, one hit per occurrence, and the order and turn each hit keeps. */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { createTranscriptModel } from '../../src/transcript/transcript-model.ts'
import { findHits, readPattern } from '../../src/transcript/search.ts'

const user = (id: string, turn: number, text: string): TranscriptEntryModel => ({ id, kind: 'transcript-user', seq: turn, updatedSeq: turn, turn, text, images: [] })
const assistant = (id: string, turn: number, text: string): TranscriptEntryModel => ({ id, kind: 'transcript-assistant', seq: turn, updatedSeq: turn, turn, step: 1, text, streaming: false })

describe('readPattern', () => {
  it('reads an empty pattern as nothing to search, and an unfinished one as invalid', () => {
    expect(readPattern('')).toEqual({ kind: 'empty' })
    expect(readPattern('(unclosed')).toEqual({ kind: 'invalid' })
    expect(readPattern('[')).toEqual({ kind: 'invalid' })
  })

  it('is case-insensitive without a capital letter (smart case), and case-sensitive with one', () => {
    const lower = readPattern('foo')
    expect(lower).toMatchObject({ kind: 'ok', caseSensitive: false })
    expect(lower.kind === 'ok' && lower.regex.flags).toBe('iu')
    const mixed = readPattern('Foo')
    expect(mixed).toMatchObject({ kind: 'ok', caseSensitive: true })
    expect(mixed.kind === 'ok' && mixed.regex.flags).toBe('u')
    // A capital inside a regular expression counts too: `\W` is a class, not a capital, and `[A-Z]` makes the search exact.
    expect(readPattern('\\d+')).toMatchObject({ caseSensitive: false })
    expect(readPattern('[A-Z]x')).toMatchObject({ caseSensitive: true })
  })
})

describe('findHits', () => {
  const model = (entries: TranscriptEntryModel[]) => createTranscriptModel('s', entries, false, 0, undefined)

  it('finds every occurrence in a part, counted from zero, and matches a regular expression', () => {
    const result = findHits(model([user('user:1', 1, 'foo Foo f.o fao')]), readPattern('foo'))
    expect(result.hits).toEqual([
      { part: 'user:1', turn: 1, order: 0, nth: 0 },
      { part: 'user:1', turn: 1, order: 0, nth: 1 },
    ])
    expect(findHits(model([user('user:1', 1, 'foo Foo f.o fao')]), readPattern('f.o')).hits.map(hit => hit.nth)).toEqual([0, 1, 2, 3])
  })

  it('honors the case rule: a capital makes the match exact', () => {
    expect(findHits(model([user('user:1', 1, 'Foo foo FOO')]), readPattern('Foo')).hits).toHaveLength(1)
    expect(findHits(model([user('user:1', 1, 'Foo foo FOO')]), readPattern('foo')).hits).toHaveLength(3)
  })

  it('matches wide characters by their code units, and a surrogate pair as one character', () => {
    expect(findHits(model([user('user:1', 1, '中文字')]), readPattern('文')).hits).toEqual([{ part: 'user:1', turn: 1, order: 0, nth: 0 }])
    expect(findHits(model([user('user:1', 1, 'a😀b')]), readPattern('😀')).hits).toHaveLength(1)
  })

  it('numbers the turns and orders of each part, oldest first, and records where each turn starts', () => {
    const result = findHits(model([user('user:1', 1, 'a'), assistant('assistant:1', 1, 'a'), user('user:2', 2, 'a')]), readPattern('a'))
    expect(result.hits.map(hit => [hit.part, hit.turn, hit.order])).toEqual([['user:1', 1, 0], ['assistant:1', 1, 1], ['user:2', 2, 2]])
    expect(result.turnStart).toEqual(new Map([[1, 0], [2, 2]]))
    expect(result.orders).toEqual(new Map([['user:1', 0], ['assistant:1', 1], ['user:2', 2]]))
  })

  it('keeps the order of a part with no hit, so a header can still land on its turn', () => {
    const result = findHits(model([user('user:1', 1, 'nothing'), user('user:2', 2, 'needle')]), readPattern('needle'))
    expect(result.hits).toEqual([{ part: 'user:2', turn: 2, order: 1, nth: 0 }])
    expect(result.orders.get('user:1')).toBe(0)
    expect(result.turnStart.get(1)).toBe(0)
  })

  it('searches each call of a group entry as its own part, by the text a person reads', () => {
    const read = { callId: 'r1', activity: 'read', detail: 'src/a.ts', seq: 1, updatedSeq: 1, turn: 1, step: 0, name: 'read', startedAt: 0, state: 'ok', path: 'src/a.ts', previewLines: [{ number: 4, text: 'needle here' }] }
    const other = { ...read, callId: 'r2', path: 'src/b.ts', previewLines: [{ number: 1, text: 'hay' }] }
    const group = { id: 'read:1', kind: 'transcript-read-group', seq: 1, updatedSeq: 1, turn: 1, step: 0, reads: [read, other] } as unknown as TranscriptEntryModel
    const result = findHits(model([group]), readPattern('needle'))
    expect(result.hits).toEqual([{ part: 'read:1:r1', turn: 1, order: 0, nth: 0 }])
    expect(result.orders).toEqual(new Map([['read:1:r1', 0], ['read:1:r2', 1]]))
  })

  it('caps the matches of one part at 500 and says nothing more of it', () => {
    const result = findHits(model([user('user:1', 1, 'a'.repeat(600))]), readPattern('a'))
    expect(result.hits).toHaveLength(500)
    expect(result.hits.at(-1)).toMatchObject({ nth: 499 })
  })

  it('counts no match for a pattern that matches nothing of width, and none for an empty or invalid pattern', () => {
    expect(findHits(model([user('user:1', 1, 'abc')]), readPattern('x*')).hits).toEqual([])
    // A match of zero width between letters is stepped past; the letters around it still match.
    expect(findHits(model([user('user:1', 1, 'axxb')]), readPattern('x*')).hits).toEqual([{ part: 'user:1', turn: 1, order: 0, nth: 0 }])
    expect(findHits(model([user('user:1', 1, 'abc')]), readPattern('')).hits).toEqual([])
    expect(findHits(model([user('user:1', 1, 'abc')]), readPattern('(')).hits).toEqual([])
  })

  it('skips canonical nodes and searches the live turn after the durable entries', () => {
    const durable = user('user:1', 1, 'needle one')
    const live = { turn: 2, step: 1, entries: [assistant('assistant:2', 2, 'needle two')] }
    const withLive = { ...createTranscriptModel('s', [ui.text('needle in a node'), durable], false), live }
    const result = findHits(withLive, readPattern('needle'))
    expect(result.hits.map(hit => hit.part)).toEqual(['user:1', 'assistant:2'])
    expect(result.hits.map(hit => hit.order)).toEqual([0, 1])
  })
})
