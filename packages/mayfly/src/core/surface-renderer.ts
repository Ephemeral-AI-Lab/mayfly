/** Mayfly renderer for the direct pane and overlay Cordis registries. */
import type { Context } from '@deepseek-ai/cordis'
import {
  type MayflyOverlayEntry,
  type MayflyPaneEntry,
  type MayflyUiEvent,
  type MayflyUiNode,
} from '@ephemeral-ai/mayfly-ui'
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { getLayoutNode, LAYOUT_NODE, type LayoutNode } from '@earendil-works/pi-tui/dist/layout-node.js'
import type { MayflyTerminalRuntime } from './terminal.ts'
import type { SurfaceLaneEntry, SurfaceRegistration } from './surface-manager.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiNode, compileMayflyUiSurfaceNode, type MayflyCompiledUi, type MayflyUiViewport } from './ui-compiler.ts'
import type { MayflyComponents, MayflyFocusable, MayflyKeymap, MayflyOverlayHandle, MayflySemanticColors } from './types.ts'
import type { UiSurfaceModel } from './ui-interaction-surface.ts'
import type { UiInteractionService } from './ui-interaction-state.ts'
const OVERLAY_DEFAULT_WIDTH = '70%'
const OVERLAY_DEFAULT_MAX_HEIGHT = '33.333333333333336%'

interface SurfaceSnapshot {
  readonly revision: number
  readonly panes: readonly MayflyPaneEntry[]
  readonly overlays: readonly MayflyOverlayEntry[]
}

type OwnerContext = Context & {
  readonly mayflyComponents: MayflyComponents
  readonly mayflyTheme: { readonly colors: MayflySemanticColors }
  readonly mayflyKeymap: MayflyKeymap
  readonly mayflyUiInteraction: UiInteractionService
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
    readonly keymap: MayflyKeymap
    readonly viewport: () => MayflyUiViewport
    readonly mode: 'main' | 'alternate'
    readonly emit: (event: MayflyUiEvent) => void
    readonly onEscape?: () => void
    readonly escapeHint?: 'close' | 'leave'
    readonly translateHint?: (key: string) => string
    readonly interactive: boolean
    readonly runtime: MayflyUiSurfaceRuntime
    readonly title?: string
  },
): MayflyCompiledUi | null {
  const framed = (value: MayflyUiNode): MayflyUiNode => {
    if (options.title === undefined) return value
    if (value.kind === 'surface' && value.chrome === 'overlay') return { ...value, title: options.title }
    return { kind: 'surface', chrome: 'overlay', title: options.title, padding: 1, child: value }
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
    keymap: options.keymap,
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
    const candidate = compileMayflyUiNode(framed(node), compilerOptions) as Extract<ReturnType<typeof compileMayflyUiNode>, { readonly ok: true }>
    if (candidate.value.focusTarget !== null) {
      options.runtime.deactivate()
      const fallbackNode = safeFailureNode(kind, 'non-capturing overlays cannot contain interactive controls')
      const fallback = compileMayflyUiNode(framed(fallbackNode), compilerOptions)
      /* v8 ignore next -- the admitted constant fallback text cannot fail compilation. */
      return fallback.ok ? fallback.value : { node: fallbackNode, component: fallback.errorComponent, focusTarget: null }
    }
  }
  const result = compileMayflyUiSurfaceNode(node, {
    ...compilerOptions,
    surfaceRuntime: options.runtime,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.escapeHint === undefined ? {} : { escapeHint: options.escapeHint }),
  })
  return (result as Extract<typeof result, { readonly ok: true }>).value
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
    return !this.live
      ? { type: 'vstack', entries: [], gap: 0, align: 'stretch' }
      : getLayoutNode(this.targetValue!.component)!
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
  render(width: number): string[] { return this.live ? this.targetValue!.component.render(width) : [] }
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
    if (rows.length <= height) return rows
    return renderLayoutFrame(this.targetValue.component, width, height, this.requestRender).lines
  }
  invalidate(): void { if (this.live) this.targetValue?.component.invalidate() }
  handleInput(data: string): void { if (this.live) this.targetValue?.component.handleInput?.(data) }
}

interface PaneRecord {
  entry: MayflyPaneEntry
  readonly interaction: UiSurfaceModel
  readonly runtime: MayflyUiSurfaceRuntime
  readonly component: PaneComponent
  registration: SurfaceRegistration | undefined
  renderScheduled?: boolean
  renderedRevision: number
}

interface OverlayRecord {
  entry: MayflyOverlayEntry
  readonly interaction: UiSurfaceModel
  readonly runtime: MayflyUiSurfaceRuntime
  readonly component: OverlayComponent
  readonly handle: MayflyOverlayHandle | undefined
  renderScheduled?: boolean
  renderedRevision: number
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
    const height = entry.definition.maxHeight ?? OVERLAY_DEFAULT_MAX_HEIGHT
    const requestedRows = typeof height === 'string' ? percent(height, runtime.rows) : Math.max(1, Math.floor(height))
    if (entry.definition.presentation === 'editor') {
      const viewport = ctx.mayflyScreen.editorViewport
      return { columns: viewport.columns, rows: Math.max(1, Math.min(viewport.rows, requestedRows)) }
    }
    const width = entry.definition.width ?? OVERLAY_DEFAULT_WIDTH
    const requestedWidth = typeof width === 'string' ? percent(width, runtime.columns) : Math.floor(width)
    const maximum = 100
    const columns = Math.min(runtime.columns, maximum, Math.max(Math.floor(entry.definition.minWidth ?? 1), requestedWidth))
    return { columns: Math.max(1, columns), rows: Math.max(1, Math.min(runtime.rows, requestedRows)) }
  }

  const renderPane = (record: PaneRecord): void => {
    const entry = record.entry
    const compiled = compile(record.interaction.decisionNode ?? record.interaction.node, 'pane', {
      components: ctx.mayflyComponents,
      colors: ctx.mayflyTheme.colors,
      keymap: ctx.mayflyKeymap,
      viewport: () => paneViewport(entry.id),
      mode: runtime.mode,
      emit: record.interaction.emit.bind(record.interaction),
      onEscape: () => runtime.releaseSurfaceFocus(entry.id),
      escapeHint: 'leave',
      ...(translateHint === undefined ? {} : { translateHint }),
      interactive: true,
      runtime: record.runtime,
      ...(entry.definition.title === undefined ? {} : { title: entry.definition.title }),
    })
    record.renderedRevision = record.interaction.revision
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

  const schedulePane = (record: PaneRecord): void => {
    if (record.renderScheduled === true) return
    record.renderScheduled = true
    queueMicrotask(() => {
      record.renderScheduled = false
      const retained = pending === undefined || pending.panes.some(entry => entry.id === record.entry.id)
      if (!disposed && retained && panes.get(record.entry.id) === record) renderPane(record)
    })
  }

  const addPane = (entry: MayflyPaneEntry): void => {
    let record!: PaneRecord
    const interaction = ctx.mayflyUiInteraction.get('pane', entry.id)!
    record = { entry, interaction, runtime: new MayflyUiSurfaceRuntime(interaction), component: new PaneComponent(), registration: undefined, renderedRevision: -1 }
    panes.set(entry.id, record)
    schedulePane(record)
  }

  const addOverlay = (entry: MayflyOverlayEntry): void => {
    let record!: OverlayRecord
    const interaction = ctx.mayflyUiInteraction.get('overlay', entry.id)!
    const surfaceRuntime = new MayflyUiSurfaceRuntime(interaction)
    const compiled = compile(interaction.decisionNode ?? interaction.node, 'overlay', {
      components: ctx.mayflyComponents,
      colors: ctx.mayflyTheme.colors,
      keymap: ctx.mayflyKeymap,
      viewport: () => overlayViewport(entry),
      mode: runtime.mode,
      emit: interaction.emit.bind(interaction),
      ...(entry.definition.capturing && entry.definition.dismissible !== false ? { onEscape: () => interaction.emit({ kind: 'dismiss', pagePath: [] }), escapeHint: 'close' as const } : {}),
      ...(translateHint === undefined ? {} : { translateHint }),
      interactive: entry.definition.capturing === true,
      runtime: surfaceRuntime,
      ...(entry.definition.title === undefined ? {} : { title: entry.definition.title }),
    })!
    const component = new OverlayComponent(compiled, () => overlayViewport(entry), runtime.requestRender)
    const handle = entry.definition.presentation === 'editor' ? undefined : runtime.showOverlay(component, {
      width: entry.definition.width ?? OVERLAY_DEFAULT_WIDTH,
      ...(entry.definition.minWidth === undefined ? {} : { minWidth: entry.definition.minWidth }),
      maxWidth: 100,
      maxHeight: entry.definition.maxHeight ?? OVERLAY_DEFAULT_MAX_HEIGHT,
      anchor: overlayAnchor(entry.definition.anchor),
      nonCapturing: !entry.definition.capturing,
    })
    if (entry.hidden) handle?.setHidden(true)
    record = { entry, interaction, runtime: surfaceRuntime, component, handle, renderedRevision: interaction.revision }
    overlays.set(entry.id, record)
  }

  const renderOverlay = (record: OverlayRecord): void => {
    const entry = record.entry
    const compiled = compile(record.interaction.decisionNode ?? record.interaction.node, 'overlay', {
      components: ctx.mayflyComponents,
      colors: ctx.mayflyTheme.colors,
      keymap: ctx.mayflyKeymap,
      viewport: () => overlayViewport(entry),
      mode: runtime.mode,
      emit: record.interaction.emit.bind(record.interaction),
      ...(entry.definition.capturing && entry.definition.dismissible !== false ? { onEscape: () => record.interaction.emit({ kind: 'dismiss', pagePath: [] }), escapeHint: 'close' as const } : {}),
      ...(translateHint === undefined ? {} : { translateHint }),
      interactive: entry.definition.capturing === true,
      runtime: record.runtime,
      ...(entry.definition.title === undefined ? {} : { title: entry.definition.title }),
    })!
    record.renderedRevision = record.interaction.revision
    record.component.replace(compiled)
    runtime.requestRender()
  }

  const scheduleOverlay = (record: OverlayRecord): void => {
    if (record.renderScheduled === true) return
    record.renderScheduled = true
    queueMicrotask(() => {
      record.renderScheduled = false
      const retained = pending === undefined || pending.overlays.some(entry => entry.id === record.entry.id)
      if (!disposed && retained && overlays.get(record.entry.id) === record) renderOverlay(record)
    })
  }

  const reconcile = (snapshot: SurfaceSnapshot): void => {
    const paneIds = new Set(snapshot.panes.map(entry => entry.id))
    for (const [id, record] of panes) if (!paneIds.has(id)) {
      const layout = navigationId === id ? currentLayout() : undefined
      const navigationPlacement = layout === undefined
        ? undefined
        : [layout.header, layout.left, layout.right, layout.bottom].find(lane => lane?.active.id === id)?.placement
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
      if (record.interaction !== ctx.mayflyUiInteraction.get('pane', entry.id)) {
        record.runtime.dispose()
        record.component.dispose()
        record.registration?.dispose()
        panes.delete(entry.id)
        addPane(entry)
        continue
      }
      const renderChanged = record.entry.revision !== entry.revision || record.renderedRevision !== record.interaction.revision
      record.entry = entry
      if (renderChanged) schedulePane(record)
    }

    const overlayIds = new Set(snapshot.overlays.map(entry => entry.id))
    for (const [id, record] of [...overlays].reverse()) if (!overlayIds.has(id)) {
      record.runtime.dispose()
      record.component.dispose()
      record.handle?.hide()
      overlays.delete(id)
    }
    for (const entry of [...snapshot.overlays].sort((left, right) => left.order - right.order)) {
      const record = overlays.get(entry.id)
      if (record === undefined) { addOverlay(entry); continue }
      if (record.interaction !== ctx.mayflyUiInteraction.get('overlay', entry.id)) {
        record.runtime.dispose()
        record.component.dispose()
        record.handle?.hide()
        overlays.delete(entry.id)
        addOverlay(entry)
        continue
      }
      const renderChanged = record.entry.revision !== entry.revision || record.renderedRevision !== record.interaction.revision
      const focusChanged = record.entry.focusRevision !== entry.focusRevision
      record.entry = entry
      record.handle?.setHidden(entry.hidden)
      if (focusChanged) record.handle?.focus()
      if (renderChanged) scheduleOverlay(record)
    }
    const editor = [...overlays.values()].filter(record => record.entry.definition.presentation === 'editor' && !record.entry.hidden).toSorted((left, right) => left.entry.order - right.entry.order).at(-1)
    const occupied = editor !== undefined
    if (occupied !== editorOccupied) {
      editorOccupied = occupied
      ctx.emit('mayfly/editor-slot-swapped', occupied)
    }
    ctx.mayflyScreen.setEditorReplacement(editor?.component ?? null)
    ctx.mayflyUiInteraction.setNotificationVisibility(!occupied)
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
        return focusTarget(entry) === null ? [] : [{ lane, entry }]
      }),
    )
    if (entries.length === 0) return
    const currentId = runtime.surfaces.focusedId ?? navigationId
    const current = entries.findIndex(item => item.entry.id === currentId)
    const next = current < 0 ? (direction > 0 ? 0 : entries.length - 1) : current + direction
    if (next < 0 || next >= entries.length) {
      /* v8 ignore else -- reaching the boundary after a focused surface always has an id. */
      if (runtime.surfaces.focusedId !== undefined) runtime.releaseSurfaceFocus(runtime.surfaces.focusedId)
      navigationId = undefined
      return
    }
    const selected = entries[next]!
    const target = focusTarget(selected.entry)!
    runtime.surfaces.activate(selected.lane.placement, selected.entry.id)
    navigationId = selected.entry.id
    runtime.setFocus(target)
  }
  ctx.effect(() => ctx.mayflyKeymap.register([
    { id: 'mayfly.surface.next', keys: 'f6', description: 'Focus the next Mayfly surface', handler: () => navigate(1) },
    { id: 'mayfly.surface.previous', keys: 'shift+f6', description: 'Focus the previous Mayfly surface', handler: () => navigate(-1) },
  ]))
  let registryRevision = 0
  let editorOccupied = false
  const publish = (): void => schedule({
    revision: ++registryRevision,
    panes: ctx.mayflyUiInteraction.panes().toSorted((left, right) => (left.definition.priority ?? 0) - (right.definition.priority ?? 0) || left.id.localeCompare(right.id)),
    overlays: ctx.mayflyUiInteraction.overlays().toSorted((left, right) => left.order - right.order),
  })
  const offInteraction = ctx.mayflyUiInteraction.subscribe(publish)
  publish()
  ctx.effect(() => () => {
    disposed = true
    offInteraction()
    for (const record of [...overlays.values()].reverse()) {
      record.runtime.dispose()
      record.component.dispose()
      record.handle?.hide()
    }
    for (const record of panes.values()) {
      record.runtime.dispose()
      record.component.dispose()
      record.registration?.dispose()
    }
    overlays.clear()
    ctx.mayflyScreen.setEditorReplacement(null)
    ctx.mayflyUiInteraction.setNotificationVisibility(false)
    if (editorOccupied) ctx.emit('mayfly/editor-slot-swapped', false)
    panes.clear()
    pending = undefined
  })
}
