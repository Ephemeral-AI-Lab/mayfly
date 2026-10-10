/**
 * Scene 5, Lists (roadmap slice 1.4): the seven pages of the scene, each built with the real builders and driven with
 * the keys of every walk; every frame of a walk is compared with its grid golden. Scene 1's lists and form and scene
 * 10's windowed list, which the same painter draws, are compared beside them.
 */
import { afterEach, describe, it } from 'vitest'
import type { MayflyUiEvent } from '../../../ui/src/index.ts'
import { caption, createRealSurface, expectFrames, paint, probeComponents, type Frame, type RealSurface } from './probe.ts'
import { NARROW, NEXT, sceneWalks, stepLabel } from './walks.ts'
import { pageNode } from './scene-05.ts'
import { ui, type MayflyInlineSpan, type MayflyUiNode } from '../../../ui/src/index.ts'
const mu = (text: string): MayflyInlineSpan => ({ text, tone: 'muted' })

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

/** A real surface of one page, and the events its keys emitted. */
function open(page: number, width: number, feedback?: string) {
  const events: MayflyUiEvent[] = []
  const surface = createRealSurface(pageNode(page, feedback), width, {
    components: probeComponents(),
    events: event => events.push(event),
    overrides: { onUnhandledEscape: () => {}, escapeHint: 'close' },
  })
  surfaces.push(surface)
  return { surface, events }
}

describe('scene 5, Lists', () => {
  it.each(sceneWalks(5).map(walk => [walk.name, walk] as const))('walk %s paints its grid golden', async (_name, walk) => {
    let page = 0
    let width = 84
    let { surface, events } = open(page, width)
    const frames: Frame[] = []
    for (const step of walk.steps) {
      if (typeof step === 'string' && step !== '\0') {
        if (step === NEXT) { page = (page + 1) % 7; ({ surface, events } = open(page, width)) }
        else if (step === NARROW) { if (page === 5) { width = width === 62 ? 84 : 62; ({ surface, events } = open(page, width)) } }
        else {
          const before = events.length
          surface.press(step)
          // The scene's host answers an accepted selection with feedback in the footer.
          const accepted = events.slice(before).find(event => event.kind === 'selection-accept')
          if (accepted !== undefined && page === 0) ({ surface, events } = open(page, width, `accepted ${accepted.selectedIds.join(', ')}`))
        }
      }
      frames.push({ label: stepLabel(step), rows: surface.render(), width })
    }
    await expectFrames(`${walk.dir}/${walk.name}`, frames)
  })
})

describe('scene 1 Marks and tokens, page 1: the lists and the form', () => {
  it('draws the cursor, the selection rails, the disclosure and checks, the muted right-aligned count, and the form marks', async () => {
    const block = (node: MayflyUiNode, focused: boolean) => {
      const surface = createRealSurface(node, 100, { components: probeComponents(), focused })
      surfaces.push(surface)
      return surface.render()
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
      '',
      ...paint(caption('‹ v › a value ←/→ changes · • an edited field · (inherited) · ! an error'), 100),
      // The form's first field holds focus (slice 1.6): the marks, units, and origin notes of the field kinds.
      ...block(ui.form({ id: 'm4', fields: [
        { id: 'm', kind: 'select', label: 'Model', value: 'deepseek-chat', origin: 'inherited', options: [{ id: 'deepseek-chat', label: 'deepseek-chat' }, { id: 'deepseek-reasoner', label: 'deepseek-reasoner' }] },
        { id: 't', kind: 'number', label: 'Timeout', value: 45, resetValue: 30, unit: 's', min: 5, max: 120 },
        { id: 'n', kind: 'input', label: 'Name', value: '', required: true, error: 'Required' },
      ] }), true),
    ]
    await expectFrames('01-marks-and-tokens/page-1-lists', [{ label: 'page 1', rows, width: 100 }])
  })
})

describe('scene 10 Layout, the windowed list', () => {
  it('draws a maxRows list with the rows it shows and a count of what is hidden', async () => {
    const node = ui.list({ id: 'win', role: 'browse', maxRows: 4, selectedIds: [], items: Array.from({ length: 9 }, (_, index) => ({ id: `r${String(index)}`, label: `row ${String(index + 1)}` })) })
    // Drawn with no focus, so no row carries the arrow.
    const surface = createRealSurface(node, 40, { components: probeComponents(), focused: false })
    surfaces.push(surface)
    await expectFrames('10-layout/windowed-list', [{ label: 'at rest', rows: surface.render(), width: 40 }])
  })
})
