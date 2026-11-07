import { describe, expect, it } from 'vitest'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { freezeModel, materializeTranscriptEntries, type TranscriptEntryModel, type TranscriptModel } from '../../src/frontend/models.ts'

describe('renderer-neutral model fixture', () => {
  it('leaves primitive and null values unchanged', () => {
    expect(freezeModel(null)).toBeNull()
    expect(freezeModel('plain')).toBe('plain')
  })

  it('snapshots canonical nodes without renderer objects', () => {
    const nodes: MayflyUiNode[] = [
      { kind: 'text', content: 'hello' },
      { kind: 'rich-text', spans: [{ text: 'strong', styles: ['strong'] }] },
      { kind: 'fields', rows: [{ label: 'mode', value: [{ text: 'normal' }] }] },
      { kind: 'sections', sections: [{ title: 'details', body: { kind: 'text', content: 'body' } }] },
      { kind: 'list', id: 'fixture', role: 'browse', items: [{ id: 'one', label: 'One' }], selectedIds: ['one'] },
      { kind: 'code', code: 'const x = 1', language: 'ts' },
      { kind: 'diff', before: 'a', after: 'b' },
    ]
    const snapshot = freezeModel({ nodes })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.nodes)).toBe(true)
    expect(Object.isFrozen(snapshot.nodes[0])).toBe(true)
    expect(snapshot).toMatchSnapshot()
  })
})

it('overlays only the active assistant step and keeps every other durable entry by identity', () => {
  const entry = (kind: 'transcript-user' | 'transcript-assistant' | 'transcript-thinking', turn: number, step: number) => ({ kind, id: `${kind}:${turn}:${step}`, turn, step, text: kind }) as TranscriptEntryModel
  const user = entry('transcript-user', 2, 1)
  const previousTurn = entry('transcript-assistant', 1, 1)
  const previousStep = entry('transcript-thinking', 2, 0)
  const assistant = entry('transcript-assistant', 2, 1)
  const thinking = entry('transcript-thinking', 2, 1)
  const notice = { kind: 'text' as const, content: 'notice' }
  const live = entry('transcript-assistant', 2, 1)
  const model: TranscriptModel = { kind: 'transcript', id: 'overlay', generation: 1, entries: [user, previousTurn, previousStep, assistant, thinking, notice] }
  expect(materializeTranscriptEntries(model)).toBe(model.entries)
  const materialized = materializeTranscriptEntries({ ...model, live: { turn: 2, step: 1, entries: [live] } })
  expect(materialized).toEqual([user, previousTurn, previousStep, notice, live])
  expect(materialized[0]).toBe(user)
  expect(materialized[1]).toBe(previousTurn)
  expect(model.entries).toContain(assistant)
})
