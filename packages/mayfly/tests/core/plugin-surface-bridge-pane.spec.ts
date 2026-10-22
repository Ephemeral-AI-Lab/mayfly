/** Direct pane registry renderer lifecycle and event tests.
 * @module @ephemeral-ai/mayfly/core/tests/surface-renderer-pane
 */

import { Context } from '@deepseek-ai/cordis'
import { getLayoutNode } from '@earendil-works/pi-tui/dist/layout-node.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyApi } from '../../../ui/src/provider.ts'
import type {
  MayflyPaneDefinition,
  MayflyPaneRegistration,
  MayflyUiEventContext,
  MayflyUiNode,
} from '../../../ui/src/contracts.ts'
import { ui } from '../../../ui/src/index.ts'
import { mountMayflySurfaceRenderer } from '../../src/core/surface-renderer.ts'
import { SurfaceManager, type SurfaceLaneEntry, type SurfaceLayout } from '../../src/core/surface-manager.ts'
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

async function fixture(runtime = createRuntime(), compilerComponents: MayflyComponents = components): Promise<Fixture> {
  const root = new Context()
  await root.plugin({ name: 'test-mayfly-ui-provider', apply: applyApi })
  const keymap = new KeymapHarness()
  const owners: Scope[] = []
  const mount = (): Scope => {
    const owner = new Scope()
    Object.assign(owner, {
      mayflyPanes: root.mayflyPanes,
      mayflyOverlays: root.mayflyOverlays,
      mayflyComponents: compilerComponents,
      mayflyTheme: { colors },
      mayflyKeymap: keymap,
    })
    mountMayflySurfaceRenderer(owner as never, runtime.runtime)
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

function entries(surfaces: SurfaceManager, columns = 120, rows = 20): SurfaceLaneEntry[] {
  const layout = surfaces.linearLayout(columns, rows)
  return placements.flatMap(placement => layout[placement]?.entries ?? [])
}

function entry(surfaces: SurfaceManager, id: string): SurfaceLaneEntry {
  const found = entries(surfaces).find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`missing surface: ${id}`)
  return found
}

function deferred<T>(): { readonly promise: Promise<T>, resolve(value?: T): void, reject(error: unknown): void } {
  const result = Promise.withResolvers<T>()
  return { promise: result.promise, resolve: result.resolve as (value?: T) => void, reject: result.reject }
}

afterEach(() => { vi.useRealTimers() })

describe('direct pane surface renderer', () => {
  it('replays direct registry state across renderer gaps', async () => {
    const f = await fixture()
    try {
      f.register({ id: 'owned', placement: 'right', render: () => ui.text('owned pane') })
      await flush()
      expect(entries(f.runtime.surfaces).map(item => item.id)).toEqual(['owned'])
      f.owner.dispose()
      expect(entries(f.runtime.surfaces)).toEqual([])
      expect(f.root.mayflyPanes.list().map(item => item.id)).toEqual(['owned'])
      f.mount()
      await flush()
      expect(entry(f.runtime.surfaces, 'owned').component.render(40)).toEqual(['owned pane'])
    } finally {
      await f.dispose()
    }
  })

  it('contains null, hostile, and over-wide snapshot output', async () => {
    const f = await fixture()
    try {
      let nullable = false
      const nullableHandle = f.register({ id: 'nullable', render: () => nullable ? null : ui.text('visible') })
      f.register({ id: 'invalid', render: () => ({ kind: 'unknown' }) as never })
      await flush()
      const invalid = entry(f.runtime.surfaces, 'invalid').component.render(12)
      expect(invalid.join(' ')).toContain('Mayfly UI')
      expect(invalid.every(row => visibleWidth(row) <= 12)).toBe(true)
      const nullableComponent = entry(f.runtime.surfaces, 'nullable').component
      expect((nullableComponent as MayflyFocusable).focused).toBe(false)
      nullableComponent.invalidate()
      nullable = true
      nullableHandle.refresh()
      await flush()
      expect(entries(f.runtime.surfaces).map(item => item.id)).not.toContain('nullable')
      expect(nullableComponent.render(20)).toEqual([])
      expect(getLayoutNode(nullableComponent)).toMatchObject({ type: 'vstack', entries: [] })
      nullable = false
      nullableHandle.refresh()
      await flush()
      expect(entry(f.runtime.surfaces, 'nullable').component.render(20)).toEqual(['visible'])
    } finally {
      await f.dispose()
    }
  })

  it('keeps component identity and resets local drafts only on external refresh', async () => {
    const f = await fixture()
    try {
      let renders = 0
      const handle = f.register({
        id: 'profile',
        render: () => {
          renders += 1
          return ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: 'A' }] })
        },
      })
      await flush()
      const surface = entry(f.runtime.surfaces, 'profile')
      f.runtime.runtime.setFocus(surface.focusTarget!)
      surface.focusTarget!.handleInput?.('\x1b')
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      f.runtime.runtime.setFocus(surface.focusTarget!)
      surface.focusTarget!.handleInput?.('B')
      await flush()
      expect(renders).toBe(1)
      expect(entry(f.runtime.surfaces, 'profile').component).toBe(surface.component)
      expect(surface.component.render(80).join('\n')).toContain('Name: AB')

      surface.focusTarget!.handleInput?.('C')
      handle.refresh()
      await flush()
      expect(surface.component.render(80).join('\n')).toContain('Name: A')
      expect(surface.component.render(80).join('\n')).not.toContain('Name: ABC')
      expect(entry(f.runtime.surfaces, 'profile').focusTarget).toBe(surface.focusTarget)
    } finally {
      await f.dispose()
    }
  })

  it('hides and restores a stable pane shell without stealing focus', async () => {
    const f = await fixture()
    try {
      let renders = 0
      const handle = f.register({ id: 'toggle', render: () => { renders += 1; return ui.actions({ id: 'a', items: [{ id: 'go', label: 'Go' }] }) } })
      await flush()
      const surface = entry(f.runtime.surfaces, 'toggle')
      f.runtime.runtime.setFocus(surface.focusTarget!)
      handle.setHidden(true)
      await flush()
      expect(entries(f.runtime.surfaces).map(item => item.id)).not.toContain('toggle')
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      handle.setHidden(false)
      await flush()
      expect(entry(f.runtime.surfaces, 'toggle').component).toBe(surface.component)
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      expect(renders).toBe(2)
    } finally {
      await f.dispose()
    }
  })

  it('aborts stale latest-wins events and refreshes from only the current result', async () => {
    const f = await fixture()
    try {
      const calls: Array<{ context: MayflyUiEventContext, result: ReturnType<typeof deferred<void>> }> = []
      let renders = 0
      const handle = f.register({
        id: 'latest',
        render: () => { renders += 1; return ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value: '' }] }) },
        onEvent: (_event, context) => {
          const result = deferred<void>()
          calls.push({ context, result })
          return result.promise
        },
      })
      await flush()
      const target = entry(f.runtime.surfaces, 'latest').focusTarget!
      f.runtime.runtime.setFocus(target)
      target.handleInput?.('a')
      await flush()
      target.handleInput?.('b')
      await flush()
      expect(calls).toHaveLength(2)
      expect(calls[0]!.context.signal.aborted).toBe(true)
      calls[0]!.result.resolve()
      calls[1]!.result.resolve()
      await flush()
      expect(renders).toBe(1)

      target.handleInput?.('c')
      await flush()
      handle.refresh()
      await flush()
      expect(calls[2]!.context.signal.aborted).toBe(true)
      calls[2]!.result.resolve()
      await flush()
      expect(renders).toBe(2)
    } finally {
      await f.dispose()
    }
  })

  it('accepts an event-owned snapshot without aborting its own handler', async () => {
    const f = await fixture()
    try {
      let handle!: TestPaneRegistration
      let context: MayflyUiEventContext | undefined
      let value = ''
      let hold = false
      const pending = deferred<void>()
      handle = f.register({
        id: 'event-owned',
        render: () => ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value }] }),
        onEvent: (event, nextContext) => {
          context = nextContext
          if (event.kind === 'value-change') value = String(event.value)
          handle.set(ui.form({ id: 'form', fields: [{ kind: 'input', id: 'name', label: 'Name', value }] }), {
            eventRevision: nextContext.revision,
          })
          if (hold) return pending.promise
        },
      })
      await flush()
      const target = entry(f.runtime.surfaces, 'event-owned').focusTarget!
      f.runtime.runtime.setFocus(target)
      target.handleInput?.('x')
      await flush()
      expect(context?.signal.aborted).toBe(false)
      expect(entry(f.runtime.surfaces, 'event-owned').component.render(80).join('\n')).toContain('Name: x')

      hold = true
      target.handleInput?.('y')
      await flush(2)
      handle.set(ui.text('external'), { eventRevision: (context?.revision ?? 0) + 100 })
      await flush()
      expect(context?.signal.aborted).toBe(true)
      pending.resolve()
    } finally {
      await f.dispose()
    }
  })

  it('coalesces a scheduled pane replacement and drops a removed pending frame', async () => {
    const f = await fixture()
    try {
      const handle = f.register({ id: 'scheduled-pane', render: () => ui.text('initial') })
      await flush()
      const tasks: VoidFunction[] = []
      const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(task => { tasks.push(task) })

      handle.set(ui.text('second'))
      tasks.shift()!()
      expect(tasks).toHaveLength(1)
      handle.set(ui.text('third'))
      expect(tasks).toHaveLength(2)
      tasks.splice(1, 1)[0]!()
      tasks.shift()!()
      expect(entry(f.runtime.surfaces, 'scheduled-pane').component.render(80)).toEqual(['third'])

      handle.set(ui.text('retained-a'))
      tasks.shift()!()
      handle.set(ui.text('retained-b'))
      tasks.shift()!()
      tasks.shift()!()
      tasks.shift()!()
      expect(entry(f.runtime.surfaces, 'scheduled-pane').component.render(80)).toEqual(['retained-b'])

      handle.set(ui.text('removed'))
      tasks.shift()!()
      handle.dispose()
      tasks.shift()!()
      tasks.shift()!()
      expect(entries(f.runtime.surfaces).map(item => item.id)).not.toContain('scheduled-pane')
      queue.mockRestore()
    } finally {
      vi.restoreAllMocks()
      await f.dispose()
    }
  })

  it('keeps an already-scheduled internal pane refresh across a second event', async () => {
    const f = await fixture()
    try {
      const onEvent = vi.fn()
      let handle!: TestPaneRegistration
      handle = f.register({
        id: 'internal-pane',
        render: () => ui.actions({ id: 'actions', items: [{ id: 'go', label: 'Go' }] }),
        onEvent: (event, context) => {
          onEvent(event, context)
          handle.set(ui.actions({ id: 'actions', items: [{ id: 'go', label: 'Go' }] }), { eventRevision: context.revision })
        },
      })
      await flush()
      const target = entry(f.runtime.surfaces, 'internal-pane').focusTarget!
      f.runtime.runtime.setFocus(target)
      const tasks: VoidFunction[] = []
      const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(task => { tasks.push(task) })
      target.handleInput?.('\r')
      await flush()
      expect(tasks).toHaveLength(1)
      tasks.shift()!()
      target.handleInput?.('\r')
      await flush()
      expect(tasks).toHaveLength(2)
      tasks.splice(1, 1)[0]!()
      tasks.shift()!()
      expect(onEvent).toHaveBeenCalledTimes(2)
      queue.mockRestore()
    } finally {
      vi.restoreAllMocks()
      await f.dispose()
    }
  })

  it('serializes FIFO events and contains handler rejection', async () => {
    const f = await fixture()
    try {
      const calls: Array<ReturnType<typeof deferred<void>>> = []
      let renders = 0
      f.register({
        id: 'fifo',
        render: () => { renders += 1; return ui.actions({ id: 'actions', items: [{ id: 'go', label: 'Go' }] }) },
        onEvent: () => {
          const result = deferred<void>()
          calls.push(result)
          return result.promise
        },
      })
      await flush()
      const target = entry(f.runtime.surfaces, 'fifo').focusTarget!
      f.runtime.runtime.setFocus(target)
      target.handleInput?.('\r')
      target.handleInput?.('\r')
      await flush()
      expect(calls).toHaveLength(1)
      calls[0]!.resolve()
      await flush()
      expect(calls).toHaveLength(2)
      expect(renders).toBe(1)
      calls[1]!.reject(new Error('rejected'))
      await flush()
      expect(entries(f.runtime.surfaces).map(item => item.id)).toContain('fifo')
      expect(renders).toBe(1)
      target.handleInput?.('\r')
      await flush()
      calls[2]!.resolve()
      await flush()
      expect(renders).toBe(1)
    } finally {
      await f.dispose()
    }
  })

  it('coalesces independent latest-wins pane events into one internal render', async () => {
    const f = await fixture()
    try {
      let renders = 0
      const release = deferred<void>()
      f.register({
        id: 'coalesced',
        render: () => {
          renders += 1
          return ui.stack.column([
            ui.tabs({ id: 'views', activeId: 'summary', items: [
              { id: 'summary', label: 'Summary' },
              { id: 'details', label: 'Details' },
            ] }),
            ui.form({ id: 'profile', fields: [{ kind: 'toggle', id: 'enabled', label: 'Enabled', value: false }] }),
          ])
        },
        onEvent: () => release.promise,
      })
      await flush()
      const target = entry(f.runtime.surfaces, 'coalesced').focusTarget!
      f.runtime.runtime.setFocus(target)
      target.handleInput?.('\x1b[C')
      target.handleInput?.('\t')
      target.handleInput?.('\r')
      await flush()
      expect(renders).toBe(1)
      release.resolve()
      await flush()
      expect(renders).toBe(1)
    } finally {
      await f.dispose()
    }
  })

  it('keeps or drops a queued pane render against the pending registry snapshot', async () => {
    const f = await fixture()
    try {
      let renders = 0
      const handle = f.register({
        id: 'pending',
        render: () => { renders += 1; return ui.actions({ id: 'actions', items: [{ id: 'go', label: 'Go' }] }) },
      })
      await flush()
      const target = entry(f.runtime.surfaces, 'pending').focusTarget!
      f.runtime.runtime.setFocus(target)

      const retainedTasks: VoidFunction[] = []
      const retainedQueue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(task => { retainedTasks.push(task) })
      target.handleInput?.('\r')
      await flush()
      target.handleInput?.('\r')
      await flush()
      f.register({ id: 'sibling', render: () => ui.text('sibling') })
      expect(retainedTasks.length).toBeGreaterThanOrEqual(1)
      while (retainedTasks.length > 0) retainedTasks.shift()!()
      retainedQueue.mockRestore()
      await flush()
      expect(renders).toBe(1)

      const droppedTasks: VoidFunction[] = []
      const droppedQueue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(task => { droppedTasks.push(task) })
      target.handleInput?.('\r')
      await flush()
      handle.dispose()
      expect(droppedTasks.length).toBeGreaterThanOrEqual(1)
      while (droppedTasks.length > 0) droppedTasks.shift()!()
      droppedQueue.mockRestore()
      await flush()
      expect(renders).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await f.dispose()
    }
  })

  it('aborts queued work and atomically replaces a disposed same-id pane', async () => {
    const f = await fixture()
    try {
      const calls: Array<{ context: MayflyUiEventContext, result: ReturnType<typeof deferred<void>> }> = []
      const original = f.register({
        id: 'replace',
        render: () => ui.actions({ id: 'actions', items: [{ id: 'go', label: 'Go' }] }),
        onEvent: (_event, context) => {
          const result = deferred<void>()
          calls.push({ context, result })
          return result.promise
        },
      })
      await flush()
      const oldComponent = entry(f.runtime.surfaces, 'replace').component as MayflyFocusable
      f.runtime.runtime.setFocus(oldComponent)
      oldComponent.handleInput?.('\r')
      oldComponent.handleInput?.('\r')
      await flush()
      expect(calls).toHaveLength(1)
      original.refresh()
      await flush()
      expect(calls[0]!.context.signal.aborted).toBe(true)
      calls[0]!.result.resolve()
      await flush()

      const refreshed = entry(f.runtime.surfaces, 'replace').focusTarget!
      f.runtime.runtime.setFocus(refreshed)
      refreshed.handleInput?.('\r')
      refreshed.handleInput?.('\r')
      await flush()
      expect(calls).toHaveLength(2)
      original.dispose()
      f.register({
        id: 'replace',
        title: 'Replacement',
        priority: 9,
        size: { preferred: 8 },
        narrow: 'hidden',
        render: () => ui.text('new pane'),
      })
      await flush()
      expect(calls[1]!.context.signal.aborted).toBe(true)
      calls[1]!.result.resolve()
      await flush()
      expect(entry(f.runtime.surfaces, 'replace').component.render(30)).toEqual(['new pane'])
      expect((oldComponent as MayflyFocusable).focused).toBe(false)
      expect(oldComponent.render(30)).toEqual([])
      expect(getLayoutNode(oldComponent)).toMatchObject({ type: 'vstack', entries: [] })
      oldComponent.invalidate()
      oldComponent.handleInput?.('\r')
    } finally {
      await f.dispose()
    }
  })

  it('aborts timed-out and unloaded pane work without accepting late completion', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    try {
      const contexts: MayflyUiEventContext[] = []
      const results: Array<ReturnType<typeof deferred<void>>> = []
      let renders = 0
      const handle = f.register({
        id: 'abort',
        render: () => { renders += 1; return ui.actions({ id: 'actions', items: [{ id: 'go', label: 'Go' }] }) },
        onEvent: (_event, context) => {
          contexts.push(context)
          const result = deferred<void>()
          results.push(result)
          return result.promise
        },
      })
      await flush()
      const target = entry(f.runtime.surfaces, 'abort').focusTarget!
      f.runtime.runtime.setFocus(target)
      target.handleInput?.('\r')
      await flush()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(contexts[0]!.signal.aborted).toBe(true)
      expect(entries(f.runtime.surfaces).map(item => item.id)).toContain('abort')
      results[0]!.resolve()
      await flush()
      expect(renders).toBe(1)

      target.handleInput?.('\r')
      await flush()
      handle.dispose()
      await flush()
      expect(contexts[1]!.signal.aborted).toBe(true)
      results[1]!.resolve()
      await flush()
      expect(entries(f.runtime.surfaces).map(item => item.id)).not.toContain('abort')
    } finally {
      await f.dispose()
    }
  })

  it('routes F6 across direct panes and respects capturing overlays', async () => {
    const f = await fixture()
    try {
      f.register({ id: 'header', placement: 'header', render: () => ui.actions({ id: 'h', items: [{ id: 'go', label: 'Header' }] }) })
      f.register({ id: 'left-passive', placement: 'left', render: () => ui.text('passive') })
      f.register({ id: 'bottom', render: () => ui.actions({ id: 'b', items: [{ id: 'go', label: 'Bottom' }] }) })
      await flush()

      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.surfaces.focusedId).toBe('header')
      const firstFocus = f.runtime.focused()
      f.runtime.setCapturing(true)
      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.focused()).toBe(firstFocus)
      f.runtime.setCapturing(false)
      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.surfaces.focusedId).toBeUndefined()
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.surfaces.focusedId).toBe('bottom')
      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      f.keymap.invoke('mayfly.surface.previous')
      expect(f.runtime.surfaces.focusedId).toBe('bottom')
    } finally {
      await f.dispose()
    }
  })

  it('navigates main-layout components without explicit focus targets and handles an empty surface set', async () => {
    const f = await fixture(createRuntime('main'))
    try {
      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.focused()).toBe(f.runtime.editor)

      const focusable: MayflyFocusable = { focused: false, render: () => ['focusable'], invalidate: () => {} }
      const passive: MayflyComponent = { render: () => ['passive'], invalidate: () => {} }
      const focusableRegistration = f.runtime.surfaces.register({ id: 'direct-focusable', placement: 'header', component: focusable })
      const passiveRegistration = f.runtime.surfaces.register({ id: 'direct-passive', placement: 'bottom', component: passive })
      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.focused()).toBe(focusable)
      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.focused()).toBe(f.runtime.editor)
      passiveRegistration.dispose()
      focusableRegistration.dispose()
    } finally {
      await f.dispose()
    }
  })

  it('retains navigation placement while the active pane is removed', async () => {
    const f = await fixture()
    try {
      const first = f.register({ id: 'a-remove', placement: 'left', render: () => ui.actions({ id: 'a', items: [{ id: 'go', label: 'A' }] }) })
      const second = f.register({ id: 'b-remove', placement: 'left', render: () => ui.actions({ id: 'b', items: [{ id: 'go', label: 'B' }] }) })
      await flush()
      f.keymap.invoke('mayfly.surface.next')
      expect(f.runtime.surfaces.focusedId).toBe('a-remove')
      first.dispose()
      await flush()
      expect(entries(f.runtime.surfaces).map(item => item.id)).toEqual(['b-remove'])
      second.dispose()
      await flush()
      expect(entries(f.runtime.surfaces)).toEqual([])
    } finally {
      await f.dispose()
    }
  })

  it('falls back from navigation state when a hidden pane is removed', async () => {
    const f = await fixture()
    try {
      const handle = f.register({ id: 'hidden-remove', placement: 'left', render: () => ui.actions({ id: 'a', items: [{ id: 'go', label: 'A' }] }) })
      await flush()
      f.keymap.invoke('mayfly.surface.next')
      handle.setHidden(true)
      await flush()
      handle.dispose()
      await flush()
      expect(entries(f.runtime.surfaces)).toEqual([])
    } finally {
      await f.dispose()
    }
  })

  it('passes the live allocated viewport to responsive pane nodes', async () => {
    const runtime = createRuntime('alternate', 100, 20)
    const f = await fixture(runtime)
    try {
      const handle = f.register({
        id: 'responsive',
        placement: 'left',
        size: { preferred: 30 },
        render: () => ui.stack.column([
          ui.child(ui.text('wide'), { when: { minWidth: 20 } }),
          ui.child(ui.text('narrow'), { when: { maxWidth: 19 } }),
        ]),
      })
      await flush()
      expect(entry(runtime.surfaces, 'responsive').component.render(30)).toContain('wide')
      runtime.resize(18, 20)
      handle.refresh()
      await flush()
      const rows = entry(runtime.surfaces, 'responsive').component.render(18)
      expect(rows).toContain('narrow')
      expect(rows.every(row => visibleWidth(row) <= 18)).toBe(true)
    } finally {
      await f.dispose()
    }
  })
})
