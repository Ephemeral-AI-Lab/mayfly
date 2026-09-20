import { describe, expect, it, vi } from 'vitest'
import {
  SURFACE_HEADER_MAX_ROWS,
  SURFACE_TRANSCRIPT_MIN_COLUMNS,
  SURFACE_TRANSCRIPT_REOPEN_COLUMNS,
  SurfaceManager,
  renderSurfaceLane,
  renderSurfaceTabs,
  renderedSurfaceEntries,
  type SurfaceContribution,
  type SurfacePlacement,
} from '../../src/core/surface-manager.ts'
import type { MayflyComponent } from '../../src/core/types.ts'
import { visibleWidth } from '../../src/core/width.ts'

function component(...rows: string[]): MayflyComponent {
  return { render: () => rows, invalidate: () => {} }
}

function contribution(
  id: string,
  placement: SurfacePlacement,
  options: Partial<Omit<SurfaceContribution, 'id' | 'placement' | 'component'>> = {},
  body: MayflyComponent = component(id),
): SurfaceContribution {
  return { id, placement, component: body, ...options }
}

describe('SurfaceManager', () => {
  it('has no lanes or empty chrome without visible contributions', () => {
    const manager = new SurfaceManager()
    expect(manager.empty).toBe(true)
    expect(manager.layout(Number.NaN, Number.NEGATIVE_INFINITY)).toEqual({
      columns: 1,
      rows: 1,
      transcriptColumns: 1,
      overflow: [],
    })
    expect(renderSurfaceLane(undefined, 0)).toEqual([])
    manager.register(contribution('single', 'header', {}, component('one')))
    expect(renderSurfaceLane(manager.linearLayout(10, 2).header, 10)).toEqual(['one'])
  })

  it('orders deterministically and applies immutable user layout overrides', () => {
    const changes = vi.fn()
    const saves = vi.fn()
    const manager = new SurfaceManager({
      userState: {
        order: ['ordered'],
        pinnedIds: ['pinned'],
        active: { right: 'low' },
        hiddenIds: ['hidden'],
        placements: { moved: 'right' },
      },
      onChange: changes,
      onUserStateChange: saves,
    })
    manager.register(contribution('zeta', 'right', { priority: 10 }))
    manager.register(contribution('alpha', 'right', { priority: 10 }))
    manager.register(contribution('low', 'right', { priority: -1 }))
    manager.register(contribution('pinned', 'right'))
    manager.register(contribution('ordered', 'right'))
    manager.register(contribution('hidden', 'right'))
    manager.register(contribution('moved', 'left'))

    const right = manager.linearLayout(120, 24).right!
    expect(right.entries.map(entry => entry.id)).toEqual(['ordered', 'pinned', 'alpha', 'zeta', 'moved', 'low'])
    expect(right.active.id).toBe('low')
    expect(manager.userState).toEqual({
      hiddenIds: ['hidden'],
      order: ['ordered'],
      active: { right: 'low' },
      placements: { moved: 'right' },
      pinnedIds: ['pinned'],
      sizes: {},
    })
    expect(Object.isFrozen(manager.userState)).toBe(true)
    expect(Object.isFrozen(manager.userState.active)).toBe(true)
    expect(manager.activate('left', 'missing')).toBe(false)
    expect(manager.activate('right', 'alpha')).toBe(true)
    expect(manager.userState.active.right).toBe('alpha')
    expect(saves).toHaveBeenCalledOnce()
    expect(changes).toHaveBeenCalledTimes(8)
  })

  it('renders Mayfly-owned tabs, active selection, overflow, and hostile widths safely', () => {
    const manager = new SurfaceManager({ userState: { active: { right: 'cjk' } } })
    manager.register(contribution('ansi', 'right', { title: '\x1b[31mRed\x1b[0m' }))
    manager.register(contribution('cjk', 'right', { title: '面板' }, component('\x1b[32m内容\x1b[0m', '👩‍💻'.repeat(8))))
    manager.register(contribution('emoji', 'right', { title: '🚀 launch' }))
    const lane = manager.linearLayout(120, 24).right!

    expect(renderSurfaceTabs(lane, 80)).toContain('[面板]')
    expect(renderSurfaceTabs(lane, 80)).not.toContain('\x1b[31m')
    expect(renderSurfaceTabs(lane, 18)).toContain('+1')
    expect(renderSurfaceTabs(lane, 8)).toContain('+2')
    for (const width of [5, 3, 2, 1]) {
      const rows = renderSurfaceLane(lane, width)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true)
    }
    expect(renderSurfaceLane(lane, 20, 1)).toHaveLength(1)
    expect(renderSurfaceLane(lane, 20, Number.NaN)).toEqual([])
    expect(renderSurfaceLane(manager.linearLayout(120, 24).left, 20)).toEqual([])
  })

  it('stacks every visible bottom contribution without lane tabs', () => {
    const manager = new SurfaceManager({ userState: { active: { bottom: 'activity' } } })
    manager.register(contribution('activity', 'bottom', { title: 'Activity', priority: 10 }, component('activity')))
    manager.register(contribution('todo', 'bottom', { title: 'Todo', priority: 30 }, component('todo-title', 'todo-row')))
    manager.register(contribution('agents', 'bottom', { title: 'Agents', priority: 50 }, component('agents-title', 'agent-row')))
    const lane = manager.linearLayout(120, 24).bottom!

    expect(lane.entries.map(entry => entry.id)).toEqual(['agents', 'todo', 'activity'])
    expect(renderSurfaceLane(lane, 80)).toEqual([
      'agents-title', 'agent-row', 'todo-title', 'todo-row', 'activity',
    ])
    expect(renderSurfaceLane(lane, 80, 4)).toEqual([
      'agents-title', 'agent-row', 'todo-title', 'todo-row',
    ])
  })

  it('stacks passive bottom progress around only the active focusable pane', () => {
    const manager = new SurfaceManager()
    const first = { ...component('first-form'), focused: false }
    const second = { ...component('second-form'), focused: false }
    manager.register(contribution('progress', 'bottom', { title: 'Progress', priority: 50 }, component('progress-row')))
    manager.register({ ...contribution('first', 'bottom', { title: 'First', priority: 20 }, first), focusTarget: first })
    manager.register({ ...contribution('second', 'bottom', { title: 'Second', priority: 10 }, second), focusTarget: second })

    let lane = manager.linearLayout(80, 24).bottom!
    expect(renderSurfaceTabs(lane, 80)).toBe('[First] Second')
    expect(renderSurfaceLane(lane, 80)).toEqual(['[First] Second', 'progress-row', 'first-form'])
    expect(manager.activate('bottom', 'second')).toBe(true)
    lane = manager.linearLayout(80, 24).bottom!
    expect(renderSurfaceLane(lane, 80)).toEqual(['First [Second]', 'progress-row', 'second-form'])
  })

  it('falls back to a selectable active tab when user state names a passive pane', () => {
    const manager = new SurfaceManager({ userState: { active: { bottom: 'progress' } } })
    const passive = component('progress')
    const focusable = { ...component('form'), focused: false }
    manager.register(contribution('progress', 'bottom', { title: 'Progress' }, passive))
    manager.register({ ...contribution('form', 'bottom', { title: 'Form' }, focusable), focusTarget: focusable })
    const lane = manager.linearLayout(80, 24).bottom!
    expect(lane.active.id).toBe('form')
    expect(() => renderSurfaceTabs(lane, 8)).not.toThrow()
  })

  it('repairs a passive active entry when rendering a manually supplied lane', () => {
    const passive = component('progress')
    const focusable = { ...component('form'), focused: false }
    const lane = {
      placement: 'bottom' as const,
      entries: [
        { id: 'progress', placement: 'bottom' as const, priority: 20, pinned: false, component: passive },
        { id: 'form', placement: 'bottom' as const, priority: 10, pinned: false, component: focusable, focusTarget: focusable },
      ],
      active: { id: 'progress', placement: 'bottom' as const, priority: 20, pinned: false, component: passive },
    }
    expect(renderSurfaceTabs(lane, 80)).toBe('[form]')
    expect(renderedSurfaceEntries(lane).map(entry => entry.id)).toEqual(['progress', 'form'])
  })

  it('keeps the transcript at 40 columns and reopens sides only with 44 columns of margin', () => {
    const manager = new SurfaceManager()
    manager.register(contribution('strong', 'left', { priority: 100 }))
    manager.register(contribution('weak', 'right', { priority: 1 }))

    const wide = manager.layout(120, 24)
    expect(wide.left?.width).toBe(32)
    expect(wide.right?.width).toBe(32)
    expect(wide.transcriptColumns).toBe(54)

    const collapsed = manager.layout(105, 24)
    expect(collapsed.left).toBeDefined()
    expect(collapsed.right).toBeUndefined()
    expect(collapsed.bottom?.entries.map(entry => entry.id)).toContain('weak')
    expect(collapsed.transcriptColumns).toBeGreaterThanOrEqual(SURFACE_TRANSCRIPT_MIN_COLUMNS)

    expect(manager.layout(109, 24).right).toBeUndefined()
    const reopened = manager.layout(110, 24)
    expect(reopened.right).toBeDefined()
    expect(reopened.transcriptColumns).toBe(SURFACE_TRANSCRIPT_REOPEN_COLUMNS)

    const narrow = manager.layout(40, 24)
    expect(narrow.left).toBeUndefined()
    expect(narrow.right).toBeUndefined()
    expect(narrow.transcriptColumns).toBe(40)
    expect(manager.layout(3, 24).transcriptColumns).toBe(3)

    const tied = new SurfaceManager()
    tied.register(contribution('a', 'left'))
    tied.register(contribution('b', 'right'))
    expect(tied.layout(40, 20).bottom?.entries.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('parks collapsed sides by narrow policy without recursive migration', () => {
    const manager = new SurfaceManager()
    manager.register(contribution('base', 'bottom'))
    manager.register(contribution('fallback', 'left', { narrow: 'bottom', priority: 30 }))
    manager.register(contribution('overlay', 'right', { narrow: 'overlay', priority: 20 }))
    manager.register(contribution('gone', 'right', { narrow: 'hidden', priority: 10 }))

    const layout = manager.layout(40, 10)
    expect(layout.bottom?.entries.map(entry => entry.id)).toEqual(['fallback', 'base'])
    expect(layout.overflow.map(item => [item.entry.id, item.reason])).toEqual([
      ['overlay', 'overlay'],
      ['gone', 'hidden'],
    ])
    expect(renderSurfaceLane(layout.bottom, 40, Math.floor(layout.rows / 3))).toHaveLength(2)
    expect(SURFACE_HEADER_MAX_ROWS).toBe(4)
  })

  it('memoizes both layouts per viewport until the registry, user state, focus, or activation changes', () => {
    const manager = new SurfaceManager()
    const a = manager.register(contribution('a', 'header'))
    const b = manager.register(contribution('b', 'bottom', {}, { focused: false, render: () => ['b'], invalidate: () => {} } as MayflyComponent))
    manager.register(contribution('c', 'bottom', {}, { focused: false, render: () => ['c'], invalidate: () => {} } as MayflyComponent))

    // Same viewport: identity-stable results; another viewport is memoized separately.
    const layout = manager.layout(80, 24)
    expect(manager.layout(80, 24)).toBe(layout)
    const narrow = manager.layout(60, 24)
    expect(narrow).not.toBe(layout)
    expect(manager.layout(60, 24)).toBe(narrow)
    expect(manager.layout(80, 24)).toBe(layout)
    const linear = manager.linearLayout(80, 24)
    expect(manager.linearLayout(80, 24)).toBe(linear)
    expect(manager.linearLayout(80, 30)).not.toBe(linear)

    // Every mutation path drops the memo and the fresh layout reflects it.
    expect(manager.setFocused('b')).toBe(true)
    expect(manager.setFocused('b')).toBe(true)
    const focused = manager.layout(80, 24)
    expect(focused).not.toBe(layout)
    expect(focused.bottom?.active.id).toBe('b')
    expect(manager.linearLayout(80, 24)).not.toBe(linear)
    expect(manager.activate('bottom', 'c')).toBe(true)
    expect(manager.layout(80, 24).bottom?.active.id).toBe('c')
    expect(manager.focusedId).toBe('c')
    b.setHidden(true)
    expect(manager.layout(80, 24).bottom?.entries.map(entry => entry.id)).toEqual(['c'])
    b.setHidden(false)
    const before = manager.layout(80, 24)
    a.replace(component('a2'))
    expect(manager.layout(80, 24)).not.toBe(before)
    expect(manager.layout(80, 24).header?.active.component.render(10)).toEqual(['a2'])
    const beforeDispose = manager.layout(80, 24)
    a.dispose()
    expect(manager.layout(80, 24)).not.toBe(beforeDispose)
    expect(manager.layout(80, 24).header).toBeUndefined()
    const beforeState = manager.layout(80, 24)
    manager.replaceUserState({ hiddenIds: ['c'] })
    expect(manager.layout(80, 24)).not.toBe(beforeState)
    expect(manager.layout(80, 24).bottom?.entries.map(entry => entry.id)).toEqual(['b'])
    // Retiring an unavailable focus inside layout() invalidates mid-flight, so
    // the returned frame is recomputed once more before it memoizes.
    const side = manager.register(contribution('side', 'left', { narrow: 'hidden' }, { focused: false, render: () => ['side'], invalidate: () => {} } as MayflyComponent))
    manager.replaceUserState({})
    expect(manager.setFocused('side')).toBe(true)
    const retired = manager.layout(30, 10)
    expect(retired.overflow.map(item => item.entry.id)).toEqual(['side'])
    expect(manager.focusedId).toBeUndefined()
    expect(manager.layout(30, 10)).not.toBe(retired)
    expect(manager.layout(30, 10)).toBe(manager.layout(30, 10))
    side.dispose()
  })

  it('keeps collapse hysteresis exact: a flag flip in one viewport invalidates every memo', () => {
    const manager = new SurfaceManager()
    manager.register(contribution('left', 'left'))
    // 73 columns leaves the transcript at 40: open stays open, closed stays closed.
    expect(manager.layout(73, 24).left).toBeDefined()
    expect(manager.layout(73, 24)).toBe(manager.layout(73, 24))
    // 30 columns collapses the side into bottom fallback — and drops the 73 memo.
    const collapsed = manager.layout(30, 10)
    expect(collapsed.left).toBeUndefined()
    expect(collapsed.bottom?.entries.map(entry => entry.id)).toEqual(['left'])
    expect(manager.layout(30, 10)).toBe(manager.layout(30, 10))
    // Back at 73 a stale memo must not resurrect the open lane: the collapse
    // flag survives below the 44-column reopen threshold.
    const hysteresis = manager.layout(73, 24)
    expect(hysteresis.left).toBeUndefined()
    expect(manager.layout(73, 24)).toBe(hysteresis)
    // 77 columns reopens the side (transcript 44); the flip is memo-visible.
    expect(manager.layout(77, 24).left).toBeDefined()
    expect(manager.layout(73, 24).left).toBeDefined()
  })

  it('separates provider visibility from user state and handles registration lifecycle', () => {
    const changes = vi.fn()
    const saves = vi.fn()
    const first = component('first')
    const replacement = component('replacement')
    const manager = new SurfaceManager({ onChange: changes, onUserStateChange: saves })
    const a = manager.register(contribution('a', 'header', {}, first))
    const b = manager.register(contribution('b', 'header'))
    expect(a.disposed).toBe(false)
    expect(() => manager.register(contribution('a', 'bottom'))).toThrow('Duplicate surface id: a')
    manager.invalidate()

    a.setHidden(true)
    a.setHidden(true)
    expect(manager.linearLayout(80, 20).header?.active.id).toBe('b')
    a.setHidden(false)
    a.replace(first)
    a.replace(replacement)
    expect(manager.linearLayout(80, 20).header?.active.component).toBe(replacement)

    expect(manager.activate('header', 'a')).toBe(true)
    a.dispose()
    a.dispose()
    a.setHidden(true)
    a.replace(first)
    expect(a.disposed).toBe(true)
    expect(manager.userState.active.header).toBe('b')
    expect(saves).toHaveBeenCalledTimes(2)
    expect(changes).toHaveBeenCalledTimes(7)
    b.dispose()
    expect(manager.empty).toBe(true)
  })

  it('replaces persisted state, clamps side sizes, and clears stale active state', () => {
    const changes = vi.fn()
    const saves = vi.fn()
    const manager = new SurfaceManager({ onChange: changes, onUserStateChange: saves })
    const huge = manager.register(contribution('huge', 'left', { size: { min: 60, preferred: 100, max: 10 } }))
    manager.register(contribution('auto', 'right', { size: { min: Number.NaN, preferred: 'auto', max: Number.NaN } }))
    expect(manager.layout(200, 20).left?.width).toBe(48)
    expect(manager.layout(200, 20).right?.width).toBe(32)

    manager.replaceUserState({
      hiddenIds: [],
      order: [],
      active: { left: 'huge' },
      placements: {},
      pinnedIds: [],
      sizes: { huge: -20 },
    })
    expect(manager.layout(200, 20).left?.width).toBe(48)
    huge.dispose()
    expect(manager.userState.active.left).toBeUndefined()
    expect(manager.empty).toBe(false)
    expect(saves).toHaveBeenCalledOnce()
    expect(changes).toHaveBeenCalledTimes(4)
  })

  it('supports fallback activation and every user-order comparison', () => {
    const manager = new SurfaceManager({ userState: { order: ['b', 'a'] } })
    const invalidated = vi.fn()
    const a = manager.register(contribution('a', 'left', {}, { render: () => ['a'], invalidate: invalidated }))
    manager.register(contribution('b', 'bottom'))
    manager.register(contribution('c', 'bottom'))
    expect(manager.linearLayout(120, 20).bottom?.entries.map(entry => entry.id)).toEqual(['b', 'c'])
    expect(manager.activate('bottom', 'a')).toBe(true)
    expect(manager.layout(40, 20).bottom?.active.id).toBe('a')
    expect(manager.userState.active.bottom).toBe('a')
    manager.invalidate()
    expect(invalidated).toHaveBeenCalledOnce()
    a.dispose()
    expect(manager.userState.active.bottom).toBe('b')
  })

  it('uses lane-wide pin, focus, and recent activation before plugin priority', () => {
    const pinned = new SurfaceManager({
      userState: { active: { right: 'right-active' }, pinnedIds: ['right-pinned'] },
    })
    pinned.register(contribution('left-high', 'left', { priority: 100 }))
    pinned.register(contribution('right-active', 'right', { priority: 0 }))
    pinned.register(contribution('right-pinned', 'right', { priority: -100 }))
    expect(pinned.layout(73, 20).right?.active.id).toBe('right-active')
    expect(pinned.layout(73, 20).left).toBeUndefined()

    const attention = new SurfaceManager()
    attention.register(contribution('left-low', 'left', { priority: 0 }))
    attention.register(contribution('right-high', 'right', { priority: 100 }))
    expect(attention.setFocused('missing')).toBe(false)
    expect(attention.setFocused('left-low')).toBe(true)
    expect(attention.setFocused('left-low')).toBe(true)
    expect(attention.focusedId).toBe('left-low')
    expect(attention.layout(73, 20).left).toBeDefined()
    expect(attention.layout(73, 20).right).toBeUndefined()
    expect(attention.setFocused(undefined)).toBe(true)

    attention.replaceUserState({})
    expect(attention.activate('left', 'left-low')).toBe(true)
    expect(attention.layout(73, 20).left).toBeDefined()
    attention.replaceUserState({ order: ['right-high'] })
    expect(attention.focusedId).toBeUndefined()
    expect(attention.layout(73, 20).right).toBeDefined()
    expect(attention.layout(73, 20).left).toBeUndefined()

    const ordered = new SurfaceManager({ userState: { order: ['right-low'] } })
    ordered.register(contribution('left-high', 'left', { priority: 100 }))
    ordered.register(contribution('right-low', 'right', { priority: 0 }))
    expect(ordered.layout(73, 20).right).toBeDefined()
    expect(ordered.layout(73, 20).left).toBeUndefined()

    const focusedPromotion = new SurfaceManager()
    focusedPromotion.register(contribution('left-high', 'left', { priority: 100 }))
    focusedPromotion.register(contribution('right-low', 'right', { priority: 0 }))
    expect(focusedPromotion.layout(73, 20).left).toBeDefined()
    focusedPromotion.setFocused('right-low')
    const focusedLayout = focusedPromotion.layout(73, 20)
    expect(focusedLayout.left).toBeUndefined()
    expect(focusedLayout.right).toBeDefined()
    expect(focusedLayout.transcriptColumns).toBe(40)

    const activatedPromotion = new SurfaceManager()
    activatedPromotion.register(contribution('left-high', 'left', { priority: 100 }))
    activatedPromotion.register(contribution('right-low', 'right', { priority: 0 }))
    expect(activatedPromotion.layout(73, 20).left).toBeDefined()
    expect(activatedPromotion.activate('right', 'right-low')).toBe(true)
    const activatedLayout = activatedPromotion.layout(73, 20)
    expect(activatedLayout.left).toBeUndefined()
    expect(activatedLayout.right).toBeDefined()
    expect(activatedLayout.transcriptColumns).toBe(40)

    const oversizedPromotion = new SurfaceManager()
    oversizedPromotion.register(contribution('left-small', 'left', { priority: 100, size: { preferred: 20 } }))
    oversizedPromotion.register(contribution('right-wide', 'right', { priority: 0, size: { preferred: 48 } }))
    expect(oversizedPromotion.layout(61, 20).left).toBeDefined()
    oversizedPromotion.setFocused('right-wide')
    const blockedPromotion = oversizedPromotion.layout(61, 20)
    expect(blockedPromotion.left).toBeDefined()
    expect(blockedPromotion.right).toBeUndefined()
    expect(blockedPromotion.transcriptColumns).toBe(40)
  })

  it('enforces the 20-column side floor and clears hidden transient attention', () => {
    const manager = new SurfaceManager()
    const registration = manager.register(contribution('tiny', 'left', {
      size: { min: 2, preferred: 4, max: 8 },
      narrow: 'hidden',
    }))
    expect(manager.linearLayout(120, 20).left?.width).toBe(20)
    expect(manager.setFocused('tiny')).toBe(true)
    registration.setHidden(true)
    expect(manager.focusedId).toBeUndefined()
    registration.setHidden(false)
    expect(manager.setFocused('tiny')).toBe(true)
    expect(manager.layout(10, 20).overflow.map(item => item.entry.id)).toEqual(['tiny'])
    expect(manager.focusedId).toBeUndefined()

    for (const width of [60, 20, 10]) {
      const layout = manager.layout(width, 20)
      expect(layout.transcriptColumns).toBe(width)
      expect(layout.left).toBeUndefined()
    }
  })

  it('reconciles explicit focus targets across every state transition', () => {
    const transitions: [MayflyComponent, MayflyComponent | null][] = []
    const manager = new SurfaceManager({ onSurfaceFocusTransition: (previous, next) => transitions.push([previous, next]) })
    const oldComponent = component('old')
    const oldFocus = { ...component('old-focus'), focused: false }
    const nextComponent = component('next')
    const nextFocus = { ...component('next-focus'), focused: false }
    const a = manager.register({ ...contribution('a', 'right', {}, oldComponent), focusTarget: oldFocus })
    manager.register({ ...contribution('b', 'right', {}, component('b')), focusTarget: null })

    manager.setFocusedComponent(oldFocus)
    expect(manager.focusedId).toBe('a')
    expect(manager.activate('right', 'b')).toBe(true)
    expect(manager.focusedId).toBeUndefined()
    expect(transitions).toEqual([[oldFocus, null]])

    manager.setFocused('a')
    a.replace(nextComponent, nextFocus)
    expect(manager.focusedId).toBe('a')
    expect(transitions.at(-1)).toEqual([oldFocus, nextFocus])
    a.replace(nextComponent, null)
    expect(manager.focusedId).toBeUndefined()
    expect(transitions.at(-1)).toEqual([nextFocus, null])

    manager.setFocused('a')
    manager.replaceUserState({ hiddenIds: ['a'] })
    expect(transitions.at(-1)).toEqual([nextFocus, null])
    manager.setFocusedComponent(null)

    const noTarget = new SurfaceManager({ onSurfaceFocusTransition: (previous, next) => transitions.push([previous, next]) })
    const only = noTarget.register(contribution('only', 'left'))
    noTarget.setFocused('only')
    only.dispose()
    expect(noTarget.focusedId).toBeUndefined()
  })

  it('covers focus reconciliation for hidden, replaced, activated, and reset non-target surfaces', () => {
    const transitions: [MayflyComponent, MayflyComponent | null][] = []
    const manager = new SurfaceManager({ onSurfaceFocusTransition: (previous, next) => transitions.push([previous, next]) })
    const focusable = { ...component('focusable'), focused: false }
    const plain = component('plain')
    const hidden = manager.register(contribution('hidden', 'right', {}, focusable))
    manager.register(contribution('plain', 'right', {}, plain))
    manager.setFocusedComponent(focusable)
    expect(manager.activate('right', 'hidden')).toBe(true)
    hidden.setHidden(true)
    expect(transitions).toContainEqual([focusable, null])

    hidden.setHidden(false)
    manager.setFocused('plain')
    const replacement = { ...component('replacement'), focused: false }
    const plainHandle = manager.register(contribution('replace-plain', 'left', {}, component('replace-plain')))
    manager.setFocused('replace-plain')
    plainHandle.replace(replacement)
    expect(manager.focusedId).toBe('replace-plain')

    expect(manager.activate('right', 'plain')).toBe(true)
    manager.setFocused('plain')
    expect(manager.activate('right', 'hidden')).toBe(true)
    expect(manager.focusedId).toBe('hidden')
    manager.replaceUserState({})
    expect(transitions.at(-1)).toEqual([focusable, null])

    const disposalTransitions: [MayflyComponent, MayflyComponent | null][] = []
    const disposal = new SurfaceManager({
      onSurfaceFocusTransition: (previous, next) => disposalTransitions.push([previous, next]),
    })
    const first = { ...component('first'), focused: false }
    const successor = { ...component('successor'), focused: false }
    const firstHandle = disposal.register(contribution('first', 'header', {}, first))
    disposal.register(contribution('successor', 'header', {}, successor))
    disposal.setFocusedComponent(first)
    firstHandle.dispose()
    expect(disposal.focusedId).toBe('successor')
    expect(disposalTransitions).toEqual([[first, successor]])

    const last = { ...component('last'), focused: false }
    const lastManager = new SurfaceManager({
      onSurfaceFocusTransition: (previous, next) => disposalTransitions.push([previous, next]),
    })
    const lastHandle = lastManager.register(contribution('last', 'header', {}, last))
    lastManager.setFocusedComponent(last)
    lastHandle.dispose()
    expect(lastManager.focusedId).toBeUndefined()
    expect(disposalTransitions.at(-1)).toEqual([last, null])
  })

  it('retargets focus from the displayed fallback when persisted active state is stale', () => {
    const transitions: [MayflyComponent, MayflyComponent | null][] = []
    const manager = new SurfaceManager({
      userState: { active: { right: 'missing' } },
      onSurfaceFocusTransition: (previous, next) => transitions.push([previous, next]),
    })
    const a = { ...component('a'), focused: false }
    const b = { ...component('b'), focused: false }
    manager.register(contribution('a', 'right', {}, a))
    manager.register(contribution('b', 'right', {}, b))
    manager.setFocusedComponent(a)

    expect(manager.linearLayout(120, 20).right?.active.id).toBe('a')
    expect(manager.activate('right', 'b')).toBe(true)
    expect(manager.focusedId).toBe('b')
    expect(transitions).toEqual([[a, b]])
  })

  it('preserves a side lane active identity through bottom fallback and back', () => {
    const manager = new SurfaceManager({ userState: { active: { right: 'b' } } })
    const a = { ...component('a'), focused: false }
    const b = { ...component('b'), focused: false }
    manager.register(contribution('a', 'right', {}, a))
    manager.register(contribution('b', 'right', {}, b))
    manager.setFocusedComponent(b)

    expect(manager.layout(120, 20).right?.active.id).toBe('b')
    expect(manager.layout(40, 20).bottom?.active.id).toBe('b')
    expect(manager.focusedId).toBe('b')
    expect(manager.activate('bottom', 'a')).toBe(true)
    expect(manager.userState.active.bottom).toBe('a')
    expect(manager.userState.active.right).toBe('a')
    expect(manager.layout(120, 20).right?.active.id).toBe('a')
  })

  it('clears recent activity in hidden overflow and evaluates every ordered lane member', () => {
    const manager = new SurfaceManager({ userState: { order: ['right-a', 'right-b', 'left-a', 'left-b'] } })
    const hidden = { ...contribution('left-a', 'left', { narrow: 'hidden' }), focusTarget: null }
    manager.register(hidden)
    manager.register(contribution('left-b', 'left'))
    manager.register(contribution('right-a', 'right'))
    manager.register(contribution('right-b', 'right'))
    expect(manager.activate('left', 'left-a')).toBe(true)
    expect(manager.setFocused('left-a')).toBe(true)
    const layout = manager.layout(10, 20)
    expect(layout.overflow.map(item => item.entry.id)).toContain('left-a')
    expect(manager.focusedId).toBeUndefined()
    expect(manager.layout(77, 20).right).toBeDefined()
  })
})
