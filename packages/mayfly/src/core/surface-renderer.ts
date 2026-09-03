/** Mayfly renderer for the direct pane and overlay Cordis registries. */
import type { Context } from '@deepseek-ai/cordis'
import {
  type MayflyOverlayEntry,
  type MayflyPaneEntry,
  type MayflyRegistryDelta,
  type MayflyUiEvent,
  type MayflyUiEventHandler,
  type MayflyUiNode,
} from '@ephemeral-ai/mayfly-ui'
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { getLayoutNode, LAYOUT_NODE, type LayoutNode } from '@earendil-works/pi-tui/dist/layout-node.js'
import type { MayflyTerminalRuntime } from './terminal.ts'
import type { SurfaceLaneEntry, SurfaceRegistration } from './surface-manager.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiNode, compileMayflyUiSurfaceNode, type MayflyCompiledUi, type MayflyUiViewport } from './ui-compiler.ts'
import type { MayflyComponents, MayflyFocusable, MayflyKeymap, MayflyOverlayHandle, MayflySemanticColors } from './types.ts'

const EVENT_TIMEOUT_MS = 30_000
const OVERLAY_DEFAULT_WIDTH = '70%'
const OVERLAY_DEFAULT_MAX_HEIGHT = '80%'

interface SurfaceSnapshot {
  readonly revision: number
  readonly panes: readonly MayflyPaneEntry[]
  readonly overlays: readonly MayflyOverlayEntry[]
}

type OwnerContext = Context & {
  readonly mayflyComponents: MayflyComponents
  readonly mayflyTheme: { readonly colors: MayflySemanticColors }
  readonly mayflyKeymap: MayflyKeymap
}

interface DispatchTask {
  readonly event: MayflyUiEvent
  readonly revision: number
  readonly renderGeneration: number
  readonly controller: AbortController
}

class SurfaceEventOwner {
  private live = true
  private revision = 0
  private renderGeneration = 0
  private readonly latest = new Map<string, AbortController>()
  private readonly fifo: DispatchTask[] = []
  private fifoRunning = false
  private readonly active = new Set<AbortController>()
  private readonly activeRevisions = new Map<AbortController, number>()

  constructor(
    private readonly surfaceId: string,
    private readonly handler: MayflyUiEventHandler | undefined,
    private readonly refresh: () => void,
    private readonly close: (() => void) | undefined,
  ) {}

  replaceExternally(eventRevision?: number): 'internal' | 'external' {
    if (eventRevision !== undefined && [...this.activeRevisions.values()].includes(eventRevision)) return 'internal'
    for (const controller of this.active) controller.abort()
    for (const task of this.fifo) task.controller.abort()
    this.fifo.length = 0
    this.latest.clear()
    this.renderGeneration += 1
    return 'external'
  }

  emit(event: MayflyUiEvent): void {
    /* v8 ignore next -- disposed component shells fence input before it can reach their disposed event owner. */
    if (!this.live) return
    const revision = ++this.revision
    const task: DispatchTask = { event, revision, renderGeneration: this.renderGeneration, controller: new AbortController() }
    if (event.kind === 'value-change' || event.kind === 'selection-change' || event.kind === 'tab-change') {
      const key = event.controlId
      this.latest.get(key)?.abort()
      this.latest.set(key, task.controller)
      void this.execute(task).finally(() => { if (this.latest.get(key) === task.controller) this.latest.delete(key) })
      return
    }
    this.fifo.push(task)
    void this.drainFifo()
  }

  dispose(): void {
    if (!this.live) return
    this.live = false
    for (const controller of this.active) controller.abort()
    for (const task of this.fifo) task.controller.abort()
    this.fifo.length = 0
    this.latest.clear()
  }

  private async drainFifo(): Promise<void> {
    if (this.fifoRunning) return
    this.fifoRunning = true
    try {
      while (this.live && this.fifo.length > 0) await this.execute(this.fifo.shift()!)
    } finally {
      this.fifoRunning = false
    }
  }

  private async execute(task: DispatchTask): Promise<void> {
    /* v8 ignore next -- every abort path removes queued tasks before execution. */
    if (!this.live || task.controller.signal.aborted) return
    this.active.add(task.controller)
    this.activeRevisions.set(task.controller, task.revision)
    let timeout: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      const handled = this.handler === undefined
        ? Promise.resolve()
        : Promise.resolve().then(() => this.handler!(task.event, {
          surfaceId: this.surfaceId,
          signal: task.controller.signal,
          revision: task.revision,
        }))
      const timeoutResult = new Promise<void>(resolve => {
          timeout = setTimeout(() => {
            timedOut = true
            task.controller.abort()
            resolve()
          }, EVENT_TIMEOUT_MS)
        })
      const aborted = new Promise<void>(resolve => {
          const abort = () => resolve()
          task.controller.signal.addEventListener('abort', abort, { once: true })
          void handled.then(
            () => task.controller.signal.removeEventListener('abort', abort),
            () => task.controller.signal.removeEventListener('abort', abort),
          )
        })
      await Promise.race([handled, timeoutResult, aborted])
      if (timedOut) { this.closeSurface(); return }
      if (!this.live || task.controller.signal.aborted || task.renderGeneration !== this.renderGeneration) return
      if (task.event.kind === 'dismiss') this.closeSurface()
      else this.refresh()
    } catch {
      /* v8 ignore next -- aborted/not-live dispatches settle through the raced abort result. */
      if (this.live && (timedOut || !task.controller.signal.aborted)) this.closeSurface()
    } finally {
      /* v8 ignore else -- execute creates its timeout synchronously before the first await. */
      if (timeout !== undefined) clearTimeout(timeout)
      this.active.delete(task.controller)
      this.activeRevisions.delete(task.controller)
    }
  }

  private closeSurface(): void {
    if (this.close === undefined) return
    this.dispose()
    this.close()
  }
}

function safeFailureNode(kind: 'pane' | 'overlay', reason: string): MayflyUiNode {
  return { kind: 'text', tone: 'danger', content: `Plugin ${kind} failed: ${reason}` }
}

function compile(
  node: MayflyUiNode | null,
  kind: 'pane' | 'overlay',
  options: {
    readonly components: MayflyComponents
    readonly colors: MayflySemanticColors
    readonly viewport: () => MayflyUiViewport
    readonly mode: 'main' | 'alternate'
    readonly emit: (event: MayflyUiEvent) => void
    readonly onEscape?: () => void
    readonly escapeHint?: 'close' | 'leave'
    readonly translateHint?: (key: string) => string
    readonly interactive: boolean
    readonly runtime: MayflyUiSurfaceRuntime
    readonly refreshMode: 'internal' | 'external'
    readonly title?: string
  },
): MayflyCompiledUi | null {
  const framed = (value: MayflyUiNode): MayflyUiNode => options.title === undefined ? value : {
    kind: 'surface',
    chrome: 'overlay',
    title: options.title,
    padding: 1,
    child: value,
  }
  if (node === null) {
    if (kind === 'pane') return null
    options.runtime.deactivate()
    const fallbackNode = safeFailureNode(kind, 'overlay render returned no node')
    const fallback = compileMayflyUiNode(framed(fallbackNode), {
      components: options.components,
      colors: options.colors,
      getViewport: options.viewport,
      screenMode: options.mode,
      emit: options.emit,
      ...(options.onEscape === undefined ? {} : { onUnhandledEscape: options.onEscape }),
    })
    /* v8 ignore next -- the admitted constant fallback text cannot fail compilation. */
    return fallback.ok ? fallback.value : { node: fallbackNode, component: fallback.errorComponent, focusTarget: null }
  }
  const compilerOptions = {
    components: options.components,
    colors: options.colors,
    getViewport: options.viewport,
    screenMode: options.mode,
    emit: options.emit,
    contextHints: {
      focusWithoutControls: kind === 'overlay' && options.interactive && options.onEscape !== undefined,
      ...(options.translateHint === undefined ? {} : { translate: options.translateHint }),
    },
    ...(options.onEscape === undefined ? {} : { onUnhandledEscape: options.onEscape }),
  }
  if (!options.interactive) {
    const candidate = compileMayflyUiNode(framed(node), compilerOptions)
    if (!candidate.ok || candidate.value.focusTarget !== null) {
      options.runtime.deactivate()
      const fallbackNode = safeFailureNode(kind, candidate.ok ? 'non-capturing overlays cannot contain interactive controls' : candidate.message)
      const fallback = compileMayflyUiNode(framed(fallbackNode), compilerOptions)
      /* v8 ignore next -- the admitted constant fallback text cannot fail compilation. */
      return fallback.ok ? fallback.value : { node: fallbackNode, component: fallback.errorComponent, focusTarget: null }
    }
  }
  const result = compileMayflyUiSurfaceNode(framed(node), {
    ...compilerOptions,
    surfaceRuntime: options.runtime,
    refreshMode: options.refreshMode,
    ...(options.escapeHint === undefined ? {} : { escapeHint: options.escapeHint }),
  })
  if (!result.ok) {
    options.runtime.deactivate()
    const fallbackNode = safeFailureNode(kind, result.message)
    const fallback = compileMayflyUiNode(framed(fallbackNode), compilerOptions)
    /* v8 ignore next -- the admitted constant fallback text cannot fail compilation. */
    return fallback.ok ? fallback.value : { node: fallbackNode, component: fallback.errorComponent, focusTarget: null }
  }
  return result.value
}

function setCompiledFocus(compiled: MayflyCompiledUi | null, focused: boolean): void {
  const component = compiled?.component as MayflyFocusable | undefined
  const target = compiled?.focusTarget ?? (typeof component?.focused === 'boolean' ? component : null)
  if (target !== undefined && target !== null) target.focused = focused
}

class PaneComponent implements MayflyFocusable {
  private targetValue: MayflyCompiledUi | null = null
  private focusedValue = false
  private live = true

  get focused(): boolean { return this.live && this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = this.live && value
    setCompiledFocus(this.targetValue, this.focusedValue)
  }
  [LAYOUT_NODE](): LayoutNode {
    return !this.live || this.targetValue === null
      ? { type: 'vstack', entries: [], gap: 0, align: 'stretch' }
      : getLayoutNode(this.targetValue.component)!
  }
  replace(compiled: MayflyCompiledUi | null): void {
    /* v8 ignore next -- record/map identity fences prevent replacement after one disposal. */
    if (!this.live) return
    setCompiledFocus(this.targetValue, false)
    this.targetValue = compiled
    setCompiledFocus(compiled, this.focusedValue)
  }
  dispose(): void {
    /* v8 ignore next -- every record is removed before another cleanup path can observe it. */
    if (!this.live) return
    this.live = false
    setCompiledFocus(this.targetValue, false)
    this.targetValue = null
    this.focusedValue = false
  }
  render(width: number): string[] { return this.live ? this.targetValue?.component.render(width) ?? [] : [] }
  invalidate(): void { if (this.live) this.targetValue?.component.invalidate() }
  handleInput(data: string): void { if (this.live) this.targetValue?.focusTarget?.handleInput?.(data) }
}

class OverlayComponent implements MayflyFocusable {
  private targetValue: MayflyCompiledUi | null
  private focusedValue = false
  private live = true
  constructor(
    compiled: MayflyCompiledUi,
    private readonly viewport: () => MayflyUiViewport,
    private readonly requestRender: () => void,
  ) { this.targetValue = compiled }
  get focused(): boolean { return this.live && this.focusedValue }
  set focused(value: boolean) {
    this.focusedValue = this.live && value
    setCompiledFocus(this.targetValue, this.focusedValue)
  }
  replace(compiled: MayflyCompiledUi): void {
    /* v8 ignore next -- record/map identity fences prevent replacement after one disposal. */
    if (!this.live) return
    setCompiledFocus(this.targetValue, false)
    this.targetValue = compiled
    setCompiledFocus(compiled, this.focusedValue)
  }
  dispose(): void {
    /* v8 ignore next -- every record is removed before another cleanup path can observe it. */
    if (!this.live) return
    this.live = false
    setCompiledFocus(this.targetValue, false)
    this.targetValue = null
    this.focusedValue = false
  }
  render(width: number): string[] {
    if (!this.live || this.targetValue === null) return []
    const rows = this.targetValue.component.render(width)
    const height = this.viewport().rows
    if (rows.length < height) return rows
    return renderLayoutFrame(this.targetValue.component, width, height, this.requestRender).lines
  }
  invalidate(): void { if (this.live) this.targetValue?.component.invalidate() }
  handleInput(data: string): void { if (this.live) this.targetValue?.component.handleInput?.(data) }
}

interface PaneRecord {
  entry: MayflyPaneEntry
  readonly events: SurfaceEventOwner
  readonly runtime: MayflyUiSurfaceRuntime
  readonly component: PaneComponent
  registration: SurfaceRegistration | undefined
  renderScheduled?: boolean
  renderMode: 'internal' | 'external' | undefined
}

interface OverlayRecord {
  entry: MayflyOverlayEntry
  readonly events: SurfaceEventOwner
  readonly runtime: MayflyUiSurfaceRuntime
  readonly component: OverlayComponent
  readonly handle: MayflyOverlayHandle
  renderScheduled?: boolean
  renderMode: 'internal' | 'external' | undefined
}

function overlayAnchor(anchor: MayflyOverlayEntry['definition']['anchor']) {
  switch (anchor) {
    case 'top': return 'top-center' as const
    case 'bottom': return 'bottom-center' as const
    case 'left': return 'left-center' as const
    case 'right': return 'right-center' as const
    default: return 'center' as const
  }
}

function focusTarget(entry: SurfaceLaneEntry): MayflyFocusable | null {
  if (entry.focusTarget !== undefined) return entry.focusTarget
  return typeof (entry.component as MayflyFocusable).focused === 'boolean' ? entry.component as MayflyFocusable : null
}

/** Mount the direct registry renderer after theme/components become available. */
export function mountMayflySurfaceRenderer(ctx: OwnerContext, runtime: MayflyTerminalRuntime, translateHint?: (key: string) => string): void {
  const panes = new Map<string, PaneRecord>()
  const overlays = new Map<string, OverlayRecord>()
  let disposed = false
  let pending: SurfaceSnapshot | undefined
  let scheduled = false
  let appliedRevision = -1
  let navigationId: string | undefined

  const currentLayout = () => runtime.mode === 'main'
    ? runtime.surfaces.linearLayout(runtime.columns, runtime.rows)
    : runtime.surfaces.layout(runtime.columns, runtime.rows)

  const paneViewport = (id: string): MayflyUiViewport => runtime.surfaceViewport(id)
  const overlayViewport = (entry: MayflyOverlayEntry): MayflyUiViewport => {
    const percent = (value: string, total: number) => Math.max(1, Math.floor(total * Number.parseFloat(value) / 100))
    const width = entry.definition.width ?? OVERLAY_DEFAULT_WIDTH
    const requestedWidth = typeof width === 'string' ? percent(width, runtime.columns) : Math.floor(width)
    const maximum = 100
    const columns = Math.min(runtime.columns, maximum, Math.max(Math.floor(entry.definition.minWidth ?? 1), requestedWidth))
    const height = entry.definition.maxHeight ?? OVERLAY_DEFAULT_MAX_HEIGHT
    return { columns: Math.max(1, columns), rows: Math.max(1, Math.min(runtime.rows, typeof height === 'string' ? percent(height, runtime.rows) : Math.floor(height))) }
  }

  const renderPane = (record: PaneRecord, refreshMode: 'internal' | 'external'): void => {
    const entry = record.entry
    const compiled = compile(entry.node, 'pane', {
      components: ctx.mayflyComponents,
      colors: ctx.mayflyTheme.colors,
      viewport: () => paneViewport(entry.id),
      mode: runtime.mode,
      emit: event => record.events.emit(event),
      onEscape: () => runtime.releaseSurfaceFocus(entry.id),
      escapeHint: 'leave',
      ...(translateHint === undefined ? {} : { translateHint }),
      interactive: true,
      runtime: record.runtime,
      refreshMode,
    })
    if (compiled === null) {
      record.runtime.deactivate()
      record.component.replace(null)
      record.registration?.dispose()
      record.registration = undefined
      return
    }
    record.component.replace(compiled)
    if (record.registration === undefined) {
      record.registration = runtime.surfaces.register({
        id: entry.id,
        ...(entry.definition.title === undefined ? {} : { title: entry.definition.title }),
        placement: entry.definition.placement,
        ...(entry.definition.priority === undefined ? {} : { priority: entry.definition.priority }),
        ...(entry.definition.size === undefined ? {} : { size: entry.definition.size }),
        ...(entry.definition.narrow === undefined ? {} : { narrow: entry.definition.narrow }),
        component: record.component,
        focusTarget: compiled.focusTarget === null ? null : record.component,
      })
    } else record.registration.replace(record.component, compiled.focusTarget === null ? null : record.component)
    runtime.requestRender()
  }

  const schedulePane = (record: PaneRecord, mode: 'internal' | 'external'): void => {
    if (record.renderScheduled === true) {
      if (mode === 'external') record.renderMode = mode
      return
    }
    record.renderMode = mode
    record.renderScheduled = true
    queueMicrotask(() => {
      record.renderScheduled = false
      const refreshMode = record.renderMode!
      record.renderMode = undefined
      const retained = pending === undefined || pending.panes.some(entry => entry.id === record.entry.id)
      if (!disposed && retained && panes.get(record.entry.id) === record) renderPane(record, refreshMode)
    })
  }

  const addPane = (entry: MayflyPaneEntry): void => {
    let record!: PaneRecord
    const events = new SurfaceEventOwner(entry.id, entry.definition.onEvent, runtime.requestRender, undefined)
    record = { entry, events, runtime: new MayflyUiSurfaceRuntime(), component: new PaneComponent(), registration: undefined, renderMode: undefined }
    panes.set(entry.id, record)
    schedulePane(record, 'external')
  }

  const addOverlay = (entry: MayflyOverlayEntry): void => {
    let record!: OverlayRecord
    const events = new SurfaceEventOwner(entry.id, entry.definition.onEvent, runtime.requestRender, () => {
      ctx.mayflyOverlays.close(record.entry.id)
    })
    const surfaceRuntime = new MayflyUiSurfaceRuntime()
    const compiled = compile(entry.node, 'overlay', {
      components: ctx.mayflyComponents,
      colors: ctx.mayflyTheme.colors,
      viewport: () => overlayViewport(entry),
      mode: runtime.mode,
      emit: event => events.emit(event),
      ...(entry.definition.capturing && entry.definition.dismissible !== false ? { onEscape: () => events.emit({ kind: 'dismiss' as const }), escapeHint: 'close' as const } : {}),
      ...(translateHint === undefined ? {} : { translateHint }),
      interactive: entry.definition.capturing === true,
      runtime: surfaceRuntime,
      refreshMode: 'external',
      ...(entry.definition.title === undefined ? {} : { title: entry.definition.title }),
    })!
    const component = new OverlayComponent(compiled, () => overlayViewport(entry), runtime.requestRender)
    const handle = runtime.showOverlay(component, {
      width: entry.definition.width ?? OVERLAY_DEFAULT_WIDTH,
      ...(entry.definition.minWidth === undefined ? {} : { minWidth: entry.definition.minWidth }),
      maxWidth: 100,
      maxHeight: entry.definition.maxHeight ?? OVERLAY_DEFAULT_MAX_HEIGHT,
      anchor: overlayAnchor(entry.definition.anchor),
      nonCapturing: !entry.definition.capturing,
    })
    if (entry.hidden) handle.setHidden(true)
    record = { entry, events, runtime: surfaceRuntime, component, handle, renderMode: undefined }
    overlays.set(entry.id, record)
  }

  const renderOverlay = (record: OverlayRecord, refreshMode: 'internal' | 'external'): void => {
    const entry = record.entry
    const compiled = compile(entry.node, 'overlay', {
      components: ctx.mayflyComponents,
      colors: ctx.mayflyTheme.colors,
      viewport: () => overlayViewport(entry),
      mode: runtime.mode,
      emit: event => record.events.emit(event),
      ...(entry.definition.capturing && entry.definition.dismissible !== false ? { onEscape: () => record.events.emit({ kind: 'dismiss' as const }), escapeHint: 'close' as const } : {}),
      ...(translateHint === undefined ? {} : { translateHint }),
      interactive: entry.definition.capturing === true,
      runtime: record.runtime,
      refreshMode,
      ...(entry.definition.title === undefined ? {} : { title: entry.definition.title }),
    })!
    record.component.replace(compiled)
    runtime.requestRender()
  }

  const scheduleOverlay = (record: OverlayRecord, mode: 'internal' | 'external'): void => {
    if (record.renderScheduled === true) {
      if (mode === 'external') record.renderMode = mode
      return
    }
    record.renderMode = mode
    record.renderScheduled = true
    queueMicrotask(() => {
      record.renderScheduled = false
      const refreshMode = record.renderMode!
      record.renderMode = undefined
      const retained = pending === undefined || pending.overlays.some(entry => entry.id === record.entry.id)
      if (!disposed && retained && overlays.get(record.entry.id) === record) renderOverlay(record, refreshMode)
    })
  }

  const reconcile = (snapshot: SurfaceSnapshot): void => {
    const paneIds = new Set(snapshot.panes.map(entry => entry.id))
    for (const [id, record] of panes) if (!paneIds.has(id)) {
      const layout = navigationId === id ? currentLayout() : undefined
      const navigationPlacement = layout === undefined
        ? undefined
        : [layout.header, layout.left, layout.right, layout.bottom].find(lane => lane?.active.id === id)?.placement
      record.events.dispose()
      record.runtime.dispose()
      record.component.dispose()
      record.registration?.dispose()
      panes.delete(id)
      if (navigationId === id) {
        const layout = currentLayout()
        navigationId = navigationPlacement === undefined
          ? runtime.surfaces.focusedId
          : layout[navigationPlacement]?.active.id ?? runtime.surfaces.focusedId
      }
    }
    for (const entry of snapshot.panes) {
      const record = panes.get(entry.id)
      if (record === undefined) { addPane(entry); continue }
      if (record.entry.definition !== entry.definition) {
        record.events.dispose()
        record.runtime.dispose()
        record.component.dispose()
        record.registration?.dispose()
        panes.delete(entry.id)
        addPane(entry)
        continue
      }
      const renderChanged = record.entry.revision !== entry.revision
      record.entry = entry
      if (renderChanged) schedulePane(record, record.renderMode ?? 'external')
    }

    const overlayIds = new Set(snapshot.overlays.map(entry => entry.id))
    for (const [id, record] of [...overlays].reverse()) if (!overlayIds.has(id)) {
      record.events.dispose()
      record.runtime.dispose()
      record.component.dispose()
      record.handle.hide()
      overlays.delete(id)
    }
    for (const entry of [...snapshot.overlays].sort((left, right) => left.order - right.order)) {
      const record = overlays.get(entry.id)
      if (record === undefined) { addOverlay(entry); continue }
      if (record.entry.definition !== entry.definition) {
        record.events.dispose()
        record.runtime.dispose()
        record.component.dispose()
        record.handle.hide()
        overlays.delete(entry.id)
        addOverlay(entry)
        continue
      }
      const renderChanged = record.entry.revision !== entry.revision
      const focusChanged = record.entry.focusRevision !== entry.focusRevision
      record.entry = entry
      record.handle.setHidden(entry.hidden)
      if (focusChanged) record.handle.focus()
      if (renderChanged) scheduleOverlay(record, record.renderMode ?? 'external')
    }
    appliedRevision = Math.max(appliedRevision, snapshot.revision)
  }

  const drain = (): void => {
    scheduled = false
    if (disposed) return
    const snapshot = pending!
    pending = undefined
    reconcile(snapshot)
  }
  const schedule = (snapshot: SurfaceSnapshot): void => {
    /* v8 ignore next -- registryRevision is private and strictly increments for every published snapshot. */
    if (snapshot.revision <= appliedRevision) return
    const paneEntries = new Map(snapshot.panes.map(entry => [entry.id, entry]))
    const overlayEntries = new Map(snapshot.overlays.map(entry => [entry.id, entry]))
    for (const [id, record] of panes) {
      const entry = paneEntries.get(id)
      if (entry === undefined || entry.definition !== record.entry.definition) record.events.dispose()
      else if (entry !== record.entry) {
        const mode = record.events.replaceExternally(entry.eventRevision)
        record.renderMode = record.renderMode === 'external' ? 'external' : mode
      }
    }
    for (const [id, record] of overlays) {
      const entry = overlayEntries.get(id)
      if (entry === undefined || entry.definition !== record.entry.definition) record.events.dispose()
      else if (entry !== record.entry) {
        const mode = record.events.replaceExternally(entry.eventRevision)
        record.renderMode = record.renderMode === 'external' ? 'external' : mode
      }
    }
    pending = snapshot
    if (!scheduled) { scheduled = true; queueMicrotask(drain) }
  }
  const navigate = (direction: -1 | 1): void => {
    if (runtime.hasCapturingOverlay()) return
    const layout = currentLayout()
    const seen = new Set<string>()
    const entries = [layout.header, layout.left, layout.right, layout.bottom].flatMap(lane =>
      lane === undefined ? [] : lane.entries.flatMap(entry => {
        /* v8 ignore next -- host admission and SurfaceManager both enforce global ids. */
        if (seen.has(entry.id)) return []
        seen.add(entry.id)
        return [{ lane, entry }]
      }),
    )
    if (entries.length === 0) return
    const currentId = runtime.surfaces.focusedId ?? navigationId
    const current = entries.findIndex(item => item.entry.id === currentId)
    const next = current < 0 ? (direction > 0 ? 0 : entries.length - 1) : current + direction
    if (next < 0 || next >= entries.length) {
      if (runtime.surfaces.focusedId !== undefined) runtime.releaseSurfaceFocus(runtime.surfaces.focusedId)
      navigationId = undefined
      return
    }
    const selected = entries[next]!
    const previousFocused = runtime.surfaces.focusedId
    const target = focusTarget(selected.entry)
    if (target === null && previousFocused !== undefined) runtime.releaseSurfaceFocus(previousFocused)
    runtime.surfaces.activate(selected.lane.placement, selected.entry.id)
    navigationId = selected.entry.id
    if (target !== null) runtime.setFocus(target)
  }
  ctx.effect(() => ctx.mayflyKeymap.register([
    { id: 'mayfly.surface.next', keys: 'f6', description: 'Focus the next Mayfly surface', handler: () => navigate(1) },
    { id: 'mayfly.surface.previous', keys: 'shift+f6', description: 'Focus the previous Mayfly surface', handler: () => navigate(-1) },
  ]))
  const paneEntries = new Map<string, MayflyPaneEntry>()
  const overlayEntries = new Map<string, MayflyOverlayEntry>()
  let registryRevision = 0
  const publish = (): void => schedule({
    revision: ++registryRevision,
    panes: [...paneEntries.values()].sort((left, right) => (left.definition.priority ?? 0) - (right.definition.priority ?? 0) || left.id.localeCompare(right.id)),
    overlays: [...overlayEntries.values()].sort((left, right) => left.order - right.order),
  })
  const applyDelta = <Entry extends { readonly id: string }>(entries: Map<string, Entry>, delta: MayflyRegistryDelta<Entry>): void => {
    if (delta.kind === 'remove') entries.delete(delta.id)
    else entries.set(delta.entry.id, delta.entry)
    publish()
  }
  const offPanes = ctx.mayflyPanes.subscribe(delta => { applyDelta(paneEntries, delta) })
  const offOverlays = ctx.mayflyOverlays.subscribe(delta => { applyDelta(overlayEntries, delta) })
  ctx.effect(() => () => {
    disposed = true
    offPanes()
    offOverlays()
    for (const record of [...overlays.values()].reverse()) {
      record.events.dispose()
      record.runtime.dispose()
      record.component.dispose()
      record.handle.hide()
    }
    for (const record of panes.values()) {
      record.events.dispose()
      record.runtime.dispose()
      record.component.dispose()
      record.registration?.dispose()
    }
    overlays.clear()
    panes.clear()
    pending = undefined
  })
}
