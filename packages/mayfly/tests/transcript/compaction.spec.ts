/** Compaction boundary row: state rendering, timer lifecycle, expansion.
 * @module @ephemeral-ai/mayfly/tests/transcript/compaction
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { MayflySemanticColors } from '../../src/core/index.ts'
import type { TranscriptCompactionModel } from '../../src/frontend/models.ts'
import { CompactionRowComponent, setCompactionTimers, type CompactionTimers } from '../../src/transcript/compaction.ts'
import { createTranscriptModel, TranscriptModelComponent } from '../../src/transcript/transcript-model.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'

const colors = COLORS as MayflySemanticColors
const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/gu, '')

function model(overrides: Partial<TranscriptCompactionModel> = {}): TranscriptCompactionModel {
  return {
    kind: 'transcript-compaction', id: 'compaction:c1', seq: 1, updatedSeq: 1, turn: 1,
    state: 'ok', trigger: 'manual', startedAt: 0, endedAt: 9_000,
    shadowedCount: 47, shadowedTokens: 18_200, ...overrides,
  }
}

/** A fake timer pair that captures the live interval callback. */
function fakeTimers(): { readonly timers: CompactionTimers, readonly tick: () => void, readonly cleared: () => number } {
  const handles: { callback?: () => void, cleared: number } = { cleared: 0 }
  return {
    timers: {
      setInterval: (callback) => {
        handles.callback = callback
        return callback as never
      },
      clearInterval: () => {
        handles.cleared += 1
      },
    },
    tick: () => handles.callback?.(),
    cleared: () => handles.cleared,
  }
}

afterEach(() => {
  setCompactionTimers(undefined)
})

describe('CompactionRowComponent', () => {
  it('renders the running label, drives ticks through injected timers, and stands down on settle', () => {
    const { timers, tick, cleared } = fakeTimers()
    setCompactionTimers(timers)
    let repaints = 0
    const component = new CompactionRowComponent(
      model({ state: 'running', startedAt: Date.now(), endedAt: undefined }),
      colors, fakeMayflyComponents(), () => { repaints += 1 },
    )
    try {
      const before = component.render(80).map(strip)
      expect(before[0]).toContain('⠋ compacting context…')
      tick()
      expect(repaints).toBe(1)
      // The frame advanced through the braille cycle.
      expect(component.render(80).map(strip)[0]).toContain('⠙ compacting context…')
      // The tick that observes a settled model retires the timer itself.
      component.update(model())
      tick()
      expect(repaints).toBe(1)
      expect(cleared()).toBe(1)
      expect(component.render(80).map(strip)[0]).toContain('✓ compacted 47 items · ~17.8k')
      // Rendering a settled row never restarts the timer.
      tick()
      expect(repaints).toBe(1)
    } finally {
      component.dispose()
    }
  })

  it('renders every settled shape and the expanded summary preview', () => {
    const components = fakeMayflyComponents()
    const ok = new CompactionRowComponent(model(), colors, components)
    expect(ok.render(120).map(strip)).toEqual(['✓ compacted 47 items · ~17.8k'])

    const auto = new CompactionRowComponent(model({ trigger: 'auto' }), colors, components)
    expect(auto.render(120).map(strip)).toEqual(['✓ compacted 47 items · ~17.8k · auto'])

    const noTokens = new CompactionRowComponent(model({ shadowedTokens: undefined }), colors, components)
    expect(noTokens.render(120).map(strip)).toEqual(['✓ compacted 47 items'])

    const detailOnly = new CompactionRowComponent(model({
      shadowedCount: undefined, shadowedTokens: undefined, detail: 'No compactable history yet.',
    }), colors, components)
    expect(detailOnly.render(120).map(strip)).toEqual(['✓ No compactable history yet.'])

    const fallback = new CompactionRowComponent(model({ shadowedCount: undefined, shadowedTokens: undefined }), colors, components)
    expect(fallback.render(120).map(strip)).toEqual(['✓ compacted'])

    const failed = new CompactionRowComponent(model({ state: 'error', error: 'boom\nsecond line' }), colors, components)
    expect(failed.render(120).map(strip)).toEqual(['✗ boom'])

    const noReason = new CompactionRowComponent(model({ state: 'error', error: undefined }), colors, components)
    expect(noReason.render(120).map(strip)).toEqual(['✗ compaction failed'])

    const detailReason = new CompactionRowComponent(model({ state: 'error', error: undefined, detail: 'Compaction cancelled.' }), colors, components)
    expect(detailReason.render(120).map(strip)).toEqual(['✗ Compaction cancelled.'])

    const expanded = new CompactionRowComponent(model({ summary: 'line one\nline two\n\x1b[31mred\x1b[39m' }), colors, components)
    expanded.setExpanded(true)
    const rows = expanded.render(120).map(strip)
    expect(rows).toEqual(['✓ compacted 47 items · ~17.8k', '  line one', '  line two', '  red'])
    expanded.setExpanded(false)
    expect(expanded.render(120).map(strip)).toHaveLength(1)
    // setScope and invalidate are no-ops on the boundary row.
    expanded.setScope({ hint: true })
    expanded.invalidate()
    expect(expanded.render(120)).toHaveLength(1)
    expanded.dispose()
  })

  it('starts no timer for a settled row and tolerates a missing render nudge', () => {
    const { timers, tick, cleared } = fakeTimers()
    setCompactionTimers(timers)
    const component = new CompactionRowComponent(model(), colors, fakeMayflyComponents())
    component.render(80)
    expect(cleared()).toBe(0)
    // A running row without a requestRender still ticks (frame advance only).
    const silent = new CompactionRowComponent(
      model({ state: 'running', startedAt: Date.now(), endedAt: undefined }), colors, fakeMayflyComponents(),
    )
    silent.render(80)
    tick()
    silent.update(model())
    silent.render(80)
    silent.dispose()
    component.dispose()
  })

  it('arms the real interval when no timers are injected and renders an expanded running row', () => {
    const component = new CompactionRowComponent(
      model({ state: 'running', trigger: 'auto', startedAt: Date.now(), endedAt: undefined }),
      colors, fakeMayflyComponents(),
    )
    try {
      component.setExpanded(true)
      const [row] = component.render(80).map(strip)
      expect(row).toContain('compacting context…')
      expect(row).toContain('· auto')
      expect(component.render(80)).toHaveLength(1)
    } finally {
      component.dispose()
    }
    // An expanded settled row without a summary stays one line.
    const bare = new CompactionRowComponent(model({ summary: undefined }), colors, fakeMayflyComponents())
    bare.setExpanded(true)
    expect(bare.render(80)).toHaveLength(1)
    bare.dispose()
  })

  it('reconciles revisions through the transcript model and degrades to plain text', () => {
    const { timers, tick } = fakeTimers()
    setCompactionTimers(timers)
    const components = fakeMayflyComponents()
    const entry = (overrides: Partial<TranscriptCompactionModel>): TranscriptCompactionModel => model(overrides)
    let transcript = createTranscriptModel('cmp-flow', [entry({ state: 'running', startedAt: Date.now(), endedAt: undefined })], false, 0)
    let repaints = 0
    const component = new TranscriptModelComponent(() => transcript, {
      colors, components, images: () => ({}), requestRender: () => { repaints += 1 }, viewportRows: () => 24,
    })
    try {
      expect(component.render(80).map(strip).join('\n')).toContain('compacting context…')
      // The mounted live row nudges a repaint on every tick.
      tick()
      expect(repaints).toBe(1)
      expect(component.render(80).map(strip).join('\n')).toContain('compacting context…')
      // A new revision on the same entry id flows through the update hook.
      transcript = createTranscriptModel('cmp-flow', [entry({ state: 'ok', updatedSeq: 2, shadowedCount: 2, shadowedTokens: 2_048 })], false, 0)
      expect(component.render(80).map(strip).join('\n')).toContain('✓ compacted 2 items · ~2k')
    } finally {
      component.dispose()
    }

    let plain = createTranscriptModel('cmp-plain', [
      entry({ id: 'a', state: 'running', startedAt: Date.now(), endedAt: undefined }),
      entry({ id: 'b', state: 'error', error: 'denied' }),
      entry({ id: 'c', state: 'error' }),
      entry({ id: 'd', state: 'ok', shadowedCount: 3, shadowedTokens: undefined }),
      entry({ id: 'e', state: 'ok', shadowedCount: 3, shadowedTokens: 18_200 }),
      entry({ id: 'f', state: 'ok', shadowedCount: undefined, shadowedTokens: undefined, detail: 'No compactable history yet.' }),
      entry({ id: 'g', state: 'ok', shadowedCount: undefined, shadowedTokens: undefined }),
    ], false, 0)
    const flat = new TranscriptModelComponent(() => plain, {
      colors, components, images: () => ({}), requestRender: () => {}, viewportRows: () => 24, semantic: false,
    })
    try {
      const rows = flat.render(120).map(strip).join('\n')
      expect(rows).toContain('Compacting context')
      expect(rows).toContain('Compaction failed: denied')
      expect(rows).toContain('Compaction failed\n')
      expect(rows).toContain('Compacted 3 items\n')
      expect(rows).toContain('Compacted 3 items (~18200 tokens)')
      expect(rows).toContain('No compactable history yet.')
      expect(rows.split('\n')).toContain('Compacted')
    } finally {
      flat.dispose()
    }
  })
})
