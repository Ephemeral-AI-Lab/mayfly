/** The views lane through the direct pane renderer: registration, F6 order, entering, switching, leaving, and cleanup.
 * @module @ephemeral-ai/mayfly/tests/core/views-lane-renderer
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyApi } from '../../../ui/src/provider.ts'
import type {
  MayflyPaneDefinition,
  MayflyPaneRegistration,
  MayflyUiNode,
} from '../../../ui/src/contracts.ts'
import { ui } from '../../../ui/src/index.ts'
import * as frontend from '../../src/frontend/index.ts'
import { mountMayflySurfaceRenderer } from '../../src/core/surface-renderer.ts'
import { MayflyScreenService } from '../../src/core/screen.ts'
import { SurfaceManager, type SurfaceLayout } from '../../src/core/surface-manager.ts'
import type { MayflyComponent, MayflyComponents, MayflyFocusable, MayflyKeyAction, MayflySemanticColors } from '../../src/core/types.ts'
import type { MayflyTerminalRuntime } from '../../src/core/terminal.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { createFakeEditor } from './fake-editor.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, {
  get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity,
}) as unknown as MayflySemanticColors
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth, createEditor: createFakeEditor } as MayflyComponents
const placements = ['header', 'left', 'right', 'bottom'] as const

class Scope {
  private readonly cleanups: Array<() => void> = []

  effect(callback: () => void | (() => void)): () => void {
    const cleanup = callback()
    if (typeof cleanup !== 'function') return () => {}
    let live = true
    const dispose = (): void => {
      if (!live) return
      live = false
      cleanup()
    }
    this.cleanups.push(dispose)
    return dispose
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup()
  }
}

class KeymapHarness {
  readonly actions = new Map<string, MayflyKeyAction>()

  register(actions: MayflyKeyAction[]): () => void {
    for (const action of actions) this.actions.set(action.id, action)
    return () => { for (const action of actions) this.actions.delete(action.id) }
  }

  invoke(id: string): void {
    const handler = this.actions.get(id)?.handler
    if (handler === undefined) throw new Error(`missing key handler: ${id}`)
    handler()
  }
}

interface RuntimeHarness {
  readonly runtime: MayflyTerminalRuntime
  readonly surfaces: SurfaceManager
  readonly editor: MayflyFocusable
  readonly focused: () => MayflyComponent | null
  setCapturing(value: boolean): void
  resize(columns: number, rows: number): void
}

function createRuntime(mode: 'main' | 'alternate' = 'alternate', initialColumns = 120, initialRows = 20): RuntimeHarness {
  const editor: MayflyFocusable = { focused: true, render: () => ['editor'], invalidate: () => {} }
  let focused: MayflyComponent | null = editor
  let columns = initialColumns
  let rows = initialRows
  let capturing = false
  const assignFocus = (component: MayflyComponent | null): void => {
    if (focused !== null && 'focused' in focused) (focused as MayflyFocusable).focused = false
    focused = component
    if (component !== null && 'focused' in component) (component as MayflyFocusable).focused = true
  }
  const surfaces = new SurfaceManager({
    onSurfaceFocusTransition: (previous, next) => {
      if (focused === previous) assignFocus(next ?? editor)
    },
  })
  const layout = (): SurfaceLayout => mode === 'main'
    ? surfaces.linearLayout(columns, rows)
    : surfaces.layout(columns, rows)
  const runtime = {
    mode,
    get columns() { return columns },
    get rows() { return rows },
    background: undefined,
    kittyKeyboard: false,
    tui: {},
    surfaces,
    surfaceViewport(id: string) {
      const current = layout()
      const lane = placements.map(placement => current[placement])
        .find(candidate => candidate?.entries.some(entry => entry.id === id))
      const paneColumns = lane?.placement === 'left' || lane?.placement === 'right'
        ? lane.width ?? columns
        : columns
      return { columns: Math.max(1, paneColumns), rows: Math.max(1, rows) }
    },
    releaseSurfaceFocus(id: string) {
      if (surfaces.focusedId !== undefined && surfaces.focusedId !== id) return
      surfaces.setFocused(undefined)
      assignFocus(editor)
    },
    hasCapturingOverlay: () => capturing,
    setFocus(component: MayflyComponent | null) {
      surfaces.setFocusedComponent(component)
      assignFocus(component)
    },
    showOverlay() { throw new Error('pane test opened an overlay') },
    addChild() {},
    addBottomChild() {},
    requestRender() {},
  } as unknown as MayflyTerminalRuntime
  return {
    runtime,
    surfaces,
    editor,
    focused: () => focused,
    setCapturing: value => { capturing = value },
    resize: (nextColumns, nextRows) => { columns = nextColumns; rows = nextRows },
  }
}

interface Fixture {
  readonly root: Context
  readonly runtime: RuntimeHarness
  readonly owner: Scope
  readonly keymap: KeymapHarness
  mount(): Scope
  register(contribution: TestPaneContribution): TestPaneRegistration
  dispose(): Promise<void>
}

type TestPaneContribution = Omit<MayflyPaneDefinition, 'placement' | 'onEvent'> & {
  readonly placement?: MayflyPaneDefinition['placement']
  readonly render: () => MayflyUiNode | null
  readonly onEvent?: MayflyPaneDefinition['onEvent']
}
type TestPaneRegistration = MayflyPaneRegistration & { refresh(): void, setHidden(hidden: boolean): void }

async function fixture(runtime = createRuntime(), compilerComponents: MayflyComponents = components, translateHint?: (key: string) => string): Promise<Fixture> {
  const root = new Context()
  await root.plugin({ name: 'test-mayfly-ui-provider', apply: applyApi })
  await root.plugin(frontend)
  await root.plugin(MayflyScreenService, runtime.runtime)
  const keymap = new KeymapHarness()
  const owners: Scope[] = []
  const mount = (): Scope => {
    const owner = new Scope()
    Object.assign(owner, {
      mayflyPanes: root.mayflyPanes,
      mayflyOverlays: root.mayflyOverlays,
      mayflyUiInteraction: root.mayflyUiInteraction,
      mayflyScreen: root.mayflyScreen,
      mayflyComponents: compilerComponents,
      mayflyTheme: { colors },
      mayflyKeymap: keymap,
    })
    mountMayflySurfaceRenderer(owner as never, runtime.runtime, translateHint, root.get('mayflyUiImages'))
    owners.push(owner)
    return owner
  }
  const owner = mount()
  return {
    root,
    runtime,
    owner,
    keymap,
    mount,
    register: contribution => {
      const { render, onEvent, ...definition } = contribution
      const handle = root.mayflyPanes.register({
        placement: 'bottom',
        ...definition,
        ...(onEvent === undefined ? {} : { onEvent }),
      }, render())
      return Object.assign(handle, {
        refresh: () => handle.set(render()),
        setHidden: (hidden: boolean) => handle.set(hidden ? null : render()),
      })
    },
    async dispose() {
      for (const mounted of owners.splice(0).reverse()) mounted.dispose()
      await root.fiber.dispose()
    },
  }
}

async function flush(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}


const row2 = (text: string, count?: number | string) => ({ node: ui.richText([{ text }]), ...(count === undefined ? {} : { count }) })
const plain = (rows: readonly string[] | undefined): string[] => (rows ?? []).map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
const press = (f: Fixture, key: string): void => { (f.runtime.focused() as MayflyFocusable).handleInput?.(key) }
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'

function actions(id: string, label: string) {
  return () => ui.actions({ id, items: [{ id: `${id}-run`, label }] })
}

describe('views lane through the direct pane renderer', () => {
  it('takes a views pane into row 2 and nowhere else', async () => {
    const f = await fixture()
    try {
      const pane = f.register({ id: 'agents', placement: 'views', title: 'Agents', priority: 1, summary: row2('Agents 5 ● 1 waiting', 5), render: actions('a', 'Open') })
      await flush()
      const lane = f.runtime.surfaces.views
      expect(lane.statusEntries().map(entry => entry.id)).toEqual(['views/agents'])
      expect(lane.statusEntries()[0]!.node).toEqual(row2('Agents 5 ● 1 waiting').node)
      const layout: SurfaceLayout = f.runtime.surfaces.linearLayout(120, 20)
      expect([layout.header, layout.left, layout.right, layout.bottom]).toEqual([undefined, undefined, undefined, undefined])
      expect(f.runtime.surfaces.empty).toBe(true)
      pane.setSummary(row2('Agents 6', 6))
      await flush()
      expect(lane.statusEntries()[0]!.node).toEqual(row2('Agents 6').node)
      pane.setSummary(null)
      await flush()
      expect(lane.statusEntries()).toEqual([])
      expect(lane.enterable).toBe(false)
      pane.setSummary(row2('Agents 7', 7))
      await flush()
      expect(lane.statusEntries()).toHaveLength(1)
    } finally {
      await f.dispose()
    }
  })

  it('enters the first view on F6 ahead of the interactive panes, walks on to them, and returns to the prompt', async () => {
    const f = await fixture()
    try {
      f.register({ id: 'agents', placement: 'views', title: 'Agents', summary: row2('Agents'), render: actions('a', 'Open') })
      f.register({ id: 'pane', placement: 'bottom', render: actions('p', 'Pane action') })
      await flush()
      const lane = f.runtime.surfaces.views
      f.keymap.invoke('mayfly.surface.next')
      expect(lane.isEntered).toBe(true)
      expect(f.runtime.surfaces.focusedId).toBe('@views')
      expect(f.runtime.focused()).toBe(lane.component)
      f.keymap.invoke('mayfly.surface.next')
      expect(lane.isEntered).toBe(false)
      expect(f.runtime.surfaces.focusedId).toBe('pane')
      f.keymap.invoke('mayfly.surface.previous')
      expect(lane.isEntered).toBe(true)
      f.keymap.invoke('mayfly.surface.previous')
      expect(lane.isEntered).toBe(false)
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      f.keymap.invoke('mayfly.surface.previous')
      expect(f.runtime.surfaces.focusedId).toBe('pane')
    } finally {
      await f.dispose()
    }
  })

  it('enters from the prompt through the screen, shows the panel under the tab strip and the lane hints, and Esc returns', async () => {
    const f = await fixture(createRuntime(), components, key => key)
    try {
      f.register({ id: 'agents', placement: 'views', title: 'Agents', priority: 1, summary: row2('Agents', 5), render: actions('a', 'Open agent') })
      f.register({ id: 'jobs', placement: 'views', title: 'Jobs', priority: 2, summary: row2('Jobs', 3), render: actions('j', 'Open job') })
      await flush()
      expect(f.root.mayflyScreen.views.panel(80)).toBeUndefined()
      expect(f.root.mayflyScreen.enterViews()).toBe(true)
      const rows = plain(f.root.mayflyScreen.views.panel(80))
      expect(rows[0]).toBe('Agents 5   Jobs 3')
      expect(rows[1]).toBe('━━━━━━━━')
      expect(rows.join('\n')).toContain('Open agent')
      expect(rows.at(-1)).toContain('←/→ tabs')
      expect(rows.at(-1)).toContain('Esc close')
      press(f, '\x1b')
      await flush()
      expect(f.runtime.surfaces.views.isEntered).toBe(false)
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      expect(f.root.mayflyScreen.views.panel(80)).toBeUndefined()
    } finally {
      await f.dispose()
    }
  })

  it('switches views with the arrows and routes each action to the registration of the active view', async () => {
    const f = await fixture()
    try {
      const agent = vi.fn(() => ({ kind: 'completed' as const }))
      const job = vi.fn(() => ({ kind: 'completed' as const }))
      f.register({ id: 'agents', placement: 'views', title: 'Agents', priority: 1, summary: row2('Agents'), render: actions('a', 'Open agent'), onEvent: { action: agent } })
      f.register({ id: 'jobs', placement: 'views', title: 'Jobs', priority: 2, summary: row2('Jobs'), render: actions('j', 'Open job'), onEvent: { action: job } })
      await flush()
      f.root.mayflyScreen.enterViews()
      press(f, '\r')
      await flush()
      expect([agent.mock.calls.length, job.mock.calls.length]).toEqual([1, 0])
      press(f, RIGHT)
      expect(f.runtime.surfaces.views.active).toBe('jobs')
      expect(plain(f.root.mayflyScreen.views.panel(80)).join('\n')).toContain('Open job')
      press(f, '\r')
      await flush()
      expect([agent.mock.calls.length, job.mock.calls.length]).toEqual([1, 1])
      press(f, LEFT)
      expect(f.runtime.surfaces.views.active).toBe('agents')
    } finally {
      await f.dispose()
    }
  })

  it('keeps a view with no panel yet in the row, enters it once the panel arrives, and leaves when it goes', async () => {
    const f = await fixture()
    try {
      const pane = f.register({ id: 'late', placement: 'views', summary: row2('Late'), render: () => null as never })
      await flush()
      const lane = f.runtime.surfaces.views
      expect(lane.statusEntries()).toHaveLength(1)
      expect(f.root.mayflyScreen.enterViews()).toBe(false)
      pane.set(ui.text('arrived'))
      await flush()
      expect(f.root.mayflyScreen.enterViews()).toBe(true)
      const rows = plain(f.root.mayflyScreen.views.panel(40))
      expect(rows.slice(0, 3)).toEqual(['late', '━━━━', 'arrived'])
      pane.set(null)
      await flush()
      expect(lane.isEntered).toBe(false)
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      expect(lane.statusEntries()).toHaveLength(1)
    } finally {
      await f.dispose()
    }
  })

  it('removes the view with its registration, and with the renderer', async () => {
    const f = await fixture()
    try {
      const pane = f.register({ id: 'agents', placement: 'views', summary: row2('Agents'), render: actions('a', 'Open') })
      f.register({ id: 'jobs', placement: 'views', priority: 2, summary: row2('Jobs'), render: actions('j', 'Open') })
      await flush()
      f.root.mayflyScreen.enterViews()
      pane.dispose()
      await flush()
      expect(f.runtime.surfaces.views.active).toBe('jobs')
      expect(f.runtime.surfaces.views.statusEntries().map(entry => entry.id)).toEqual(['views/jobs'])
      f.owner.dispose()
      await flush()
      expect(f.runtime.surfaces.views.statusEntries()).toEqual([])
      expect(f.runtime.surfaces.views.enterable).toBe(false)
    } finally {
      await f.dispose()
    }
  })

  it('replaces the content of an entered panel for a pending decision and keeps its tab', async () => {
    const f = await fixture()
    try {
      f.register({ id: 'agents', placement: 'views', title: 'Agents', summary: row2('Agents', 1), render: () => ui.actions({ id: 'a', items: [{ id: 'stop', label: 'Stop', confirm: 'Stop this?' }] }) })
      await flush()
      f.root.mayflyScreen.enterViews()
      press(f, '\r')
      await flush()
      const rows = plain(f.root.mayflyScreen.views.panel(60))
      expect(rows[0]).toBe('Agents 1')
      expect(rows.join('\n')).toContain('Stop this?')
    } finally {
      await f.dispose()
    }
  })
})
