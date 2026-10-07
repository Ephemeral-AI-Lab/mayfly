/**
 * Scene 5, Lists (roadmap slice 1.4): the seven pages of `ui-preview.mjs`, each built with the real builders and driven
 * with the keys of every golden walk. Every frame of a walk is compared cell by cell with the prototype; the walks the
 * scene shares with a later slice are listed in `pending.ts` and must still differ. The key behavior the frames cannot
 * show (accept events, the slash filter, the segment pin) is checked beside them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { MayflyUiEvent } from '../../../ui/src/index.ts'
import { walks } from '../../../../script/design-golden-walks.mjs'
import { createRealSurface, parityComponents, readGoldenFrames, type RealSurface } from './parity.ts'
import { PENDING_PARITY, PENDING_WALKS, pendingFor, pendingWalk } from './pending.ts'
import { caption as sceneCaption, diffReport, frameDiffs, goldenRows, paint } from './scene.ts'

import { pageNode } from './scene-05.ts'
import { ui, type MayflyInlineSpan, type MayflyUiNode } from '../../../ui/src/index.ts'
const mu = (text: string): MayflyInlineSpan => ({ text, tone: 'muted' })
const caption = sceneCaption

const NEXT = '\x0e'
const NARROW = '\x17'

/** The rows of the surface itself: the prototype also prints its captions above it. */
const surfaceRows = (rows: readonly string[]): readonly string[] => {
  const start = rows.findIndex(row => row.replace(/\x1b\[[0-9;]*m/gu, '').startsWith('╭'))
  return start < 0 ? rows : rows.slice(start)
}

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

/** A real surface of one page, and the events its keys emitted. */
function open(page: number, width: number, feedback?: string) {
  const events: MayflyUiEvent[] = []
  const surface = createRealSurface(pageNode(page, feedback), width, {
    components: parityComponents(),
    events: event => events.push(event),
    overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  return { surface, events }
}

const SCENE_WALKS = walks().filter(walk => walk.scene === 5)

describe('scene 5, Lists', () => {
  it('has a ledger entry only for walks the scene has', () => {
    expect(PENDING_WALKS.filter(entry => entry.scene === 5).every(entry => SCENE_WALKS.some(walk => walk.name === entry.walk))).toBe(true)
    expect(PENDING_PARITY.filter(entry => entry.directory === '05-lists').every(entry => SCENE_WALKS.some(walk => walk.name === entry.walk))).toBe(true)
  })

  it.each(SCENE_WALKS.map(walk => [walk.name, walk] as const))('walk %s matches the prototype cell by cell, or is pending', async (_name, walk) => {
    const frames = readGoldenFrames(walk.dir, walk.name)
    let page = 0
    let width = 84
    let { surface, events } = open(page, width)
    let differs = false
    const report: string[] = []
    for (const [index, step] of walk.steps.entries()) {
      if (typeof step === 'string' && step !== '\0') {
        if (step === NEXT) { page = (page + 1) % 7; ({ surface, events } = open(page, width)) }
        else if (step === NARROW) { if (page === 5) { width = width === 62 ? 84 : 62; ({ surface, events } = open(page, width)) } }
        else {
          const before = events.length
          surface.press(step)
          // The prototype answers an accepted selection with feedback in the footer.
          const accepted = events.slice(before).find(event => event.kind === 'selection-accept')
          if (accepted !== undefined && page === 0) ({ surface, events } = open(page, width, `accepted ${accepted.selectedIds.join(', ')}`))
        }
      }
      const owed = pendingFor(walk.dir, walk.name, index)
      // A pending entry cannot go stale: the frame it covers must still differ.
      if (owed.length > 0) expect((await frameDiffs(surfaceRows(frames[index]!.rows), surface.render(), 96)).length, `${walk.name} frame ${String(index)} is still pending`).toBeGreaterThan(0)
      const diffs = await frameDiffs(surfaceRows(frames[index]!.rows), surface.render(), 96, [], owed)
      if (diffs.length > 0) { differs = true; report.push(`frame ${String(index)}:\n${diffReport(diffs)}`) }
    }
    expect(differs, `${pendingWalk(5, walk.name)?.reason ?? 'a matched walk'}\n${report.join('\n')}`).toBe(pendingWalk(5, walk.name) !== undefined)
  })
})

describe('scene 1 Marks and tokens, page 1: the lists', () => {
  it('draws the cursor, the selection rails, the disclosure and checks, and the muted right-aligned count', async () => {
    const block = (node: MayflyUiNode, focused: boolean) => {
      const surface = createRealSurface(node, 100, { components: parityComponents(), focused })
      surfaces.push(surface)
      // A focused surface ends with its hint row, which the prototype draws only inside a frame.
      return focused ? surface.render().slice(0, -1) : surface.render()
    }
    const rows = [
      ...paint(caption('page 1/6 (Ctrl+N): selection and focus: → the cursor, ▌ the persistent selection, ▸ ▾ disclosure, ● ○ ◐ checks, [current], — reason'), 100),
      '',
      ...paint(caption('→ a cursor in a choose list (the row Enter acts on)'), 100),
      ...block(ui.list({ id: 'm1', role: 'choose', selectedIds: [], items: [{ id: 'a', label: 'Default', badge: 'current' }, { id: 'b', label: 'Accept edits' }, { id: 'c', label: 'Full access', disabled: true, disabledReason: 'managed by policy' }] }), true),
      '',
      ...paint(caption('▌ the persistent selection in a rail; inverse only while the rail has focus'), 100),
      ...block(ui.stack.column([
        ui.list({ id: 'm2', role: 'browse', marker: 'selection', selectedIds: [], focusItem: { id: 'b', rev: 1 }, items: [{ id: 'a', label: 'General' }, { id: 'b', label: 'Model' }, { id: 'c', label: 'Permissions', right: [mu('2')] }] }),
        ui.list({ id: 'm2b', role: 'browse', marker: 'selection', selectedIds: [], focusItem: { id: 'b', rev: 1 }, items: [{ id: 'a', label: 'General' }, { id: 'b', label: 'Model' }] }),
      ]), true),
      '',
      ...paint(caption('▸ ▾ disclosure and ● ○ ◐ checks (single: ●/○, multiple: ●/○, a partly selected parent ◐)'), 100),
      ...block(ui.list({ id: 'm3', role: 'choose', mode: 'multiple', tree: true, selectedIds: ['p1'], items: [{ id: 'p', label: 'filesystem', expanded: true }, { id: 'p1', label: 'read_file', parentId: 'p' }, { id: 'p2', label: 'write_file', parentId: 'p' }, { id: 'q', label: 'github' }] }), false),
    ]
    // The form block below is slice 1.6's: the pending entry covers its rows.
    const golden = goldenRows('01-marks-and-tokens', 'pages', 0).slice(0, rows.length)
    const diffs = await frameDiffs(golden, rows, 100, [{ delta: 'Δ20', rows: [1, 1] }], pendingFor('01-marks-and-tokens', 'pages', 0))
    expect(diffReport(diffs)).toBe('')
  })
})

describe('scene 10 Layout, the windowed list', () => {
  it('draws a maxRows list with the rows it shows and a count of what is hidden', async () => {
    const node = ui.list({ id: 'win', role: 'browse', maxRows: 4, selectedIds: [], items: Array.from({ length: 9 }, (_, index) => ({ id: `r${String(index)}`, label: `row ${String(index + 1)}` })) })
    // The prototype draws it with no focus, so no row carries the arrow.
    const surface = createRealSurface(node, 40, { components: parityComponents(), focused: false })
    surfaces.push(surface)
    const golden = goldenRows('10-layout', 'initial', 0).slice(-5)
    expect(diffReport(await frameDiffs(golden, surface.render(), 96))).toBe('')
  })
})
