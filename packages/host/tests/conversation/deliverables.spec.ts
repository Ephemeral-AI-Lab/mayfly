import { describe, expect, it } from 'vitest'
import { deliverablesProjection } from '../../src/conversation/deliverables.ts'

describe('deliverablesProjection', () => {
  it('starts empty and only folds its own event', () => {
    const initial = deliverablesProjection.init()
    expect(initial).toEqual([])
    expect(deliverablesProjection.apply(initial, { type: 'turn/start', seq: 1, data: {} } as never)).toBe(initial)
  })

  it('appends one stable id per delivered file', () => {
    const next = deliverablesProjection.apply([], {
      type: 'deliverables/presented',
      seq: 7,
      data: { files: [{ path: '/work/a.md', description: 'notes' }, { path: '/work/b.png' }] },
    } as never)
    expect(next).toEqual([
      { id: '7/0', path: '/work/a.md', description: 'notes' },
      { id: '7/1', path: '/work/b.png' },
    ])
    expect(deliverablesProjection.wire.view(next)).toBe(next)
    expect(deliverablesProjection.wire.viewSchema.parse(next)).toEqual(next)
  })
})
